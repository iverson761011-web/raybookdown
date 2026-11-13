import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {TARGET,SECTION_NAMES,normalizeDashboard} from '../dashboard-model.mjs';
import {normalizeRecommendations,normalizeLeagueAnalysis} from '../features-model.mjs';
import {generateRecommendations,scoredCategories} from './build-recommendations.mjs';
import {sanitizeCachedDay,scopePlayerGames,normalizePlayerName} from './collect-recommendation-evidence.mjs';

const HOUR=3600000,LIMIT=1048576;
const identity={League:TARGET.League,Platform:TARGET.Platform,Season:TARGET.Season};
const statuses=['ok','partial','error','unavailable'];
const privateKey=/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|secret|password|authorization|cookie|credentials?|bearer|code[_-]?verifier|code[_-]?challenge|state|session|mcp[_-]?session[_-]?id|league[_-]?(?:id|key)|team[_-]?(?:id|key)|player[_-]?(?:id|key)|transaction[_-]?id)$/i;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const clean=(v,max=1000)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v)&&!/^Bearer\s|github_pat_|gh[pousr]_[A-Za-z0-9]{20,}|^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/i.test(v)?v:null;
const utc=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19)?v:null;
const positiveInt=(v,max=1000)=>Number.isInteger(v)&&v>0&&v<=max?v:null;
const fresh=(v,now)=>utc(v)!==null&&Date.parse(v)<=+now&&+now-Date.parse(v)<=36*HOUR;
const selectionKey=v=>typeof v==='string'&&/^team-[a-f0-9]{64}(?:-[1-9][0-9]*)?$/.test(v)?v:null;
function problem(){throw new Error('InvalidLeagueAnalysisInput');}
function assertPublic(root){const stack=[{v:root,d:0}];let count=0;while(stack.length){const {v,d}=stack.pop();if(++count>150000||d>26)problem();if(typeof v==='string'&&!clean(v,10000))problem();if(v&&typeof v==='object')for(const key of Object.keys(v)){if(privateKey.test(key)||['__proto__','constructor','prototype'].includes(key))problem();stack.push({v:v[key],d:d+1});}}}
function absent(checked,error='NotProvided'){return {Status:'unavailable',Source:'Flaim Fantasy / Yahoo',CheckedAtUtc:checked,RetrievedAtUtc:null,SourceUpdatedAtUtc:null,ErrorType:error,Data:null};}
function template(team,checked){return {SchemaVersion:2,...identity,Team:team,GeneratedAtUtc:checked,Sections:Object.fromEntries(SECTION_NAMES.map(name=>[name,absent(checked)]))};}
function normalizeContext(entry,raw,checked){
  const context=template(entry.Team,checked),errors=[];
  for(const name of ['Rules','Market','Roster','Matchup','Budget']){
    const supplied=['Rules','Market'].includes(name)?raw[name]:entry[name];
    if(supplied===undefined||supplied===null)continue;
    const draft=template(entry.Team,checked);draft.Sections[name]=supplied;
    try{context.Sections[name]=normalizeDashboard(draft,{expectedTeam:entry.Team}).Sections[name];}
    catch{context.Sections[name]={...absent(checked,'InvalidLeagueTeamSection'),Status:'error'};errors.push(name);}
  }
  return {context,errors};
}
function validatedLeague(raw,now){
  if(raw===null||raw===undefined)return null;
  assertPublic(raw);
  if(!record(raw)||raw.SchemaVersion!==1||Object.entries(identity).some(([key,value])=>raw[key]!==value)||!statuses.includes(raw.Status)||!utc(raw.CheckedAtUtc)||!Array.isArray(raw.Teams)||raw.Teams.length>32)problem();
  if(raw.TeamCount!==null&&raw.TeamCount!==undefined&&!positiveInt(raw.TeamCount))problem();
  if(raw.CurrentWeek!==null&&raw.CurrentWeek!==undefined&&!positiveInt(raw.CurrentWeek,100))problem();
  if(raw.RetrievedAtUtc!==null&&raw.RetrievedAtUtc!==undefined&&!utc(raw.RetrievedAtUtc))problem();
  const keys=new Set(),teams=[],invalid=[];
  for(const entry of raw.Teams){
    if(!record(entry)||!selectionKey(entry.SelectionKey)||!clean(entry.Team,200)||typeof entry.IsUserTeam!=='boolean'||!statuses.includes(entry.Status)){invalid.push('有球隊的名稱或公開選擇欄位未核實，未列入可選清單。');continue;}
    if(keys.has(entry.SelectionKey))problem();keys.add(entry.SelectionKey);
    const {context,errors}=normalizeContext(entry,raw,raw.CheckedAtUtc);
    teams.push({SelectionKey:entry.SelectionKey,Team:entry.Team,IsUserTeam:entry.IsUserTeam,Status:entry.Status,context,errors});
  }
  return {raw,teams,invalid};
}
function matchupUsable(team,currentWeek,now){const s=team.context.Sections.Matchup;return s.Status==='ok'&&fresh(s.RetrievedAtUtc,now)&&currentWeek!==null&&s.Data?.Week===currentWeek;}
function currentWeekOf(raw){const a=positiveInt(raw.CurrentWeek,100),b=raw.Rules?.Status==='ok'?positiveInt(raw.Rules?.Data?.CurrentWeek,100):null;return a!==null&&b!==null&&a!==b?null:a??b;}
function categoryMap(team,currentWeek,now){
  if(!matchupUsable(team,currentWeek,now))return new Map();
  const result=new Map(),duplicates=new Set();
  for(const c of scoredCategories(team.context.Sections.Matchup.Data)){if(result.has(c.label))duplicates.add(c.label);result.set(c.label,c);}
  for(const label of duplicates)result.delete(label);
  return result;
}
function teamCategories(team,maps,teamCount,teamCountPresent){
  const own=maps.get(team.SelectionKey),labels=new Set([...maps.values()].flatMap(m=>[...m.keys()]));
  return [...labels].map(Label=>{
    const value=own.get(Label),values=[...maps.values()].map(m=>m.get(Label)?.own).filter(v=>typeof v==='number'&&Number.isFinite(v));
    const Direction=value?.stat==='TO'||Label==='TO'?'lower':'higher';
    const ComparedTeamCount=values.length,complete=teamCount!==null&&ComparedTeamCount===teamCount&&teamCountPresent===teamCount;
    const Rank=value?1+values.filter(v=>Direction==='lower'?v<value.own:v>value.own).length:null;
    const threshold=Math.max(1,Math.floor(ComparedTeamCount/3)),tied=values.length>0&&values.every(v=>v===values[0]);
    const Assessment=Rank===null||ComparedTeamCount<4?'unknown':tied?'balanced':Rank<=threshold?'strength':Rank>ComparedTeamCount-threshold?'weakness':'balanced';
    return {Label,OwnValue:value?.own??null,Rank,ComparedTeamCount,Assessment,Direction,CompleteLeagueCoverage:complete};
  }).sort((a,b)=>a.Label.localeCompare(b.Label));
}
function source(name,s){return {Name:name.slice(0,200),RetrievedAtUtc:utc(s?.RetrievedAtUtc),SourceUpdatedAtUtc:utc(s?.SourceUpdatedAtUtc),Url:null};}
function briefSources(report){
  const sourceList=Array.isArray(report?.Sources)?report.Sources:[],hasCurrentInjury=sourceList.some(s=>s.Name==='本次NBA官方傷勢候選現況核對'),preferred=sourceList.filter(s=>s.Name!=='NBA官方比賽統計'&&!(hasCurrentInjury&&s.Name==='NBA官方傷勢報告')&&!s.Name.startsWith('本次Flaim / Yahoo Add額度檢查'));
  return [...preferred,...sourceList.filter(s=>s.Name==='NBA官方比賽統計').slice(0,2)].slice(0,8);
}
function officialRows(history,evidence){
  if(!record(history)||history.SchemaVersion!==1||!Array.isArray(history.Days)||history.Days.length>32)return Array.isArray(evidence?.PlayerGames)?evidence.PlayerGames:[];
  const days=history.Days.flatMap(raw=>{const day=sanitizeCachedDay(raw,raw?.DateET);return day?[day]:[];});
  return days.length?days.flatMap(d=>d.PlayerGames):Array.isArray(evidence?.PlayerGames)?evidence.PlayerGames:[];
}
function unavailableFeed(now){return {SchemaVersion:1,...identity,Status:'unavailable',GeneratedAtUtc:now.toISOString(),RetrievedAtUtc:null,SourceUpdatedAtUtc:null,CurrentWeek:null,TeamCount:null,ComparedTeamCount:0,Teams:[],Notes:['尚未取得可核實的聯盟球隊資料，球隊、優劣勢與補強人選均未知。']};}
export function generateLeagueAnalysis({league=null,evidence=null,history=null,week=null,previous=null,now=new Date()}={}){
  if(!Number.isFinite(+now))problem();
  const validated=validatedLeague(league,now);if(!validated)return unavailableFeed(now);
  const {raw,teams,invalid}=validated,currentWeek=currentWeekOf(raw),teamCount=positiveInt(raw.TeamCount),maps=new Map(teams.map(t=>[t.SelectionKey,categoryMap(t,currentWeek,now)]));
  const compared=teams.filter(t=>maps.get(t.SelectionKey).size>0).length,rows=officialRows(history,evidence);
  const namesInFreshRosters=new Set(teams.flatMap(t=>{const s=t.context.Sections.Roster;return s.Status==='ok'&&fresh(s.RetrievedAtUtc,now)?s.Data.Players.map(p=>normalizePlayerName(p.Player)):[];}));
  const oldEntries=previous?.SchemaVersion===1&&Object.entries(identity).every(([key,value])=>previous[key]===value)&&Array.isArray(previous.Teams)?previous.Teams:[];
  const output=[];
  for(const team of teams){
    const Categories=teamCategories(team,maps,teamCount,teams.length),Strengths=Categories.filter(c=>c.Assessment==='strength').map(c=>`${c.Label}：本週累計在已取得的${c.ComparedTeamCount}隊中並列第${c.Rank}；${c.Direction==='lower'?'較低較佳':'較高較佳'}。`),Weaknesses=Categories.filter(c=>c.Assessment==='weakness').map(c=>`${c.Label}：本週累計在已取得的${c.ComparedTeamCount}隊中並列第${c.Rank}，可列補強觀察。`);
    const Notes=['優劣勢只比較本週目前累計比項，會受已出賽場數影響，不代表長期能力或最終勝負。','比項排名採實際取得且同週的新鮮資料；同值並列，不平均投籃或罰球百分比。'];
    if(Categories.some(c=>!c.CompleteLeagueCoverage))Notes.push('聯盟比較資料未完整；排名分母只代表已核實球隊數，不宣稱已涵蓋全聯盟。');
    if(team.errors.length)Notes.push('部分球隊來源格式未通過檢查，相關欄位保留未知。');
    if(!matchupUsable(team,currentWeek,now))Notes.push('當週週次或比分來源尚未核實、過期或未回傳；本隊比項比較與新補強排序暫停。');
    const context=structuredClone(team.context);
    if(context.Sections.Market.Data){const before=context.Sections.Market.Data.Players;context.Sections.Market.Data.Players=before.filter(p=>!namesInFreshRosters.has(normalizePlayerName(p.Player)));const removed=before.length-context.Sections.Market.Data.Players.length;if(removed)Notes.push('本次市場與所取得的聯盟陣容有'+removed+'名同名球員取得狀態矛盾；不推定哪份快照正確，已從新加入候選排除。');}
    if(!matchupUsable(team,currentWeek,now))context.Sections.Matchup=absent(raw.CheckedAtUtc,'CurrentWeekUnknown');
    const scoped=scopePlayerGames(context,rows,{expectedTeam:team.Team});
    const teamEvidence=evidence?{...evidence,...scoped}:null;
    const old=oldEntries.filter(p=>p?.SelectionKey===team.SelectionKey&&p.Team===team.Team);
    const Recommendations=generateRecommendations({dashboard:context,evidence:teamEvidence,week,previous:old.length===1?old[0].Recommendations:null,previousTeamName:old.length===1?team.Team:null,targetTeamName:team.Team,emphasisCategories:Categories.filter(c=>c.Assessment==='weakness').map(c=>c.Label),now});
    Recommendations.Sources=briefSources(Recommendations);normalizeRecommendations(Recommendations);
    if(Recommendations.Status==='waiting')Notes.push('補強報告可能保留上個已完賽日期；優劣勢表採本次比項快照，各自時間分開標示。');
    const available=['Roster','Matchup','Budget'].filter(key=>team.context.Sections[key].Status==='ok').length;
    const Status=available===0?'unavailable':team.Status==='ok'&&team.errors.length===0&&available===3&&matchupUsable(team,currentWeek,now)&&['Rules','Market','Roster','Budget'].every(key=>team.context.Sections[key].Status==='ok'&&fresh(team.context.Sections[key].RetrievedAtUtc,now))?'ok':'partial';
    output.push({SelectionKey:team.SelectionKey,Team:team.Team,IsUserTeam:team.IsUserTeam,Status,Roster:team.context.Sections.Roster,Matchup:team.context.Sections.Matchup,Budget:team.context.Sections.Budget,Sources:[source('Flaim / Yahoo '+team.Team+' 陣容',team.context.Sections.Roster),source('Flaim / Yahoo '+team.Team+' 當週比分',team.context.Sections.Matchup),source('Flaim / Yahoo '+team.Team+' 取得額度',team.context.Sections.Budget),source('Flaim / Yahoo 聯盟市場',team.context.Sections.Market)],Strengths,Weaknesses,Categories,Recommendations,Notes});
  }
  const hasData=output.some(t=>t.Status!=='unavailable'),Status=!hasData?'unavailable':raw.Status==='ok'&&invalid.length===0&&output.length===teamCount&&output.every(t=>t.Status==='ok')?'ok':'partial';
  const report={SchemaVersion:1,...identity,Status,GeneratedAtUtc:now.toISOString(),RetrievedAtUtc:utc(raw.RetrievedAtUtc),SourceUpdatedAtUtc:null,CurrentWeek:currentWeek,TeamCount:teamCount,ComparedTeamCount:compared,Teams:output,Notes:[...new Set(['只針對所選球隊提出觀察；所有球員操作仍須由各隊管理員自行在Yahoo確認。','可取得球員為Flaim本次回傳清單，不代表完整市場。',...invalid])]};
  assertPublic(report);normalizeLeagueAnalysis(report);if(Buffer.byteLength(JSON.stringify(report),'utf8')>LIMIT)throw new Error('LeagueAnalysisTooLarge');return report;
}
async function readJson(file,max=LIMIT){const bytes=await fs.readFile(file);if(bytes.length>max)problem();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
export async function buildLeagueAnalysis(dashboardPath,{now=new Date()}={}){
  const folder=path.dirname(path.resolve(dashboardPath));normalizeDashboard(await readJson(dashboardPath));
  let league=null,evidence=null,history=null,week=null,previous=null;
  try{league=await readJson(path.join(folder,'league-teams.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const [file,set,max]of [['recommendation-evidence.json',v=>evidence=v,LIMIT],['recommendation-history.json',v=>history=v,8*LIMIT],['team-week-schedule.json',v=>week=v,LIMIT],['league-analysis.json',v=>previous=v,LIMIT]])try{set(await readJson(path.join(folder,file),max));}catch{}
  const report=generateLeagueAnalysis({league,evidence,history,week,previous,now}),output=path.join(folder,'league-analysis.json'),temporary=output+'.'+crypto.randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.rename(temporary,output);}finally{await fs.rm(temporary,{force:true});}
  return {LeagueAnalysisUpdated:true,Status:report.Status,Teams:report.Teams.length,ComparedTeamCount:report.ComparedTeamCount,GeneratedAtUtc:report.GeneratedAtUtc};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await buildLeagueAnalysis(path.resolve(process.argv[2]??'data/dashboard.json'))));}catch{console.error(JSON.stringify({LeagueAnalysisUpdated:false,ErrorType:'LeagueAnalysisBuildFailed'}));process.exitCode=1;}}
