import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateRecommendations,scoredCategories,compareProjection,buildRecommendations} from './build-recommendations.mjs';
import {TEAM_CATALOG,TEAM_CODE_ALIASES} from './build-weekly-schedule.mjs';
import {addDays} from './update-nba-schedule.mjs';

const now=new Date('2026-11-13T17:00:00Z'),target='2026-11-12',stamp=now.toISOString();
const stats=(factor=1)=>({MIN:30*factor,FGM:5*factor,FGA:10*factor,FTM:4*factor,FTA:5*factor,'3PTM':2*factor,PTS:20*factor,OREB:2*factor,DREB:4*factor,REB:6*factor,AST:5*factor,ST:factor,BLK:factor,TO:2*factor,DD:0});
function fixture(){
 const matchup={Week:4,Categories:[{Label:'PTS',OwnValue:'100',OpponentValue:'110',Result:'loss',DisplayOnly:false},{Label:'TO',OwnValue:'20',OpponentValue:'15',Result:'loss',DisplayOnly:false}]};
 const section=Data=>({Status:'ok',RetrievedAtUtc:stamp,SourceUpdatedAtUtc:null,Data});
 const dashboard={SchemaVersion:2,League:'Funny League 2026-27',Team:'RayBookDown',Platform:'yahoo',Season:2026,Sections:{Roster:section({Players:[{Player:'Roster Player',TeamCode:'BOS',IsUndroppable:false}]}),Market:section({Players:[{Player:'Market Player',TeamCode:'GS',Availability:'free_agent'}]}),Matchup:section(matchup)}};
 const week={PeriodBasis:'taipei_calendar',YahooWeekBoundsKnown:false,RangeStartDateTaipei:'2026-11-09',RangeEndDateTaipei:'2026-11-15',CoverageVerified:true,CheckedAtUtc:stamp,RetrievedAtUtc:stamp,SourceUpdatedAtUtc:null,TeamCatalogSourceUrl:'https://www.nba.com/teams',TeamCodeAliases:{...TEAM_CODE_ALIASES},Teams:TEAM_CATALOG.map(t=>({...t,RemainingGames:t.TeamCode==='GSW'?3:2}))};
 const rows=[];
 for(const [player,id,code,factor]of [['Roster Player','1','BOS',.5],['Market Player','2','GSW',1.5]])for(let block=0;block<4;block++)for(const day of [0,2,4]){
  const date=addDays(target,-block*7-day),gameId='00226'+String(block*100+day+Number(id)).padStart(5,'0');
  rows.push({Player:player,OfficialPlayerId:id,GameId:gameId,TeamCode:code,DateET:date,Played:true,Stats:stats(factor),RetrievedAtUtc:stamp,SourceUrl:'https://www.nba.com/game/'+gameId+'/box-score'});
 }
 const Day={CoverageVerified:true,Status:'final',RetrievedAtUtc:stamp,Games:[{Status:'final',DateET:target,Teams:[{Score:100},{Score:99}]}]};
 const historyGames=rows.map(r=>({GameId:r.GameId,DateET:r.DateET,Status:'final',Teams:[{Code:r.TeamCode,Score:100},{Code:r.TeamCode==='BOS'?'NYK':'LAL',Score:99}]}));
 const evidence={SchemaVersion:1,GeneratedAtUtc:stamp,TargetNbaDateET:target,Day,PlayerGames:rows,PlayerScope:{AmbiguousPlayers:[],IdentityUnknownPlayers:[]},History:{VerifiedDates:Array.from({length:28},(_,i)=>addDays(target,-i)),UnavailableDates:[],MissingBoxScoreDates:[],Games:historyGames},Injuries:{Status:'available',ReportIssuedAtUtc:'2026-11-13T16:00:00Z',RetrievedAtUtc:stamp,SourceUrl:'https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-13_11_00AM.pdf',TeamReports:[{TeamName:'Golden State Warriors',GameDateET:'2026-11-13',Submitted:true},{TeamName:'Boston Celtics',GameDateET:'2026-11-13',Submitted:true}],UnsubmittedTeams:[],Players:[{Player:'Roster Player',TeamName:'Boston Celtics',GameDateET:'2026-11-13',Status:'Available'}]}};
 return {dashboard,evidence,week,now};
}
const run=options=>generateRecommendations(options??fixture());
function strictDashboard(raw){
 const d=structuredClone(raw);d.GeneratedAtUtc=stamp;
 for(const name of ['Rules','Roster','Matchup','Transactions','Budget','Market','Schedule']){
  const value=d.Sections[name];
  d.Sections[name]=value?{Status:'ok',Source:'Flaim Fantasy / Yahoo',CheckedAtUtc:stamp,RetrievedAtUtc:value.RetrievedAtUtc,SourceUpdatedAtUtc:null,ErrorType:null,Data:value.Data}:{Status:'unavailable',Source:'Synthetic fixture',CheckedAtUtc:stamp,RetrievedAtUtc:null,SourceUpdatedAtUtc:null,ErrorType:'Unknown',Data:null};
 }
 d.Sections.Roster.Data={PlayerCount:raw.Sections.Roster.Data.Players.length,Players:raw.Sections.Roster.Data.Players.map(p=>({Player:p.Player,Position:null,Status:null,EligiblePositions:null,TeamCode:p.TeamCode,IsUndroppable:p.IsUndroppable??null}))};
 d.Sections.Market.Data={Coverage:'returned_list',RateScope:'yahoo_platform_global',Players:raw.Sections.Market.Data.Players.map(p=>({Player:p.Player,Position:null,TeamCode:p.TeamCode,Availability:p.Availability,PercentOwned:null,WaiverDate:null}))};
 d.Sections.Matchup.Data={Week:4,WeekStartDate:null,WeekEndDate:null,Status:'in_progress',Opponent:'Synthetic Opponent',OwnScore:null,OpponentScore:null,OwnGamesRemaining:null,OpponentGamesRemaining:null,Categories:raw.Sections.Matchup.Data.Categories.map(c=>({Name:null,...c}))};
 return d;
}

