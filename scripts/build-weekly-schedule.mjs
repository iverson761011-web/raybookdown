import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { addDays, collectSchedule, taipeiDate } from './update-nba-schedule.mjs';

export const TEAM_CATALOG_SOURCE = 'https://www.nba.com/teams';
export const TEAM_CATALOG = Object.freeze([
  ['ATL','Atlanta Hawks'],['BOS','Boston Celtics'],['BKN','Brooklyn Nets'],['CHA','Charlotte Hornets'],
  ['CHI','Chicago Bulls'],['CLE','Cleveland Cavaliers'],['DAL','Dallas Mavericks'],['DEN','Denver Nuggets'],
  ['DET','Detroit Pistons'],['GSW','Golden State Warriors'],['HOU','Houston Rockets'],['IND','Indiana Pacers'],
  ['LAC','LA Clippers'],['LAL','Los Angeles Lakers'],['MEM','Memphis Grizzlies'],['MIA','Miami Heat'],
  ['MIL','Milwaukee Bucks'],['MIN','Minnesota Timberwolves'],['NOP','New Orleans Pelicans'],['NYK','New York Knicks'],
  ['OKC','Oklahoma City Thunder'],['ORL','Orlando Magic'],['PHI','Philadelphia 76ers'],['PHX','Phoenix Suns'],
  ['POR','Portland Trail Blazers'],['SAC','Sacramento Kings'],['SAS','San Antonio Spurs'],['TOR','Toronto Raptors'],
  ['UTA','Utah Jazz'],['WAS','Washington Wizards'],
].map(([TeamCode,Team])=>Object.freeze({TeamCode,Team})));

