// Compare reported current-week values, never a hypothetical official matchup result.
const MAX_SOURCE_AGE_MS=36*60*60*1000;
const validWeek=value=>Number.isInteger(value)&&value>0&&value<=100;
const text=value=>typeof value==='string'&&value.trim()?value:null;
const scalar=value=>typeof value==='number'&&Number.isFinite(value)||typeof value==='string'?value:null;
const readable=section=>['ok','partial'].includes(section?.Status)&&section.Data&&typeof section.Data==='object';
const source=section=>section?Object.fromEntries(['Status','Source','CheckedAtUtc','RetrievedAtUtc','SourceUpdatedAtUtc'].map(key=>[key,section[key]??null])):null;
const keyPattern=/^team-[a-f0-9]{64}(?:-[1-9][0-9]*)?$/;

function categoryMap(categories,side){
 const rows=Array.isArray(categories)?categories.slice(0,200):[],names=new Map(),fallbackLabels=new Map();
 for(const row of rows){const name=text(row?.Name),label=text(row?.Label),map=name?names:fallbackLabels,key=name??label;if(key)map.set(key,(map.get(key)??0)+1);}
 const result=new Map();let ambiguous=false;
 rows.forEach((row,index)=>{
  const name=text(row?.Name),label=text(row?.Label),key=name?'name:'+JSON.stringify([name,label]):label?'label:'+label:'unmatched:'+side+':'+index;
  const duplicate=(name?names.get(name):fallbackLabels.get(label))>1;
  ambiguous||=duplicate||!name&&!label;
  if(!result.has(key))result.set(key,{label:label??name??'未命名比項',value:duplicate?null:scalar(row?.OwnValue),displayOnly:row?.DisplayOnly===true?true:row?.DisplayOnly===false?false:null});
 });
 return{rows:result,ambiguous};
}

export function buildWeekComparison({dashboard,league,selectionKey,leagueFetchFailed=false,now=new Date()}={}){
 const notes=[],addNote=note=>{if(!notes.includes(note))notes.push(note);};
 const ownSection=dashboard?.Sections?.Matchup,rules=dashboard?.Sections?.Rules,own=readable(ownSection)?ownSection.Data:null;
 const identityMatches=!league||['League','Platform','Season'].every(key=>league[key]===undefined||league[key]===dashboard?.[key]);
 const rawTeams=identityMatches&&Array.isArray(league?.Teams)?league.Teams.slice(0,32):[];
 const eligible=rawTeams.filter(team=>team&&team.IsUserTeam!==true&&text(team.Team)&&team.Team!==dashboard?.Team&&keyPattern.test(team.SelectionKey??''));
 const counts=new Map(),nameCounts=new Map();for(const team of eligible){counts.set(team.SelectionKey,(counts.get(team.SelectionKey)??0)+1);nameCounts.set(team.Team,(nameCounts.get(team.Team)??0)+1);}
 const teams=eligible.filter(team=>counts.get(team.SelectionKey)===1&&nameCounts.get(team.Team)===1).sort((a,b)=>a.Team.localeCompare(b.Team,'zh-Hant')||a.SelectionKey.localeCompare(b.SelectionKey));
 if(teams.length!==eligible.length)addNote('部分球隊識別重複，暫不提供選擇。');
 const options=teams.map(team=>({key:team.SelectionKey,name:team.Team}));
 const selected=teams.find(team=>team.SelectionKey===selectionKey)??teams.find(team=>team.Team===own?.Opponent)??teams[0]??null;
 const otherSection=selected?.Matchup,other=readable(otherSection)?otherSection.Data:null;
 const week=readable(rules)&&validWeek(rules.Data.CurrentWeek)?rules.Data.CurrentWeek:null;
 const ownCurrent=week!==null&&validWeek(own?.Week)&&own.Week===week;
 const leagueCurrent=week!==null&&validWeek(league?.CurrentWeek)&&league.CurrentWeek===week;
 const otherCurrent=leagueCurrent&&validWeek(other?.Week)&&other.Week===week;
 const mismatched=week!==null&&[own?.Week,league?.CurrentWeek,other?.Week].some(value=>validWeek(value)&&value!==week);
 const ownCategories=categoryMap(ownCurrent?own.Categories:[],'own'),otherCategories=categoryMap(otherCurrent?other.Categories:[],'other');
 const keys=[...new Set([...ownCategories.rows.keys(),...otherCategories.rows.keys()])];
 const rows=keys.map(key=>{const a=ownCategories.rows.get(key),b=otherCategories.rows.get(key);return{label:a?.label??b?.label,ownValue:a?.value??null,otherValue:b?.value??null,displayOnly:a?.displayOnly===true||b?.displayOnly===true?true:a?.displayOnly===false&&b?.displayOnly===false?false:null};});
 let status=ownCurrent&&otherCurrent&&identityMatches?'ready':'unavailable';
 if(mismatched){status='week_mismatch';addNote('來源週次不一致，未混用不同週的數據；請等待當週資料同步。');}
 if(!ownCurrent)addNote('RayBookDown 的當週數據尚未核實。');
 if(!otherCurrent)addNote('所選球隊的同一週數據尚未核實，缺失數值顯示未知。');
 if(!identityMatches)addNote('球隊資料不屬於目前聯盟或賽季，未用於對照。');
 if(!options.length)addNote('目前沒有可選的其他聯盟球隊。');
 let partial=false;
 if(leagueFetchFailed){partial=true;addNote('本次聯盟資料讀取未完成，保留上次資料與原來源時間。');}
 if(league&&league.Status!=='ok'||selected&&selected.Status!=='ok'){partial=true;addNote('聯盟或所選球隊資料部分未取得，請核對來源狀態。');}
 const nowMs=now instanceof Date?+now:typeof now==='number'?now:Date.parse(now);
 for(const [label,section]of[['聯盟規則',rules],['RayBookDown',ownSection],['所選球隊',otherSection]]){
  if(!section)continue;
  if(section.Status==='partial'){partial=true;addNote(label+'來源僅部分取得。');}
  const stamp=Date.parse(section.RetrievedAtUtc);
  if(!Number.isFinite(stamp)||!Number.isFinite(nowMs)||nowMs-stamp>MAX_SOURCE_AGE_MS||stamp-nowMs>10*60*1000){partial=true;addNote(label+'來源時間較舊或未能核實，請查看讀取時間。');}
 }
 if(ownCategories.ambiguous||otherCategories.ambiguous){partial=true;addNote('部分比項名稱重複或不明，無法確定的對照值顯示未知。');}
 if(!rows.length||rows.some(row=>row.ownValue===null||row.otherValue===null)){partial=true;addNote('部分比項未能逐一配對或缺少數值，未將缺失資料視為 0。');}
 if(status==='ready'&&partial)status='partial';
 return{options,selectedKey:selected?.SelectionKey??null,selectedName:selected?.Team??null,week,rows,status,notes,ownSource:source(ownSection),otherSource:source(otherSection),ownOpponent:ownCurrent?text(own.Opponent):null,otherOpponent:otherCurrent?text(other.Opponent):null,ownScore:ownCurrent?own.OwnScore??null:null,otherScore:otherCurrent?other.OwnScore??null:null};
}
