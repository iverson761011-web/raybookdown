import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence, fetchOfficialEvidence, latestInjuryReportLink, normalizePlayerName, parseBoxScore, parseDailyScoreboard, parseMinutes, parsePlayerStatistics, sanitizeCachedDay, scopePlayerGames, validateInjuryResult } from './collect-recommendation-evidence.mjs';
import { TARGET,SECTION_NAMES } from '../dashboard-model.mjs';

const date='2026-11-11',start='2026-11-12T00:00:00Z';
const wrap=(props,query={date})=>`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({query,props:{pageProps:props}})}</script></html>`;
const team=(name,score)=>({teamName:name,teamCity:'City',teamTricode:name.slice(0,3).toUpperCase(),score});
const game=(overrides={})=>({gameId:'0022600218',gameTimeUtc:start,gameStatus:3,gameStatusText:'Final',awayTeam:team('Away',102),homeTeam:team('Home',103),...overrides});
const daily=(games)=>wrap({gameCardFeed:{modules:[{cards:games.map(cardData=>({cardData}))}]}});
const expected=()=>parseDailyScoreboard(daily([game()]),date).Games[0];
const statistic={minutes:'PT30M30S',fieldGoalsMade:7,fieldGoalsAttempted:15,freeThrowsMade:2,freeThrowsAttempted:2,threePointersMade:2,points:18,reboundsOffensive:1,reboundsDefensive:3,reboundsTotal:4,assists:10,steals:1,blocks:0,turnovers:2};
const player=(overrides={})=>({personId:123,name:'Alperen Şengün',played:'1',statistics:statistic,...overrides});
const box=(players=[player()])=>wrap({game:{...game(),awayTeam:{...team('Away',102),players},homeTeam:{...team('Home',103),players:[player({personId:124,name:'Other Player'})]}}});
const fixedNow=()=>new Date('2026-11-12T17:00:00Z');
const injuryIndex='<h1>NBA Injury Report 2026-27 Season</h1><a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-12_11_30AM.pdf">PDF</a>';
const rawInjuries={Status:'partial',ReportIssuedAtUtc:'2026-11-12T16:30:00Z',UnsubmittedTeams:['Home Team'],TeamReports:[{TeamName:'Home Team',GameDateET:'2026-11-12',Submitted:false}],Players:[{Player:'Morez Johnson Jr.',TeamName:'Dallas Mavericks',GameDateET:'2026-11-12',Status:'Probable',Reason:'Injury/Illness - Left Shin; Contusion'}]};
const dashboardFixture=(rosterNames,marketNames=[])=>{
 const blank={Status:'unavailable',Source:'Fixture',CheckedAtUtc:fixedNow().toISOString(),RetrievedAtUtc:null,SourceUpdatedAtUtc:null,ErrorType:null,Data:null};
 const Sections=Object.fromEntries(SECTION_NAMES.map(name=>[name,{...blank}]));
 Sections.Roster={...blank,Status:'ok',RetrievedAtUtc:fixedNow().toISOString(),Data:{PlayerCount:rosterNames.length,Players:rosterNames.map(Player=>({Player,Position:null,Status:null,EligiblePositions:null,TeamCode:null}))}};
 Sections.Market={...blank,Status:'ok',RetrievedAtUtc:fixedNow().toISOString(),Data:{Coverage:'returned_list',RateScope:'yahoo_platform_global',Players:marketNames.map(Player=>({Player,Position:null,TeamCode:null,Availability:'free_agent',PercentOwned:null,WaiverDate:null}))}};
 return {SchemaVersion:2,...TARGET,GeneratedAtUtc:fixedNow().toISOString(),Sections};
};

