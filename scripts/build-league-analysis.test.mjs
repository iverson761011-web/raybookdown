import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateLeagueAnalysis,buildLeagueAnalysis} from './build-league-analysis.mjs';
import {normalizeDashboard} from '../dashboard-model.mjs';
import {normalizeLeagueAnalysis} from '../features-model.mjs';
import {addDays} from './update-nba-schedule.mjs';
import {TEAM_CATALOG,TEAM_CODE_ALIASES} from './build-weekly-schedule.mjs';

const base=JSON.parse(await fs.readFile(new URL('../tests/fixtures/dashboard.json',import.meta.url),'utf8'));
const now=new Date('2026-11-13T17:00:00Z'),stamp=now.toISOString(),target='2026-11-12';
const key=i=>'team-'+String(i).padStart(64,'0');
const section=Data=>({Status:'ok',Source:'Flaim Fantasy / Yahoo',CheckedAtUtc:stamp,RetrievedAtUtc:stamp,SourceUpdatedAtUtc:null,ErrorType:null,Data});
const player=(i)=>({Player:'Player '+i,Position:'PG',Status:null,EligiblePositions:['PG','G','Util'],TeamCode:'BOS',IsUndroppable:false});
const stats=f=>({MIN:30,FGM:5*f,FGA:10*f,FTM:4*f,FTA:5*f,'3PTM':2*f,PTS:20*f,OREB:2*f,DREB:4*f,REB:6*f,AST:5*f,ST:f,BLK:f,TO:2*f,DD:0});
function categories(i){return [
  {Name:'PTS',Label:'PTS',OwnValue:String(i*10),OpponentValue:'55',Result:'loss',DisplayOnly:false},
  {Name:'TO',Label:'TO',OwnValue:String(i+2),OpponentValue:'8',Result:'win',DisplayOnly:false},
  {Name:'FG%',Label:'FG%',OwnValue:(.3+i*.1).toFixed(3),OpponentValue:'.550',Result:i>2?'win':'loss',DisplayOnly:false},
  {Name:'FGM/A',Label:'FGM/A',OwnValue:String(15+i*5)+'/50',OpponentValue:'22/40',Result:null,DisplayOnly:true},
  {Name:'FT%',Label:'FT%',OwnValue:'.800',OpponentValue:'.850',Result:'loss',DisplayOnly:false},
  {Name:'FTM/A',Label:'FTM/A',OwnValue:'8/10',OpponentValue:'17/20',Result:null,DisplayOnly:true},
];}
function fixture(){
 const rules=structuredClone(base.Sections.Rules.Data);rules.TeamCount=4;rules.CurrentWeek=4;
 const market={Coverage:'returned_list',RateScope:'yahoo_platform_global',Players:[{Player:'Market Player',Position:'SG',TeamCode:'GSW',Availability:'free_agent',PercentOwned:null,WaiverDate:null}]};
 const league={SchemaVersion:1,League:base.League,Platform:'yahoo',Season:2026,Status:'ok',CheckedAtUtc:stamp,RetrievedAtUtc:stamp,SourceUpdatedAtUtc:null,TeamCount:4,CurrentWeek:4,Rules:section(rules),Market:section(market),Teams:Array.from({length:4},(_,n)=>{const i=n+1;return{SelectionKey:key(i),Team:i===1?'RayBookDown':'Team '+i,IsUserTeam:i===1,Status:'ok',Roster:section({PlayerCount:1,Players:[player(i)]}),Matchup:section({Week:4,WeekStartDate:null,WeekEndDate:null,Status:'in_progress',Opponent:'Opponent '+i,OwnScore:null,OpponentScore:null,OwnGamesRemaining:null,OpponentGamesRemaining:null,Categories:categories(i)}),Budget:section({FaabBalance:i*10,WaiverPriority:i,MaxWeeklyAdds:6,AddsUsedThisWeek:null,AddsRemainingThisWeek:null})};})};
 const dates=Array.from({length:28},(_,i)=>addDays(target,-i));
 const days=dates.map((date,index)=>{
  const play=index%7===0||index%7===2||index%7===4;
  const games=[],rows=[];
  if(play)for(const [code,other,idOffset]of[['BOS','NYK',0],['GSW','LAL',1]]){
   const GameId='00226'+String(index*2+idOffset+1).padStart(5,'0'),SourceUrl='https://www.nba.com/game/'+GameId+'/box-score';
   games.push({GameId,DateET:date,StartAtUtc:date+'T20:00:00.000Z',Status:'final',Teams:[{Name:code==='BOS'?'Boston Celtics':'Golden State Warriors',City:null,Code:code,Score:100},{Name:other==='NYK'?'New York Knicks':'Los Angeles Lakers',City:null,Code:other,Score:90}],SourceUrl,RetrievedAtUtc:stamp});
   const group=code==='BOS'?[1,2,3,4]:[50];
   for(const i of group)rows.push({Player:i===50?'Market Player':'Player '+i,OfficialPlayerId:String(i),GameId,TeamCode:code,DateET:date,SourceUrl,Played:true,Stats:stats(i===50?4:1),RetrievedAtUtc:stamp});
  }
  return {DateET:date,RetrievedAtUtc:stamp,Day:{Status:play?'final':'no_games',CoverageVerified:true,Games:games},PlayerGames:rows,BoxScoresComplete:true};
 });
 const history={SchemaVersion:1,GeneratedAtUtc:stamp,Days:days};
 const evidence={SchemaVersion:1,GeneratedAtUtc:stamp,TargetNbaDateET:target,Day:{...days[0].Day,RetrievedAtUtc:stamp},PlayerGames:days.flatMap(d=>d.PlayerGames).filter(r=>['Player 1','Market Player'].includes(r.Player)),History:{VerifiedDates:dates,UnavailableDates:[],MissingBoxScoreDates:[],Games:days.flatMap(d=>d.Day.Games)},Injuries:{Status:'available',RetrievedAtUtc:stamp,ReportIssuedAtUtc:'2026-11-13T16:00:00Z',SourceUrl:'https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-13_11_00AM.pdf',TeamReports:[{TeamName:'Boston Celtics',GameDateET:'2026-11-13',Submitted:true},{TeamName:'Golden State Warriors',GameDateET:'2026-11-13',Submitted:true}],UnsubmittedTeams:[],Players:[]}};
 const week={PeriodBasis:'taipei_calendar',YahooWeekBoundsKnown:false,RangeStartDateTaipei:'2026-11-09',RangeEndDateTaipei:'2026-11-15',CoverageVerified:true,CheckedAtUtc:stamp,RetrievedAtUtc:stamp,SourceUpdatedAtUtc:null,TeamCatalogSourceUrl:'https://www.nba.com/teams',TeamCodeAliases:{...TEAM_CODE_ALIASES},Teams:TEAM_CATALOG.map(t=>({...t,RemainingGames:t.TeamCode==='GSW'?3:2}))};
 return{league,evidence,history,week,now};
}
const run=options=>generateLeagueAnalysis(options??fixture());
function currentDashboard(f){const d=structuredClone(base);d.GeneratedAtUtc=stamp;for(const s of Object.values(d.Sections)){s.CheckedAtUtc=stamp;if(s.RetrievedAtUtc)s.RetrievedAtUtc=stamp;}return d;}