// Explicit compatibility mappings, not substring/city guesses.
export const TEAM_CODE_ALIASES = Object.freeze({
  ...Object.fromEntries(TEAM_CATALOG.map(t=>[t.TeamCode,t.TeamCode])),
  GS:'GSW',NO:'NOP',NY:'NYK',SA:'SAS',UTAH:'UTA',WSH:'WAS',PHO:'PHX',BRK:'BKN',
});
const teamByCode = new Map(TEAM_CATALOG.map(t=>[t.TeamCode,t]));
const normalized = v=>typeof v==='string'?v.trim().replace(/\s+/g,' ').toUpperCase():'';
const teamByName = new Map(TEAM_CATALOG.map(t=>[normalized(t.Team),t]));
teamByName.set('LOS ANGELES CLIPPERS',teamByCode.get('LAC'));
teamByName.set('LA LAKERS',teamByCode.get('LAL'));
// NBA GameCard's current public feed can omit teamCity and send only these exact nicknames.
for(const [code,nickname] of Object.entries({ATL:'Hawks',BOS:'Celtics',BKN:'Nets',CHA:'Hornets',CHI:'Bulls',CLE:'Cavaliers',DAL:'Mavericks',DEN:'Nuggets',DET:'Pistons',GSW:'Warriors',HOU:'Rockets',IND:'Pacers',LAC:'Clippers',LAL:'Lakers',MEM:'Grizzlies',MIA:'Heat',MIL:'Bucks',MIN:'Timberwolves',NOP:'Pelicans',NYK:'Knicks',OKC:'Thunder',ORL:'Magic',PHI:'76ers',PHX:'Suns',POR:'Trail Blazers',SAC:'Kings',SAS:'Spurs',TOR:'Raptors',UTA:'Jazz',WAS:'Wizards'}))teamByName.set(normalized(nickname),teamByCode.get(code));
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const START=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?\+08:00$/;
const DAY=86400000;
function problem(code){throw Object.assign(new Error(code),{safeCode:code});}
function date(value){if(typeof value!=='string'||!DATE.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)problem('InvalidWeekDate');return value;}
function safeOfficialUrl(value){let u;try{u=new URL(value);}catch{problem('InvalidOfficialSource');}if(u.protocol!=='https:'||!(u.hostname==='nba.com'||u.hostname.endsWith('.nba.com'))||u.username||u.password||u.hash||u.port&&u.port!=='443')problem('InvalidOfficialSource');if(u.search&&!(u.pathname==='/games'&&Array.from(u.searchParams.keys()).length===1&&DATE.test(u.searchParams.get('date')??'')))problem('InvalidOfficialSource');return u.href;}
export function resolveTeam(value){const key=normalized(value);return teamByCode.get(TEAM_CODE_ALIASES[key])??teamByName.get(key)??null;}
export function taipeiCalendarWeek(now=new Date()){
  if(!Number.isFinite(+now))problem('InvalidWeekDate');
  const today=taipeiDate(now),day=new Date(today+'T00:00:00Z').getUTCDay();
  const start=addDays(today,-((day+6)%7));
  return {start,end:addDays(start,6),startUtc:new Date(Date.parse(start+'T00:00:00Z')-8*3600000).toISOString(),endExclusiveUtc:new Date(Date.parse(addDays(start,7)+'T00:00:00Z')-8*3600000).toISOString()};
}
function localMidnightUtc(value,timeZone){
  const [year,month,day]=date(value).split('-').map(Number),wanted=Date.UTC(year,month-1,day);
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let guess=wanted;
  for(let i=0;i<5;i++){
    const p=Object.fromEntries(formatter.formatToParts(new Date(guess)).map(x=>[x.type,x.value]));
    const displayed=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second),delta=wanted-displayed;
    if(delta===0)return new Date(guess).toISOString();
    guess+=delta;
  }
  problem('UnknownWeekBoundary');
}
function verifiedBounds(dashboard,explicit){
  if(explicit)return explicit;
  const section=dashboard?.Sections?.Matchup,match=section?.Data;
  // These additive fields must come from documented provider metadata. Dates alone do not establish a timezone.
  if(section?.Status!=='ok'||!match||typeof match.WeekTimeZone!=='string'||match.WeekBoundsVerified!==true)return null;
  return {Verified:true,StartDate:match.WeekStartDate,EndDateInclusive:match.WeekEndDate,TimeZone:match.WeekTimeZone,SourceUrl:match.WeekBoundsSourceUrl??null};
}
export function determineWeekPeriod(dashboard,{now=new Date(),yahooBounds=null}={}){
  const current=dashboard?.Sections?.Rules?.Data?.CurrentWeek;
  const week=Number.isInteger(current)&&current>0&&current<=100?current:null;
  const fallback=taipeiCalendarWeek(now),bounds=verifiedBounds(dashboard,yahooBounds);
  if(bounds?.Verified===true){
    try{
      const start=date(bounds.StartDate),end=date(bounds.EndDateInclusive),zone=bounds.TimeZone;
      if(typeof zone!=='string'||!(zone==='UTC'||/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(zone)))problem('UnknownWeekBoundary');
      const days=(Date.parse(end)-Date.parse(start))/DAY+1;
      if(!Number.isInteger(days)||days<1||days>14)problem('UnknownWeekBoundary');
      const startUtc=localMidnightUtc(start,zone),endExclusiveUtc=localMidnightUtc(addDays(end,1),zone);
      if(+now<Date.parse(startUtc)||+now>=Date.parse(endExclusiveUtc))problem('UnknownWeekBoundary');
      return {PeriodBasis:'yahoo_verified',PeriodLabel:'已驗證的 Yahoo 對戰週',YahooWeekBoundsKnown:true,YahooWeek:week,YahooWeekTimeZone:zone,RangeStartDateTaipei:taipeiDate(new Date(startUtc)),RangeEndDateTaipei:taipeiDate(new Date(Date.parse(endExclusiveUtc)-1)),PeriodStartAtUtc:startUtc,PeriodEndExclusiveAtUtc:endExclusiveUtc};
    }catch{}
  }
  return {PeriodBasis:'taipei_calendar',PeriodLabel:'台灣日曆週（週一至週日；Yahoo 對戰週起訖未知）',YahooWeekBoundsKnown:false,YahooWeek:week,YahooWeekTimeZone:null,RangeStartDateTaipei:fallback.start,RangeEndDateTaipei:fallback.end,PeriodStartAtUtc:fallback.startUtc,PeriodEndExclusiveAtUtc:fallback.endExclusiveUtc};
}
export function aggregateTeamWeek(result,{period,now=new Date(),sourceUrls=[]}={}){
  if(!period||!Number.isFinite(+now))problem('InvalidWeekDate');
  const start=date(period.RangeStartDateTaipei),end=date(period.RangeEndDateTaipei);
  const expectedDates=Array.from({length:(Date.parse(end)-Date.parse(start))/DAY+1},(_,i)=>addDays(start,i));
  if(expectedDates.length<1||expectedDates.length>15)problem('InvalidWeekDate');
  const unavailable=new Set((Array.isArray(result?.unavailableDates)?result.unavailableDates:expectedDates).filter(d=>expectedDates.includes(d)));
  if(!Array.isArray(result?.requestedDates)||expectedDates.some(d=>!result.requestedDates.includes(d)))for(const d of expectedDates)if(!result?.requestedDates?.includes(d))unavailable.add(d);
  const teams=TEAM_CATALOG.map(t=>({...t,TotalGames:null,RemainingGames:null,DatesTaipei:[],RemainingDatesTaipei:[],VerifiedGames:[]}));
  const byCode=new Map(teams.map(t=>[t.TeamCode,t])),unknown=new Set(),seen=new Set(),urls=new Set([TEAM_CATALOG_SOURCE]);
  for(const source of sourceUrls){try{urls.add(safeOfficialUrl(source));}catch{}}
  let invalidGames=0;
  const games=Array.isArray(result?.games)?result.games:[];
  for(const game of games){
    try{
      if(!game||typeof game.StartAtTaipei!=='string'||!START.test(game.StartAtTaipei)||!Number.isFinite(Date.parse(game.StartAtTaipei))||new Date(Date.parse(game.StartAtTaipei)+8*3600000).toISOString().slice(0,19)!==game.StartAtTaipei.slice(0,19))problem('InvalidOfficialGame');
      const instant=Date.parse(game.StartAtTaipei);
      if(instant<Date.parse(period.PeriodStartAtUtc)||instant>=Date.parse(period.PeriodEndExclusiveAtUtc))continue;
      if(!Array.isArray(game.Teams)||game.Teams.length!==2)problem('InvalidOfficialGame');
      const pair=game.Teams.map(resolveTeam);
      for(let i=0;i<2;i++)if(!pair[i]){const raw=game.Teams[i];unknown.add(typeof raw==='string'&&raw.length<=160?raw:'未知球隊');}
      if(pair.some(t=>!t)||pair[0].TeamCode===pair[1].TeamCode){invalidGames++;continue;}
      const url=safeOfficialUrl(game.SourceUrl),key=instant+'|'+pair.map(t=>t.TeamCode).sort().join('|');
      if(seen.has(key))continue;
      seen.add(key);urls.add(url);
      for(let side=0;side<2;side++)byCode.get(pair[side].TeamCode).VerifiedGames.push({StartAtTaipei:game.StartAtTaipei,OpponentCode:pair[1-side].TeamCode,Opponent:pair[1-side].Team,SourceUrl:url});
    }catch{invalidGames++;}
  }
  const coverage=unavailable.size===0&&unknown.size===0&&invalidGames===0;
  for(const team of teams){
    team.VerifiedGames.sort((a,b)=>a.StartAtTaipei.localeCompare(b.StartAtTaipei));
    const remaining=team.VerifiedGames.filter(g=>Date.parse(g.StartAtTaipei)>+now);
    team.DatesTaipei=[...new Set(team.VerifiedGames.map(g=>g.StartAtTaipei.slice(0,10)))];
    team.RemainingDatesTaipei=[...new Set(remaining.map(g=>g.StartAtTaipei.slice(0,10)))];
    if(coverage){team.TotalGames=team.VerifiedGames.length;team.RemainingGames=remaining.length;}
  }
  const any=teams.some(t=>t.VerifiedGames.length),status=coverage?'ok':any?'partial':'unavailable';
  return {SchemaVersion:1,Status:status,Source:'NBA official schedule',CheckedAtUtc:now.toISOString(),RetrievedAtUtc:status==='unavailable'?null:now.toISOString(),SourceUpdatedAtUtc:null,ErrorType:coverage?null:status==='partial'?'WeekScheduleCoverageIncomplete':'OfficialWeekScheduleUnavailable',...period,TimeZone:'Asia/Taipei',CoverageVerified:coverage,UnavailableDates:[...unavailable].sort(),UnknownTeams:[...unknown].sort(),TeamCatalogSourceUrl:TEAM_CATALOG_SOURCE,TeamCodeAliases:{...TEAM_CODE_ALIASES},SourceUrls:[...urls].sort(),Teams:teams};
}
export async function buildWeeklySchedule(dashboardPath,{now=new Date(),collect=collectSchedule,yahooBounds=null}={}){
  const bytes=await fs.readFile(dashboardPath);if(bytes.length>1048576)problem('InvalidDashboard');
  let dashboard;try{dashboard=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{problem('InvalidDashboard');}
  if(dashboard?.SchemaVersion!==2||dashboard.League!=='Funny League 2026-27'||dashboard.Team!=='RayBookDown'||dashboard.Platform!=='yahoo'||!Number.isInteger(dashboard.Season)||!dashboard.Sections)problem('InvalidDashboard');
  const period=determineWeekPeriod(dashboard,{now,yahooBounds});
  const days=(Date.parse(period.RangeEndDateTaipei)-Date.parse(period.RangeStartDateTaipei))/DAY+1,sources=[];
  let result;
  try{result=await collect({startDate:period.RangeStartDateTaipei,days,seasonYear:dashboard.Season,onDiagnostic:event=>{if(event?.Phase==='parse'&&event.ErrorType===null&&typeof event.Url==='string')sources.push(event.Url);}});}
  catch{result={requestedDates:Array.from({length:days},(_,i)=>addDays(period.RangeStartDateTaipei,i)),games:[],unavailableDates:Array.from({length:days},(_,i)=>addDays(period.RangeStartDateTaipei,i))};}
  const document=aggregateTeamWeek(result,{period,now,sourceUrls:sources});
  const output=path.join(path.dirname(path.resolve(dashboardPath)),'team-week-schedule.json');
  const temporary=output+'.'+crypto.randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(document,null,2)+'\n',{flag:'wx'});await fs.rename(temporary,output);}finally{await fs.rm(temporary,{force:true});}
  return {WeeklyScheduleUpdated:true,Status:document.Status,PeriodBasis:document.PeriodBasis,Teams:document.Teams.length,CoverageVerified:document.CoverageVerified,UnknownDates:document.UnavailableDates.length,ErrorType:document.ErrorType};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await buildWeeklySchedule(path.resolve(process.argv[2]??'data/dashboard.json'))));}
  catch(error){const safe=new Set(['InvalidDashboard','InvalidWeekDate']);console.error(JSON.stringify({WeeklyScheduleUpdated:false,ErrorType:safe.has(error.safeCode)?error.safeCode:'WeeklyScheduleBuildFailed'}));process.exitCode=1;}
}
