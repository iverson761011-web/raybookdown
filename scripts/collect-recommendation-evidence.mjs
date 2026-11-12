import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { addDays, taipeiDate } from './update-nba-schedule.mjs';
import { normalizeDashboard } from '../dashboard-model.mjs';

const HOSTS = new Set(['nba.com','www.nba.com','cdn.nba.com','official.nba.com','ak-static.cms.nba.com']);
const MAX_BYTES = 12 * 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ET = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function problem(code){throw Object.assign(new Error(code),{safeCode:code});}
function day(value){const parsed=typeof value==='string'&&DATE.test(value)?new Date(value+'T00:00:00Z'):null;if(!parsed||!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==value)problem('InvalidDate');return value;}
function clean(value,max=200){return typeof value==='string'&&value.trim()&&value.length<=max&&!/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)?value.trim():null;}
function number(value,max=1000){if(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value))value=Number(value);return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max?value:null;}
function count(value,max=1000){const result=number(value,max);return Number.isInteger(result)?result:null;}
function etDate(instant){const p=Object.fromEntries(ET.formatToParts(new Date(instant)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
export function officialEvidenceUrl(value,base){let url;try{url=new URL(value,base);}catch{problem('UntrustedOfficialUrl');}if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.username||url.password||url.hash||(url.port&&url.port!=='443'))problem('UntrustedOfficialUrl');return url;}
export async function fetchOfficialEvidence(value,{fetchImpl=fetch,timeoutMs=12000,onDiagnostic=()=>{}}={}){
 let url=officialEvidenceUrl(value);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{for(let redirects=0;redirects<=3;redirects++){
  const response=await fetchImpl(url,{redirect:'manual',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{Accept:'application/json,text/html,application/pdf;q=0.9','User-Agent':'RayBookDown-Evidence/1.0'}});
  onDiagnostic({Phase:'http',HttpStatus:response.status});
  if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location||redirects===3)problem('OfficialRedirectRejected');url=officialEvidenceUrl(location,url);continue;}
  if(!response.ok)problem('OfficialHttpError');const length=Number(response.headers.get('content-length'));if(Number.isFinite(length)&&length>MAX_BYTES)problem('OfficialResponseTooLarge');
  const reader=response.body?.getReader();if(!reader)problem('OfficialResponseUnavailable');const pieces=[];let bytes=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES)problem('OfficialResponseTooLarge');pieces.push(value);}}finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  return Buffer.concat(pieces);
 }problem('OfficialRedirectRejected');}finally{clearTimeout(timer);}
}
export function nextData(html){for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){if(/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(m[1])){try{return JSON.parse(m[2]);}catch{problem('InvalidOfficialJson');}}}problem('OfficialStructureUnknown');}
function gameCards(root,date){if(root?.query?.date!==date)problem('OfficialDateMismatch');const modules=root?.props?.pageProps?.gameCardFeed?.modules;if(!Array.isArray(modules))problem('OfficialStructureUnknown');const cards=modules.flatMap(m=>Array.isArray(m?.cards)?m.cards:[]);return cards.filter(c=>c?.cardData?.gameId||c?.cardData?.game?.gameId).map(c=>c.cardData.game??c.cardData);}
export function normalizePlayerName(value){return typeof value==='string'?value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[’']/g,'').replace(/[.]/g,'').replace(/[-\s]+/g,' ').trim().toLowerCase():'';}
export function normalizeFinalStatus(raw){const label=clean(raw?.gameStatusText,80);if(label&&/^final(?:\s*\/\s*(?:\d+)?ot)?$/i.test(label)&&(raw.gameStatus===3||raw.gameStatus==='3'||raw.gameStatus==null))return'final';if(label&&/postpon|cancel|suspend|ppd/i.test(label))return'unknown';if(raw?.gameStatus===1||raw?.gameStatus==='1')return'upcoming';if(raw?.gameStatus===2||raw?.gameStatus==='2')return'in_progress';return'unknown';}
function startAt(raw){for(const key of ['gameTimeUtc','gameTimeUTC','gameDateTimeUTC','startDate']){const value=raw?.[key];if(typeof value==='string'&&ISO.test(value)&&Number.isFinite(Date.parse(value)))return new Date(value).toISOString();}return null;}
function club(raw){return{ Name:clean(raw?.teamName),City:clean(raw?.teamCity),Code:clean(raw?.teamTricode,12),Score:count(raw?.score,1000) };}
function gameSourceUrl(raw) {
 const id=raw.gameId;
 if(typeof raw.shareUrl==='string')try{const url=officialEvidenceUrl(raw.shareUrl,'https://www.nba.com');if(['www.nba.com','nba.com'].includes(url.hostname)&&new RegExp('^/game/(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?'+id+'(?:/(?:box-score|preview))?/?$','i').test(url.pathname)){url.hostname='www.nba.com';url.pathname=url.pathname.replace(/\/(?:box-score|preview)\/?$/,'').replace(/\/$/,'')+'/box-score';url.search='';return url.href;}}catch{}
 const away=raw.awayTeam?.teamTricode,home=raw.homeTeam?.teamTricode;
 const slug=typeof away==='string'&&/^[A-Z]{2,3}$/i.test(away)&&typeof home==='string'&&/^[A-Z]{2,3}$/i.test(home)?`${away.toLowerCase()}-vs-${home.toLowerCase()}-`:'';
 return `https://www.nba.com/game/${slug}${id}/box-score`;
}
export function parseDailyScoreboard(html,date){day(date);const root=nextData(html),props=root?.props?.pageProps;const cards=gameCards(root,date);if(cards.length>32)problem('OfficialStructureUnknown');if(!cards.length&&props?.gameCount!==0&&props?.gameCardFeed?.totalGames!==0)return{CoverageVerified:false,Status:'unknown',Games:[]};
 let verified=true;const games=[];const ids=new Set();for(const raw of cards){const id=raw?.gameId,start=startAt(raw);if(typeof id!=='string'||!/^\d{10}$/.test(id)||ids.has(id)||!start||etDate(start)!==date){verified=false;continue;}ids.add(id);const teams=[club(raw.awayTeam),club(raw.homeTeam)];if(teams.some(t=>!t.Name)||teams[0].Name===teams[1].Name){verified=false;continue;}games.push({GameId:id,DateET:date,StartAtUtc:start,Status:normalizeFinalStatus(raw),Teams:teams,SourceUrl:gameSourceUrl(raw)});}
 const status=!verified?'unknown':games.length===0?'no_games':games.every(g=>g.Status==='final'&&g.Teams.every(t=>t.Score!==null))?'final':games.some(g=>g.Status==='unknown')?'unknown':'waiting';return{CoverageVerified:verified,Status:status,Games:games};
}
export function parseMinutes(value){if(typeof value==='number')return number(value,100);if(typeof value!=='string')return null;let m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);if(m&&(m[1]||m[2]||m[3]))return number(Number(m[1]??0)*60+Number(m[2]??0)+Number(m[3]??0)/60,100);m=/^(\d{1,2}):(\d{2})(?:\.(\d+))?$/.exec(value);if(m&&Number(m[2])<60)return number(Number(m[1])+Number(m[2]+'.'+(m[3]??0))/60,100);return null;}
export function parsePlayerStatistics(raw){const s=raw&&typeof raw==='object'?raw:{};const result={MIN:parseMinutes(s.minutes??s.minutesCalculated),FGM:count(s.fieldGoalsMade),FGA:count(s.fieldGoalsAttempted),FTM:count(s.freeThrowsMade),FTA:count(s.freeThrowsAttempted),'3PTM':count(s.threePointersMade),PTS:count(s.points),OREB:count(s.reboundsOffensive),DREB:count(s.reboundsDefensive),REB:count(s.reboundsTotal),AST:count(s.assists),ST:count(s.steals),BLK:count(s.blocks),TO:count(s.turnovers),DD:null};
 for(const[made,attempted]of[['FGM','FGA'],['FTM','FTA']])if(result[made]!==null&&result[attempted]!==null&&result[made]>result[attempted]){result[made]=null;result[attempted]=null;}
 if(result['3PTM']!==null&&result.FGM!==null&&result['3PTM']>result.FGM)result['3PTM']=null;
 const dd=[result.PTS,result.REB,result.AST,result.ST,result.BLK];if(dd.filter(v=>v!==null&&v>=10).length>=2)result.DD=1;else if(dd.every(v=>v!==null))result.DD=0;return result;}
function gameCandidates(root){const found=[],stack=[root?.props?.pageProps];let n=0;while(stack.length&&++n<20000){const v=stack.pop();if(!v||typeof v!=='object')continue;if(v.homeTeam&&v.awayTeam&&(Array.isArray(v.homeTeam.players)||Array.isArray(v.awayTeam.players)))found.push(v);for(const[k,c]of Object.entries(v))if(!['__proto__','prototype','constructor'].includes(k)&&c&&typeof c==='object')stack.push(...(Array.isArray(c)?c:[c]));}return found;}
export function parseBoxScore(html,expectedGame){const root=nextData(html),candidates=gameCandidates(root);const game=candidates.find(g=>g.gameId===expectedGame.GameId);if(!game)problem('OfficialBoxScoreUnknown');const time=startAt(game);if(time&&etDate(time)!==expectedGame.DateET)problem('OfficialDateMismatch');if(normalizeFinalStatus(game)!=='final')problem('GameNotFinal');const rows=[];for(const team of[game.awayTeam,game.homeTeam]){if(!Array.isArray(team.players))problem('OfficialBoxScoreUnknown');for(const p of team.players){const name=clean(p.name??[p.firstName??p.nameFirst,p.familyName??p.nameFamily].filter(Boolean).join(' '));if(!name)continue;let played=null;if(p.played===true||p.played==='1'||p.played===1)played=true;else if(p.played===false||p.played==='0'||p.played===0)played=false;const values=parsePlayerStatistics(p.statistics);const explicitDnp=typeof p.comment==='string'&&/^(?:(?:DNP|DND|NWT)\b|did not play\b|did not dress\b|not with (?:the )?team\b)/i.test(p.comment.trim());if(played===null&&explicitDnp&&(values.MIN===null||values.MIN===0))played=false;else if(played===null&&values.MIN!==null&&values.MIN>0)played=true;rows.push({Player:name,OfficialPlayerId:typeof p.personId==='number'&&Number.isSafeInteger(p.personId)&&p.personId>0?String(p.personId):typeof p.personId==='string'&&/^\d{1,12}$/.test(p.personId)?p.personId:null,GameId:expectedGame.GameId,TeamCode:clean(team.teamTricode,12),DateET:expectedGame.DateET,SourceUrl:expectedGame.SourceUrl,Played:played,Stats:played===false?null:values});}}if(!rows.length)problem('OfficialBoxScoreUnknown');const ids=new Set();for(const row of rows){const key=row.OfficialPlayerId??normalizePlayerName(row.Player);if(ids.has(key))problem('OfficialPlayerIdentityAmbiguous');ids.add(key);}return rows;}
export function latestInjuryReportLink(html,seasonYear){const label=`${seasonYear}-${String(seasonYear+1).slice(-2)}`;if(!html.includes(label))problem('OfficialSeasonMismatch');const reports=[];for(const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){let u;try{u=officialEvidenceUrl(m[1].replace(/&amp;/g,'&'),'https://official.nba.com');}catch{continue;}if(u.hostname!=='ak-static.cms.nba.com'||u.search)continue;const p=/\/referee\/injury\/Injury-Report_(\d{4}-\d{2}-\d{2})_(\d{1,2})_(\d{2})(AM|PM)\.pdf$/i.exec(u.pathname);if(!p)continue;try{day(p[1]);}catch{continue;}if(![seasonYear,seasonYear+1].includes(Number(p[1].slice(0,4))))continue;const h=Number(p[2]),min=Number(p[3]);if(h<1||h>12||min>59)continue;const hour=h%12+(p[4].toUpperCase()==='PM'?12:0);reports.push({SourceUrl:u.href,ReportDateET:p[1],ReportTimeET:`${String(hour).padStart(2,'0')}:${p[3]}`,ReportIssuedAtUtc:null});}reports.sort((a,b)=>(a.ReportDateET+' '+a.ReportTimeET).localeCompare(b.ReportDateET+' '+b.ReportTimeET));if(!reports.length)problem('OfficialInjuryReportUnavailable');return reports.at(-1);}
const publicKeys=v=>v&&typeof v==='object'?Object.keys(v).filter(k=>/^[A-Za-z0-9_]{1,60}$/.test(k)).slice(0,50):[];
export function describeDailySchema(html) {
 const root=nextData(html),props=root?.props?.pageProps,feed=props?.gameCardFeed;
 const summary=value=>({Keys:publicKeys(value),Scalars:Object.fromEntries(Object.entries(value??{}).filter(([key,v])=>/^[A-Za-z0-9_]{1,60}$/.test(key)&&(typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'||/(?:type|title|text|headline|subhead|message|body|count|description)/i.test(key)&&clean(v,200)!==null)).slice(0,16))});
 const visible=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;|&#x0*a0;/gi,' ').replace(/\s+/g,' ');
 const emptyMatches=[...visible.matchAll(/.{0,35}\bno\s+games?\s+(?:are\s+)?(?:scheduled|today|available)\b.{0,55}/gi)].map(m=>clean(m[0].trim(),120)).filter(Boolean);
 const fieldShape=v=>({Type:v===null?'null':Array.isArray(v)?'array':typeof v,...(Array.isArray(v)?{Count:v.length,FirstItemType:v[0]===null?'null':Array.isArray(v[0])?'array':typeof v[0],FirstItemKeys:publicKeys(v[0]),DateSamples:v.filter(x=>typeof x==='string'&&(DATE.test(x)||ISO.test(x))).slice(0,3)}:v&&typeof v==='object'?{Keys:publicKeys(v)}:{})});
 return {PagePropKeys:publicKeys(props),PageProps:summary(props),Selection:{QueryDate:typeof root?.query?.date==='string'&&DATE.test(root.query.date)?root.query.date:null,HasError:typeof props?.hasError==='boolean'?props.hasError:null,SelectedDate:typeof props?.selectedDate==='string'&&clean(props.selectedDate,60)?props.selectedDate:null,SelectedDateShape:fieldShape(props?.selectedDate),IsDateOverrideActive:typeof props?.isDateOverrideActive==='boolean'?props.isDateOverrideActive:null,AllGamesInCurrentYear:fieldShape(props?.allGamesInCurrentYear),Events:fieldShape(props?.events)},VisibleEmptyNotices:[...new Set(emptyMatches)].slice(0,3),Feed:summary(feed),Modules:Array.isArray(feed?.modules)?feed.modules.slice(0,4).map(m=>({...summary(m),CardsCount:Array.isArray(m?.cards)?m.cards.length:null,Cards:Array.isArray(m?.cards)?m.cards.slice(0,4).map(c=>({...summary(c),CardData:summary(c?.cardData)})):[]})):[]};
}
export function describeBoxScoreSchema(html){const root=nextData(html),props=root?.props?.pageProps,candidates=gameCandidates(root);return{PagePropKeys:publicKeys(props),GameKeys:publicKeys(props?.game),GameDataKeys:publicKeys(props?.gameData),BoxScoreKeys:publicKeys(props?.boxScore),CandidateGameCount:candidates.length,Candidates:candidates.slice(0,2).map(g=>({Keys:publicKeys(g),HomeTeamKeys:publicKeys(g.homeTeam),AwayTeamKeys:publicKeys(g.awayTeam),FirstPlayerKeys:publicKeys(g.homeTeam?.players?.[0]??g.awayTeam?.players?.[0]),StatisticKeys:publicKeys(g.homeTeam?.players?.[0]?.statistics??g.awayTeam?.players?.[0]?.statistics)}))};}
export async function probeSources({date=addDays(taipeiDate(),-1),seasonYear=2026,fetchBytes=fetchOfficialEvidence,parsePdf=parseInjuryPdf}={}){
 const diagnostics=[];let scoreboard=null;const url='https://www.nba.com/games?date='+day(date);
 try{const html=new TextDecoder('utf-8',{fatal:true}).decode(await fetchBytes(url));scoreboard=parseDailyScoreboard(html,date);diagnostics.push({Source:url,Phase:'scoreboard',Status:scoreboard.Status,CoverageVerified:scoreboard.CoverageVerified,Games:scoreboard.Games.length,FinalGames:scoreboard.Games.filter(g=>g.Status==='final').length,MissingScores:scoreboard.Games.filter(g=>g.Teams.some(t=>t.Score===null)).length,FirstCardKeys:publicKeys(gameCards(nextData(html),date)[0]),FirstTeamKeys:publicKeys(gameCards(nextData(html),date)[0]?.homeTeam),EmptyDaySchema:scoreboard.Games.length===0?describeDailySchema(html):undefined});}catch(e){diagnostics.push({Source:url,Phase:'scoreboard',ErrorType:e.safeCode??'OfficialSourceUnavailable'});}
 for(const game of(scoreboard?.Games??[]).filter(g=>g.Status==='final').slice(0,1))try{const html=new TextDecoder('utf-8',{fatal:true}).decode(await fetchBytes(game.SourceUrl));let rows=null,error=null;try{rows=parseBoxScore(html,game);}catch(e){error=e.safeCode??'OfficialBoxScoreUnknown';}diagnostics.push({Source:game.SourceUrl,Phase:'boxscore',Rows:rows?.length??0,PlayersWithStatistics:rows?.filter(p=>p.Stats&&p.Stats.PTS!==null).length??0,ErrorType:error,Schema:describeBoxScoreSchema(html)});}catch(e){diagnostics.push({Source:game.SourceUrl,Phase:'boxscore',ErrorType:e.safeCode??'OfficialSourceUnavailable'});}
 const injuryUrl=`https://official.nba.com/nba-injury-report-${seasonYear}-${String(seasonYear+1).slice(-2)}-season/`;
 try{const html=new TextDecoder('utf-8',{fatal:true}).decode(await fetchBytes(injuryUrl));const report=latestInjuryReportLink(html,seasonYear);diagnostics.push({Source:injuryUrl,Phase:'injury-index',Report:report});try{const parsed=validateInjuryResult(await parsePdf(await fetchBytes(report.SourceUrl),report),report,new Date().toISOString());diagnostics.push({Source:report.SourceUrl,Phase:'injury-pdf',Status:parsed.Status,ReportIssuedAtUtc:parsed.ReportIssuedAtUtc,Players:parsed.Players.length,UnsubmittedTeams:parsed.UnsubmittedTeams.length,TeamReports:parsed.TeamReports.length});}catch(e){diagnostics.push({Source:report.SourceUrl,Phase:'injury-pdf',ErrorType:e.safeCode??'InjuryParserFailed',Diagnostics:e.diagnostics});}}catch(e){diagnostics.push({Source:injuryUrl,Phase:'injury-index',ErrorType:e.safeCode??'OfficialSourceUnavailable'});}
 return{Probe:true,CheckedAtUtc:new Date().toISOString(),TargetNbaDateET:date,Diagnostics:diagnostics};
}

const INJURY_HELPER = fileURLToPath(new URL('./parse-nba-injuries.py', import.meta.url));
const INJURY_CODES=new Set(['InvalidExpectedReportDate','InvalidExpectedReportTime','InjuryReportHeaderMissing','InjuryReportHeaderInvalid','InjuryReportTimestampMismatch','InjuryReportTimeAmbiguous','InjuryReportTextTooLarge','InjuryGameDateInvalid','InjuryReportTooManyRows','InjuryPdfSizeInvalid','InjuryPdfFormatInvalid','InjuryPdfDependencyUnavailable','InjuryPdfEncrypted','InjuryPdfPageCountInvalid','InjuryPdfTextUnavailable','InjuryPdfExtractionFailed','InjuryReportTextInvalid','InjuryReportParsingFailed']);
const STAT_KEYS = ['MIN','FGM','FGA','FTM','FTA','3PTM','PTS','OREB','DREB','REB','AST','ST','BLK','TO','DD'];
function gameRowsComplete(rows) { return rows.length>0&&rows.some(p=>p.Played===true)&&rows.every(p=>p.Played===false||p.Played===true&&p.Stats&&STAT_KEYS.every(k=>p.Stats[k]!==null)); }
const SAFE_CODES = new Set(['OfficialHttpError','OfficialResponseTooLarge','OfficialResponseUnavailable','OfficialRedirectRejected','UntrustedOfficialUrl','InvalidOfficialJson','OfficialStructureUnknown','OfficialDateMismatch','OfficialBoxScoreUnknown','OfficialPlayerIdentityAmbiguous','GameNotFinal','OfficialSeasonMismatch','OfficialInjuryReportUnavailable','InjuryParserUnavailable','InjuryParserFailed','InjuryReportUnknown','InjuryTimestampUnknown','InjuryReportDateMismatch']);
function errorType(error) { return SAFE_CODES.has(error?.safeCode)||INJURY_CODES.has(error?.safeCode) ? error.safeCode : 'OfficialSourceUnavailable'; }
function timestamp(value) { return typeof value==='string'&&ISO.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null; }
function decode(bytes) { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { problem('OfficialStructureUnknown'); } }

/** A small separate process keeps PDF decompression/extraction bounded and reports no raw error text. */
export async function parseInjuryPdf(bytes, report, {python=process.env.PYTHON_EXECUTABLE||'python',timeoutMs=20000}={}) {
 if (!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_BYTES||!Buffer.from(bytes).subarray(0,5).equals(Buffer.from('%PDF-'))) problem('InjuryReportUnknown');
 return await new Promise((resolve,reject)=>{
  const child=spawn(python,[INJURY_HELPER,'--expected-date',day(report.ReportDateET),'--expected-time',report.ReportTimeET],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',overflow=false;const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('InjuryParserFailed'),{safeCode:'InjuryParserFailed'}));},timeoutMs);
  child.stdout.on('data',value=>{stdout+=value.toString('utf8');if(stdout.length>2*1024*1024){overflow=true;child.kill();}});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);reject(Object.assign(new Error('InjuryParserUnavailable'),{safeCode:'InjuryParserUnavailable'}));});
  child.on('close',code=>{clearTimeout(timer);let raw;try{raw=JSON.parse(stdout);}catch{}if(code!==0||overflow){const safeCode=INJURY_CODES.has(raw?.ErrorType)?raw.ErrorType:'InjuryParserFailed';const diagnostics=raw?.Diagnostics&&typeof raw.Diagnostics==='object'?Object.fromEntries(Object.entries(raw.Diagnostics).filter(([key,value])=>['Phase','PdfPages','TextCharacters','HeaderCount','HeaderDate','HeaderTime','ColumnLinePresent','DateRowCount','PlayerStatusRowCount','ExtractionMode','HeaderPreview'].includes(key)&&(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&(key==='HeaderPreview'?clean(value,100)!==null&&/^Injury\s*Report/i.test(value):/^[A-Za-z0-9_:\-]{1,40}$/.test(value))))):undefined;reject(Object.assign(new Error(safeCode),{safeCode,diagnostics}));return;}if(raw)resolve(raw);else reject(Object.assign(new Error('InjuryParserFailed'),{safeCode:'InjuryParserFailed'}));});
  child.stdin.end(bytes);
 });
}

function injuryPlayer(row) {
 if(!row||!clean(row.Player)||!clean(row.TeamName)||!DATE.test(row.GameDateET??'')||!['Out','Doubtful','Questionable','Probable','Available'].includes(row.Status))return null;
 try{day(row.GameDateET);}catch{return null;}
 return {Player:clean(row.Player),TeamName:clean(row.TeamName),GameDateET:row.GameDateET,Status:row.Status,Reason:clean(row.Reason,1500)};
}
export function validateInjuryResult(raw,report,retrievedAt) {
 const issued=timestamp(raw?.ReportIssuedAtUtc);
 if(!issued||etDate(issued)!==report.ReportDateET)problem('InjuryTimestampUnknown');
 const local=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(issued)).map(x=>[x.type,x.value]));
 if(`${local.hour}:${local.minute}`!==report.ReportTimeET)problem('InjuryReportDateMismatch');
 if(!['available','partial','unknown'].includes(raw?.Status)||!Array.isArray(raw.Players)||!Array.isArray(raw.UnsubmittedTeams))problem('InjuryReportUnknown');
 if(raw.Status==='unknown'&&raw.Players.length)problem('InjuryReportUnknown');
 const players=raw.Players.map(injuryPlayer);if(players.some(p=>!p))problem('InjuryReportUnknown');
 const teamReports=Array.isArray(raw.TeamReports)?raw.TeamReports.filter(t=>clean(t?.TeamName)&&DATE.test(t?.GameDateET??'')&&typeof t.Submitted==='boolean').map(t=>({TeamName:clean(t.TeamName),GameDateET:t.GameDateET,Submitted:t.Submitted})):[];
 const unsubmitted=raw.UnsubmittedTeams.map(t=>clean(t)).filter(Boolean);
 return {Status:raw.Status,RetrievedAtUtc:retrievedAt,ReportIssuedAtUtc:issued,SourceUrl:report.SourceUrl,UnsubmittedTeams:[...new Set(unsubmitted)],TeamReports:teamReports,Players:players};
}

/** Only our public, whitelisted output can be loaded back into the evidence cache. */
export function sanitizeCachedDay(raw,date) {
 try {
  if(raw?.DateET!==day(date)||!['final','no_games'].includes(raw?.Day?.Status)||raw.Day.CoverageVerified!==true||!Array.isArray(raw.Day.Games)||!Array.isArray(raw.PlayerGames))return null;
  const retrieved=timestamp(raw.RetrievedAtUtc);if(!retrieved)return null;
  const games=raw.Day.Games.map(g=>{
   if(g.DateET!==date||!/^\d{10}$/.test(g.GameId??'')||g.Status!=='final'||!timestamp(g.StartAtUtc)||etDate(g.StartAtUtc)!==date||!Array.isArray(g.Teams)||g.Teams.length!==2)problem('OfficialStructureUnknown');
   const source=officialEvidenceUrl(g.SourceUrl);if(source.hostname!=='www.nba.com'||source.search||!new RegExp('^/game/(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?'+g.GameId+'/box-score$','i').test(source.pathname))problem('OfficialStructureUnknown');
   const teams=g.Teams.map(t=>({Name:clean(t.Name),City:clean(t.City),Code:clean(t.Code,12),Score:count(t.Score,1000)}));if(teams.some(t=>!t.Name||t.Score===null))problem('OfficialStructureUnknown');
   return {GameId:g.GameId,DateET:date,StartAtUtc:timestamp(g.StartAtUtc),Status:'final',Teams:teams,SourceUrl:source.href,RetrievedAtUtc:timestamp(g.RetrievedAtUtc)??retrieved};
  });
  if((raw.Day.Status==='no_games')!==(games.length===0)||new Set(games.map(g=>g.GameId)).size!==games.length)return null;
  const rows=raw.PlayerGames.map(p=>{
   const g=games.find(g=>g.GameId===p.GameId);if(!g||p.DateET!==date||p.SourceUrl!==g.SourceUrl||!clean(p.Player)||![true,false,null].includes(p.Played))problem('OfficialStructureUnknown');
   const stats=p.Stats===null?null:Object.fromEntries(STAT_KEYS.map(k=>[k,k==='MIN'?number(p.Stats?.[k],100):count(p.Stats?.[k])]));
   return {Player:clean(p.Player),OfficialPlayerId:typeof p.OfficialPlayerId==='string'&&/^\d{1,12}$/.test(p.OfficialPlayerId)?p.OfficialPlayerId:null,GameId:g.GameId,TeamCode:clean(p.TeamCode,12),DateET:date,SourceUrl:g.SourceUrl,Played:p.Played,Stats:p.Played===false?null:stats,RetrievedAtUtc:timestamp(p.RetrievedAtUtc)??retrieved};
  });
  const complete=games.length===0||games.every(g=>gameRowsComplete(rows.filter(p=>p.GameId===g.GameId)));
  return {DateET:date,RetrievedAtUtc:retrieved,Day:{Status:raw.Day.Status,CoverageVerified:true,Games:games},PlayerGames:rows,BoxScoresComplete:complete};
 } catch { return null; }
}

async function parallel(items,limit,operation) {
 const results=new Array(items.length);let index=0;
 await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{for(;;){const i=index++;if(i>=items.length)return;results[i]=await operation(items[i],i);}}));
 return results;
}