test('every selected team keeps its real name, roster, budget and source times without borrowing RayBookDown data',()=>{
 const report=run();normalizeLeagueAnalysis(report);assert.equal(report.Status,'ok');assert.equal(report.Teams.length,4);
 for(let i=1;i<=4;i++){const t=report.Teams[i-1];assert.equal(t.Team,i===1?'RayBookDown':'Team '+i);assert.equal(t.Roster.Data.Players[0].Player,'Player '+i);assert.equal(t.Budget.Data.FaabBalance,i*10);assert.equal(t.Recommendations.DropReviews[0].Player,'Player '+i);assert(t.Recommendations.DropReviews.every(r=>r.Player==='Player '+i));assert.equal(t.Sources[0].RetrievedAtUtc,stamp);}
 assert(!JSON.stringify(report).includes('OfficialPlayerId'));assert(!JSON.stringify(report).includes('GameId'));
});
test('full verified public history supplies other teams beyond the original compact evidence roster',()=>{
 const f=fixture(),report=run(f);assert.equal(f.evidence.PlayerGames.some(p=>p.Player==='Player 3'),false);const third=report.Teams[2];assert.equal(third.Recommendations.DropReviews[0].SampleGames7,3);assert.equal(third.Recommendations.DropReviews[0].SampleGames14,6);
 const missing=run({...f,history:null});assert.equal(missing.Teams[2].Recommendations.DropReviews[0].SampleGames7,null);assert(missing.Teams[2].Recommendations.Candidates.every(c=>c.DropOptions.length===0));
});
test('current-week rankings handle lower turnovers, ties and actual ratios without averaging percentages',()=>{
 const report=run(),alpha=report.Teams[0],delta=report.Teams[3];
 assert.deepEqual(alpha.Categories.find(c=>c.Label==='PTS'),{Label:'PTS',OwnValue:10,Rank:4,ComparedTeamCount:4,Assessment:'weakness',Direction:'higher',CompleteLeagueCoverage:true});
 assert.equal(alpha.Categories.find(c=>c.Label==='TO').Assessment,'strength');assert.equal(delta.Categories.find(c=>c.Label==='TO').Assessment,'weakness');
 assert.equal(alpha.Categories.find(c=>c.Label==='FG%').OwnValue,.4);assert.equal(delta.Categories.find(c=>c.Label==='FG%').Rank,1);
 assert(alpha.Categories.find(c=>c.Label==='FT%').Assessment==='balanced');assert(report.Teams.every(t=>t.Categories.find(c=>c.Label==='FT%').Rank===1));
 assert(alpha.Strengths.some(s=>s.includes('TO')));assert(alpha.Weaknesses.some(s=>s.includes('PTS')));assert(alpha.Notes.some(n=>n.includes('本週目前累計')));
});
test('recommendations explicitly connect gains or limits to the selected team relative weaknesses',()=>{
 const first=run().Teams[0];assert(first.Recommendations.Notes.some(n=>n.includes('不是Yahoo計分規則')));
 assert(first.Recommendations.Candidates[0].Reasons.some(r=>r.includes('本隊本週相對弱項')&&r.includes('PTS')));
 assert(first.Recommendations.Candidates[0].Tradeoffs.some(r=>r.includes('TO')));
});

