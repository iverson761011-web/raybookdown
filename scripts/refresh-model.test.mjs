import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE_NAMES,WORKFLOW_URL,WORKFLOW_RUNS_URL,createSourceRefreshState,beginSourceRefresh,observeSourceRefresh} from '../refresh-model.mjs';

const request=new Date('2026-11-13T10:00:00.500Z'),started='2026-11-13T10:00:02Z',read='2026-11-13T10:01:00.1234567+00:00',old='2026-11-13T09:00:00Z',now=new Date('2026-11-13T10:02:00Z');
const section=(overrides={})=>({Status:'ok',CheckedAtUtc:read,RetrievedAtUtc:read,SourceUpdatedAtUtc:null,...overrides});
const dashboard=(overrides={})=>({SchemaVersion:2,League:'Funny League 2026-27',Team:'RayBookDown',Platform:'yahoo',Season:2026,GeneratedAtUtc:read,Sections:Object.fromEntries(SOURCE_NAMES.map(name=>[name,section()])),...overrides});
const run=(overrides={})=>({id:101,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/daily-update.yml',status:'completed',conclusion:'success',created_at:started,run_started_at:started,html_url:'https://evil.test/secret',...overrides});
const begin=()=>beginSourceRefresh({now:request,dashboard:dashboard({GeneratedAtUtc:old}),latestRunId:100});
const observe=(state=begin(),args={})=>observeSourceRefresh(state,{runs:[run()],dashboard:dashboard(),now,...args});
const league=()=>({Status:'ok',GeneratedAtUtc:read,RetrievedAtUtc:read,SourceUpdatedAtUtc:null,TeamCount:1,Teams:[{Roster:section(),Matchup:section(),Budget:section()}]});

test('opening GitHub starts only awaiting-trigger state and contains no credential request',()=>{
 const s=begin();assert.equal(s.phase,'awaiting_trigger');assert.equal(s.runId,null);assert.equal(s.sourceChecks.length,7);assert.ok(s.sourceChecks.every(c=>c.status==='unconfirmed'));
 assert.equal(createSourceRefreshState({now:request}).phase,'idle');
 for(const url of [WORKFLOW_URL,WORKFLOW_RUNS_URL]){assert.equal(new URL(url).username,'');assert.ok(!/token|secret|authorization/i.test(url));}
});
test('an old run, another branch, another workflow and PR/push/schedule runs cannot impersonate manual refresh',()=>{
 for(const changes of [{id:100},{head_branch:'test'},{event:'pull_request'},{event:'push'},{event:'schedule'},{path:'.github/workflows/another.yml'},{head_repository:{full_name:'other/repository'}},{created_at:'2026-11-13T08:00:00Z'}])assert.equal(observe(begin(),{runs:[run(changes)]}).phase,'awaiting_trigger');
});
test('known ID baseline accommodates clock skew while unfenced requests do not accept a minute-old run',()=>{
 const skew=run({created_at:'2026-11-13T09:59:30Z',run_started_at:'2026-11-13T10:00:02Z',status:'queued',conclusion:null});
 assert.equal(observe(begin(),{runs:[skew]}).phase,'queued');
 assert.equal(observe(beginSourceRefresh({now:request,dashboard:dashboard({GeneratedAtUtc:old})}),{runs:[skew]}).phase,'awaiting_trigger');
 assert.equal(beginSourceRefresh({now:request,latestRunIds:[99,102,101]}).baselineRunId,102);
});
test('queued and running phases describe the workflow, not a completed provider read',()=>{
 const q=observe(begin(),{runs:[run({status:'queued',conclusion:null})]});assert.equal(q.phase,'queued');assert.equal(q.runUrl,'https://github.com/iverson761011-web/raybookdown/actions/runs/101');
 assert.equal(observe(q,{runs:[run({status:'in_progress',conclusion:null})]}).phase,'running');
});
test('only a successful run plus a newly generated snapshot and all seven verified source reads is success',()=>{
 const result=observe();assert.equal(result.phase,'success');assert.equal(result.sourceChecks.length,7);assert.ok(result.sourceChecks.every(s=>s.status==='fresh'));
 assert.equal(result.sourceChecks[0].retrievedAtUtc,read);assert.equal(result.sourceChecks[0].sourceUpdatedAtUtc,null);
});
test('successful workflow with cached, unchanged, wrong-league or future JSON stays unconfirmed',()=>{
 for(const value of [dashboard({GeneratedAtUtc:old}),dashboard({League:'Other'}),dashboard({GeneratedAtUtc:'2026-11-13T11:00:00Z'}),null])assert.equal(observe(begin(),{dashboard:value}).phase,'unconfirmed');
 const same=beginSourceRefresh({now:request,dashboard:dashboard(),latestRunId:100});assert.equal(observe(same).phase,'unconfirmed');
});
test('retained or failed sources remain partial and retain original or unknown source times',()=>{
 const d=dashboard();d.Sections.Market=section({Status:'error',RetrievedAtUtc:null});d.Sections.Schedule=section({Status:'partial',RetrievedAtUtc:old});
 const result=observe(begin(),{dashboard:d});assert.equal(result.phase,'partial');
 assert.equal(result.sourceChecks.find(c=>c.name==='Market').status,'failed');assert.equal(result.sourceChecks.find(c=>c.name==='Market').retrievedAtUtc,null);
 assert.equal(result.sourceChecks.find(c=>c.name==='Schedule').status,'unconfirmed');assert.equal(result.sourceChecks.find(c=>c.name==='Schedule').retrievedAtUtc,old);
});
test('a newly read but partial section never produces an all-success claim',()=>{
 const d=dashboard();d.Sections.Market=section({Status:'partial'});const r=observe(begin(),{dashboard:d});assert.equal(r.phase,'partial');assert.equal(r.sourceChecks.find(c=>c.name==='Market').status,'fresh');assert.equal(r.sourceChecks.find(c=>c.name==='Market').sourceStatus,'partial');
});
test('403 or unavailable status reads and unknown completed conclusions are unconfirmed, not false failures',()=>{
 assert.equal(observe(begin(),{fetchSucceeded:false}).phase,'unconfirmed');assert.equal(observe(begin(),{runs:[run({conclusion:null})]}).phase,'unconfirmed');
 assert.equal(observe(begin(),{runs:[run({conclusion:'failure'})]}).phase,'failed');assert.equal(observe(begin(),{runs:[run({conclusion:'cancelled'})]}).phase,'failed');
});
test('optional league analysis must also have fresh source reads for every team',()=>{
 const fresh=league();assert.equal(observe(begin(),{leagueAnalysis:fresh}).phase,'success');
 const stale=league();stale.Teams[0].Roster.RetrievedAtUtc=old;const result=observe(begin(),{leagueAnalysis:stale});assert.equal(result.phase,'partial');assert.equal(result.sourceChecks.length,8);assert.equal(result.sourceChecks.at(-1).status,'unconfirmed');
 const cached=league();cached.RetrievedAtUtc=old;assert.equal(observe(begin(),{leagueAnalysis:cached}).phase,'partial');
});
test('no new run is an unconfirmed request after the observation window, not a failed provider call',()=>{
 const r=observe(begin(),{runs:[],now:new Date('2026-11-13T10:20:00Z')});assert.equal(r.phase,'unconfirmed');assert.equal(r.messageCode,'no_new_run');
});
test('existing matched run is retained and untrusted API links or labels are not copied',()=>{
 const s=observe(begin(),{runs:[run({status:'in_progress',conclusion:null})]});const r=observe(s,{runs:[run({id:102,status:'queued',conclusion:null,created_at:'2026-11-13T10:01:30Z'}),run()]});assert.equal(r.runId,101);assert.equal(r.phase,'success');assert.ok(!JSON.stringify(r).includes('evil.test'));
});
