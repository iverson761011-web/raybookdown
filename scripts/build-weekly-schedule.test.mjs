import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TEAM_CATALOG,TEAM_CODE_ALIASES,resolveTeam,taipeiCalendarWeek,determineWeekPeriod,aggregateTeamWeek,buildWeeklySchedule} from './build-weekly-schedule.mjs';
import {addDays,parseDailyHtml} from './update-nba-schedule.mjs';

const now=new Date('2026-11-13T04:00:00Z'); // Friday noon in Taiwan.
const dashboard={SchemaVersion:2,League:'Funny League 2026-27',Team:'RayBookDown',Platform:'yahoo',Season:2026,Sections:{Rules:{Data:{CurrentWeek:4}},Matchup:{Status:'ok',Data:{WeekStartDate:null,WeekEndDate:null}}}};
const period=()=>determineWeekPeriod(dashboard,{now});
const dates=Array.from({length:7},(_,i)=>addDays('2026-11-09',i));
const game=(start,teams=['Golden State Warriors','New Orleans Pelicans'],id='0022600100')=>({StartAtTaipei:start,Teams:teams,SourceUrl:'https://www.nba.com/game/'+id});
const full=games=>({requestedDates:dates,games,unavailableDates:[]});
const team=(feed,code)=>feed.Teams.find(t=>t.TeamCode===code);
async function removeTestFolder(folder){
  const target=path.resolve(folder),temporaryRoot=path.resolve(os.tmpdir());
  if(path.dirname(target)!==temporaryRoot||!path.basename(target).startsWith('raybookdown-week-'))throw new Error('UnsafeTestCleanup');
  await fs.rm(target,{recursive:true,force:true});
}