test('selected league teams with opposite weaknesses get measured observation priorities from the same market',()=>{
 const f=fixture(),market=f.league.Market.Data.Players[0];
 f.league.Market.Data.Players=[{...market,Player:'Scorer',Availability:'waivers'},{...market,Player:'Caretaker',Availability:'waivers'}];
 for(const day of f.history.Days){const rows=day.PlayerGames.filter(r=>r.Player==='Market Player');day.PlayerGames=day.PlayerGames.filter(r=>r.Player!=='Market Player');for(const [Player,OfficialPlayerId,PTS,TO]of [['Scorer','50',30,4],['Caretaker','51',8,0]])for(const row of rows)day.PlayerGames.push({...row,Player,OfficialPlayerId,Stats:{...stats(1),PTS,TO}});}
 const report=run(f),points=report.Teams[0],turnovers=report.Teams[3];
 assert(points.Weaknesses.some(r=>r.startsWith('PTS')));assert(turnovers.Weaknesses.some(r=>r.startsWith('TO')));
 assert.deepEqual(points.Recommendations.Candidates,[]);assert.deepEqual(turnovers.Recommendations.Candidates,[]);
 assert.equal(points.Recommendations.WatchCandidates[0].Player,'Scorer');assert.equal(turnovers.Recommendations.WatchCandidates[0].Player,'Caretaker');
 assert(points.Recommendations.WatchCandidates[0].Reasons.some(r=>r.includes('RayBookDown')&&r.includes('PTS')));assert(turnovers.Recommendations.WatchCandidates[0].Reasons.some(r=>r.includes('Team 4')&&r.includes('TO')));
 const expected=report.Teams.map(t=>t.Recommendations.WatchCandidates);
 f.league.Market.Data.Players.reverse();f.history.Days.reverse();for(const day of f.history.Days)day.PlayerGames.reverse();
 assert.deepEqual(run(f).Teams.map(t=>t.Recommendations.WatchCandidates),expected);
});
test('only genuinely scored rows rank; display-only, missing results and ambiguous duplicate labels stay out',()=>{
 const f=fixture();for(const t of f.league.Teams)t.Matchup.Data.Categories.push({Name:'ABC',Label:'ABC',OwnValue:999,OpponentValue:1,Result:null,DisplayOnly:false});
 f.league.Teams[0].Matchup.Data.Categories.push({...categories(1)[0],OwnValue:'999'});
 const r=run(f);assert(!r.Teams[0].Categories.some(c=>['FGM/A','FTM/A','ABC'].includes(c.Label)));const pts=r.Teams[0].Categories.find(c=>c.Label==='PTS');assert.equal(pts.OwnValue,null);assert.equal(pts.Rank,null);assert.equal(pts.ComparedTeamCount,3);assert.equal(pts.Assessment,'unknown');
});
test('a malformed team roster is isolated; other real teams and independently valid matchup totals still work',()=>{
 const f=fixture();f.league.Teams[1].Roster.Data.PlayerCount=99;const r=run(f);assert.equal(r.Status,'partial');assert.equal(r.Teams[1].Roster.Status,'error');assert.equal(r.Teams[1].Roster.Data,null);assert.equal(r.Teams[1].Recommendations.Status,'unavailable');assert.equal(r.Teams[2].Roster.Data.Players[0].Player,'Player 3');assert.equal(r.Teams[2].Recommendations.DropReviews[0].SampleGames7,3);
});
test('stale and wrong-week team matchups do not become fresh league rankings or new pickup advice',()=>{
 const f=fixture();f.league.Teams[1].Matchup.RetrievedAtUtc='2026-11-11T00:00:00Z';f.league.Teams[2].Matchup.Data.Week=3;const r=run(f);assert.equal(r.ComparedTeamCount,2);for(const i of [1,2]){assert.equal(r.Teams[i].Recommendations.Status,'unavailable');assert(r.Teams[i].Categories.every(c=>c.Rank===null));}assert(r.Teams[0].Categories.every(c=>c.Assessment==='unknown'&&!c.CompleteLeagueCoverage));
});
test('missing league week and conflicting week sources withhold comparison instead of guessing the period',()=>{
 for(const value of [null,5]){const f=fixture();f.league.CurrentWeek=value;if(value===null)f.league.Rules.Data.CurrentWeek=null;const r=run(f);assert.equal(r.CurrentWeek,null);assert.equal(r.ComparedTeamCount,0);assert(r.Teams.every(t=>t.Recommendations.Status==='unavailable'));}
});
test('a zero Add allowance applies only to its selected team, never every other team budget',()=>{
 const f=fixture();f.league.Teams[1].Budget.Data.AddsRemainingThisWeek=0;const r=run(f);assert.deepEqual(r.Teams[1].Recommendations.Candidates,[]);assert(r.Teams[1].Recommendations.WatchCandidates.every(c=>c.DropOptions.length===0));assert(r.Teams[1].Recommendations.Reasons.some(reason=>reason.includes('剩餘Add為0')));assert(r.Teams[0].Recommendations.Candidates.some(c=>c.Recommendation.includes('可評估加入')));
});