/** Limit the public feed to current observed full names, without inferring NBA teams or nicknames. */
export function scopePlayerGames(rawDashboard, rows) {
 const dashboard=normalizeDashboard(rawDashboard),sections=dashboard.Sections;
 const names=[...new Set(['Roster','Market'].flatMap(key=>(sections[key]?.Data?.Players??[]).map(p=>p.Player)))];
 const selected=new Map(names.map(name=>[normalizePlayerName(name),name]));
 const candidates=new Map([...selected.keys()].map(key=>[key,[]]));
 for(const row of rows){const list=candidates.get(normalizePlayerName(row.Player));if(list)list.push(row);}
 const retained=[],matched=[],missing=[],ambiguous=[],unknown=[];
 for(const [key,name]of selected){
  const found=candidates.get(key),ids=new Set(found.map(p=>p.OfficialPlayerId).filter(Boolean));
  if(!found.length){missing.push(name);continue;}
  if(ids.size>1){ambiguous.push(name);continue;}
  if(ids.size===0){unknown.push(name);continue;}
  const id=[...ids][0],verified=found.filter(p=>p.OfficialPlayerId===id);
  retained.push(...verified);matched.push(name);
 }
 return {PlayerGames:retained,PlayerScope:{Status:'current_roster_and_market',PlayerCount:selected.size,ObservedPlayers:[...selected.values()],MatchedPlayers:matched,MissingPlayers:missing,AmbiguousPlayers:ambiguous,IdentityUnknownPlayers:unknown,RosterRetrievedAtUtc:sections.Roster.RetrievedAtUtc,MarketRetrievedAtUtc:sections.Market.RetrievedAtUtc}};
}

