import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeOfficialGame, parseLeagueSchedule, parseDailyHtml, describeDailySchema, officialUrl, fetchOfficialText, collectSchedule, buildScheduleSection, updateDashboard, taipeiDate } from './update-nba-schedule.mjs';

const game = (utc = '2026-11-13T00:00:00Z', id = '0022600001') => ({
  gameId: id, gameDateTimeUTC: utc,
  awayTeam: { teamCity: 'Alpha City', teamName: 'Alphas' },
  homeTeam: { teamCity: 'Beta City', teamName: 'Betas' },
});
const daily = (date, games) => '<html><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ query: { date }, props: { pageProps: { games } } }) + '</script></html>';
const baseSection = { Status: 'ok', Source: 'NBA official schedule', CheckedAtUtc: '2026-11-12T10:00:00Z', RetrievedAtUtc: '2026-11-12T10:00:00Z', SourceUpdatedAtUtc: null, ErrorType: null, Data: { Games: [{ StartAtTaipei: '2026-11-13T08:00:00+08:00', Teams: ['Alpha City Alphas', 'Beta City Betas'], SourceUrl: 'https://www.nba.com/game/0022600001' }] } };

test('official UTC starts convert to Taipei without inventing a timezone', () => {
  const result = normalizeOfficialGame(game(), '2026-11-12');
  assert.equal(result.StartAtTaipei, '2026-11-13T08:00:00+08:00');
  assert.deepEqual(result.Teams, ['Alpha City Alphas', 'Beta City Betas']);
  assert.throws(() => normalizeOfficialGame({ ...game(), gameDateTimeUTC: '2026-11-12T19:00:00' }, '2026-11-12'));
  assert.throws(() => normalizeOfficialGame({ ...game(), gameStatusText: 'TBD' }, '2026-11-12'));
});
test('Eastern date is checked across daylight-saving transitions', () => {
  assert.equal(normalizeOfficialGame(game('2026-11-01T05:30:00Z'), '2026-11-01').StartAtTaipei, '2026-11-01T13:30:00+08:00');
  assert.equal(normalizeOfficialGame(game('2026-11-01T06:30:00Z'), '2026-11-01').StartAtTaipei, '2026-11-01T14:30:00+08:00');
  assert.throws(() => normalizeOfficialGame(game(), '2026-11-13'));
});

