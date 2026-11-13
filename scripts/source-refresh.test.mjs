import test from 'node:test';
import assert from 'node:assert/strict';
import {initSourceRefresh} from '../source-refresh.mjs';
import {WORKFLOW_URL,WORKFLOW_RUNS_URL,SOURCE_NAMES} from '../refresh-model.mjs';
class Element{constructor(){this.children=[];this.events={};this.dataset={};this.textContent='';}replaceChildren(...v){this.children=v;}append(...v){this.children.push(...v);}addEventListener(name,fn){this.events[name]=fn;}}
const initial='2026-11-13T09:00:00Z',read='2026-11-13T10:01:00Z';
const snapshot=stamp=>({SchemaVersion:2,League:'Funny League 2026-27',Team:'RayBookDown',Platform:'yahoo',Season:2026,GeneratedAtUtc:stamp,Sections:Object.fromEntries(SOURCE_NAMES.map(name=>[name,{Status:'ok',CheckedAtUtc:stamp,RetrievedAtUtc:stamp,SourceUpdatedAtUtc:null}]))});
function fixture(){
 const names=['sourceRefreshOpen','sourceRefreshCheck','sourceRefreshStatus','sourceRefreshRows','sourceRefreshRun'],elements=Object.fromEntries(names.map(n=>[n,new Element()]));
 let time=new Date('2026-11-13T10:00:00Z'),current={dashboard:snapshot(initial),lastFileCheck:initial},reloads=0,runRows=[],failure=false,revision=0;
 const calls=[],timers=[];
 const documentImpl={getElementById:id=>elements[id],createElement:()=>new Element(),visibilityState:'visible'};
 const c=initSourceRefresh({documentImpl,windowImpl:null,now:()=>time,readCurrent:()=>current,reloadSnapshots:async()=>{reloads++;if(!failure)current={dashboard:snapshot(read),lastFileCheck:'revision-'+(++revision)};},fetchImpl:async(url,opts)=>{calls.push({url,opts});return failure?new Response('',{status:403}):new Response(JSON.stringify({workflow_runs:runRows}));},setIntervalImpl:fn=>{timers.push(fn);return timers.length;},clearIntervalImpl:()=>{}});
 return{c,elements,calls,timers,get reloads(){return reloads;},get current(){return current;},set time(v){time=new Date(v);},set failure(v){failure=v;},set runs(v){runRows=v;}};
}
const run=(extra={})=>({id:101,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/daily-update.yml',created_at:'2026-11-13T10:00:02Z',run_started_at:'2026-11-13T10:00:02Z',status:'completed',conclusion:'success',...extra});
const content=n=>[n.textContent,...n.children.map(content)].join(' ');
test('opening refresh is only navigation: no automatic provider write, POST or success claim',()=>{
 const f=fixture();assert.equal(f.calls.length,0);f.elements.sourceRefreshOpen.events.click();
 assert.equal(f.c.state.phase,'awaiting_trigger');assert.equal(f.c.state.baselineKnown,false);assert.equal(f.reloads,0);assert.equal(f.calls.length,0);
 assert.equal(f.elements.sourceRefreshOpen.href,WORKFLOW_URL);assert.equal(f.elements.sourceRefreshOpen.rel,'noopener noreferrer');assert.match(f.elements.sourceRefreshStatus.textContent,/尚未確認.*啟動/);f.c.stop();
});
test('queued work never claims data refreshed; verified new run plus source reads can complete',async()=>{
 const f=fixture();f.c.begin();f.time='2026-11-13T10:02:00Z';f.runs=[run({status:'queued',conclusion:null})];await f.c.inspect();assert.equal(f.c.state.phase,'queued');
 f.runs=[run()];await f.c.inspect();assert.equal(f.c.state.phase,'success');assert.equal(f.elements.sourceRefreshRows.children.length,7);assert.match(content(f.elements.sourceRefreshRows),/未知/);
 for(const call of f.calls){assert.equal(call.url,WORKFLOW_RUNS_URL);assert.equal(call.opts.credentials,'omit');assert.equal(call.opts.redirect,'error');assert.equal(call.opts.referrerPolicy,'no-referrer');assert.ok(!call.opts.method||call.opts.method==='GET');assert.ok(!Object.keys(call.opts.headers).some(k=>/authorization/i.test(k)));}f.c.stop();
});
test('HTTP status failure and retained snapshots stay unconfirmed without stamping old source reads as new',async()=>{
 const f=fixture();f.c.begin();f.time='2026-11-13T10:02:00Z';f.failure=true;await f.c.inspect();
 assert.equal(f.c.state.phase,'unconfirmed');assert.equal(f.current.dashboard.GeneratedAtUtc,initial);assert.match(f.elements.sourceRefreshStatus.textContent,/舊快照不會標示/);assert.equal(f.elements.sourceRefreshCheck.disabled,false);f.c.stop();
});
