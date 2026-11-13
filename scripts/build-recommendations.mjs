import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {normalizePlayerName} from './collect-recommendation-evidence.mjs';
import {resolveTeam} from './build-weekly-schedule.mjs';
import {addDays,taipeiDate} from './update-nba-schedule.mjs';
import {normalizeDashboard} from '../dashboard-model.mjs';
import {normalizeRecommendations} from '../features-model.mjs';

const DAY=86400000,HOUR=3600000;
const STATS=['MIN','FGM','FGA','FTM','FTA','3PTM','PTS','OREB','DREB','REB','AST','ST','BLK','TO','DD'];
const CATEGORIES={'MIN':'MIN','FG%':'FG%','FT%':'FT%','3PTM':'3PTM','3PM':'3PTM','PTS':'PTS','OREB':'OREB','DREB':'DREB','REB':'REB','AST':'AST','ST':'ST','STL':'ST','BLK':'BLK','TO':'TO','A/T':'A/T','AST/TO':'A/T','DD':'DD'};
const clean=(v,max=300)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v)&&!/github_pat_|gh[pousr]_[A-Za-z0-9]{20,}|^Bearer\s|^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/i.test(v)?v:null;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v?v:null;
const time=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const uniq=values=>[...new Set(values.filter(v=>typeof v==='string'))];
const etDate=now=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
const fresh=(value,now,hours)=>time(value)!==null&&Date.parse(value)<=+now&&+now-Date.parse(value)<=hours*HOUR;
const bool=v=>typeof v==='boolean'?v:null;
function sourceUrl(value){if(value===null)return null;let u;try{u=new URL(value);}catch{return null;}if(u.protocol!=='https:'||!(u.hostname==='nba.com'||u.hostname.endsWith('.nba.com'))||u.username||u.password||u.hash)return null;if(u.search&&!(u.pathname==='/games'&&Array.from(u.searchParams.keys()).length===1&&date(u.searchParams.get('date'))))return null;return u.href;}
function section(dashboard,name){const s=dashboard?.Sections?.[name];return s&&s.Status==='ok'&&s.Data&&typeof s.Data==='object'?s:null;}
function addAllowance(dashboard,now){
  const values=['Budget','Transactions'].flatMap(name=>{const s=section(dashboard,name),value=s?.Data?.AddsRemainingThisWeek;return s&&fresh(s.RetrievedAtUtc,now,36)&&Number.isInteger(value)&&value>=0&&value<=1000?[value]:[];});
  const zero=values.includes(0),inconsistent=new Set(values).size>1;
  return {hold:zero||inconsistent,zero,inconsistent,unknown:values.length===0,reason:zero?'已核實本週剩餘Add為0，暫停新加入優先排序；保留觀察而不承諾可加入。':inconsistent?'新鮮的Add額度來源互相不一致，採保守暫停新加入優先排序。':null};
}
function dayFinal(day){return day?.CoverageVerified===true&&Array.isArray(day.Games)&&((day.Status==='no_games'&&day.Games.length===0)||(day.Status==='final'&&day.Games.length>0&&day.Games.every(g=>g?.Status==='final'&&Array.isArray(g.Teams)&&g.Teams.length===2&&g.Teams.every(t=>number(t.Score)!==null))));}
function playerCode(value,week){const mapped=typeof value==='string'?week?.TeamCodeAliases?.[value.trim().toUpperCase()]:null;return resolveTeam(mapped??value)?.TeamCode??null;}
function weekInfo(week){return {Basis:['yahoo_verified','taipei_calendar'].includes(week?.PeriodBasis)?week.PeriodBasis:null,StartDateTaipei:date(week?.RangeStartDateTaipei),EndDateTaipei:date(week?.RangeEndDateTaipei),VerifiedYahooWeek:week?.YahooWeekBoundsKnown===true};}
function baseReport(evidence,week,now){return {SchemaVersion:1,Status:'insufficient_data',GeneratedAtUtc:now.toISOString(),ReportDateET:date(evidence?.TargetNbaDateET),Strategy:'aggressive_week',Reasons:[],Candidates:[],DropReviews:[],Sources:[],Week:weekInfo(week),Notes:['以下為7/14日樣本與排定場次的情境估算，非實際出賽或類別勝率保證。','對手後續增量、可用欄位、每週Add餘額與操作合法性仍需在Yahoo確認。']};}
function safePrevious(previous,now,target){
  try{normalizeRecommendations(previous);}catch{return null;}
  if(previous?.SchemaVersion!==1||previous.Strategy!=='aggressive_week'||!time(previous.GeneratedAtUtc)||Date.parse(previous.GeneratedAtUtc)>+now||!date(previous.ReportDateET)||previous.ReportDateET>=target||previous.ReportDateET>etDate(now)||!Array.isArray(previous.Candidates)||previous.Candidates.length>8)return null;
  const strings=v=>Array.isArray(v)?v.map(x=>clean(x,1500)).filter(Boolean).slice(0,30):[];
  const candidates=previous.Candidates.filter(c=>clean(c?.Player,200)).map(c=>({Player:clean(c.Player,200),TeamCode:clean(c.TeamCode,12),Availability:['free_agent','waivers'].includes(c.Availability)?c.Availability:null,RemainingGames:number(c.RemainingGames),SampleGames7:number(c.SampleGames7),SampleGames14:number(c.SampleGames14),InjuryStatus:clean(c.InjuryStatus,200),Recommendation:clean(c.Recommendation,1000)??'舊報告，等待更新',Reasons:strings(c.Reasons),Tradeoffs:strings(c.Tradeoffs),DropOptions:[]}));
  const reviews=Array.isArray(previous.DropReviews)?previous.DropReviews.filter(d=>clean(d?.Player,200)).slice(0,100).map(d=>({Player:clean(d.Player,200),TeamCode:clean(d.TeamCode,12),SampleGames7:number(d.SampleGames7),SampleGames14:number(d.SampleGames14),RemainingGames:number(d.RemainingGames),Review:clean(d.Review??d.Recommendation,600)??'舊報告觀察項目，非新移除指示',Reasons:strings(d.Reasons),Protected:bool(d.Protected)})):[];
  return {SchemaVersion:1,Status:'waiting',GeneratedAtUtc:previous.GeneratedAtUtc,ReportDateET:previous.ReportDateET,Strategy:'aggressive_week',Reasons:strings(previous.Reasons),Candidates:candidates,DropReviews:reviews,Sources:Array.isArray(previous.Sources)?previous.Sources.slice(0,100).map(s=>({Name:clean(s?.Name,200)??'舊報告來源',RetrievedAtUtc:time(s?.RetrievedAtUtc),SourceUpdatedAtUtc:time(s?.SourceUpdatedAtUtc),Url:sourceUrl(s?.Url)})):[],Week:{Basis:['yahoo_verified','taipei_calendar'].includes(previous.Week?.Basis)?previous.Week.Basis:null,StartDateTaipei:date(previous.Week?.StartDateTaipei),EndDateTaipei:date(previous.Week?.EndDateTaipei),VerifiedYahooWeek:previous.Week?.VerifiedYahooWeek===true},Notes:strings(previous.Notes)};
}
function validatePreservedWaiting(report,dashboard,now,evidence,week){
  const roster=section(dashboard,'Roster'),market=section(dashboard,'Market');
  const rosterFresh=roster&&fresh(roster.RetrievedAtUtc,now,36)&&Array.isArray(roster.Data.Players);
  const marketFresh=market&&fresh(market.RetrievedAtUtc,now,36)&&Array.isArray(market.Data.Players);
  const oldSource=name=>report.Sources.find(s=>s.Name==='Flaim / Yahoo '+name)?.RetrievedAtUtc;
  const oldFresh=fresh(report.GeneratedAtUtc,now,36)&&fresh(oldSource('Roster'),now,36)&&fresh(oldSource('Market'),now,36);
  const common=[];
  const oldWeek=report.Week,currentWeek=weekInfo(week),today=taipeiDate(now);
  const oldStart=date(oldWeek?.StartDateTaipei),oldEnd=date(oldWeek?.EndDateTaipei),currentStart=date(currentWeek.StartDateTaipei),currentEnd=date(currentWeek.EndDateTaipei);
  const periodsKnown=oldStart&&oldEnd&&currentStart&&currentEnd&&oldStart<=oldEnd&&currentStart<=currentEnd&&['yahoo_verified','taipei_calendar'].includes(oldWeek?.Basis)&&['yahoo_verified','taipei_calendar'].includes(currentWeek.Basis)&&(oldWeek.Basis!=='yahoo_verified'||oldWeek.VerifiedYahooWeek===true)&&(currentWeek.Basis!=='yahoo_verified'||currentWeek.VerifiedYahooWeek===true);
  if(!periodsKnown)common.push('原報告或目前的週日期範圍／基準未核實；舊場次只供回看，暫停沿用舊加入優先排序。');
  else if(oldEnd<today||oldStart>today)common.push('原報告期間已非目前台灣日期所在範圍；保留原場次供回看，暫停沿用舊加入優先排序。');
  else if(oldStart!==currentStart||oldEnd!==currentEnd||oldWeek.Basis!==currentWeek.Basis)common.push('原報告與目前的週日期範圍或基準不同；尚未重算新週場次，暫停沿用舊加入優先排序。');
  if(!oldFresh)common.push('原報告產生時間或原陣容／市場來源超過36小時、時間未知；舊表現比較只能觀察，不沿用加入優先順序。');
  if(!rosterFresh||!marketFresh)common.push('目前陣容或市場來源不可用、過期或缺少完整名單；目前取得狀態未知。');
  for(const candidate of report.Candidates){
    const key=normalizePlayerName(candidate.Player),owned=rosterFresh&&roster.Data.Players.some(p=>normalizePlayerName(p?.Player??'')===key);
    const matches=marketFresh?market.Data.Players.filter(p=>normalizePlayerName(p?.Player??'')===key):[];
    const reasons=[...common];
    if(owned)reasons.push('目前新鮮陣容已持有這名球員，舊報告不再作為新加入候選。');
    if(matches.length!==1)reasons.push('目前回傳市場名單未找到唯一、完整姓名相符的可核實記錄，不能假設仍可加入。');
    else if(matches[0].Availability!=='free_agent')reasons.push('目前市場已是讓渡名單或取得方式未知，舊報告不代表可立即加入。');
    if(matches.length===1&&candidate.TeamCode&&resolveTeam(matches[0].TeamCode)?.TeamCode!==resolveTeam(candidate.TeamCode)?.TeamCode)reasons.push('目前與原報告球隊來源不一致；原排程與表現估算未重算，僅列觀察。');
    if(!owned&&marketFresh&&matches.length===1){const injury=injuryCheck({player:matches[0],key},evidence,week,now);candidate.InjuryStatus=injury.label;if(!injury.safe)reasons.push('目前官方傷勢或適用報告未通過核對，舊報告不代表仍可出賽：'+injury.reason);else if(!injury.medicalKnown&&candidate.Recommendation.includes('可評估加入'))candidate.Recommendation='條件式觀察舊報告：目前醫療狀態未知，需先核對出賽；原表現估算未重算。';}
    candidate.Availability=!owned&&marketFresh&&matches.length===1&&['free_agent','waivers'].includes(matches[0].Availability)?matches[0].Availability:null;
    candidate.DropOptions=[];
    if(reasons.length){candidate.Recommendation='觀察舊報告：目前取得狀態或來源年齡未通過核對，暫停沿用舊加入優先排序';candidate.Reasons=uniq([...candidate.Reasons,...reasons]);}
  }
  for(const review of report.DropReviews){
    const matches=rosterFresh?roster.Data.Players.filter(p=>normalizePlayerName(p?.Player??'')===normalizePlayerName(review.Player)):[];
    const current=matches.length===1?protectedFlag(matches[0]):null;
    review.Protected=current;
    if(current===true)review.Review='保留：目前Yahoo標示不可丟棄；原報告表現比較未重算。';
    else if(current===null){review.Review='觀察舊報告：目前持有狀態或保護欄位未知，不能視為可移除。';review.Reasons=uniq([...review.Reasons,'目前陣容／不可丟棄欄位未核實；舊保護標記不作為現在的移除依據。']);}
  }
  const prefix='本次Flaim / Yahoo候選現況核對 ';
  const sources=['Roster','Market'].map(name=>{const s=section(dashboard,name);return {Name:prefix+name,RetrievedAtUtc:time(s?.RetrievedAtUtc),SourceUpdatedAtUtc:time(s?.SourceUpdatedAtUtc),Url:null};});
  const injurySource={Name:'本次NBA官方傷勢候選現況核對',RetrievedAtUtc:time(evidence?.Injuries?.RetrievedAtUtc),SourceUpdatedAtUtc:time(evidence?.Injuries?.ReportIssuedAtUtc),Url:sourceUrl(evidence?.Injuries?.SourceUrl)};
  report.Sources=[...sources,injurySource,...report.Sources.filter(s=>!s.Name.startsWith(prefix)&&s.Name!==injurySource.Name)].slice(0,100);
  if(common.length)report.Reasons=uniq([...report.Reasons,...common]);
  report.Notes=uniq([...report.Notes,'等待期間只另行核對目前持有／取得狀態、官方傷勢與保護標記；原GeneratedAtUtc、報告日期、樣本、剩餘場次及表現估算均未更新，也未產生新排序。']);
  return report;
}
function historyComplete(evidence,start,end){const verified=new Set(evidence?.History?.VerifiedDates??[]),missing=new Set([...(evidence?.History?.UnavailableDates??[]),...(evidence?.History?.MissingBoxScoreDates??[])]);for(let d=start;d<=end;d=addDays(d,1))if(!verified.has(d)||missing.has(d))return false;return true;}
function playerCoverage(evidence,rows,code,start,end){
  if(!Array.isArray(evidence?.History?.Games))return historyComplete(evidence,start,end);
  const verified=new Set(evidence.History.VerifiedDates??[]),unavailable=new Set(evidence.History.UnavailableDates??[]);
  for(let d=start;d<=end;d=addDays(d,1))if(!verified.has(d)||unavailable.has(d))return false;
  if(!code||rows.some(r=>r.DateET>=start&&r.DateET<=end&&resolveTeam(r.TeamCode)?.TeamCode!==code))return false;
  for(const game of evidence.History.Games){
    if(!/^002\d{7}$/.test(game?.GameId??'')||!date(game.DateET)||game.DateET<start||game.DateET>end)continue;
    const involved=Array.isArray(game.Teams)&&game.Teams.some(t=>resolveTeam(t?.Code??t?.Name)?.TeamCode===code);
    if(!involved)continue;
    if(game.Status!=='final'||game.Teams.some(t=>number(t.Score)===null))return false;
    const row=rows.find(r=>r.GameId===game.GameId&&r.DateET===game.DateET);
    if(!row||row.Played!==false&&!(row.Played===true&&STATS.every(k=>number(row.Stats?.[k])!==null)))return false;
  }
  return true;
}
function mean(rows){const result={};for(const key of STATS)result[key]=rows.length&&rows.every(r=>number(r.Stats?.[key])!==null)?rows.reduce((n,r)=>n+r.Stats[key],0)/rows.length:null;return result;}
function protectedFlag(player){return bool(player?.IsUndroppable)??bool(player?.Protected);}
function inspectPlayer(player,evidence,week,reportDate,now,nameCounts){
  const key=normalizePlayerName(player.Player),ambiguous=new Set([...(evidence?.PlayerScope?.AmbiguousPlayers??[]),...(evidence?.PlayerScope?.IdentityUnknownPlayers??[])].map(normalizePlayerName));
  // NBA's 002 series identifies regular-season games; preseason/exhibitions cannot seed a decline baseline.
  const matches=(Array.isArray(evidence?.PlayerGames)?evidence.PlayerGames:[]).filter(r=>typeof r?.GameId==='string'&&/^002\d{7}$/.test(r.GameId)&&normalizePlayerName(r?.Player??'')===key&&date(r.DateET)&&r.DateET<=reportDate&&r.DateET>=addDays(reportDate,-27)&&(!r.RetrievedAtUtc||fresh(r.RetrievedAtUtc,now,24*370)));
  const ids=new Set(matches.map(r=>typeof r.OfficialPlayerId==='string'&&/^\d{1,12}$/.test(r.OfficialPlayerId)?r.OfficialPlayerId:null).filter(Boolean));
  const identity=ids.size===1&&!ambiguous.has(key)&&nameCounts.get(key)===1,officialId=identity?[...ids][0]:null;
  const distinct=new Map();for(const row of matches)if(row.OfficialPlayerId===officialId&&typeof row.GameId==='string'){
    const k=row.GameId;if(distinct.has(k)&&JSON.stringify(distinct.get(k).Stats)!==JSON.stringify(row.Stats)){ambiguous.add(key);continue;}distinct.set(k,row);
  }
  const identityKnown=identity&&!ambiguous.has(key),all=identityKnown?[...distinct.values()].sort((a,b)=>a.DateET.localeCompare(b.DateET)):[];
  const rows=all.filter(r=>r.Played===true&&number(r.Stats?.MIN)!==null&&r.Stats.MIN>0),last=all.at(-1);
  const currentCode=playerCode(player.TeamCode,week),officialCode=playerCode(last?.TeamCode,week),consistent=!!currentCode&&!!officialCode&&currentCode===officialCode;
  const entry=Array.isArray(week?.Teams)?week.Teams.find(t=>t.TeamCode===currentCode):null;
  const remaining=consistent&&week?.CoverageVerified===true&&fresh(week.CheckedAtUtc,now,36)?number(entry?.RemainingGames):null;
  const window=(offset,span)=>rows.filter(r=>r.DateET>=addDays(reportDate,offset-span+1)&&r.DateET<=addDays(reportDate,offset));
  const w7=window(0,7),w14=window(0,14),p7=window(-7,7),p14=window(-14,14);
  const enough=identityKnown&&w7.length>=3&&w14.length>=3&&playerCoverage(evidence,all,currentCode,addDays(reportDate,-13),reportDate);
  const a7=mean(w7),a14=mean(w14),projection={};for(const stat of STATS)projection[stat]=a7[stat]!==null&&a14[stat]!==null?.65*a7[stat]+.35*a14[stat]:null;
  const reasons=[];if(!identityKnown)reasons.push('完整姓名尚未連到唯一的官方球員ID，或來源存在同名歧義。');if(!consistent)reasons.push('最新官方比賽球隊與Yahoo球隊代碼不一致或缺少，未推定轉隊；場次未知。');if(!enough)reasons.push('7/14日樣本各需至少3場，且觀察期間官方比分與統計覆蓋需完整。');if(remaining===null)reasons.push('本週剩餘排定場次尚未完整核實。');
  return {player,key,identityKnown,consistent,remaining,w7,w14,p7,p14,a7,a14,projection,enough,reasons,all,currentCode,Protected:protectedFlag(player)};
}
function injuryCheck(inspect,evidence,week,now){
  const injuries=evidence?.Injuries,code=playerCode(inspect.player.TeamCode,week),today=etDate(now);
  if(!code||!['available','partial'].includes(injuries?.Status)||!fresh(injuries.ReportIssuedAtUtc,now,26))return {label:'未知：缺少26小時內可核實的官方傷勢報告',safe:false,reason:'最新官方傷勢報告不完整、過期或球隊未知，僅列觀察。'};
  const reports=(Array.isArray(injuries.TeamReports)?injuries.TeamReports:[]).filter(t=>resolveTeam(t?.TeamName)?.TeamCode===code&&date(t.GameDateET)&&t.GameDateET>=today);
  const submitted=reports.filter(t=>t.Submitted===true),unsubmitted=reports.some(t=>t.Submitted===false)||(injuries.UnsubmittedTeams??[]).some(t=>resolveTeam(t)?.TeamCode===code);
  if(!submitted.length||unsubmitted)return {label:'未知：球隊尚未確認提交適用的官方報告',safe:false,reason:'未以沒有傷勢列項推定健康；需等球隊適用日期報告。'};
  const dates=new Set(submitted.map(t=>t.GameDateET)),rows=(injuries.Players??[]).filter(r=>normalizePlayerName(r?.Player??'')===inspect.key&&resolveTeam(r?.TeamName)?.TeamCode===code&&dates.has(r.GameDateET));
  const statuses=uniq(rows.map(r=>r.Status)),risk=['Out','Doubtful','Questionable'].find(s=>statuses.includes(s));
  if(risk)return {label:risk,safe:false,reason:'官方標示Out／Doubtful／Questionable者僅觀察，不列優先加入排序。'};
  if(statuses.some(s=>!['Available','Probable'].includes(s)))return {label:'未知：官方狀態無法解讀',safe:false,reason:'傷勢狀態未知。'};
  if(!rows.length)return {label:'醫療未知（球隊已提交、未列名；不代表健康）',safe:true,medicalKnown:false,reason:'已核實球隊提交適用日期報告，但未列名並非健康確認；只可做醫療未知的條件情境，降低信心。'};
  return {label:statuses.includes('Probable')?'Probable':'Available',safe:true,medicalKnown:true,reason:'依本次官方報告狀態評估，仍非實際出賽保證。'};
}
function numericStat(value){if(typeof value==='number'&&Number.isFinite(value))return value;if(typeof value==='string'&&/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))return Number(value);return null;}
export function scoredCategories(matchup){return (Array.isArray(matchup?.Categories)?matchup.Categories:[]).flatMap(c=>{const stat=CATEGORIES[c?.Label],own=numericStat(c?.OwnValue),opponent=numericStat(c?.OpponentValue);if(!stat||c.DisplayOnly===true||!['win','loss','tie'].includes(c.Result)||own===null||opponent===null)return [];const scale=stat==='FG%'?.03:stat==='FT%'?.05:stat==='A/T'?.3:Math.max(1,Math.max(Math.abs(own),Math.abs(opponent))*.15);return [{stat,label:c.Label,own,opponent,scale,weight:1/(1+Math.abs(own-opponent)/scale)*(c.Result==='loss'?1.15:c.Result==='tie'?1.2:1)}];});}
function attempts(matchup,label){const row=matchup?.Categories?.find(c=>c.Label===label);const m=typeof row?.OwnValue==='string'?/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(row.OwnValue):null;return m&&Number(m[2])>0&&Number(m[1])<=Number(m[2])?[Number(m[1]),Number(m[2])]:null;}
export function compareProjection(candidate,drop,categories,matchup){
  const rows=[];let score=0,weight=0;
  for(const category of categories){
    const {stat}=category;let delta=null;
    if(['FG%','FT%','A/T'].includes(stat)){
      const keys=stat==='FG%'?['FGM','FGA']:stat==='FT%'?['FTM','FTA']:['AST','TO'];
      const base=stat==='A/T'?[numericStat(matchup?.Categories?.find(c=>c.Label==='AST')?.OwnValue),numericStat(matchup?.Categories?.find(c=>c.Label==='TO')?.OwnValue)]:attempts(matchup,stat==='FG%'?'FGM/A':'FTM/A');
      if(base&&base.every(v=>v!==null)&&keys.every(k=>number(candidate.projection[k])!==null&&number(drop.projection[k])!==null)){
        const ca=base[1]+candidate.projection[keys[1]]*candidate.remaining,da=base[1]+drop.projection[keys[1]]*drop.remaining;
        if(ca>0&&da>0)delta=(base[0]+candidate.projection[keys[0]]*candidate.remaining)/ca-(base[0]+drop.projection[keys[0]]*drop.remaining)/da;
      }
    }else if(number(candidate.projection[stat])!==null&&number(drop.projection[stat])!==null)delta=candidate.projection[stat]*candidate.remaining-drop.projection[stat]*drop.remaining;
    if(delta===null)continue;
    const gain=delta*(stat==='TO'?-1:1);score+=gain/category.scale*category.weight;weight+=category.weight;rows.push({stat,delta,gain,impact:gain/category.scale*category.weight});
  }
  return {score:weight?score/weight:null,rows,complete:rows.length===categories.length};
}
function trend(inspect,categories,evidence,reportDate){
  if(!inspect.enough||inspect.p7.length<3||inspect.p14.length<3||!playerCoverage(evidence,inspect.all,inspect.currentCode,addDays(reportDate,-27),reportDate))return {declining:false,reason:'沒有足夠的前7/14日基準，不以一場低迷判定該移除。'};
  const before7=mean(inspect.p7),before14=mean(inspect.p14),cats=categories.filter(c=>!['FG%','FT%','A/T','TO'].includes(c.stat));
  const ratios=(current,before)=>{let sum=0,weights=0;for(const c of cats)if(number(current[c.stat])!==null&&number(before[c.stat])>0){sum+=current[c.stat]/before[c.stat]*c.weight;weights+=c.weight;}return weights?sum/weights:null;};
  const ratio7=ratios(inspect.a7,before7),ratio14=ratios(inspect.a14,before14),individual=inspect.w7.map(r=>ratios(r.Stats,before7)).filter(v=>v!==null).sort((a,b)=>a-b),median=individual.length?individual[Math.floor(individual.length/2)]:null;
  const declining=ratio7!==null&&ratio14!==null&&ratio7<.8&&ratio14<.8&&individual.filter(v=>v<.8).length>=2&&median!==null&&median<.8;
  return {declining,reason:declining?'7日與14日相對各自前窗的加權產出均下滑超過20%，且多場／中位數同向；仍需比較換人代價。':'尚未同時達到兩觀察窗與多場下滑條件，保留觀察，不因單場低迷建議移除。'};
}
function formatDelta(row){const signed=(row.delta>=0?'+':'')+(Math.abs(row.delta)<1?row.delta.toFixed(3):row.delta.toFixed(1));return row.stat==='TO'?`TO估計差${signed}（失誤較少較好）`:`${row.stat}估計差${signed}`;}
function sourcesFor(report,dashboard,evidence,week,reportDate){
  const sources=[];for(const key of ['Roster','Market','Matchup','Budget','Transactions']){const s=dashboard?.Sections?.[key];if(s)sources.push({Name:'Flaim / Yahoo '+key,RetrievedAtUtc:time(s?.RetrievedAtUtc),SourceUpdatedAtUtc:time(s?.SourceUpdatedAtUtc),Url:null});}
  const reportedDay=evidence?.LastCompletedDay?.DateET===reportDate?evidence.LastCompletedDay.Day:evidence?.Day;
  sources.push({Name:'NBA官方完整比賽日',RetrievedAtUtc:time(reportedDay?.RetrievedAtUtc),SourceUpdatedAtUtc:null,Url:sourceUrl('https://www.nba.com/games?date='+reportDate)});
  sources.push({Name:'NBA官方傷勢報告',RetrievedAtUtc:time(evidence?.Injuries?.RetrievedAtUtc),SourceUpdatedAtUtc:time(evidence?.Injuries?.ReportIssuedAtUtc),Url:sourceUrl(evidence?.Injuries?.SourceUrl)});
  sources.push({Name:'NBA官方週賽程',RetrievedAtUtc:time(week?.RetrievedAtUtc),SourceUpdatedAtUtc:time(week?.SourceUpdatedAtUtc),Url:sourceUrl(week?.TeamCatalogSourceUrl)});
  const seen=new Set();for(const row of [...(evidence?.PlayerGames??[])].filter(r=>/^002\d{7}$/.test(r?.GameId??'')&&date(r?.DateET)&&r.DateET<=reportDate&&r.DateET>=addDays(reportDate,-27)&&(!time(r.RetrievedAtUtc)||Date.parse(r.RetrievedAtUtc)<=Date.parse(report.GeneratedAtUtc))).sort((a,b)=>b.DateET.localeCompare(a.DateET))){const url=sourceUrl(row.SourceUrl);if(url&&!seen.has(url)){seen.add(url);sources.push({Name:'NBA官方比賽統計',RetrievedAtUtc:time(row.RetrievedAtUtc),SourceUpdatedAtUtc:null,Url:url});if(seen.size>=64)break;}}
  report.Sources=sources;
}
export function generateRecommendations({dashboard,evidence,week,previous=null,now=new Date(),targetTeamName='RayBookDown',previousTeamName=null,emphasisCategories=[]}={}){
  const report=baseReport(evidence,week,now),target=date(evidence?.TargetNbaDateET);
  if(!clean(targetTeamName,200)||dashboard?.League!=='Funny League 2026-27'||dashboard?.Team!==targetTeamName||dashboard?.Platform!=='yahoo'||dashboard?.Season!==2026||!target||target>etDate(now)){report.Status='unavailable';report.Reasons=['聯盟、所選球隊或官方目標日期無法核實；未使用未來資料。'];return report;}
  if(previousTeamName!==null&&previousTeamName!==targetTeamName||targetTeamName!=='RayBookDown'&&previousTeamName!==targetTeamName)previous=null;
  const allowance=addAllowance(dashboard,now);
  let reportDate=target,backfilled=false;
  if(evidence?.Day?.Status==='waiting'){
    const old=safePrevious(previous,now,target);
    if(old){
      old.Notes=uniq([...old.Notes,`目前目標美東${target}尚未全部完賽；保留美東${old.ReportDateET}舊報告與原產生時間，未當作新完賽建議。`]);
      if(allowance.hold){
        old.Reasons=uniq([...old.Reasons,allowance.reason,...(allowance.inconsistent?['目前Add額度來源數值不一致，暫停舊報告的新加入優先排序。']:[])]);
        for(const candidate of old.Candidates){candidate.Recommendation=allowance.zero?'觀察舊報告：目前本週剩餘Add為0，暫停新加入優先排序':'觀察舊報告：目前Add額度來源不一致，暫停新加入優先排序';candidate.Reasons=uniq([...candidate.Reasons,allowance.reason]);}
        const quotaSources=['Budget','Transactions'].flatMap(name=>{const s=section(dashboard,name);return s&&fresh(s.RetrievedAtUtc,now,36)&&Number.isInteger(s.Data.AddsRemainingThisWeek)?[{Name:'本次Flaim / Yahoo Add額度檢查 '+name,RetrievedAtUtc:time(s.RetrievedAtUtc),SourceUpdatedAtUtc:time(s.SourceUpdatedAtUtc),Url:null}]:[];});
        old.Sources=[...quotaSources,...old.Sources].slice(0,100);
      }
      return validatePreservedWaiting(old,dashboard,now,evidence,week);
    }
    const last=evidence?.LastCompletedDay;
    if(date(last?.DateET)&&last.DateET<target&&dayFinal(last.Day)){reportDate=last.DateET;backfilled=true;report.Notes.push(`目前目標美東${target}尚未全部完賽；此為最近已核實完賽日${reportDate}的補充報告，非今日新完賽結果。`);}
    else{report.Status='waiting';report.Reasons=['官方目標日尚未全部完賽，等待完整比分與統計。'];return report;}
  }else if(!dayFinal(evidence?.Day)){report.Status='unavailable';report.Reasons=['官方目標日全部完賽與比分覆蓋尚未核實。'];return report;}
  report.ReportDateET=reportDate;
  const usedDay=evidence?.LastCompletedDay?.DateET===reportDate?evidence.LastCompletedDay.Day:evidence?.Day;
  if(!fresh(evidence.GeneratedAtUtc,now,36)||!fresh(usedDay?.RetrievedAtUtc,now,36)||(Date.parse(etDate(now))-Date.parse(reportDate))/DAY>2){report.Status='unavailable';report.Reasons=['NBA比賽日證據過期、日期過舊或時間未知，不能把舊NBA統計配成新的推薦。'];return report;}
  const roster=section(dashboard,'Roster'),market=section(dashboard,'Market'),match=section(dashboard,'Matchup');
  if(![roster,market,match].every(s=>s&&fresh(s.RetrievedAtUtc,now,36))){report.Status='unavailable';report.Reasons=['陣容、自由市場或本週比分缺失、超過36小時或時間在未來；不產生新的加入排序。'];return report;}
  const rosterPlayers=(roster.Data.Players??[]).filter(p=>clean(p?.Player,200)),marketPlayers=(market.Data.Players??[]).filter(p=>clean(p?.Player,200)),counts=new Map();for(const p of [...rosterPlayers,...marketPlayers]){const key=normalizePlayerName(p.Player);counts.set(key,(counts.get(key)??0)+1);}
  if(allowance.hold)report.Reasons.push(allowance.reason);
  if(allowance.inconsistent)report.Reasons.push('Budget與Transactions的最新剩餘Add數值不一致，沒有擅自挑選較寬鬆的值。');
  if(allowance.unknown)report.Notes.push('本週剩餘Add未知或來源已過期；沒有從每週上限或觀察交易筆數推算可用額度。');
  const emphasis=new Set(Array.isArray(emphasisCategories)?emphasisCategories.filter(label=>typeof label==='string'&&Object.hasOwn(CATEGORIES,label)).map(label=>CATEGORIES[label]):[]);
  const cats=scoredCategories(match.Data).map(c=>({...c,weight:c.weight*(emphasis.has(c.stat)?1.35:1)})),own=rosterPlayers.map(p=>inspectPlayer(p,evidence,week,reportDate,now,counts));
  if(emphasis.size)report.Notes.push('本週積極策略同時考慮接近比項與本隊相對偏弱項；有足夠聯盟比較資料的偏弱項增加35%情境權重。這是分析方法，不是Yahoo計分規則，亦不保證追上或獲勝。');
  if(!cats.length)report.Reasons.push('沒有可核實且本聯盟實際比較的類別項目，未產生類別淨增益排序。');
  if(!report.Week.VerifiedYahooWeek)report.Notes.push('Yahoo對戰週起訖與時區未核實；場次僅採標示的台灣日曆週，不宣稱等同Yahoo計次期間。');
  for(const item of own){
    item.trend=trend(item,cats,evidence,reportDate);
    item.injury=injuryCheck(item,evidence,week,now);
    const review=item.Protected===true?'保留：Yahoo標示不可丟棄':!item.injury.safe||!item.injury.medicalKnown?'暫緩換人判斷：傷勢風險或醫療狀態未知，不把缺賽／復健視為真實能力下滑':item.trend.declining&&item.Protected===false?'可列入換人檢視，仍需先比較淨增益與操作條件':item.trend.declining?'僅觀察：保護狀態未知，不列直接移除選項':'保留觀察，沒有足夠證據建議移除';
    report.DropReviews.push({Player:item.player.Player,TeamCode:playerCode(item.player.TeamCode,week),SampleGames7:item.identityKnown?item.w7.length:null,SampleGames14:item.identityKnown?item.w14.length:null,RemainingGames:item.remaining,Review:review,Reasons:uniq([...item.reasons,item.injury.reason,item.trend.reason,...(item.Protected===null?['Yahoo不可丟棄欄位未知，不建議直接移除。']:[])]),Protected:item.Protected});
  }
  const ranked=[],watch=[];
  for(const player of marketPlayers){
    const item=inspectPlayer(player,evidence,week,reportDate,now,counts),injury=injuryCheck(item,evidence,week,now),availability=['free_agent','waivers'].includes(player.Availability)?player.Availability:null;
    const candidate={Player:player.Player,TeamCode:playerCode(player.TeamCode,week),Availability:availability,RemainingGames:item.remaining,SampleGames7:item.identityKnown?item.w7.length:null,SampleGames14:item.identityKnown?item.w14.length:null,InjuryStatus:injury.label,Recommendation:'觀察名單：證據不足，未列加入優先順序',Reasons:uniq([...item.reasons,injury.reason]),Tradeoffs:[],DropOptions:[]};
    if(allowance.hold){candidate.Recommendation=allowance.zero?'觀察名單：本週剩餘Add為0，暫停新加入優先排序':'觀察名單：Add額度來源不一致，暫停新加入優先排序';candidate.Reasons.push(allowance.reason);}
    if(!availability)candidate.Reasons.push('Yahoo目前取得方式未知，不能承諾可立即加入。');
    if(availability==='waivers')candidate.Reasons.push('讓渡開放時間與時區尚未核實，僅列觀察；球隊剩餘排定場次不等於可用場次。');
    const eligible=!allowance.hold&&item.enough&&item.consistent&&item.remaining!==null&&item.remaining>0&&injury.safe&&availability==='free_agent'&&cats.length>0;
    const comparisons=eligible?own.filter(o=>o.enough&&o.consistent&&o.remaining!==null&&o.Protected!==true&&o.injury.safe).map(o=>({own:o,...compareProjection(item,o,cats,match.Data)})).filter(c=>c.complete&&c.score!==null).sort((a,b)=>b.score-a.score):[];
    const best=comparisons[0];
    if(best&&best.score>0){
      candidate.Recommendation=injury.medicalKnown?'可評估加入：積極本週策略的情境淨增益較佳，非出賽或獲勝保證':'條件式可評估加入：醫療狀態未知、信心較低；僅情境淨增益較佳，非健康或出賽保證';
      candidate.Reasons.push(`以7/14日每場數據65%/35%混合估算，與${best.own.player.Player}在相同標示期間的剩餘排程做假設替換比較。`);
      candidate.Reasons.push(...best.rows.filter(r=>r.gain>0).sort((a,b)=>b.impact-a.impact).slice(0,3).map(formatDelta));
      if(emphasis.size){const helped=best.rows.filter(r=>r.gain>0&&emphasis.has(r.stat)).map(r=>r.stat);candidate.Reasons.push(helped.length?'依本隊本週相對弱項評估，可望補強的情境比項：'+helped.join('、')+'。':'此候選沒有算出本隊相對弱項的正增益；用途限於其他接近比項，未把弱項當作已解決。');}
      candidate.Tradeoffs=best.rows.filter(r=>r.gain<0).sort((a,b)=>a.impact-b.impact).slice(0,3).map(formatDelta);
      candidate.Tradeoffs.push('比較未估計對手後續增量；FG/FT依投進與出手加權，A/T依AST及TO合計，沒有直接平均百分比。');
      if(best.own.Protected===null)candidate.Tradeoffs.push('比較對象保護狀態未知，此比較不是移除建議。');
      if(!best.own.injury.medicalKnown)candidate.Tradeoffs.push('比較對象醫療狀態未知；僅作條件式情境，不據此建議移除。');
      candidate.DropOptions=comparisons.filter(c=>c.score>0&&c.own.Protected===false&&c.own.injury.medicalKnown&&c.own.trend.declining).slice(0,2).map(c=>({Player:c.own.player.Player,Reason:'僅列換人候選：Yahoo未標示不可丟棄、官方傷勢狀態已核實，且7/14日與多場產出均持續下滑；仍須核對位置、每週Add及操作是否合法。'}));
      ranked.push({score:best.score,candidate});
    }else{if(eligible)candidate.Reasons.push('未取得完整且正向的候選對現陣容類別淨增益比較，暫不排序。');if(item.remaining===0)candidate.Reasons.push('本次標示期間已無未來排定場次。');watch.push(candidate);}
  }
  ranked.sort((a,b)=>b.score-a.score||a.candidate.Player.localeCompare(b.candidate.Player));
  report.Candidates=[...ranked.map(x=>x.candidate),...watch].slice(0,8);
  report.Status=backfilled?'waiting':ranked.length?'ready':'insufficient_data';
  report.Reasons=uniq([...report.Reasons,ranked.length?'僅對已核實樣本、傷勢報告、現陣容及市場資料完成的候選做本週情境比較。':'尚無候選同時滿足歷史、傷勢、場次及完整正向比較；以下是觀察名單，沿用本次市場回傳順序。']);
  sourcesFor(report,dashboard,evidence,week,reportDate);return report;
}
async function readJson(file,max=1048576){const b=await fs.readFile(file);if(b.length>max)throw new Error('InputTooLarge');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
export async function buildRecommendations(dashboardPath,{now=new Date()}={}){
  const folder=path.dirname(path.resolve(dashboardPath)),dashboard=normalizeDashboard(await readJson(dashboardPath));
  let evidence=null,week=null,previous=null;try{evidence=await readJson(path.join(folder,'recommendation-evidence.json'));}catch{}try{week=await readJson(path.join(folder,'team-week-schedule.json'));}catch{}try{previous=await readJson(path.join(folder,'recommendations.json'));}catch{}
  const report=generateRecommendations({dashboard,evidence,week,previous,now});normalizeRecommendations(report);
  const output=path.join(folder,'recommendations.json'),temporary=output+'.'+crypto.randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.rename(temporary,output);}finally{await fs.rm(temporary,{force:true});}
  return {RecommendationsUpdated:true,Status:report.Status,ReportDateET:report.ReportDateET,Candidates:report.Candidates.length,DropReviews:report.DropReviews.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await buildRecommendations(path.resolve(process.argv[2]??'data/dashboard.json'))));}catch{console.error(JSON.stringify({RecommendationsUpdated:false,ErrorType:'RecommendationBuildFailed'}));process.exitCode=1;}}