test('a whole day is final only when every listed game and its scores are verified',()=>{
 assert.equal(parseDailyScoreboard(daily([game()]),date).Status,'final');
 assert.equal(parseDailyScoreboard(daily([game(),game({gameId:'0022600219',gameStatus:2,gameStatusText:'4th Qtr'})]),date).Status,'waiting');
 assert.equal(parseDailyScoreboard(daily([game({gameStatus:1,gameStatusText:'Postponed'})]),date).Status,'unknown');
 assert.equal(parseDailyScoreboard(daily([game({awayTeam:team('Away',null)})]),date).Status,'waiting');
 assert.equal(parseDailyScoreboard(daily([game({awayTeam:team('Away',0)})]),date).Status,'final');
 assert.equal(parseDailyScoreboard(daily([]),date).Status,'unknown');
 assert.equal(parseDailyScoreboard(wrap({gameCount:0,gameCardFeed:{modules:[]}}),date).Status,'no_games');
 assert.throws(()=>parseDailyScoreboard(daily([game()]),'2026-11-10'),/OfficialDateMismatch/);
 assert.equal(parseDailyScoreboard(daily([game({gameTimeUtc:'2026-11-14T00:00:00Z'})]),date).CoverageVerified,false);
 assert.equal(parseDailyScoreboard(daily([game(),game()]),date).Status,'unknown');
});

test('DNP, unknown minutes and missing attempts never become poor zero performances',()=>{
 const rows=parseBoxScore(box([player({played:'0'}),player({personId:125,name:'Unknown Minutes',played:undefined,statistics:{points:0}})]),expected());
 assert.equal(rows[0].Played,false);assert.equal(rows[0].Stats,null);
 assert.equal(rows[1].Played,null);assert.equal(rows[1].Stats.MIN,null);assert.equal(rows[1].Stats.FGA,null);
 assert.equal(parsePlayerStatistics({fieldGoalsMade:5,fieldGoalsAttempted:2}).FGM,null);
 assert.equal(parsePlayerStatistics({points:20,reboundsTotal:11}).DD,1);
 assert.equal(parsePlayerStatistics({points:9,reboundsTotal:9}).DD,null);
 assert.equal(parseMinutes('PT1H2M30S'),62.5);assert.equal(parseMinutes('30:30'),30.5);assert.equal(parseMinutes('30:70'),null);
 assert.throws(()=>parseBoxScore(box([player(),player()]),expected()),/OfficialPlayerIdentityAmbiguous/);
});

test('normalizing a name preserves full identity and does not guess nicknames',()=>{
 assert.equal(normalizePlayerName('Alperen Şengün'),normalizePlayerName('Alperen Sengun'));
 assert.equal(normalizePlayerName('Morez Johnson Jr.'),'morez johnson jr');
 assert.notEqual(normalizePlayerName('J. Johnson'),normalizePlayerName('Jalen Johnson'));
});

test('injury filename and parsed report timestamp must agree; unavailable teams are explicit',()=>{
 const report=latestInjuryReportLink(injuryIndex,2026);
 assert.equal(report.ReportTimeET,'11:30');assert.equal(report.ReportIssuedAtUtc,null);
 const parsed=validateInjuryResult(rawInjuries,report,fixedNow().toISOString());
 assert.equal(parsed.Status,'partial');assert.deepEqual(parsed.UnsubmittedTeams,['Home Team']);
 assert.throws(()=>validateInjuryResult({...rawInjuries,ReportIssuedAtUtc:'2026-11-12T17:30:00Z'},report,fixedNow().toISOString()),/InjuryReportDateMismatch/);
 assert.throws(()=>latestInjuryReportLink(injuryIndex,2025),/OfficialSeasonMismatch/);
 const extra=injuryIndex.replace('</h1>','</h1><a href="https://attacker.example/Injury-Report_2026-11-12_12_00PM.pdf">bad</a>');
 assert.equal(latestInjuryReportLink(extra,2026).SourceUrl,report.SourceUrl);
});