test('the display period is the full current Taiwan Monday-Sunday calendar week, not a rolling seven days',()=>{
  assert.deepEqual(taipeiCalendarWeek(now),{start:'2026-11-09',end:'2026-11-15',startUtc:'2026-11-08T16:00:00.000Z',endExclusiveUtc:'2026-11-15T16:00:00.000Z'});
  const p=period();assert.equal(p.PeriodBasis,'taipei_calendar');assert.equal(p.YahooWeekBoundsKnown,false);assert.equal(p.YahooWeek,4);assert.equal(p.YahooWeekTimeZone,null);
  assert.match(p.PeriodLabel,/Yahoo.*未知/);
});
test('Taiwan midnight and year boundaries select the correct calendar week',()=>{
  assert.equal(taipeiCalendarWeek(new Date('2026-11-15T15:59:59Z')).start,'2026-11-09');
  assert.equal(taipeiCalendarWeek(new Date('2026-11-15T16:00:00Z')).start,'2026-11-16');
  assert.deepEqual([taipeiCalendarWeek(new Date('2027-01-01T00:00:00Z')).start,taipeiCalendarWeek(new Date('2027-01-01T00:00:00Z')).end],['2026-12-28','2027-01-03']);
});
test('dates without documented Yahoo timezone and verification never establish Yahoo week bounds',()=>{
  const input=structuredClone(dashboard);input.Sections.Matchup.Data={WeekStartDate:'2026-11-09',WeekEndDate:'2026-11-15'};
  assert.equal(determineWeekPeriod(input,{now}).YahooWeekBoundsKnown,false);
  input.Sections.Matchup.Data.WeekTimeZone='America/New_York';
  assert.equal(determineWeekPeriod(input,{now}).YahooWeekBoundsKnown,false);
  input.Sections.Matchup.Data.WeekBoundsVerified=true;
  assert.equal(determineWeekPeriod(input,{now}).YahooWeekBoundsKnown,true);
});
test('explicitly verified Yahoo bounds retain New York midnight and span the correct Taiwan dates',()=>{
  const p=determineWeekPeriod(dashboard,{now,yahooBounds:{Verified:true,StartDate:'2026-11-09',EndDateInclusive:'2026-11-15',TimeZone:'America/New_York'}});
  assert.equal(p.PeriodBasis,'yahoo_verified');assert.equal(p.YahooWeekBoundsKnown,true);
  assert.equal(p.PeriodStartAtUtc,'2026-11-09T05:00:00.000Z');assert.equal(p.PeriodEndExclusiveAtUtc,'2026-11-16T05:00:00.000Z');
  assert.equal(p.RangeStartDateTaipei,'2026-11-09');assert.equal(p.RangeEndDateTaipei,'2026-11-16');
});
test('ambiguous timezone abbreviations, invalid dates and past Yahoo windows use the candid calendar fallback',()=>{
  for(const bounds of [
    {Verified:true,StartDate:'2026-11-09',EndDateInclusive:'2026-11-15',TimeZone:'EST'},
    {Verified:true,StartDate:'2026-02-30',EndDateInclusive:'2026-11-15',TimeZone:'UTC'},
    {Verified:true,StartDate:'2025-11-09',EndDateInclusive:'2025-11-15',TimeZone:'UTC'},
    {Verified:false,StartDate:'2026-11-09',EndDateInclusive:'2026-11-15',TimeZone:'UTC'},
  ])assert.equal(determineWeekPeriod(dashboard,{now,yahooBounds:bounds}).PeriodBasis,'taipei_calendar');
});
test('all thirty officially catalogued teams appear even on a verified empty week',()=>{
  const feed=aggregateTeamWeek(full([]),{period:period(),now});
  assert.equal(TEAM_CATALOG.length,30);assert.equal(new Set(TEAM_CATALOG.map(t=>t.TeamCode)).size,30);assert.equal(feed.Teams.length,30);
  assert.equal(feed.Status,'ok');assert.equal(feed.CoverageVerified,true);
  for(const t of feed.Teams){assert.equal(t.TotalGames,0);assert.equal(t.RemainingGames,0);assert.deepEqual(t.DatesTaipei,[]);}
});
test('future scheduled opportunities use exact start instants; now is not remaining, duplicate games count once',()=>{
  const games=[game('2026-11-09T08:00:00+08:00'),game('2026-11-13T12:00:00+08:00',undefined,'0022600101'),game('2026-11-14T08:00:00+08:00',undefined,'0022600102')];
  const feed=aggregateTeamWeek(full([...games,{...games[2],SourceUrl:'https://www.nba.com/game/gsw-vs-nop-0022600102'}]),{period:period(),now});
  const gsw=team(feed,'GSW');assert.equal(gsw.TotalGames,3);assert.equal(gsw.RemainingGames,1);
  assert.deepEqual(gsw.DatesTaipei,['2026-11-09','2026-11-13','2026-11-14']);assert.deepEqual(gsw.RemainingDatesTaipei,['2026-11-14']);
  assert.equal(gsw.VerifiedGames.length,3);assert.equal(gsw.VerifiedGames[0].OpponentCode,'NOP');
});
test('only explicit code/name aliases map teams; short fragments and unknown names are never guessed',()=>{
  for(const [alias,code] of Object.entries({GS:'GSW',NO:'NOP',NY:'NYK',SA:'SAS',UTAH:'UTA',WSH:'WAS',PHO:'PHX',BRK:'BKN'})){
    assert.equal(TEAM_CODE_ALIASES[alias],code);assert.equal(resolveTeam(alias.toLowerCase()).TeamCode,code);
  }
  assert.equal(resolveTeam('Los Angeles Clippers').TeamCode,'LAC');assert.equal(resolveTeam('LA Clippers').TeamCode,'LAC');
  for(const v of ['York','Los Angeles','Portland','Future Expansion Team',null])assert.equal(resolveTeam(v),null);
});
test('the observed NBA GameCard bare nickname schema maps through thirty explicit aliases',()=>{
 const cardData={gameId:'0022600227',gameTimeUtc:'2026-11-13T00:00:00Z',awayTeam:{teamName:'Cavaliers'},homeTeam:{teamName:'Knicks'}};
 const html='<script id="__NEXT_DATA__">'+JSON.stringify({query:{date:'2026-11-12'},props:{pageProps:{gameCardFeed:{modules:[{cards:[{cardType:'GameCard',cardData}]}]}}}})+'</script>';
 const parsed=parseDailyHtml(html,'2026-11-12');assert.equal(parsed.verified,true);assert.deepEqual(parsed.games[0].Teams,['Cavaliers','Knicks']);
 const feed=aggregateTeamWeek(full(parsed.games),{period:period(),now});assert.equal(feed.Status,'ok');assert.equal(team(feed,'CLE').TotalGames,1);assert.equal(team(feed,'NYK').TotalGames,1);assert.deepEqual(feed.UnknownTeams,[]);
 assert.equal(resolveTeam('Trail Blazers').TeamCode,'POR');assert.equal(resolveTeam('76ers').TeamCode,'PHI');assert.equal(resolveTeam('Blazers'),null);
});
test('unverified day coverage leaves both totals unknown for every team rather than falsely publishing zeros',()=>{
  const result=full([game('2026-11-14T08:00:00+08:00')]);result.unavailableDates=['2026-11-10'];
  const feed=aggregateTeamWeek(result,{period:period(),now});assert.equal(feed.Status,'partial');assert.equal(feed.CoverageVerified,false);
  for(const t of feed.Teams){assert.equal(t.TotalGames,null);assert.equal(t.RemainingGames,null);}
  assert.deepEqual(team(feed,'GSW').RemainingDatesTaipei,['2026-11-14']);assert.equal(team(feed,'GSW').VerifiedGames.length,1);
});
test('unknown teams and invalid official URLs cannot become complete schedule totals',()=>{
  const feed=aggregateTeamWeek(full([game('2026-11-14T08:00:00+08:00',['Unknown Franchise','LA Clippers']),game('2026-11-14T09:00:00+08:00',['Boston Celtics','LA Clippers'],'0022600103'),{...game('2026-11-15T09:00:00+08:00'),SourceUrl:'https://evil.test/game/1'}]),{period:period(),now});
  assert.equal(feed.Status,'partial');assert.deepEqual(feed.UnknownTeams,['Unknown Franchise']);
  assert.equal(team(feed,'BOS').VerifiedGames.length,1);assert.equal(team(feed,'BOS').TotalGames,null);
  assert.equal(feed.SourceUrls.some(u=>u.includes('evil.test')),false);
});
test('the period excludes next-week games and honors exact verified Yahoo boundaries',()=>{
  const feed=aggregateTeamWeek(full([game('2026-11-16T00:00:00+08:00')]),{period:period(),now});assert.equal(team(feed,'GSW').TotalGames,0);
  const p=determineWeekPeriod(dashboard,{now,yahooBounds:{Verified:true,StartDate:'2026-11-09',EndDateInclusive:'2026-11-15',TimeZone:'America/New_York'}});
  const result={requestedDates:[...dates,'2026-11-16'],unavailableDates:[],games:[game('2026-11-09T12:59:59+08:00'),game('2026-11-16T12:59:59+08:00',undefined,'0022600104'),game('2026-11-16T13:00:00+08:00',undefined,'0022600105')]};
  const verified=aggregateTeamWeek(result,{period:p,now});assert.equal(team(verified,'GSW').TotalGames,1);assert.equal(team(verified,'GSW').VerifiedGames[0].StartAtTaipei,'2026-11-16T12:59:59+08:00');
});
test('a missing requested date cannot be treated as a verified no-game day',()=>{
  const feed=aggregateTeamWeek({requestedDates:dates.slice(1),games:[],unavailableDates:[]},{period:period(),now});
  assert.equal(feed.Status,'unavailable');assert.equal(feed.RetrievedAtUtc,null);assert.deepEqual(feed.UnavailableDates,['2026-11-09']);assert.equal(team(feed,'ATL').TotalGames,null);
});
test('the independent builder fetches the full calendar week and leaves dashboard bytes unchanged',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'raybookdown-week-')),file=path.join(folder,'dashboard.json');
  const original=JSON.stringify(dashboard);await fs.writeFile(file,original);
  try{
    const summary=await buildWeeklySchedule(file,{now,collect:async options=>{
      assert.equal(options.startDate,'2026-11-09');assert.equal(options.days,7);assert.equal(options.seasonYear,2026);
      options.onDiagnostic({Phase:'parse',ErrorType:null,Url:'https://www.nba.com/games?date=2026-11-09'});
      return full([game('2026-11-14T08:00:00+08:00')]);
    }});
    assert.equal(summary.WeeklyScheduleUpdated,true);assert.equal(summary.Teams,30);assert.equal(summary.Status,'ok');
    assert.equal(await fs.readFile(file,'utf8'),original);
    const output=JSON.parse(await fs.readFile(path.join(folder,'team-week-schedule.json'),'utf8'));
    assert.equal(output.PeriodBasis,'taipei_calendar');assert.equal(output.SourceUpdatedAtUtc,null);
    assert(output.SourceUrls.includes('https://www.nba.com/games?date=2026-11-09'));
  }finally{await removeTestFolder(folder);}
});
test('collection failure publishes unknown values for thirty teams and does not fabricate zero totals',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'raybookdown-week-')),file=path.join(folder,'dashboard.json');await fs.writeFile(file,JSON.stringify(dashboard));
  try{
    const summary=await buildWeeklySchedule(file,{now,collect:async()=>{throw new Error('synthetic source failure');}});
    const output=JSON.parse(await fs.readFile(path.join(folder,'team-week-schedule.json'),'utf8'));
    assert.equal(summary.Status,'unavailable');assert.equal(output.Teams.length,30);assert.equal(output.Teams.every(t=>t.TotalGames===null&&t.RemainingGames===null),true);
  }finally{await removeTestFolder(folder);}
});
