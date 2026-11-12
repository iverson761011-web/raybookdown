import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OFFICIAL_HOSTS = new Set(['nba.com', 'www.nba.com', 'cdn.nba.com']);
const CDN_SOURCES = [
  'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json',
  'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json',
];
const MAX_BYTES = 12 * 1024 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
const EASTERN = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function problem(code) { throw Object.assign(new Error(code), { safeCode: code }); }
function calendarDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) problem('InvalidDate');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) problem('InvalidDate');
  return value;
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[<>\u0000-\u001f\u007f]/u.test(value)) problem('InvalidOfficialGame');
  return value.trim();
}
export function addDays(value, days) {
  return new Date(Date.parse(calendarDate(value) + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function taipeiDate(now = new Date()) { return new Date(+now + 8 * 3600000).toISOString().slice(0, 10); }
function easternDate(date) {
  const p = Object.fromEntries(EASTERN.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function officialUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { problem('UntrustedOfficialUrl'); }
  if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.has(url.hostname) || url.username || url.password || url.hash || (url.port && url.port !== '443')) problem('UntrustedOfficialUrl');
  return url;
}
function dateKey(value) {
  if (typeof value !== 'string') problem('InvalidOfficialDate');
  if (DATE.test(value)) return calendarDate(value);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: 00:00:00)?$/.exec(value);
  if (m) return calendarDate(`${m[3]}-${m[1]}-${m[2]}`);
  problem('InvalidOfficialDate');
}
function teamName(team) {
  if (typeof team === 'string') return text(team);
  if (!team || typeof team !== 'object') problem('InvalidOfficialGame');
  if (typeof team.name === 'string') return text(team.name);
  const name = text(team.teamName);
  if (!team.teamCity) return name;
  const city = text(team.teamCity);
  return name.toLowerCase().startsWith(city.toLowerCase() + ' ') ? name : `${city} ${name}`;
}
function utcStart(game) {
  // NBA's public GameCard feed uses gameTimeUtc (not the CDN's UTC spelling).
  for (const key of ['gameDateTimeUTC', 'startDate', 'gameTimeUtc', 'gameTimeUTC', 'gameTime']) {
    const value = game[key];
    if (typeof value === 'string' && ISO_OFFSET.test(value) && Number(value.slice(0, 4)) >= 2000) {
      const date = new Date(value);
      if (Number.isFinite(+date)) return date;
    }
  }
  problem('GameTimeUnknown');
}
export function normalizeOfficialGame(raw, expectedEasternDate, sourceUrl) {
  if (!raw || typeof raw !== 'object' || /\bTBD\b|postpon|cancel|suspend|\bPPD\b/i.test(String(raw.gameStatusText ?? ''))) problem('GameTimeUnknown');
  const start = utcStart(raw);
  if (easternDate(start) !== calendarDate(expectedEasternDate)) problem('OfficialDateMismatch');
  const teams = [teamName(raw.awayTeam), teamName(raw.homeTeam)];
  if (teams[0] === teams[1]) problem('InvalidOfficialGame');
  let url = sourceUrl;
  if (typeof raw.gameId === 'string' && /^\d{10}$/.test(raw.gameId)) url = 'https://www.nba.com/game/' + raw.gameId;
  else if (typeof raw.url === 'string') url = raw.url;
  else if (!url) problem('OfficialGameLinkUnknown');
  const source = officialUrl(url, 'https://www.nba.com');
  if (source.search || !/\/game\/[A-Za-z0-9-]+(?:\/event-details)?\/?$/.test(source.pathname)) problem('OfficialGameLinkUnknown');
  const result = {
    StartAtTaipei: new Date(+start + 8 * 3600000).toISOString().slice(0, 19) + '+08:00',
    Teams: teams,
    SourceUrl: source.href,
  };
  return result;
}
function parseGameCollection(games, date, sourceUrl) {
  if (!Array.isArray(games) || games.length > 32) return { verified: false, games: [] };
  const parsed = [];
  let verified = true;
  for (const game of games) {
    try { parsed.push(normalizeOfficialGame(game, date, sourceUrl)); }
    catch { verified = false; }
  }
  return { verified, games: parsed };
}
export function parseLeagueSchedule(document, expectedSeasonYear) {
  const schedule = document?.leagueSchedule;
  if (!schedule || !Array.isArray(schedule.gameDates)) problem('UnsupportedOfficialSchema');
  const season = String(schedule.seasonYear ?? '');
  const expected = `${expectedSeasonYear}-${String(expectedSeasonYear + 1).slice(-2)}`;
  if (season !== expected) problem('OfficialSeasonMismatch');
  const dates = new Map();
  for (const item of schedule.gameDates) {
    let date;
    try { date = dateKey(item.gameDate); } catch { continue; }
    if (dates.has(date)) { dates.set(date, { verified: false, games: [] }); continue; }
    dates.set(date, parseGameCollection(item.games, date));
  }
  return dates;
}
function scriptsFromHtml(html, attribute) {
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attribute.test(match[1])) {
      try { found.push(JSON.parse(match[2])); } catch { /* Unusable script is not evidence of no games. */ }
    }
  }
  return found;
}
export function visibleOfficialText(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, ' ').replace(/\s+/g, ' ');
}
// This exact empty-day shape was verified against NBA's 2026-11-03 page.
// An absent collection or JavaScript's static "No Games" label is not evidence.
export function officialNoGamesDay(html, root, requestedDate) {
  const props = root?.props?.pageProps;
  return root?.query?.date === requestedDate && props?.selectedDate === requestedDate && props?.hasError === false
    && Array.isArray(props.gameCardFeed?.modules) && props.gameCardFeed.modules.length === 0
    && !(Array.isArray(props.games) && props.games.length > 0)
    && !(Array.isArray(props.scoreboard?.games) && props.scoreboard.games.length > 0)
    && /\bNo Games Scheduled\b/i.test(visibleOfficialText(html));
}
export function parseDailyHtml(html, requestedDate) {
  calendarDate(requestedDate);
  const parsed = scriptsFromHtml(html, /\bid\s*=\s*["']__NEXT_DATA__["']/i);
  for (const root of parsed) {
    if (root?.query?.date !== requestedDate) continue;
    const props = root?.props?.pageProps;
    if (!props || typeof props !== 'object') continue;
    const groups = [];
    if (Array.isArray(props.games)) groups.push(props.games);
    if (Array.isArray(props.scoreboard?.games)) groups.push(props.scoreboard.games);
    if (Array.isArray(props.gameCardFeed?.modules)) {
      const cards = props.gameCardFeed.modules.flatMap(x => Array.isArray(x?.cards) ? x.cards : []);
      const games = cards.filter(x => /gamecard/i.test(String(x?.cardType ?? '')) || x?.cardData?.gameId || x?.cardData?.game?.gameId)
        .map(x => x.cardData?.game ?? x.cardData);
      if (games.length) groups.push(games);
      else if (officialNoGamesDay(html, root, requestedDate)) groups.push([]);
    }
    if (groups.length) {
      const results = groups.map(games => parseGameCollection(games, requestedDate));
      const allGames = deduplicate(results.flatMap(result => result.games));
      const key = game => game.StartAtTaipei + '|' + game.Teams.join('|');
      const signature = result => result.games.map(key).sort().join('\n');
      const consistent = results.every(result => result.verified && signature(result) === signature(results[0]));
      return { verified: consistent, games: allGames };
    }
  }
  // A list of SportsEvent entries can verify individual games, but not a complete day.
  const games = [];
  let nodes = 0;
  const stack = scriptsFromHtml(html, /\btype\s*=\s*["']application\/ld\+json["']/i);
  while (stack.length && ++nodes <= 10000) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    const type = value['@type'];
    if (type === 'SportsEvent' || (Array.isArray(type) && type.includes('SportsEvent'))) {
      try { games.push(normalizeOfficialGame(value, requestedDate)); } catch { /* Unknown is retained as unknown coverage. */ }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(...(Array.isArray(child) ? child : [child]));
  }
  return { verified: false, games };
}
export async function fetchOfficialText(value, { fetchImpl = fetch, timeoutMs = 12000, onDiagnostic = () => {} } = {}) {
  let url = officialUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal, headers: { Accept: 'application/json,text/html;q=0.9', 'User-Agent': 'RayBookDown-Schedule/1.0' } });
      onDiagnostic({ Phase: 'http', HttpStatus: response.status });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) problem('OfficialRedirectRejected');
        url = officialUrl(location, url);
        continue;
      }
      if (!response.ok) problem('OfficialHttpError');
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_BYTES) problem('OfficialResponseTooLarge');
      const reader = response.body?.getReader();
      if (!reader) problem('OfficialResponseUnavailable');
      const parts = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          bytes += chunk.byteLength;
          if (bytes > MAX_BYTES) problem('OfficialResponseTooLarge');
          parts.push(chunk);
        }
      } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
    }
    problem('OfficialRedirectRejected');
  } finally { clearTimeout(timer); }
}
function deduplicate(games) {
  const map = new Map();
  for (const game of games) {
    const id = /\d{10}/.exec(game.SourceUrl)?.[0] ?? [...game.Teams].sort().join('|');
    map.set(id + '|' + game.StartAtTaipei, game);
  }
  return [...map.values()].sort((a, b) => a.StartAtTaipei.localeCompare(b.StartAtTaipei) || a.SourceUrl.localeCompare(b.SourceUrl));
}
export function describeDailySchema(html, requestedDate) {
  const keys = value => value && typeof value === 'object' ? Object.keys(value).filter(x => /^[A-Za-z0-9_]{1,60}$/.test(x)).slice(0, 40) : [];
  const roots = scriptsFromHtml(html, /\bid\s*=\s*["']__NEXT_DATA__["']/i);
  const root = roots[0];
  const props = root?.props?.pageProps;
  const module = props?.gameCardFeed?.modules?.[0];
  const card = module?.cards?.[0];
  return { NextDataScripts: roots.length, QueryDateMatches: root?.query?.date === requestedDate, QueryKeys: keys(root?.query), PagePropKeys: keys(props), FeedKeys: keys(props?.gameCardFeed), ModuleKeys: keys(module), CardKeys: keys(card), CardDataKeys: keys(card?.cardData), JsonLdScripts: scriptsFromHtml(html, /\btype\s*=\s*["']application\/ld\+json["']/i).length };
}
export async function collectSchedule({ startDate, days = 7, seasonYear, fetchText = fetchOfficialText, onDiagnostic = () => {} }) {
  calendarDate(startDate);
  if (!Number.isInteger(days) || days < 1 || days > 14 || !Number.isInteger(seasonYear)) problem('InvalidScheduleRange');
  const requestedDates = Array.from({ length: days }, (_, i) => addDays(startDate, i));
  // Each Taipei day overlaps the previous and same calendar day in New York.
  const easternDates = Array.from({ length: days + 1 }, (_, i) => addDays(startDate, i - 1));
  let dates = new Map();
  const read = url => fetchText(url, { onDiagnostic: event => onDiagnostic({ Url: url, ...event }) });
  for (const url of CDN_SOURCES) {
    try {
      const document = JSON.parse(await read(url));
      dates = parseLeagueSchedule(document, seasonYear);
      onDiagnostic({ Url: url, Phase: 'parse', ErrorType: null, VerifiedDates: easternDates.filter(date => dates.get(date)?.verified).length });
      if (easternDates.every(date => dates.get(date)?.verified)) break;
    } catch (error) { onDiagnostic({ Url: url, Phase: 'parse', ErrorType: error.safeCode ?? (error instanceof SyntaxError ? 'OfficialJsonInvalid' : 'OfficialFetchFailed') }); }
  }
  const missing = easternDates.filter(date => !dates.get(date)?.verified);
  for (let i = 0; i < missing.length; i += 3) {
    await Promise.all(missing.slice(i, i + 3).map(async date => {
      const url = 'https://www.nba.com/games?date=' + date;
      try {
        const html = await read(url);
        const result = parseDailyHtml(html, date);
        onDiagnostic({ Url: url, Phase: 'parse', ErrorType: result.verified ? null : 'OfficialDateCoverageUnverified', Games: result.games.length, Schema: describeDailySchema(html, date) });
        const previous = dates.get(date);
        dates.set(date, { verified: result.verified, games: deduplicate([...(previous?.games ?? []), ...result.games]) });
      } catch (error) { onDiagnostic({ Url: url, Phase: 'parse', ErrorType: error.safeCode ?? 'OfficialFetchFailed' }); if (!dates.has(date)) dates.set(date, { verified: false, games: [] }); }
    }));
  }
  const games = deduplicate(easternDates.flatMap(date => dates.get(date)?.games ?? [])).filter(game => requestedDates.includes(game.StartAtTaipei.slice(0, 10)));
  const unavailableDates = requestedDates.filter(date => !dates.get(addDays(date, -1))?.verified || !dates.get(date)?.verified);
  return { requestedDates, games, unavailableDates };
}
export function buildScheduleSection(result, { now = new Date(), previous = null } = {}) {
  const checked = now.toISOString();
  const complete = result.unavailableDates.length === 0;
  let games = result.games;
  let retrieved = checked;
  if (!complete && games.length === 0 && ['ok', 'partial'].includes(previous?.Status) && previous?.Data && typeof previous.RetrievedAtUtc === 'string') {
    const previousDate = new Date(previous.RetrievedAtUtc);
    if (Number.isFinite(+previousDate) && +previousDate <= +now) {
      games = (Array.isArray(previous.Data.Games) ? previous.Data.Games : []).flatMap(game => {
        try {
          if (!ISO_OFFSET.test(game.StartAtTaipei) || !game.StartAtTaipei.endsWith('+08:00') || !Number.isFinite(Date.parse(game.StartAtTaipei)) || !result.requestedDates.includes(game.StartAtTaipei.slice(0, 10))) return [];
          if (!Array.isArray(game.Teams) || game.Teams.length !== 2) return [];
          const teams = game.Teams.map(text);
          const url = officialUrl(game.SourceUrl);
          if (url.search || !/\/game\/[A-Za-z0-9-]+(?:\/event-details)?\/?$/.test(url.pathname)) return [];
          return [{ StartAtTaipei: game.StartAtTaipei, Teams: teams, SourceUrl: url.href }];
        } catch { return []; }
      });
      retrieved = previous.RetrievedAtUtc;
    }
  }
  const status = complete ? 'ok' : games.length ? 'partial' : 'unavailable';
  return {
    Status: status,
    Source: 'NBA official schedule',
    CheckedAtUtc: checked,
    RetrievedAtUtc: status === 'unavailable' ? null : retrieved,
    SourceUpdatedAtUtc: null,
    ErrorType: complete ? null : status === 'partial' ? 'ScheduleCoverageIncomplete' : 'OfficialScheduleUnavailable',
    Data: status === 'unavailable' ? null : {
      RangeStartDateTaipei: result.requestedDates[0],
      RangeEndDateTaipei: result.requestedDates.at(-1),
      UnavailableDates: result.unavailableDates,
      Games: games,
      SourceUpdatedAtUtc: null,
    },
  };
}
export async function updateDashboard(file, { now = new Date(), probe = false, diagnose = false, fetchText = fetchOfficialText } = {}) {
  const raw = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(raw) > 1048576) problem('InvalidDashboard');
  const dashboard = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (dashboard.SchemaVersion !== 2 || dashboard.League !== 'Funny League 2026-27' || dashboard.Team !== 'RayBookDown' || dashboard.Platform !== 'yahoo' || !dashboard.Sections || !Number.isInteger(dashboard.Season)) problem('InvalidDashboard');
  const diagnostics = [];
  const result = await collectSchedule({ startDate: taipeiDate(now), seasonYear: dashboard.Season, fetchText, onDiagnostic: event => { if (diagnose) diagnostics.push(event); } });
  const section = buildScheduleSection(result, { now, previous: dashboard.Sections.Schedule });
  if (!probe) {
    dashboard.Sections.Schedule = section;
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try { await fs.writeFile(temporary, JSON.stringify(dashboard, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  return { ScheduleUpdated: !probe, Status: section.Status, Games: section.Data?.Games.length ?? 0, UnknownDates: result.unavailableDates.length, RetrievedAtUtc: section.RetrievedAtUtc, CheckedAtUtc: section.CheckedAtUtc, ErrorType: section.ErrorType, ...(diagnose ? { Diagnostics: diagnostics } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const probe = args.includes('--probe');
    const diagnose = args.includes('--diagnose');
    const file = args.find(x => !x.startsWith('--')) ?? 'data/dashboard.json';
    if (args.some(x => x.startsWith('--') && !['--probe', '--diagnose'].includes(x))) problem('InvalidArguments');
    console.log(JSON.stringify(await updateDashboard(path.resolve(file), { probe, diagnose })));
  } catch (error) {
    const safe = new Set(['InvalidDashboard', 'InvalidScheduleRange', 'InvalidDate', 'InvalidArguments']);
    console.error(JSON.stringify({ ScheduleUpdated: false, ErrorType: safe.has(error.safeCode) ? error.safeCode : 'ScheduleUpdateFailed' }));
    process.exitCode = 1;
  }
}