export async function collectEvidence({date=addDays(taipeiDate(),-1),seasonYear=2026,historyDays=30,history={Days:[]},dashboard=null,fetchBytes=fetchOfficialEvidence,parsePdf=parseInjuryPdf,now=()=>new Date(),concurrency=3}={}) {
 day(date);if(!Number.isInteger(historyDays)||historyDays<1||historyDays>30)problem('InvalidHistoryWindow');
 // Retain the requested completed-day window plus the target day, which may
 // still be in progress. A waiting target must not shorten the prior window.
 const generated=now().toISOString(),start=addDays(date,-historyDays),warnings=[];
 const dates=Array.from({length:historyDays+1},(_,i)=>addDays(start,i));
 const cached=new Map();for(const raw of Array.isArray(history?.Days)?history.Days:[]){if(typeof raw?.DateET!=='string'||raw.DateET<start||raw.DateET>date)continue;const valid=sanitizeCachedDay(raw,raw.DateET);if(valid)cached.set(raw.DateET,valid);}
 const days=await parallel(dates,concurrency,async target=>{
  const previous=cached.get(target);if(previous?.BoxScoresComplete&&target!==date)return previous;
  const retrieved=now().toISOString(),url='https://www.nba.com/games?date='+target;let scoreboard;
  const reuseScoreboard=previous&&target!==date,scoreboardRetrieved=reuseScoreboard?previous.RetrievedAtUtc:retrieved;
  try{scoreboard=reuseScoreboard?previous.Day:parseDailyScoreboard(decode(await fetchBytes(url)),target);}catch(error){warnings.push({DateET:target,SourceUrl:url,ErrorType:errorType(error)});return previous??{DateET:target,RetrievedAtUtc:retrieved,Day:{Status:'unknown',CoverageVerified:false,Games:[]},PlayerGames:[],BoxScoresComplete:false};}
  const games=scoreboard.Games.map(g=>({...g,RetrievedAtUtc:g.RetrievedAtUtc??scoreboardRetrieved}));
  const rows=[];let complete=true;
  for(const game of games){
   if(game.Status!=='final'){complete=false;continue;}
   const stored=previous?.PlayerGames.filter(p=>p.GameId===game.GameId)??[];
   if(gameRowsComplete(stored)){rows.push(...stored);continue;}
   try{const readAt=now().toISOString();const parsed=parseBoxScore(decode(await fetchBytes(game.SourceUrl)),game);rows.push(...parsed.map(p=>({...p,RetrievedAtUtc:readAt})));if(!gameRowsComplete(parsed)){complete=false;warnings.push({DateET:target,SourceUrl:game.SourceUrl,ErrorType:'OfficialStatisticsIncomplete'});}}catch(error){rows.push(...stored);complete=false;warnings.push({DateET:target,SourceUrl:game.SourceUrl,ErrorType:errorType(error)});}
  }
  return {DateET:target,RetrievedAtUtc:scoreboardRetrieved,Day:{Status:scoreboard.Status,CoverageVerified:scoreboard.CoverageVerified,Games:games},PlayerGames:rows,BoxScoresComplete:complete&&['final','no_games'].includes(scoreboard.Status)};
 });
 const injuryUrl=`https://official.nba.com/nba-injury-report-${seasonYear}-${String(seasonYear+1).slice(-2)}-season/`;
 let injuries={Status:'unknown',RetrievedAtUtc:now().toISOString(),ReportIssuedAtUtc:null,SourceUrl:injuryUrl,UnsubmittedTeams:[],TeamReports:[],Players:[]};
 try{const report=latestInjuryReportLink(decode(await fetchBytes(injuryUrl)),seasonYear);const retrieved=now().toISOString();const parsed=await parsePdf(await fetchBytes(report.SourceUrl),report);injuries=validateInjuryResult(parsed,report,retrieved);}catch(error){warnings.push({SourceUrl:injuryUrl,ErrorType:errorType(error)});}
 const current=days.find(d=>d.DateET===date),verified=days.filter(d=>d.Day.CoverageVerified&&['final','no_games'].includes(d.Day.Status));
 const evidence={SchemaVersion:1,GeneratedAtUtc:generated,TargetNbaDateET:date,Day:{...current.Day,RetrievedAtUtc:current.RetrievedAtUtc,SourceUrl:'https://www.nba.com/games?date='+date},PlayerGames:days.flatMap(d=>d.PlayerGames),Injuries:injuries,History:{RequestedStartDateET:start,ThroughDateET:date,VerifiedDates:verified.map(d=>d.DateET),UnavailableDates:days.filter(d=>!verified.includes(d)).map(d=>d.DateET),MissingBoxScoreDates:days.filter(d=>!d.BoxScoresComplete).map(d=>d.DateET),Games:verified.flatMap(d=>d.Day.Games)},Warnings:warnings.sort((a,b)=>(a.DateET??'').localeCompare(b.DateET??'')||a.SourceUrl.localeCompare(b.SourceUrl))};
 const lastCompleted=verified.filter(d=>d.DateET<date&&d.Day.Status==='final').at(-1);
 if(lastCompleted)evidence.LastCompletedDay={DateET:lastCompleted.DateET,Day:{...lastCompleted.Day,RetrievedAtUtc:lastCompleted.RetrievedAtUtc,SourceUrl:'https://www.nba.com/games?date='+lastCompleted.DateET}};
 if(dashboard)Object.assign(evidence,scopePlayerGames(dashboard,evidence.PlayerGames));
 return {evidence,history:{SchemaVersion:1,GeneratedAtUtc:generated,Days:verified}};
}

