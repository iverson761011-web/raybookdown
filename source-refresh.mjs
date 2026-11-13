import {beginSourceRefresh,observeSourceRefresh,WORKFLOW_URL,WORKFLOW_RUNS_URL} from './refresh-model.mjs';
import {formatTaipei} from './dashboard-model.mjs';

const SOURCE_NAMES={Rules:'聯盟規則',Roster:'球員名單',Matchup:'比分與各比項',Transactions:'Add／Drop',Budget:'取得額度',Market:'自由市場',Schedule:'NBA 賽程',LeagueAnalysis:'聯盟各隊分析'};
const PHASE_TEXT={idle:'尚未要求來源刷新。',awaiting_trigger:'請在新開的 GitHub 頁面選 main，再按 Run workflow。本站尚未確認雲端工作已啟動。',queued:'已確認新的 main 手動同步正在排隊。',running:'雲端正在向來源讀取資料。完成後會核對新的公開資料與來源時間。',success:'已確認本次雲端讀取與新快照。這代表重新讀取來源，不保證上游已提供即時最新資訊。',partial:'本次刷新有部分來源未取得完整的新資料，請查看下方狀態與時間。',failed:'雲端工作未成功；保留原資料時間，請查看同步紀錄。',unconfirmed:'尚未確認本次的新來源資料。可能仍待啟動、發布或連線核對，舊快照不會標示為已刷新。'};
const TERMINAL=new Set(['success','partial','failed']);
const MAX_WATCH_MS=10*60*1000;

export function initSourceRefresh({readCurrent,reloadSnapshots,fetchImpl=fetch,now=()=>new Date(),documentImpl=document,windowImpl=typeof window==='undefined'?null:window,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}){
  const $=id=>documentImpl.getElementById(id);
  const open=$('sourceRefreshOpen'),check=$('sourceRefreshCheck'),status=$('sourceRefreshStatus'),rows=$('sourceRefreshRows'),runLink=$('sourceRefreshRun');
  if(!open||!check||!status||!rows||!runLink)return null;
  let state=null,busy=false,timer=null,lastRunIds=[],baselineKnown=false;
  open.href=WORKFLOW_URL;open.target='_blank';open.rel='noopener noreferrer';
  runLink.href=WORKFLOW_URL;runLink.target='_blank';runLink.rel='noopener noreferrer';
  function stop(){if(timer!==null){clearIntervalImpl(timer);timer=null;}}
  function render(){
    const phase=state?.phase??'idle';status.textContent=PHASE_TEXT[phase]??PHASE_TEXT.unconfirmed;
    status.dataset.phase=phase;status.className='section-meta'+(['success','idle'].includes(phase)?'':phase==='failed'?' error':' warn');check.disabled=busy||!state;
    runLink.href=state?.runUrl??WORKFLOW_URL;runLink.textContent=state?.runId?'查看本次雲端工作 ↗':'查看雲端同步頁 ↗';
    rows.replaceChildren();
    for(const source of state?.sourceChecks??[]){
      const tr=documentImpl.createElement('tr');
      const label=source.status==='fresh'?(source.sourceStatus==='ok'?'本次已讀取':'本次部分取得'):source.status==='failed'?'本次未取得':'尚未確認新讀取';
      for(const value of [SOURCE_NAMES[source.name]??source.name,label,formatTaipei(source.retrievedAtUtc),formatTaipei(source.sourceUpdatedAtUtc)]){const td=documentImpl.createElement('td');td.textContent=value;tr.append(td);}rows.append(tr);
    }
    if(!rows.children.length){const tr=documentImpl.createElement('tr'),td=documentImpl.createElement('td');td.colSpan=4;td.className='empty';td.textContent='啟動來源刷新後，這裡會核對各項來源時間。';tr.append(td);rows.append(tr);}
  }
  async function runs(){
    const response=await fetchImpl(WORKFLOW_RUNS_URL,{cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/vnd.github+json'}});
    if(!response.ok)throw new Error('RefreshStatusUnavailable');
    const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>524288)throw new Error('RefreshStatusUnavailable');
    const payload=await response.json();if(!Array.isArray(payload.workflow_runs)||payload.workflow_runs.length>20)throw new Error('RefreshStatusUnavailable');
    return payload.workflow_runs;
  }
  async function inspect(){
    if(!state||busy)return;busy=true;render();let runRows=[],runRead=false,snapshotRead=false;
    try{runRows=await runs();runRead=true;lastRunIds=runRows.map(r=>r.id).filter(Number.isSafeInteger);baselineKnown=true;}catch{}
    try{const before=readCurrent()?.lastFileCheck;await reloadSnapshots();const after=readCurrent();snapshotRead=typeof after?.lastFileCheck==='string'&&after.lastFileCheck!==before;}catch{}
    const current=readCurrent()??{};
    state=observeSourceRefresh(state,{runs:runRows,dashboard:current.dashboard,leagueAnalysis:current.leagueAnalysis,now:now(),fetchSucceeded:runRead&&snapshotRead});
    busy=false;render();if(TERMINAL.has(state.phase)||+now()-Date.parse(state.startedAtUtc)>MAX_WATCH_MS)stop();
  }
  function begin(){
    stop();const current=readCurrent()??{};
    state=beginSourceRefresh({now:now(),dashboard:current.dashboard,...(baselineKnown?{latestRunId:lastRunIds.length?Math.max(...lastRunIds):null,latestRunIds:lastRunIds}:{})});
    render();timer=setIntervalImpl(()=>{if(documentImpl.visibilityState!=='hidden')void inspect();},30000);
    // Opening the link is only navigation; the owner starts the workflow in GitHub.
  }
  open.addEventListener('click',begin);check.addEventListener('click',()=>void inspect());
  if(windowImpl?.addEventListener)windowImpl.addEventListener('focus',()=>{if(state&&!TERMINAL.has(state.phase))void inspect();});
  render();return {inspect,begin,stop,get state(){return state;}};
}