test('postponed canceled and suspended games never count as verified scheduled opportunities', () => {
  for (const status of ['PPD', 'Postponed', 'Canceled', 'Suspended']) {
    const raw = { ...game(), gameStatusText: status };
    assert.throws(() => normalizeOfficialGame(raw, '2026-11-12'));
    assert.deepEqual(parseDailyHtml(daily('2026-11-12', [raw]), '2026-11-12'), { verified: false, games: [] });
  }
});
test('official season and date containers are validated, absent dates remain unknown', () => {
  const dates = parseLeagueSchedule({ leagueSchedule: { seasonYear: '2026-27', gameDates: [{ gameDate: '11/12/2026 00:00:00', games: [game()] }, { gameDate: '11/13/2026', games: [] }] } }, 2026);
  assert.equal(dates.get('2026-11-12').verified, true);
  assert.deepEqual(dates.get('2026-11-13'), { verified: true, games: [] });
  assert.equal(dates.has('2026-11-14'), false);
  assert.throws(() => parseLeagueSchedule({ leagueSchedule: { seasonYear: '2025-26', gameDates: [] } }, 2026));
});
test('a matching daily page with an explicit empty games collection verifies zero games', () => {
  assert.deepEqual(parseDailyHtml(daily('2026-11-12', []), '2026-11-12'), { verified: true, games: [] });
  assert.deepEqual(parseDailyHtml(daily('2025-11-12', []), '2026-11-12'), { verified: false, games: [] });
  assert.deepEqual(parseDailyHtml('<html>NBA Games</html>', '2026-11-12'), { verified: false, games: [] });
});
test('the observed NBA empty-day message is evidence only with the selected date and successful page state', () => {
  const date = '2026-11-03';
  const page = ({ selectedDate = date, hasError = false, notice = '<main>No Games Scheduled</main>', modules = [] } = {}) =>
    '<script id="__NEXT_DATA__">' + JSON.stringify({ query: { date }, props: { pageProps: { selectedDate, hasError, gameCardFeed: { modules } } } }) + '</script>' + notice;
  assert.deepEqual(parseDailyHtml(page(), date), { verified: true, games: [] });
  for (const html of [page({ notice: '' }), page({ notice: '<script>"No Games Scheduled"</script>' }), page({ notice: '<style>/* No Games Scheduled */</style>' }), page({ selectedDate: '2026-11-04' }), page({ hasError: true }), page({ modules: [{ cards: [] }] })]) {
    assert.deepEqual(parseDailyHtml(html, date), { verified: false, games: [] });
  }
});
test('game-card feeds preserve good games while marking malformed rows as incomplete', () => {
  const html = '<script id="__NEXT_DATA__">' + JSON.stringify({ query: { date: '2026-11-12' }, props: { pageProps: { gameCardFeed: { modules: [{ cards: [{ cardType: 'GameCard', cardData: game() }, { cardType: 'GameCard', cardData: { gameId: '0022600002' } }] }] } } } }) + '</script>';
  const result = parseDailyHtml(html, '2026-11-12');
  assert.equal(result.verified, false);
  assert.equal(result.games.length, 1);
});
test('observed NBA GameCard schema reads gameTimeUtc only when it includes a timezone', () => {
  // Field names match the successful public NBA page probe; values are test fixtures.
  const cardData = {
    gameId: '0022600227', leagueId: '00', seasonYear: '2026', seasonType: 'Regular Season', dailyGameRank: 1,
    homeTeam: { teamCity: 'Philadelphia', teamName: '76ers' }, awayTeam: { teamCity: 'Toronto', teamName: 'Raptors' },
    gameTimeEastern: '2026-11-12T19:00:00', gameTimeUtc: '2026-11-13T00:00:00Z',
    gameDetailsHeader: {}, shareUrl: 'https://www.nba.com/game/0022600227',
  };
  const wrap = value => '<script id="__NEXT_DATA__">' + JSON.stringify({ query: { date: '2026-11-12' }, props: { pageProps: { gameCardFeed: { modules: [{ cards: [{ cardType: 'GameCard', cardData: value }] }] } } } }) + '</script>';
  const parsed = parseDailyHtml(wrap(cardData), '2026-11-12');
  assert.equal(parsed.verified, true);
  assert.equal(parsed.games[0].StartAtTaipei, '2026-11-13T08:00:00+08:00');
  assert.deepEqual(parsed.games[0].Teams, ['Toronto Raptors', 'Philadelphia 76ers']);
  const unknownTime = parseDailyHtml(wrap({ ...cardData, gameTimeUtc: '2026-11-13T00:00:00' }), '2026-11-12');
  assert.deepEqual(unknownTime, { verified: false, games: [] });
});
test('conflicting containers never turn a populated schedule into a verified empty day', () => {
  const html = '<script id="__NEXT_DATA__">' + JSON.stringify({ query: { date: '2026-11-12' }, props: { pageProps: { games: [], scoreboard: { games: [game()] } } } }) + '</script>';
  const result = parseDailyHtml(html, '2026-11-12');
  assert.equal(result.verified, false);
  assert.equal(result.games.length, 1);
});
test('JSON-LD verifies individual events without claiming complete day coverage', () => {
  const html = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'SportsEvent', startDate: '2026-11-12T19:00:00-05:00', awayTeam: { name: 'Alphas' }, homeTeam: { name: 'Betas' }, url: 'https://www.nba.com/game/0022600001' }) + '</script>';
  const result = parseDailyHtml(html, '2026-11-12');
  assert.equal(result.verified, false);
  assert.equal(result.games.length, 1);
});
test('untrusted hosts, URL credentials and secret-bearing game links are rejected', () => {
  for (const url of ['http://www.nba.com/game/1', 'https://nba.com.evil.test/game/1', 'https://user:pass@www.nba.com/game/1', 'https://127.0.0.1/game/1']) assert.throws(() => officialUrl(url));
  assert.throws(() => normalizeOfficialGame({ startDate: '2026-11-13T00:00:00Z', awayTeam: 'Alphas', homeTeam: 'Betas', url: 'https://www.nba.com/game/0022600001?token=private' }, '2026-11-12'));
});
test('fetch never follows a redirect to a non-official host', async () => {
  let calls = 0;
  await assert.rejects(fetchOfficialText('https://www.nba.com/games?date=2026-11-12', { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/leak' } }); } }));
  assert.equal(calls, 1);
});
test('fetch bounds successful responses before accepting their content', async () => {
  await assert.rejects(fetchOfficialText('https://www.nba.com/games', { fetchImpl: async () => new Response('ignored', { headers: { 'content-length': String(13 * 1024 * 1024) } }) }));
  assert.equal(await fetchOfficialText('https://www.nba.com/games', { fetchImpl: async () => new Response('valid') }), 'valid');
});
test('safe diagnostics distinguish HTTP refusal from parser schema without printing body values', async () => {
  const events = [];
  await assert.rejects(fetchOfficialText('https://www.nba.com/games', { onDiagnostic: event => events.push(event), fetchImpl: async () => new Response('private body value', { status: 403 }) }));
  assert.deepEqual(events, [{ Phase: 'http', HttpStatus: 403 }]);
  const html = '<script id="__NEXT_DATA__">' + JSON.stringify({ query: { date: '2026-11-12' }, props: { pageProps: { unexpectedContainer: { body: 'do not print this value' } } } }) + '</script>';
  const schema = describeDailySchema(html, '2026-11-12');
  assert.deepEqual(schema.PagePropKeys, ['unexpectedContainer']);
  assert.equal(schema.QueryDateMatches, true);
  assert.equal(JSON.stringify(schema).includes('do not print'), false);
});
test('source exception diagnostics use fixed codes instead of raw error messages', async () => {
  const events = [];
  await collectSchedule({ startDate: '2026-11-13', days: 1, seasonYear: 2026, onDiagnostic: event => events.push(event), fetchText: async () => { throw new Error('private diagnostic value'); } });
  assert.equal(events.length, 4);
  assert(events.every(event => event.ErrorType === 'OfficialFetchFailed'));
  assert.equal(JSON.stringify(events).includes('private diagnostic'), false);
});
test('a Taipei date requires coverage of both overlapping Eastern dates', async () => {
  const fetchText = async url => {
    if (url.includes('cdn.nba.com')) throw new Error('403');
    const date = new URL(url).searchParams.get('date');
    return daily(date, date === '2026-11-12' ? [game()] : []);
  };
  const complete = await collectSchedule({ startDate: '2026-11-13', days: 1, seasonYear: 2026, fetchText });
  assert.deepEqual(complete.unavailableDates, []);
  assert.equal(complete.games.length, 1);
  const partial = await collectSchedule({ startDate: '2026-11-13', days: 1, seasonYear: 2026, fetchText: async url => url.includes('date=2026-11-13') ? '<html>unavailable</html>' : fetchText(url) });
  assert.deepEqual(partial.unavailableDates, ['2026-11-13']);
  assert.equal(partial.games.length, 1);
});
test('failed sources produce unavailable rather than zero games with a fresh timestamp', async () => {
  const result = await collectSchedule({ startDate: '2026-11-13', days: 1, seasonYear: 2026, fetchText: async () => { throw new Error('unavailable'); } });
  const section = buildScheduleSection(result, { now: new Date('2026-11-12T15:00:00Z') });
  assert.equal(section.Status, 'unavailable');
  assert.equal(section.Data, null);
  assert.equal(section.RetrievedAtUtc, null);
});
test('retained verified games keep their original source time and mark date coverage unknown', () => {
  const result = { requestedDates: ['2026-11-13', '2026-11-14'], games: [], unavailableDates: ['2026-11-13', '2026-11-14'] };
  const section = buildScheduleSection(result, { now: new Date('2026-11-12T15:00:00Z'), previous: baseSection });
  assert.equal(section.Status, 'partial');
  assert.equal(section.RetrievedAtUtc, baseSection.RetrievedAtUtc);
  assert.equal(section.CheckedAtUtc, '2026-11-12T15:00:00.000Z');
  assert.equal(section.Data.Games.length, 1);
  assert.equal(buildScheduleSection({ ...result, requestedDates: ['2026-11-14'] }, { previous: baseSection }).Data, null);
});
test('verified zero is distinct from unavailable and is allowed only with complete coverage', () => {
  const section = buildScheduleSection({ requestedDates: ['2026-11-13'], games: [], unavailableDates: [] });
  assert.equal(section.Status, 'ok');
  assert.deepEqual(section.Data.Games, []);
});
test('file update changes only Schedule; probe leaves the complete file untouched', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'raybookdown-nba-'));
  const file = path.join(directory, 'dashboard.json');
  try {
    const dashboard = { SchemaVersion: 2, League: 'Funny League 2026-27', Team: 'RayBookDown', Platform: 'yahoo', Season: 2026, GeneratedAtUtc: '2026-11-12T14:00:00Z', Sections: { Schedule: baseSection, Roster: { marker: 'preserve this section exactly' } } };
    const original = JSON.stringify(dashboard);
    await fs.writeFile(file, original);
    const fetchText = async () => { throw new Error('unavailable'); };
    const now = new Date('2026-11-13T00:00:00Z');
    await updateDashboard(file, { now, probe: true, fetchText });
    assert.equal(await fs.readFile(file, 'utf8'), original);
    await updateDashboard(file, { now, fetchText });
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(result.Sections.Roster, dashboard.Sections.Roster);
    assert.equal(result.GeneratedAtUtc, dashboard.GeneratedAtUtc);
    assert.equal(result.Sections.Schedule.RetrievedAtUtc, baseSection.RetrievedAtUtc);
    assert.equal(taipeiDate(new Date('2026-11-12T16:00:00Z')), '2026-11-13');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