async function writeJson(file,value,{compact=false,maxBytes=Infinity}={}) {
 const content=JSON.stringify(value,null,compact?undefined:2)+'\n';if(Buffer.byteLength(content,'utf8')>maxBytes)problem('EvidenceSizeLimit');
 const absolute=path.resolve(file),temp=absolute+'.tmp';await fs.mkdir(path.dirname(absolute),{recursive:true});await fs.writeFile(temp,content,{encoding:'utf8',mode:0o600});await fs.rename(temp,absolute);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const options={};let probe=false;
  for(const arg of process.argv.slice(2)){
   if(arg==='--probe'){probe=true;continue;}
   const m=/^--(date|output|history|history-days|season-year|dashboard)=(.+)$/.exec(arg);if(!m)problem('InvalidArguments');options[m[1]]=m[2];
  }
  const date=options.date?day(options.date):addDays(taipeiDate(),-1),seasonYear=options['season-year']?Number(options['season-year']):2026;
  if(!Number.isInteger(seasonYear)||seasonYear<2020||seasonYear>2100)problem('InvalidSeason');
  if(probe){console.log(JSON.stringify(await probeSources({date,seasonYear})));}
  else {
   const output=options.output??'data/recommendation-evidence.json',historyPath=options.history??'data/recommendation-history.json';if(path.resolve(output)===path.resolve(historyPath))problem('OutputPathConflict');
   let history={Days:[]};try{const bytes=await fs.readFile(historyPath);if(bytes.length<=8*1024*1024)history=JSON.parse(bytes);}catch{}
   let dashboard=null;if(options.dashboard){try{const bytes=await fs.readFile(options.dashboard);if(bytes.length>1024*1024)problem('InvalidDashboard');dashboard=normalizeDashboard(JSON.parse(bytes));}catch{problem('InvalidDashboard');}}
   const result=await collectEvidence({date,seasonYear,history,dashboard,historyDays:options['history-days']?Number(options['history-days']):30});
   await writeJson(output,result.evidence,{maxBytes:dashboard?1024*1024:Infinity});await writeJson(historyPath,result.history,{compact:true,maxBytes:8*1024*1024});
   console.log(JSON.stringify({Status:result.evidence.Day.Status,CoverageVerified:result.evidence.Day.CoverageVerified,TargetNbaDateET:date,VerifiedDates:result.evidence.History.VerifiedDates.length,PlayerGameRows:result.evidence.PlayerGames.length,InjuryStatus:result.evidence.Injuries.Status,Warnings:result.evidence.Warnings.length}));
  }
 } catch(error) { console.error(JSON.stringify({ErrorType:['InvalidDate','InvalidArguments','InvalidHistoryWindow','InvalidSeason','OutputPathConflict','InvalidDashboard','EvidenceSizeLimit'].includes(error?.safeCode)?error.safeCode:'EvidenceCollectionFailed'}));process.exitCode=1; }
}