test('market conflicts with any fresh league roster are excluded globally rather than recommended to another team',()=>{
 const f=fixture();const owned={...player(4),Player:'Market Player',TeamCode:'GSW'};f.league.Teams[3].Roster.Data.Players.push(owned);f.league.Teams[3].Roster.Data.PlayerCount=2;
 const report=run(f);assert(report.Teams.every(t=>![...t.Recommendations.Candidates,...t.Recommendations.WatchCandidates].some(c=>c.Player==='Market Player')));assert(report.Teams[0].Notes.some(n=>n.includes('取得狀態矛盾')));assert.equal(f.league.Market.Data.Players[0].Availability,'free_agent');
});
test('a roster-market conflict also safely holds preserved reports, with original report time kept',()=>{
 const f=fixture(),previous=run(f);f.evidence.TargetNbaDateET='2026-11-13';f.evidence.Day.Status='waiting';f.league.Teams[3].Roster.Data.Players.push({...player(4),Player:'Market Player',TeamCode:'GSW'});f.league.Teams[3].Roster.Data.PlayerCount=2;
 const report=run({...f,previous});for(let i=0;i<3;i++){const r=report.Teams[i].Recommendations;assert.equal(r.GeneratedAtUtc,previous.Teams[i].Recommendations.GeneratedAtUtc);assert.deepEqual(r.Candidates,[]);assert.deepEqual(r.WatchCandidates,[]);}
});
test('waiting reports are reused only for an exact public selection key and team-name match',()=>{
 const f=fixture(),previous=run(f);f.evidence.TargetNbaDateET='2026-11-13';f.evidence.Day.Status='waiting';delete f.evidence.LastCompletedDay;
 const retained=run({...f,previous});assert.equal(retained.Teams[1].Recommendations.ReportDateET,target);assert.equal(retained.Teams[1].Recommendations.DropReviews[0].Player,'Player 2');
 previous.Teams[1].Team='RayBookDown';const refused=run({...f,previous});assert.equal(refused.Teams[1].Recommendations.ReportDateET,'2026-11-13');assert.deepEqual(refused.Teams[1].Recommendations.Candidates,[]);
});
test('unknown or missing all-team inputs stay unknown and never manufacture a selectable team',()=>{
 const empty=run({league:null,now});assert.equal(empty.Status,'unavailable');assert.equal(empty.TeamCount,null);assert.deepEqual(empty.Teams,[]);
 const f=fixture();f.league.Teams=[];f.league.Status='unavailable';const r=run(f);assert.equal(r.Status,'unavailable');assert.equal(r.TeamCount,4);assert.deepEqual(r.Teams,[]);
});
test('private identifiers, credential values, duplicate public keys and another league are rejected',()=>{
 for(const alter of [f=>f.league.Teams[0].teamId='synthetic-private',f=>f.league.Teams[0].Roster.Data.Players[0].Player='Bearer syntheticcredential',f=>f.league.Teams[1].SelectionKey=f.league.Teams[0].SelectionKey,f=>f.league.League='Other League']){const f=fixture();alter(f);assert.throws(()=>run(f));}
});
test('the default dashboard remains strictly RayBookDown and explicit trusted context validates only its own exact team',()=>{
 const f=fixture(),d=currentDashboard(f);d.Team='Team 2';assert.throws(()=>normalizeDashboard(d));assert.equal(normalizeDashboard(d,{expectedTeam:'Team 2'}).Team,'Team 2');assert.throws(()=>normalizeDashboard(d,{expectedTeam:'Team 3'}));assert.throws(()=>normalizeDashboard(d,{expectedTeam:'Bearer syntheticcredential'}));d.League='Other League';assert.throws(()=>normalizeDashboard(d,{expectedTeam:'Team 2'}));
});
test('the CLI writes a bounded independent feed and never mutates its input documents',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'raybookdown-league-')),f=fixture();
 const files={'dashboard.json':currentDashboard(f),'league-teams.json':f.league,'recommendation-evidence.json':f.evidence,'recommendation-history.json':f.history,'team-week-schedule.json':f.week};
 try{for(const[name,value]of Object.entries(files))await fs.writeFile(path.join(folder,name),JSON.stringify(value));const result=await buildLeagueAnalysis(path.join(folder,'dashboard.json'),{now});assert.equal(result.Teams,4);const bytes=await fs.readFile(path.join(folder,'league-analysis.json'));assert(bytes.length<1048576);normalizeLeagueAnalysis(JSON.parse(bytes));for(const[name,value]of Object.entries(files))assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,name),'utf8')),value);}
 finally{const resolved=path.resolve(folder);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('raybookdown-league-'))throw Error('UnsafeTestCleanup');await fs.rm(resolved,{recursive:true,force:true});}
});