test('a recommendation needs real samples, fresh league context, verified finals and a submitted injury report',()=>{
 const report=run();assert.equal(report.Status,'ready');assert.equal(report.Candidates.length,1);assert.match(report.Candidates[0].Recommendation,/可評估加入/);assert.equal(report.Candidates[0].RemainingGames,3);assert.equal(report.Candidates[0].SampleGames7,3);assert.equal(report.Candidates[0].SampleGames14,6);
 assert.match(report.Candidates[0].InjuryStatus,/不代表健康/);assert.equal(report.Week.VerifiedYahooWeek,false);assert(report.Notes.some(n=>n.includes('台灣日曆週')));
 assert(!JSON.stringify(report).includes('OfficialPlayerId'));assert(!JSON.stringify(report).includes('GameId'));
});
test('only actually scored category rows are used and lower turnovers are beneficial',()=>{
 const matchup={Categories:[{Label:'TO',OwnValue:10,OpponentValue:9,Result:'loss',DisplayOnly:false},{Label:'FGM/A',OwnValue:'1/2',OpponentValue:'1/3',Result:null,DisplayOnly:true},{Label:'PTS',OwnValue:20,OpponentValue:30,Result:null,DisplayOnly:false}]};
 const cats=scoredCategories(matchup);assert.deepEqual(cats.map(c=>c.stat),['TO']);
 const comparison=compareProjection({projection:{TO:1},remaining:3},{projection:{TO:3},remaining:3},cats,matchup);
 assert(comparison.score>0);assert.equal(comparison.rows[0].delta,-6);assert.equal(comparison.rows[0].gain,6);
});
test('percentage projections weight actual attempts rather than averaging the displayed percentages',()=>{
 const matchup={Categories:[{Label:'FG%',OwnValue:'.100',OpponentValue:'.200',Result:'loss',DisplayOnly:false},{Label:'FGM/A',OwnValue:'10/100',OpponentValue:'20/100',Result:null,DisplayOnly:true}]};
 const result=compareProjection({projection:{FGM:1,FGA:1},remaining:1},{projection:{FGM:10,FGA:20},remaining:1},scoredCategories(matchup),matchup);
 assert(result.score<0);assert(Math.abs(result.rows[0].delta-(11/101-20/120))<1e-12);
 const noAttempts=compareProjection({projection:{FGM:1,FGA:1},remaining:1},{projection:{FGM:10,FGA:20},remaining:1},scoredCategories({...matchup,Categories:matchup.Categories.slice(0,1)}),{Categories:matchup.Categories.slice(0,1)});
 assert.equal(noAttempts.complete,false);assert.equal(noAttempts.score,null);
});
test('A/T uses AST and TO totals, never a direct mean of ratios',()=>{
 const matchup={Categories:[{Label:'A/T',OwnValue:2,OpponentValue:3,Result:'loss',DisplayOnly:false},{Label:'AST',OwnValue:10,OpponentValue:12,Result:null},{Label:'TO',OwnValue:5,OpponentValue:4,Result:null}]};
 const result=compareProjection({projection:{AST:10,TO:10},remaining:1},{projection:{AST:1,TO:0},remaining:1},scoredCategories(matchup),matchup);
 assert(result.score<0);assert(Math.abs(result.rows[0].delta-(20/15-11/5))<1e-12);
});
test('a single bad game is not a drop signal and protection always wins',()=>{
 const f=fixture();for(const r of f.evidence.PlayerGames.filter(r=>r.Player==='Roster Player'))r.Stats=stats(1);
 f.evidence.PlayerGames.find(r=>r.Player==='Roster Player'&&r.DateET===target).Stats.PTS=0;
 const report=run(f);assert(!report.DropReviews[0].Review.startsWith('可列'));assert.equal(report.Candidates[0].DropOptions.length,0);
 f.dashboard.Sections.Roster.Data.Players[0].IsUndroppable=true;
 const protectedReport=run(f);assert.equal(protectedReport.DropReviews[0].Protected,true);assert.match(protectedReport.DropReviews[0].Review,/不可丟棄/);assert.equal(protectedReport.Candidates[0].DropOptions.length,0);
});
test('unknown protection never produces a hard drop option even with two declining windows',()=>{
 const f=fixture();delete f.dashboard.Sections.Roster.Data.Players[0].IsUndroppable;
 for(const r of f.evidence.PlayerGames.filter(r=>r.Player==='Roster Player'))r.Stats=stats(r.DateET>=addDays(target,-6)?.2:r.DateET>=addDays(target,-13)?.5:1);
 const unknown=run(f);assert.equal(unknown.DropReviews[0].Protected,null);assert.match(unknown.DropReviews[0].Review,/保護狀態未知/);assert.equal(unknown.Candidates[0].DropOptions.length,0);
 f.dashboard.Sections.Roster.Data.Players[0].IsUndroppable=false;
 const allowed=run(f);assert.equal(allowed.DropReviews[0].Protected,false);assert.equal(allowed.Candidates[0].DropOptions.length,1);assert.match(allowed.Candidates[0].DropOptions[0].Reason,/操作是否合法/);
});
test('future dates, future retrievals and DNP rows cannot improve or reduce a forecast',()=>{
 const f=fixture(),baseline=run(f);f.evidence.PlayerGames.push({...f.evidence.PlayerGames.find(r=>r.Player==='Market Player'),GameId:'0022699999',DateET:addDays(target,1),Stats:stats(999)});
 f.evidence.PlayerGames.push({...f.evidence.PlayerGames.find(r=>r.Player==='Market Player'),GameId:'0022699998',RetrievedAtUtc:'2026-11-14T17:00:00Z',Stats:stats(999)});
 f.evidence.PlayerGames.push({...f.evidence.PlayerGames.find(r=>r.Player==='Roster Player'),GameId:'0022699997',Played:false,Stats:null});
 assert.deepEqual(run(f).Candidates,baseline.Candidates);assert.deepEqual(run(f).DropReviews,baseline.DropReviews);
});
test('missing history or attempts leaves a watch list instead of fabricated ranking',()=>{
 const f=fixture();f.evidence.History.VerifiedDates=[];
 const report=run(f);assert.equal(report.Status,'insufficient_data');assert.match(report.Candidates[0].Recommendation,/觀察名單/);assert.equal(report.Candidates[0].DropOptions.length,0);
 f.evidence.PlayerGames=[];const empty=run(f);assert.equal(empty.Candidates[0].SampleGames7,null);assert.equal(empty.Candidates[0].SampleGames14,null);
});
test('ambiguous official identity or a different latest NBA team is unknown and cannot rank',()=>{
 const f=fixture();f.evidence.PlayerGames.push({...f.evidence.PlayerGames.find(r=>r.Player==='Market Player'),OfficialPlayerId:'999',GameId:'0022699996'});
 const ambiguous=run(f);assert.equal(ambiguous.Status,'insufficient_data');assert.equal(ambiguous.Candidates[0].SampleGames7,null);
 const changed=fixture();changed.evidence.PlayerGames.filter(r=>r.Player==='Market Player'&&r.DateET===target)[0].TeamCode='LAL';
 const report=run(changed);assert.equal(report.Candidates[0].RemainingGames,null);assert(report.Candidates[0].Reasons.some(r=>r.includes('未推定轉隊')));assert.match(report.Candidates[0].Recommendation,/觀察/);
});
test('Out, Doubtful and Questionable are watch-only; missing submitted-team evidence is not healthy',()=>{
 for(const Status of ['Out','Doubtful','Questionable']){const f=fixture();f.evidence.Injuries.Players=[{Player:'Market Player',TeamName:'Golden State Warriors',GameDateET:'2026-11-13',Status}];const r=run(f);assert.equal(r.Status,'insufficient_data');assert.equal(r.Candidates[0].InjuryStatus,Status);assert.equal(r.Candidates[0].DropOptions.length,0);}
 const missing=fixture();missing.evidence.Injuries.TeamReports=[];assert.match(run(missing).Candidates[0].InjuryStatus,/未知/);
 const stale=fixture();stale.evidence.Injuries.ReportIssuedAtUtc=new Date(+now-27*3600000).toISOString();assert.equal(run(stale).Status,'insufficient_data');
});
test('injured or medically unknown roster players are not dropped for apparent performance declines',()=>{
 for(const status of ['Out','Doubtful','Questionable',null]){
  const f=fixture();for(const r of f.evidence.PlayerGames.filter(r=>r.Player==='Roster Player'))r.Stats=stats(r.DateET>=addDays(target,-6)?.2:r.DateET>=addDays(target,-13)?.5:1);
  f.evidence.Injuries.Players=status?[{Player:'Roster Player',TeamName:'Boston Celtics',GameDateET:'2026-11-13',Status:status}]:[];
  const r=run(f);assert.equal(r.Candidates[0].DropOptions.length,0);assert.match(r.DropReviews[0].Review,/傷勢風險或醫療狀態未知/);
 }
});
test('unlisted submitted reports allow only clearly conditional candidates while waivers remain watch-only',()=>{
 const f=fixture(),conditional=run(f);assert.match(conditional.Candidates[0].Recommendation,/條件式/);assert.match(conditional.Candidates[0].InjuryStatus,/醫療未知/);
 f.dashboard.Sections.Market.Data.Players[0].Availability='waivers';const waiver=run(f);assert.equal(waiver.Status,'insufficient_data');assert.match(waiver.Candidates[0].Recommendation,/觀察/);assert(waiver.Candidates[0].Reasons.some(r=>r.includes('讓渡開放時間')));
});
test('per-player coverage ignores unrelated missing box scores but requires this player or explicit DNP for every team game',()=>{
 const f=fixture();f.evidence.History.MissingBoxScoreDates=[target];f.evidence.History.Games.push({GameId:'0022699911',DateET:target,Status:'final',Teams:[{Code:'PHI',Score:100},{Code:'DET',Score:90}]});
 assert.equal(run(f).Status,'ready');
 f.evidence.History.Games.push({GameId:'0022699912',DateET:target,Status:'final',Teams:[{Code:'GSW',Score:100},{Code:'CHI',Score:90}]});
 assert.equal(run(f).Status,'insufficient_data');
 f.evidence.PlayerGames.push({Player:'Market Player',OfficialPlayerId:'2',GameId:'0022699912',TeamCode:'GSW',DateET:target,Played:false,Stats:null,RetrievedAtUtc:stamp});
 const explicit=run(f);assert.equal(explicit.Status,'ready');assert.equal(explicit.Candidates[0].SampleGames7,3);
});
test('stale or future roster/market/matchup snapshots do not generate new rankings',()=>{
 for(const key of ['Roster','Market','Matchup'])for(const hours of [-37,1]){const f=fixture();f.dashboard.Sections[key].RetrievedAtUtc=new Date(+now+hours*3600000).toISOString();const r=run(f);assert.equal(r.Status,'unavailable');assert.deepEqual(r.Candidates,[]);}
});
test('unfinished target day retains the original report date and generated time',()=>{
 const f=fixture(),previous=run(f);f.evidence.TargetNbaDateET='2026-11-13';f.evidence.Day.Status='waiting';
 const waiting=run({...f,previous});assert.equal(waiting.Status,'waiting');assert.equal(waiting.GeneratedAtUtc,previous.GeneratedAtUtc);assert.equal(waiting.ReportDateET,previous.ReportDateET);assert.equal(waiting.Candidates[0].Player,previous.Candidates[0].Player);assert(waiting.Notes.some(n=>n.includes('2026-11-13')&&n.includes('保留')));
 assert.deepEqual(waiting.DropReviews,previous.DropReviews);
});
test('with no previous report an unfinished day can use only the last verified complete day, with candid labels',()=>{
 const f=fixture(),completed=structuredClone(f.evidence.Day);f.evidence.TargetNbaDateET='2026-11-13';f.evidence.Day.Status='waiting';f.evidence.LastCompletedDay={DateET:target,Day:completed};
 const r=run(f);assert.equal(r.Status,'waiting');assert.equal(r.ReportDateET,target);assert(r.Notes.some(n=>n.includes('非今日新完賽')));assert.equal(r.Candidates[0].SampleGames7,3);
 f.evidence.LastCompletedDay.Day.Games[0].Teams[0].Score=null;assert.deepEqual(run(f).Candidates,[]);
});
test('missing final scores and future target dates are withheld rather than treated as final',()=>{
 const f=fixture();f.evidence.Day.Games[0].Teams[0].Score=null;assert.equal(run(f).Status,'unavailable');
 f.evidence.TargetNbaDateET='2026-11-14';assert.equal(run(f).Status,'unavailable');
});
test('old evidence cannot be paired with fresh league data and future previous reports are never preserved',()=>{
 const f=fixture();f.evidence.GeneratedAtUtc=new Date(+now-37*3600000).toISOString();assert.equal(run(f).Status,'unavailable');
 const next=fixture(),previous=run(next);next.evidence.Day.Status='waiting';previous.ReportDateET='2026-11-14';assert.deepEqual(run({...next,previous}).Candidates,[]);
});
test('unverified weekly coverage cannot become a zero or fabricated remaining-game estimate',()=>{
 const f=fixture();f.week.CoverageVerified=false;const r=run(f);assert.equal(r.Status,'insufficient_data');assert.equal(r.Candidates[0].RemainingGames,null);assert.equal(r.DropReviews[0].RemainingGames,null);
});
test('preseason, All-Star and playoff rows never enter regular-season rolling windows or drop baselines',()=>{
 const f=fixture(),baseline=run(f);
 for(const prefix of ['001','003','004'])f.evidence.PlayerGames.push({...f.evidence.PlayerGames.find(r=>r.Player==='Market Player'),GameId:prefix+'2699995',Stats:stats(999)});
 assert.deepEqual(run(f).Candidates,baseline.Candidates);assert.deepEqual(run(f).DropReviews,baseline.DropReviews);
 const only=fixture();only.evidence.PlayerGames=only.evidence.PlayerGames.map(r=>({...r,GameId:'001'+r.GameId.slice(3)}));const report=run(only);assert.equal(report.Status,'insufficient_data');assert.equal(report.Candidates[0].SampleGames14,null);assert.equal(report.Candidates[0].DropOptions.length,0);
});
test('the CLI builder writes only recommendations and keeps input documents unchanged',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'raybookdown-recommend-'));const f=fixture(),files={'dashboard.json':strictDashboard(f.dashboard),'recommendation-evidence.json':f.evidence,'team-week-schedule.json':f.week};
 try{for(const [name,data]of Object.entries(files))await fs.writeFile(path.join(folder,name),JSON.stringify(data));const result=await buildRecommendations(path.join(folder,'dashboard.json'),{now});assert.equal(result.Status,'ready');const output=JSON.parse(await fs.readFile(path.join(folder,'recommendations.json'),'utf8'));assert.equal(output.Candidates[0].Player,'Market Player');for(const [name,data]of Object.entries(files))assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,name),'utf8')),data);}
 finally{const resolved=path.resolve(folder);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('raybookdown-recommend-'))throw new Error('UnsafeTestCleanup');await fs.rm(resolved,{recursive:true,force:true});}
});
test('candidate output is bounded to eight current-market names without fabricating a watch-list ranking',()=>{
 const f=fixture(),original=f.evidence.PlayerGames.filter(r=>r.Player==='Market Player');
 f.evidence.PlayerGames=f.evidence.PlayerGames.filter(r=>r.Player!=='Market Player');
 f.dashboard.Sections.Market.Data.Players=Array.from({length:12},(_,i)=>({Player:`Market Player ${i}`,TeamCode:'GSW',Availability:'free_agent'}));
 for(const [i,p]of f.dashboard.Sections.Market.Data.Players.entries())f.evidence.PlayerGames.push(...original.map(r=>({...r,Player:p.Player,OfficialPlayerId:String(i+10)})));
 f.evidence.History.VerifiedDates=[];
 const r=run(f);assert.equal(r.Status,'insufficient_data');assert.equal(r.Candidates.length,8);assert.deepEqual(r.Candidates.map(c=>c.Player),f.dashboard.Sections.Market.Data.Players.slice(0,8).map(p=>p.Player));
});
test('strict input validation rejects malformed protection and credential fields before replacing previous recommendations',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'raybookdown-recommend-')),file=path.join(folder,'dashboard.json'),output=path.join(folder,'recommendations.json'),f=fixture(),previous=JSON.stringify(run(f));
 await fs.writeFile(output,previous);
 try{
  const malformed=strictDashboard(f.dashboard);malformed.Sections.Roster.Data.Players[0].IsUndroppable='false';await fs.writeFile(file,JSON.stringify(malformed));
  await assert.rejects(()=>buildRecommendations(file,{now}));assert.equal(await fs.readFile(output,'utf8'),previous);
  const credentials=strictDashboard(f.dashboard);credentials.extra={refresh_token:'synthetic-secret'};await fs.writeFile(file,JSON.stringify(credentials));
  await assert.rejects(()=>buildRecommendations(file,{now}));assert.equal(await fs.readFile(output,'utf8'),previous);
 }finally{const resolved=path.resolve(folder);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('raybookdown-recommend-'))throw new Error('UnsafeTestCleanup');await fs.rm(resolved,{recursive:true,force:true});}
});
test('a fresh explicit zero Add allowance in either source suspends new-add priority and retains only observations',()=>{
 for(const name of ['Budget','Transactions']){
  const f=fixture();f.dashboard.Sections[name]={Status:'ok',RetrievedAtUtc:stamp,SourceUpdatedAtUtc:null,Data:{AddsRemainingThisWeek:0,MaxWeeklyAdds:6}};
  const r=run(f);assert.equal(r.Status,'insufficient_data');assert.match(r.Candidates[0].Recommendation,/剩餘Add為0/);assert.equal(r.Candidates[0].DropOptions.length,0);assert(r.Reasons.some(reason=>reason.includes('已核實本週剩餘Add為0')));
 }
});
test('unknown Add allowance stays unknown and is never inferred from limits or observed transactions',()=>{
 const f=fixture();f.dashboard.Sections.Budget={Status:'ok',RetrievedAtUtc:stamp,Data:{AddsRemainingThisWeek:null,MaxWeeklyAdds:6}};
 f.dashboard.Sections.Transactions={Status:'ok',RetrievedAtUtc:stamp,Data:{AddsRemainingThisWeek:null,Rows:Array(14).fill({Type:'add'})}};
 const r=run(f);assert.equal(r.Status,'ready');assert.match(r.Candidates[0].Recommendation,/可評估加入/);assert(r.Notes.some(note=>note.includes('剩餘Add未知')));assert(!r.Reasons.some(reason=>reason.includes('剩餘Add為0')));
});
test('stale, future or failed-source zero allowances do not masquerade as a current official zero',()=>{
 for(const source of [{Status:'ok',RetrievedAtUtc:new Date(+now-37*3600000).toISOString()},{Status:'ok',RetrievedAtUtc:new Date(+now+3600000).toISOString()},{Status:'error',RetrievedAtUtc:stamp}]){
  const f=fixture();f.dashboard.Sections.Budget={...source,Data:{AddsRemainingThisWeek:0}};
  const r=run(f);assert.equal(r.Status,'ready');assert(r.Notes.some(note=>note.includes('剩餘Add未知')));assert(!r.Reasons.some(reason=>reason.includes('剩餘Add為0')));
 }
});
test('contradictory fresh allowance sources hold conservatively and explicitly disclose the conflict',()=>{
 for(const [budget,transactions]of [[0,2],[2,3]]){
  const f=fixture();for(const [name,value]of [['Budget',budget],['Transactions',transactions]])f.dashboard.Sections[name]={Status:'ok',RetrievedAtUtc:stamp,Data:{AddsRemainingThisWeek:value}};
  const r=run(f);assert.equal(r.Status,'insufficient_data');assert.equal(r.Candidates[0].DropOptions.length,0);assert(r.Reasons.some(reason=>reason.includes('數值不一致')));
  if(budget!==0)assert(!r.Reasons.some(reason=>reason.includes('剩餘Add為0')));
 }
});
test('a new verified zero also places a preserved waiting report on hold without changing its original generation time',()=>{
 const f=fixture(),previous=run(f);f.evidence.TargetNbaDateET='2026-11-13';f.evidence.Day.Status='waiting';f.dashboard.Sections.Budget={Status:'ok',RetrievedAtUtc:stamp,Data:{AddsRemainingThisWeek:0}};
 const r=run({...f,previous});assert.equal(r.Status,'waiting');assert.equal(r.GeneratedAtUtc,previous.GeneratedAtUtc);assert.match(r.Candidates[0].Recommendation,/觀察舊報告.*剩餘Add為0/);assert.equal(r.Candidates[0].DropOptions.length,0);assert(r.Sources.some(s=>s.Name.includes('Add額度檢查 Budget')&&s.RetrievedAtUtc===stamp));
});