test('the HTTP reader rejects nonofficial redirects and oversized bodies before parsing',async()=>{
 await assert.rejects(()=>fetchOfficialEvidence('https://www.nba.com/games',{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://attacker.example'}})}),/UntrustedOfficialUrl/);
 await assert.rejects(()=>fetchOfficialEvidence('https://www.nba.com/games',{fetchImpl:async()=>new Response('bad',{status:200,headers:{'content-length':'999999999'}})}),/OfficialResponseTooLarge/);
 await assert.rejects(()=>fetchOfficialEvidence('https://user:secret@www.nba.com/games'),/UntrustedOfficialUrl/);
 assert.equal((await fetchOfficialEvidence('https://www.nba.com/games',{fetchImpl:async(_url,options)=>{assert.equal(options.credentials,'omit');return new Response('public');}})).toString(),'public');
});

test('retained history is real only, no fabricated stats and explicit source failures',async()=>{
 let requested=[];
 const fetchBytes=async url=>{
  requested.push(url);
  if(url.includes('/games?date=2026-11-11'))return Buffer.from(daily([game()]));
  if(url.includes('/games?date=2026-11-10'))throw new Error('raw secret-like upstream detail is never copied');
  if(url.includes('/box-score'))return Buffer.from(box());
  if(url.includes('official.nba.com'))return Buffer.from(injuryIndex);
  if(url.endsWith('.pdf'))return Buffer.from('%PDF-test');
  throw new Error('Unexpected test URL');
 };
 const result=await collectEvidence({date,historyDays:2,fetchBytes,parsePdf:async()=>rawInjuries,now:fixedNow});
 assert.equal(result.evidence.Day.Status,'final');assert.equal(result.evidence.PlayerGames.length,2);
 assert.deepEqual(result.evidence.History.VerifiedDates,[date]);assert.deepEqual(result.evidence.History.UnavailableDates,['2026-11-09','2026-11-10']);
 assert.equal(result.history.Days.length,1);assert.equal(result.evidence.Injuries.Status,'partial');
 assert.equal(result.evidence.Warnings[0].ErrorType,'OfficialSourceUnavailable');
 assert.ok(!JSON.stringify(result).includes('secret-like'));
 assert.ok(sanitizeCachedDay(result.history.Days[0],date));
 assert.equal(sanitizeCachedDay({...result.history.Days[0],PlayerGames:[{...result.history.Days[0].PlayerGames[0],SourceUrl:'https://bad.example'}]},date),null);
 requested=[];
 const again=await collectEvidence({date:'2026-11-12',historyDays:2,history:result.history,fetchBytes,parsePdf:async()=>rawInjuries,now:fixedNow});
 assert.ok(!requested.some(url=>url.includes('date=2026-11-11')||url.includes('/box-score')));
 assert.equal(again.evidence.Day.Status,'unknown');assert.equal(again.evidence.PlayerGames.length,2);
 assert.equal(again.evidence.PlayerGames[0].RetrievedAtUtc,fixedNow().toISOString());
 assert.equal(again.evidence.LastCompletedDay.DateET,date);
 assert.equal(again.evidence.LastCompletedDay.Day.RetrievedAtUtc,fixedNow().toISOString());
});

test('a failed injury parser cannot erase unknown status by treating names as healthy',async()=>{
 const result=await collectEvidence({date,historyDays:1,now:fixedNow,fetchBytes:async url=>Buffer.from(url.includes('/games?')?daily([game({gameStatus:1,gameStatusText:'7:00 pm ET'})]):url.includes('official.nba.com')?injuryIndex:'%PDF-test'),parsePdf:async()=>{throw new Error('failure');}});
 assert.equal(result.evidence.Day.Status,'waiting');assert.equal(result.evidence.PlayerGames.length,0);
 assert.equal(result.evidence.Injuries.Status,'unknown');assert.deepEqual(result.evidence.Injuries.Players,[]);
});

test('incomplete player statistics are retained with nulls and retried on the next collection',async()=>{
 let complete=false,boxReads=0;
 const fetchBytes=async url=>{
  if(url.includes('/games?date=2026-11-10'))return Buffer.from(wrap({gameCount:0,gameCardFeed:{modules:[]}},{date:'2026-11-10'}));
  if(url.includes('/games?'))return Buffer.from(daily([game()]));
  if(url.includes('/box-score')){boxReads++;return Buffer.from(box([player({statistics:complete?statistic:{points:18,minutes:'PT30M'}})]));}
  throw new Error('injury not available in this fixture');
 };
 const first=await collectEvidence({date,historyDays:1,fetchBytes,now:fixedNow});
 assert.equal(first.evidence.PlayerGames[0].Stats.FGA,null);
 assert.deepEqual(first.evidence.History.MissingBoxScoreDates,[date]);
 assert.equal(first.history.Days.find(day=>day.DateET===date).BoxScoresComplete,false);
 complete=true;
 const second=await collectEvidence({date,historyDays:1,fetchBytes,now:fixedNow,history:first.history});
 assert.equal(boxReads,2);assert.equal(second.evidence.PlayerGames[0].Stats.FGA,15);
 assert.deepEqual(second.evidence.History.MissingBoxScoreDates,[]);
});

test('the compact feed uses observed full names and rejects ambiguous official identities',()=>{
 const dashboard=dashboardFixture(['Alperen Şengün','Missing Player'],['Other Player','Unknown Player','G. Player']);
 const rows=[
  {Player:'Alperen Sengun',OfficialPlayerId:'123'},
  {Player:'Alperen Şengün',OfficialPlayerId:'456'},
  {Player:'Other Player',OfficialPlayerId:'124'},
  {Player:'Unknown Player',OfficialPlayerId:null},
  {Player:'Gary Player',OfficialPlayerId:'789'},
  {Player:'Unrelated NBA Player',OfficialPlayerId:'987'},
 ];
 const scoped=scopePlayerGames(dashboard,rows);
 assert.deepEqual(scoped.PlayerGames,[rows[2]]);
 assert.deepEqual(scoped.PlayerScope.AmbiguousPlayers,['Alperen Şengün']);
 assert.deepEqual(scoped.PlayerScope.IdentityUnknownPlayers,['Unknown Player']);
 assert.deepEqual(scoped.PlayerScope.MissingPlayers,['Missing Player','G. Player']);
 const bad=structuredClone(dashboard);bad.access_token='synthetic-only';
 assert.throws(()=>scopePlayerGames(bad,rows));
});

test('filtering evidence does not make a partial boxscore cache appear complete',async()=>{
 const dashboard=dashboardFixture(['Alperen Şengün']);
 const result=await collectEvidence({date,historyDays:1,dashboard,now:fixedNow,fetchBytes:async url=>{
  if(url.includes('/games?'))return Buffer.from(daily([game()]));
  if(url.includes('/box-score'))return Buffer.from(box());
  throw new Error('injury source unavailable for this fixture');
 }});
 assert.equal(result.evidence.PlayerGames.length,1);
 assert.equal(result.evidence.PlayerScope.PlayerCount,1);
 assert.equal(result.history.Days[0].PlayerGames.length,2);
 assert.equal(result.history.Days[0].BoxScoresComplete,true);
 assert.equal(sanitizeCachedDay(result.history.Days[0],date).BoxScoresComplete,true);
});

test('actual NBA SSR first/family names and explicit DNP comments are handled without guessing',()=>{
 const rows=parseBoxScore(box([
  player({name:undefined,firstName:'Jared',familyName:'McCain',played:undefined,comment:'DNP - Injury/Illness',statistics:{...statistic,minutes:'PT0M0S',points:0}}),
  player({personId:125,name:'Unknown Participation',played:undefined,comment:'',statistics:{...statistic,minutes:'PT0M0S',points:0}}),
  player({personId:126,name:'Actually Played',played:undefined,comment:'Injury/Illness - Left Wrist',statistics:statistic}),
 ]),expected());
 assert.equal(rows[0].Player,'Jared McCain');assert.equal(rows[0].Played,false);assert.equal(rows[0].Stats,null);
 assert.equal(rows[1].Played,null);assert.equal(rows[2].Played,true);assert.equal(rows[2].Stats.PTS,18);
});
