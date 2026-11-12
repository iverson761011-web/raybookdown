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
const panels=['roster','matchup','market','schedule','adds','settings'].map(id=>{elements[id].id=id;return elements[id];});
const intervals=[];
const originalTimeout=globalThis.setTimeout;
globalThis.document={getElementById:id=>{assert.ok(elements[id],'Known element '+id);return elements[id];},createElement:tag=>new Element(tag),querySelectorAll:q=>q==='[data-tab]'?buttons:q==='.panel'?panels:[],body:new Element('body')};
globalThis.location={hostname:'127.0.0.1',href:'http://127.0.0.1:8760/index.html'};
globalThis.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
globalThis.setInterval=(fn,ms)=>{intervals.push({fn,ms});return intervals.length;};
globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};
let fetchCount=0;
globalThis.fetch=async(url,options)=>{fetchCount++;assert.equal(url,'http://127.0.0.1:8760/data/dashboard.json');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');return new Response(JSON.stringify(fixture),{headers:{'content-type':'application/json'}});};
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
assert.equal(buttons.length,6);buttons[3].click();assert.equal(panels.find(p=>p.id==='schedule').hidden,false);assert.ok(panels.filter(p=>p.id!=='schedule').every(p=>p.hidden));
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
console.log('Dashboard runtime checks passed: all sections refresh, six tabs, market search/filter, dated schedule including verified zero-game and unknown days, null vs zero, independent failure, safe fetch.');
