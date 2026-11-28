/** Year-end UI regression: one source of truth for saved and new PDFs. Synthetic only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/year-end-assist/index.html');
const css=read('public/styles/year-end-assist.css');
const ts=read('src/year-end-assist.ts');
const home=read('public/index.html');
const dash=read('public/styles/dashboard.css');
const between=(value,start,end)=>{const a=value.indexOf(start),b=value.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Expected section ${start}`);return value.slice(a,b);};
const directory=between(html,'<section id="yea-directory"','<div class="yea-main"');
const detail=between(html,'<div class="yea-main" id="yea-content" hidden>','<dialog id="yea-create-dialog"');
const addition=html.slice(html.indexOf('<dialog id="yea-create-dialog"'));
assert.match(directory,/<button[^>]*id="yea-create-open"/);
assert.doesNotMatch(directory,/yea-create-details/);
assert.ok(directory.includes('id="yea-person-list"'));
for(const id of ['yea-person-create','yea-new-name','yea-create-close'])assert.ok(addition.includes(`id="${id}"`));
for(const id of ['yea-current-name','yea-calendar-year','yea-pdfs','yea-year-memo','yea-estimate-months','yea-save-all','yea-forecast-accordion','yea-commit'])assert.ok(detail.includes(`id="${id}"`),`required detail: ${id}`);
assert.doesNotMatch(detail,/yea-open-manage/);
assert.match(ts,/row\.append\(button,rename,remove\)/);
assert.match(ts,/requiredText:name,acceptLabel:'従業員を削除'/);
const header=between(html,'<header class="site-header">','</header>');
assert.match(header, /href="\.\.\/index\.html">ホーム<\/a>/);
assert.doesNotMatch(header, /yea-back-directory|yea-back-home/);
assert.match(detail, /class="yea-detail-navigation">[\s\S]*?id="yea-back-directory" hidden>[\s\S]*?<span>従業員一覧へ<\/span><\/button>/);
assert.match(ts,/backDirectory\.hidden=false/);assert.match(ts,/backDirectory\.hidden=true/);
assert.match(ts,/yearContent\.dataset\.empty=data\.documents\.length===0\?'true':'false'/);
assert.doesNotMatch(css,/\.yea-main\[data-empty="true"\] >/);
assert.match(ts,/function showYearPlaceholders\(\)/);
assert.ok(detail.indexOf('class="yea-context"')<detail.indexOf('class="card yea-upload-panel yea-accordion"'));
assert.ok(detail.indexOf('class="yea-stats"')<detail.indexOf('class="card yea-upload-panel yea-accordion"'));
assert.doesNotMatch(detail,/月別給与の状態|id="yea-docs"|保存済み給与・賞与明細|yea-copy-raw|yea-copy|yea-replace-pdf/);
assert.match(detail,/id="yea-taxable-breakdown"/,'taxable breakdown is an explicit audit view');
for(const type of ['yea-upload-panel','yea-taxable-audit','yea-forecast-accordion']){
 const opening=detail.match(new RegExp(`<details class="[^"]*${type}[^"]*yea-accordion[^"]*"[^>]*>\\s*<summary class="yea-upload-summary accordion-summary"><strong`));
 assert.ok(opening,`${type} must share the exact accordion header markup`);
}
assert.match(css,/\.yea-accordion\s*\{[^}]*padding:0!important/,'all accordions should share one container style');
assert.match(css,/\.yea-accordion\[open\]>.yea-upload-summary\{border-bottom:/,'all accordions should share the open border');
assert.doesNotMatch(css,/\.yea-taxable-audit>summary\s*\{/,'monthly breakdown must not override the shared header');
assert.doesNotMatch(html,/yea-upload-target|id="yea-pdf-dialog"|iframe|本人への確認・転記|id="yea-review-ack"/);
assert.match(html,/<details class="card yea-upload-panel yea-accordion" id="yea-upload-accordion" open>/);
const start=detail.indexOf('id="yea-upload-accordion"');
const summary=detail.indexOf('class="yea-upload-summary accordion-summary"',start);
const list=detail.indexOf('id="yea-drafts"',start);
const review=detail.indexOf('id="yea-review-content"',start);
const save=detail.indexOf('id="yea-save-all"',start);
const close=detail.indexOf('</details>',start);
assert.ok(start>=0&&summary>start&&list>summary&&review>list&&save>review&&close>save,
 'the single accordion must contain upload, saved list, edit form and bulk save together');
assert.match(css,/\.yea-context\{[^}]*background:transparent;border:0/,'employee header has no background card');
assert.match(ts,/uploadAccordion\.open=data\.documents\.length===0/);
assert.match(ts,/repo\.createPerson\(name,''\)/);assert.match(ts,/repo\.renamePerson\(id,name,p\.alias,p\.displayName\)/);
assert.match(ts,/const displayPerson=.*p\.alias/);
assert.doesNotMatch(ts,/\.\/storage\/payrollStore/);
assert.match(home, /<nav class="site-nav"[\s\S]*?href="\.\/year-end-assist\/index\.html"[\s\S]*?href="\.\/backup\/index\.html"[\s\S]*?<\/nav>/);
assert.match(home, /class="dashboard-upload"|class="btn btn--primary dashboard-upload"/);
assert.doesNotMatch(home,/class="card yea-entry"/);assert.doesNotMatch(dash,/\.yea-entry/);
console.log('PASS: directory, empty-state importer, always-visible unified list, header navigation, single collapsible editor, no redundant monthly table or PDF iframe');

{
// Exercise the real list renderer with a synthetic DOM and a mocked repository.
// No profile data is persisted or sent outside this fixture.
const {stripTypeScriptTypes}=await import('node:module');
const {runInNewContext}=await import('node:vm');
class FixtureElement extends EventTarget{
 constructor(tag,klass='',text=''){super();this.tag=tag;this.className=klass;this.textContent=text;this.children=[];this.hidden=false;this.attributes={};this.parent=null;}
 append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
 replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
 after(child){child.parent=this.parent;this.parent.children.splice(this.parent.children.indexOf(this)+1,0,child);}
 remove(){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
 get isConnected(){return this.parent!==null;}
 get childElementCount(){return this.children.length;}
 setAttribute(key,value){this.attributes[key]=value;}
 querySelector(selector){return this.children.find(child=>'.'+child.className===selector)??null;}
 querySelectorAll(selector){assert.equal(selector,'button,input');return this.children.flatMap(child=>[...(['button','input'].includes(child.tag)?[child]:[]),...child.querySelectorAll(selector)]);}
 closest(selector){return ('.'+this.className===selector)?this:this.parent?.closest(selector)??null;}
 focus(){}
 click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
}
const personList=new FixtureElement('div'),empty=new FixtureElement('p'),pending=new FixtureElement('div');
const directoryNode=new FixtureElement('section'),dialog=new FixtureElement('dialog'),create=new FixtureElement('button'),refresh=new FixtureElement('button');
create.id='yea-create-open';refresh.id='yea-people-refresh';directoryNode.append(personList,pending,create,refresh);
dialog.append(new FixtureElement('input'),new FixtureElement('button'));
const first={id:'synthetic-id-1',displayName:'Synthetic A',alias:'Synthetic alias',state:'active'};
const second={id:'synthetic-id-2',displayName:'Synthetic B',alias:'',state:'active'};
let authorized=true,approved=false,request,operations=[];
const context={directoryObservedEpoch:'',sharedNavigationEpoch:()=>'fixture',personList,people:[first,second],selected:null,busy:false,peopleLoaded:true,peopleStale:false,directory:directoryNode,displayPerson:p=>p.alias?`${p.displayName}（${p.alias}）`:p.displayName,
 el:(...args)=>new FixtureElement(...args),$:id=>id==='yea-person-empty'?empty:id==='yea-create-dialog'?dialog:pending,
 captureOperationAuthorization:()=>()=>authorized,approveYearEnd:async(req,guard)=>{request=req;return approved&&guard();},
 action:async(_label,fn)=>fn(),selectPerson:async(id)=>operations.push(['select',id]),loadPeople:async()=>{},
 repo:{renamePerson:async(...args)=>{operations.push(['rename',...args]);return {...first,displayName:args[1]};},deletePerson:async(...args)=>operations.push(['delete',...args])}};
const renderStart=ts.indexOf('function renderPeople()'),renderEnd=ts.indexOf('function person()',renderStart);
assert.ok(renderEnd>renderStart);
const controlStart=ts.indexOf('function updateDirectoryControls()'),controlEnd=ts.indexOf('function updateYearControls()',controlStart);
assert.ok(controlStart>=0&&controlEnd>controlStart);
runInNewContext(stripTypeScriptTypes(ts.slice(controlStart,controlEnd)+ts.slice(renderStart,renderEnd),{mode:'strip'})+'\nglobalThis.syncControls=updateDirectoryControls;renderPeople()',context);
const [rowA,rowB]=personList.children;
assert.equal(rowA.children[0].children[0].textContent,'Synthetic A（Synthetic alias）');
assert.equal(create.disabled,false);assert.equal(refresh.disabled,false);
context.busy=true;context.syncControls();assert.equal(create.disabled,true);assert.equal(refresh.disabled,true);assert.equal(rowA.children[1].disabled,true);assert.ok(dialog.children.every(x=>x.disabled));
context.busy=false;context.peopleStale=true;context.syncControls();assert.equal(create.disabled,true);assert.equal(refresh.disabled,false);assert.equal(rowA.children[2].disabled,true);
rowA.children[2].click();assert.equal(operations.length,0);
context.peopleStale=false;context.syncControls();assert.equal(create.disabled,false);
rowA.children[1].click();const renameForm=personList.children[1];assert.equal(rowA.hidden,true);assert.equal(renameForm.children[0].value,'Synthetic A');assert.equal(refresh.disabled,true);assert.equal(rowB.children[0].disabled,true);assert.equal(renameForm.children[0].disabled,false);
rowB.children[0].click();assert.equal(operations.length,0,'do not silently abandon inline edit');
renameForm.children[0].value='New synthetic name';renameForm.dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(operations,[['rename',first.id,'New synthetic name',first.alias,first.displayName]]);
assert.equal(personList.children[0].children[0].children[0].textContent,'New synthetic name（Synthetic alias）');
assert.equal(personList.children.length,2,'inline edit returns to the list without reloading other profiles');
const refreshedB=personList.children[1];
refreshedB.children[2].click();await new Promise(resolve=>setImmediate(resolve));assert.equal(request.requiredText,'Synthetic B');assert.equal(operations.length,1,'cancelled delete cannot write');
approved=true;authorized=false;refreshedB.children[2].click();await new Promise(resolve=>setImmediate(resolve));assert.equal(operations.length,1,'changed authorization cannot delete');
authorized=true;refreshedB.children[2].click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(operations.at(-1),['delete',second.id,second]);assert.equal(personList.children.length,1);
console.log('PASS: actual directory rendering, inline rename preserving alias, cancellation and authorization-bound delete');
}
