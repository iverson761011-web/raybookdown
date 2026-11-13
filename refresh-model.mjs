// Public status only. A browser link opens GitHub; it does not dispatch a workflow.
export const WORKFLOW_URL='https://github.com/iverson761011-web/raybookdown/actions/workflows/daily-update.yml';
export const WORKFLOW_RUNS_URL='https://api.github.com/repos/iverson761011-web/raybookdown/actions/workflows/daily-update.yml/runs?branch=main&per_page=20';
export const SOURCE_NAMES=Object.freeze(['Rules','Roster','Matchup','Transactions','Budget','Market','Schedule']);
export const REFRESH_PHASES=Object.freeze(['idle','awaiting_trigger','queued','running','success','partial','failed','unconfirmed']);
const REPOSITORY='iverson761011-web/raybookdown';
const WORKFLOW_PATH='.github/workflows/daily-update.yml';
const IDENTITY={League:'Funny League 2026-27',Team:'RayBookDown',Platform:'yahoo',Season:2026};
const SOURCE_STATUSES=['ok','partial','error','unavailable'];
const RUN_STATUSES=['queued','in_progress','completed','waiting','requested','pending'];
const FAILURE_CONCLUSIONS=['failure','cancelled','timed_out','action_required','startup_failure','stale'];
const MINUTE=60000;
function record(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function utc(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19)?v:null;}
function instant(now){const d=now instanceof Date?now:new Date(now??Date.now());if(!Number.isFinite(+d))throw new Error('InvalidRefreshTime');return d;}
function runId(v){return Number.isSafeInteger(v)&&v>0?v:null;}
function sourceStatus(v){return SOURCE_STATUSES.includes(v)?v:null;}
function dashboardValid(v){return record(v)&&v.SchemaVersion===2&&Object.entries(IDENTITY).every(([key,value])=>v[key]===value)&&record(v.Sections);}
function canonicalRunUrl(id){return 'https://github.com/'+REPOSITORY+'/actions/runs/'+id;}
function emptySource(name){return{name,status:'unconfirmed',sourceStatus:null,retrievedAtUtc:null,sourceUpdatedAtUtc:null,checkedAtUtc:null,messageCode:'source_unconfirmed'};}
function atOrAfter(value,threshold,now){const parsed=utc(value);return parsed!==null&&Date.parse(parsed)>=threshold&&Date.parse(parsed)<=+now+2000;}
function sourceCheck(name,s,threshold,now){
 const result={name,status:'unconfirmed',sourceStatus:sourceStatus(s?.Status),retrievedAtUtc:utc(s?.RetrievedAtUtc),sourceUpdatedAtUtc:utc(s?.SourceUpdatedAtUtc),checkedAtUtc:utc(s?.CheckedAtUtc),messageCode:'source_unconfirmed'};
 if(['error','unavailable'].includes(result.sourceStatus)&&atOrAfter(result.checkedAtUtc,threshold,now)){result.status='failed';result.messageCode='source_failed';}
 else if(['ok','partial'].includes(result.sourceStatus)&&atOrAfter(result.retrievedAtUtc,threshold,now)){result.status='fresh';result.messageCode=result.sourceStatus==='partial'?'source_partial':'source_read';}
 else if(result.retrievedAtUtc!==null)result.messageCode='source_retained';
 return result;
}
function leagueCheck(raw,threshold,now){
 const result={name:'LeagueAnalysis',status:'unconfirmed',sourceStatus:sourceStatus(raw?.Status),retrievedAtUtc:utc(raw?.RetrievedAtUtc),sourceUpdatedAtUtc:utc(raw?.SourceUpdatedAtUtc),checkedAtUtc:utc(raw?.GeneratedAtUtc),messageCode:'source_unconfirmed'};
 if(!record(raw)||Object.entries(IDENTITY).filter(([key])=>key!=='Team').some(([key,value])=>raw[key]!==undefined&&raw[key]!==value)||raw.SchemaVersion!==undefined&&raw.SchemaVersion!==1)return emptySource('LeagueAnalysis');
 const generated=atOrAfter(result.checkedAtUtc,threshold,now),read=atOrAfter(result.retrievedAtUtc,threshold,now);
 if(['error','unavailable'].includes(result.sourceStatus)&&generated){result.status='failed';result.messageCode='source_failed';return result;}
 const teams=Array.isArray(raw.Teams)&&raw.Teams.length<=32?raw.Teams:null;
 const count=Number.isInteger(raw.TeamCount)&&raw.TeamCount>0?raw.TeamCount:null;
 const full=teams!==null&&count!==null&&teams.length===count&&teams.every(t=>['Roster','Matchup','Budget'].every(name=>{
  const s=t?.[name];return s?.Status==='ok'&&atOrAfter(s.RetrievedAtUtc,threshold,now);
 }));
 if(generated&&read&&['ok','partial'].includes(result.sourceStatus)&&full){result.status='fresh';result.messageCode=result.sourceStatus==='partial'?'source_partial':'source_read';}
 else if(generated&&read&&['ok','partial'].includes(result.sourceStatus)){result.messageCode='league_sources_unconfirmed';}
 else if(result.retrievedAtUtc!==null)result.messageCode='source_retained';
 return result;
}
function normalizeRun(raw){
 if(!record(raw)||runId(raw.id)===null||raw.head_branch!=='main'||raw.event!=='workflow_dispatch'||!RUN_STATUSES.includes(raw.status)||!utc(raw.created_at))return null;
 if(typeof raw.path==='string'&&raw.path.split('@')[0]!==WORKFLOW_PATH)return null;
 if(raw.head_repository?.full_name!==undefined&&raw.head_repository.full_name!==REPOSITORY)return null;
 const started=utc(raw.run_started_at)??raw.created_at;
 return{id:raw.id,createdAtUtc:raw.created_at,startedAtUtc:started,status:raw.status,conclusion:typeof raw.conclusion==='string'?raw.conclusion:null,url:canonicalRunUrl(raw.id)};
}
function publicRuns(raw){const rows=Array.isArray(raw)?raw:raw?.workflow_runs;if(!Array.isArray(rows)||rows.length>100)return[];return rows.map(normalizeRun).filter(Boolean);}
function initial(now){return{phase:'idle',runId:null,runUrl:null,sourceChecks:[],startedAtUtc:null,updatedAtUtc:now.toISOString(),messageCode:'idle',baselineGeneratedAtUtc:null,baselineRunId:null,baselineKnown:false,workflowStartedAtUtc:null,snapshotGeneratedAtUtc:null};}
export function createSourceRefreshState({now=new Date()}={}){return initial(instant(now));}
export function beginSourceRefresh({now=new Date(),dashboard=null,latestRunId=null,latestRunIds=undefined}={}){
 const date=instant(now),state=initial(date),ids=(Array.isArray(latestRunIds)?latestRunIds.slice(0,100):[]).map(runId).filter(v=>v!==null),single=runId(latestRunId);
 if(single!==null)ids.push(single);
 return{...state,phase:'awaiting_trigger',startedAtUtc:date.toISOString(),messageCode:'awaiting_trigger',baselineGeneratedAtUtc:dashboardValid(dashboard)?utc(dashboard.GeneratedAtUtc):null,baselineRunId:ids.length?Math.max(...ids):null,baselineKnown:single!==null||Array.isArray(latestRunIds),sourceChecks:SOURCE_NAMES.map(emptySource)};
}
/** Observation never starts or retries a workflow and never treats a new GET as a provider refresh. */
export function observeSourceRefresh(previous,{runs=[],dashboard=null,leagueAnalysis=undefined,now=new Date(),fetchSucceeded=true}={}){
 const date=instant(now),state=record(previous)&&REFRESH_PHASES.includes(previous.phase)?{...previous}:initial(date);
 state.updatedAtUtc=date.toISOString();
 if(!utc(state.startedAtUtc))return{...initial(date),messageCode:'idle'};
 const request=Date.parse(state.startedAtUtc),rows=publicRuns(runs);
 // A known ID fence permits small machine-clock differences. Without a fence,
 // only GitHub's one-second timestamp rounding is tolerated, not an old run.
 const tolerance=state.baselineKnown?MINUTE:2000;
 const eligible=rows.filter(r=>(state.baselineRunId===null||r.id>state.baselineRunId)&&Date.parse(r.createdAtUtc)>=request-tolerance&&Date.parse(r.createdAtUtc)<=+date+2000);
 const run=eligible.find(r=>r.id===state.runId)??eligible.sort((a,b)=>Date.parse(b.createdAtUtc)-Date.parse(a.createdAtUtc)||b.id-a.id)[0]??null;
 if(run){state.runId=run.id;state.runUrl=run.url;state.workflowStartedAtUtc=run.startedAtUtc;}
 const threshold=run?Math.max(request-tolerance,Date.parse(run.startedAtUtc)):request;
 state.sourceChecks=SOURCE_NAMES.map(name=>dashboardValid(dashboard)?sourceCheck(name,dashboard.Sections[name],threshold,date):emptySource(name));
 if(leagueAnalysis!==undefined)state.sourceChecks.push(leagueCheck(leagueAnalysis,threshold,date));
 state.snapshotGeneratedAtUtc=dashboardValid(dashboard)?utc(dashboard.GeneratedAtUtc):null;
 if(fetchSucceeded!==true){state.phase='unconfirmed';state.messageCode='status_unavailable';return state;}
 if(!run){state.phase=+date-request>15*MINUTE?'unconfirmed':'awaiting_trigger';state.messageCode=state.phase==='unconfirmed'?'no_new_run':'awaiting_trigger';return state;}
 if(['queued','waiting','requested','pending'].includes(run.status)){state.phase='queued';state.messageCode='queued';return state;}
 if(run.status==='in_progress'){state.phase='running';state.messageCode='running';return state;}
 if(FAILURE_CONCLUSIONS.includes(run.conclusion)){state.phase='failed';state.messageCode='workflow_failed';return state;}
 if(run.conclusion!=='success'){state.phase='unconfirmed';state.messageCode='result_unconfirmed';return state;}
 const generated=state.snapshotGeneratedAtUtc,newSnapshot=atOrAfter(generated,threshold,date)&&(state.baselineGeneratedAtUtc===null||Date.parse(generated)>Date.parse(state.baselineGeneratedAtUtc));
 if(!newSnapshot){state.phase='unconfirmed';state.messageCode='snapshot_unconfirmed';return state;}
 const complete=state.sourceChecks.every(s=>s.status==='fresh'&&s.sourceStatus==='ok');
 state.phase=complete?'success':'partial';state.messageCode=complete?'success':'partial';return state;
}
