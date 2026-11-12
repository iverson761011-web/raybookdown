import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const html=await fs.readFile(path.join(root,'index.html'),'utf8');
let fixture=JSON.parse(await fs.readFile(path.join(root,'tests/fixtures/dashboard.json'),'utf8'));
class Element {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.value='';this.textContent='';this.dataset={};this.events={};this.attributes={};this.hidden=false;this.classList={add:()=>{},toggle:()=>{}};}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=[...children];}
 addEventListener(name,handler){this.events[name]=handler;}
 setAttribute(name,value){this.attributes[name]=value;}
 click(){this.events.click?.();}
 remove(){}
}
const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(x=>[x[1],new Element()]));
elements.filter.value='all';elements.scheduleDate.value='all';
const buttons=[...html.matchAll(/data-tab="([^"]+)"/g)].map(x=>{const b=new Element('button');b.dataset.tab=x[1];return b;});
const panels=['roster','recommendations','matchup','history','market','schedule','adds','settings'].map(id=>{elements[id].id=id;return elements[id];});
const intervals=[];
const originalTimeout=globalThis.setTimeout;
globalThis.document={getElementById:id=>{assert.ok(elements[id],'Known element '+id);return elements[id];},createElement:tag=>new Element(tag),querySelectorAll:q=>q==='[data-tab]'?buttons:q==='.panel'?panels:[],body:new Element('body')};
globalThis.location={hostname:'127.0.0.1',href:'http://127.0.0.1:8760/index.html'};
globalThis.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
globalThis.setInterval=(fn,ms)=>{intervals.push({fn,ms});return intervals.length;};
globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};
let fetchCount=0,featureFailure=false;
const time='2026-11-12T16:37:50Z';
const history={SchemaVersion:1,League:'Funny League 2026-27',Team:'RayBookDown',Platform:'yahoo',Season:2026,Status:'ok',RetrievedAtUtc:time,CheckedAtUtc:time,SourceUpdatedAtUtc:null,CurrentWeek:4,UnavailableWeeks:[],Weeks:[{Week:3,Status:'final',Opponent:'Past opponent',OwnScore:{Wins:9,Losses:4,Ties:0},Winner:'own',WeekStartDate:null,WeekEndDate:null,RetrievedAtUtc:time,SourceUpdatedAtUtc:null,Categories:[{Name:'Points',Label:'PTS',OwnValue:'100',OpponentValue:'90',Result:'win',DisplayOnly:false}]},{Week:4,Status:'in_progress',Opponent:'Current opponent',OwnScore:{Wins:7,Losses:6,Ties:0},Winner:null,WeekStartDate:null,WeekEndDate:null,RetrievedAtUtc:time,SourceUpdatedAtUtc:null,Categories:[]}]};
const weekly={SchemaVersion:1,Status:'ok',CheckedAtUtc:time,RetrievedAtUtc:time,SourceUpdatedAtUtc:null,PeriodBasis:'taipei_calendar',YahooWeekBoundsKnown:false,RangeStartDateTaipei:'2026-11-09',RangeEndDateTaipei:'2026-11-15',CoverageVerified:true,UnavailableDates:[],TeamCodeAliases:{CLE:'CLE',GS:'GSW',GSW:'GSW'},Teams:[{TeamCode:'CLE',Team:'Cleveland Cavaliers',TotalGames:4,RemainingGames:2,DatesTaipei:['2026-11-10','2026-11-12','2026-11-14','2026-11-15'],RemainingDatesTaipei:['2026-11-14','2026-11-15'],VerifiedGames:[]},{TeamCode:'GSW',Team:'Golden State Warriors',TotalGames:0,RemainingGames:0,DatesTaipei:[],RemainingDatesTaipei:[],VerifiedGames:[]}]};
const recommendations={SchemaVersion:1,Status:'insufficient_data',GeneratedAtUtc:time,ReportDateET:'2026-11-11',Strategy:'aggressive_week',Reasons:['近期已確認出賽樣本不足'],Candidates:[{Player:'<script>unsafe</script>',TeamCode:'CLE',Availability:'free_agent',RemainingGames:2,SampleGames7:1,SampleGames14:1,InjuryStatus:null,Recommendation:'等待更多數據',Reasons:['只有一場完整數據'],Tradeoffs:[],DropOptions:[]}],DropReviews:[{Player:'Protected player',TeamCode:'CLE',SampleGames7:3,SampleGames14:6,RemainingGames:2,Review:'保留',Reasons:['來源列為不可移除'],Protected:true}],Sources:[{Name:'NBA official',RetrievedAtUtc:time,SourceUpdatedAtUtc:null,Url:'https://www.nba.com/schedule'}],Week:{Basis:'taipei_calendar',StartDateTaipei:'2026-11-09',EndDateTaipei:'2026-11-15',VerifiedYahooWeek:false},Notes:[]};
globalThis.fetch=async(url,options)=>{const parsed=new URL(url);assert.equal(parsed.origin,'http://127.0.0.1:8760');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');if(parsed.pathname.endsWith('/dashboard.json'))fetchCount++;else if(featureFailure)return new Response('',{status:503});const value={'/data/dashboard.json':fixture,'/data/matchup-history.json':history,'/data/team-week-schedule.json':weekly,'/data/recommendations.json':recommendations}[parsed.pathname];assert.ok(value,'Known public feed');return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});};
const settled=()=>new Promise(resolve=>originalTimeout(resolve,5));
await import(pathToFileURL(path.join(root,'dashboard.mjs')).href);
await settled();
const content=n=>[n.textContent,...n.children.map(content)].join(' ');
assert.equal(elements.rosterRows.children.length,12);
assert.equal(elements.scoreValue.textContent,'7 : 6');
assert.equal(elements.marketRows.children.length,25);
assert.equal(elements.addRows.children.length,21);
assert.equal(elements.scheduleRows.children.length,27);
assert.equal(elements.addsValue.textContent,'未知');
assert.equal(elements.faabValue.textContent,'80');
assert.match(elements.rulesMeta.textContent,/來源最後更新：未知/);
assert.equal(buttons.length,8);buttons.find(b=>b.dataset.tab==='schedule').click();assert.equal(panels.find(p=>p.id==='schedule').hidden,false);assert.ok(panels.filter(p=>p.id!=='schedule').every(p=>p.hidden));
assert.equal(elements.historyRows.children.length,2);assert.match(content(elements.historyRows.children[0]),/9－4－0.*勝/);assert.match(content(elements.historyRows.children[1]),/進行中/);assert.doesNotMatch(content(elements.historyRows.children[1]),/獲勝/);assert.equal(elements.historyWeek.value,'3');assert.match(content(elements.historyCategoryRows),/我方勝/);
assert.match(elements.weeklySchedulePeriod.textContent,/台灣日曆週.*Yahoo.*未確認/);assert.equal(elements.weeklyTeamRows.children.length,2);assert.equal(elements.rosterRows.children[0].children[5].textContent,'2');assert.match(content(elements.weeklyTeamRows.children[1]),/0 0/);assert.match(elements.recommendationState.textContent,/資料不足/);assert.match(content(elements.recommendationCards),/<script>unsafe<\/script>/);assert.equal(elements.recommendationCards.children[0].children[0].tagName,'h3');assert.match(content(elements.dropReviewRows),/保留/);assert.match(content(elements.recommendationSources),/來源最後更新：未知/);
elements.weeklyTeamSearch.value='GSW';elements.weeklyTeamSearch.events.input();assert.equal(elements.weeklyTeamRows.children.length,1);assert.match(content(elements.weeklyTeamRows),/Golden State/);elements.weeklyTeamSearch.value='';elements.weeklyTeamSearch.events.input();
elements.search.value='demin';elements.search.events.input();assert.equal(elements.marketRows.children.length,1);assert.match(content(elements.marketRows),/Egor Dëmin/);
elements.search.value='';elements.filter.value='waivers';elements.filter.events.change();assert.ok(elements.marketRows.children.length<25);assert.ok(elements.marketRows.children.every(r=>content(r).includes('讓渡名單')));
elements.filter.value='all';elements.filter.events.change();
elements.scheduleDate.value='2026-11-13';elements.scheduleDate.events.change();assert.equal(elements.scheduleRows.children.length,4);
fixture=structuredClone(fixture);fixture.Sections.Matchup.Data.OwnScore.Wins=8;fixture.Sections.Matchup.Data.OwnScore.Losses=5;fixture.Sections.Budget.Data.FaabBalance=0;fixture.Sections.Market.Data.Players[0].PercentOwned=0;
fixture.Sections.Transactions.Status='error';fixture.Sections.Transactions.Data=null;fixture.Sections.Transactions.RetrievedAtUtc=null;fixture.Sections.Transactions.ErrorType='DataUnavailable';
await intervals.find(i=>i.ms===300000).fn();await settled();
assert.equal(elements.scoreValue.textContent,'8 : 5');assert.equal(elements.faabValue.textContent,'0');assert.match(content(elements.marketRows.children[0]),/0%/);assert.match(content(elements.addRows),/資料未知/);assert.match(elements.transactionsMeta.textContent,/讀取失敗/);assert.equal(elements.scheduleRows.children.length,4);
fixture=structuredClone(fixture);fixture.Sections.Schedule.Status='partial';fixture.Sections.Schedule.Data.RangeEndDateTaipei='2026-11-18';fixture.Sections.Schedule.Data.UnavailableDates=['2026-11-18'];
await intervals.find(i=>i.ms===300000).fn();await settled();
assert.ok(elements.scheduleDate.children.some(o=>o.value==='2026-11-17'),'Confirmed zero-game day appears in date selector');
assert.ok(elements.scheduleDate.children.some(o=>o.value==='2026-11-18'),'Unavailable day remains selectable');
assert.ok(elements.scheduleDate.children.length<=33,'Calendar selector is bounded to 32 days plus All');
elements.scheduleDate.value='2026-11-17';elements.scheduleDate.events.change();assert.match(content(elements.scheduleRows),/已確認 2026-11-17 沒有排賽/);assert.doesNotMatch(content(elements.scheduleRows),/未知/);
elements.scheduleDate.value='2026-11-18';elements.scheduleDate.events.change();assert.match(content(elements.scheduleRows),/是否有比賽未知/);assert.doesNotMatch(content(elements.scheduleRows),/已確認/);
elements.scheduleDate.value='all';elements.scheduleDate.events.change();assert.equal(elements.scheduleRows.children.length,27);assert.equal(elements.scheduleRows.children[0].children[3].children[0].href,fixture.Sections.Schedule.Data.Games[0].SourceUrl);
fixture=structuredClone(fixture);fixture.Sections.Schedule.Status='ok';fixture.Sections.Schedule.Data.RangeEndDateTaipei='2026-11-14';fixture.Sections.Schedule.Data.UnavailableDates=[];fixture.Sections.Schedule.Data.Games=[];
await intervals.find(i=>i.ms===300000).fn();await settled();
assert.equal(elements.scheduleDate.children.length,3);assert.match(content(elements.scheduleRows),/已確認此查詢範圍沒有排賽/);
elements.scheduleDate.value='2026-11-14';elements.scheduleDate.events.change();assert.match(content(elements.scheduleRows),/已確認 2026-11-14 沒有排賽/);
assert.equal(fetchCount,4);
featureFailure=true;fixture=structuredClone(fixture);fixture.Sections.Budget.Data.FaabBalance=10;await intervals.find(i=>i.ms===300000).fn();await settled();assert.equal(elements.faabValue.textContent,'10');assert.equal(elements.historyRows.children.length,2);assert.match(elements.historyMeta.textContent,/保留上次資料與原時間/);assert.match(elements.weeklyScheduleMeta.textContent,/保留上次資料與原時間/);assert.match(elements.recommendationMeta.textContent,/保留上次報告/);
console.log('Dashboard runtime checks passed: eight tabs, independent history/recommendations/weekly counts, source times, no inferred final winner, safe text nodes, preserved failures, search/filter, verified zero vs unknown.');
