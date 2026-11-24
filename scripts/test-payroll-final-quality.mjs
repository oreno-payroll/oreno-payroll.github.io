/** Final quality regression: actual state transitions and read-only Graph requests. Synthetic only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {PayrollGraph} from '../src/cloud/graph.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const section=(s,a,b)=>{const start=s.indexOf(a),end=s.indexOf(b,start+1);assert.ok(start>=0&&end>start,a);return s.slice(start,end);};
const execute=(source,ctx,exportCode)=>runInNewContext(stripTypeScriptTypes(source,{mode:'strip'})+'\n'+exportCode,ctx);
const year=read('src/year-end-assist.ts');
const node=()=>({hidden:true,disabled:false,textContent:'',dataset:{},value:'',setAttribute(k,v){this[k]=v;},querySelector(){return null;}});
// H02: failed year acquisition must keep inputs locked until a successful retry.
{
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 const memoInput=node(),memoButton=node(),uiPdf=node(),yearSelect=node(),backDirectory=node(),yearRetry=node(),yearError=node(),radio=node();
 let fail=true,rendered=0;
 const ctx={$ ,memoInput,memoButton,uiPdf,yearSelect,backDirectory,yearRetry,yearError,methodChoices:{querySelectorAll:()=>[radio]},busy:false,data:null,memoDirty:false,selected:'fixture',activeYear:2026,forecastDirty:false,bonusDirty:false,uploadAccordion:{},otherYearNames:[],yearContent:node(),
  showYearPlaceholders(){yearError.hidden=true;yearRetry.hidden=true;},renderYear(){rendered++;},updateDrafts(){},say(){},
  repo:{async yearWithOtherYearNames(){if(fail)throw new Error('synthetic failure');return {data:{memo:'fixture',documents:[]},otherYearNames:async()=>[]};}}};
 execute(section(year,'function updateYearControls()','const reviewForm=')+section(year,'async function loadYear()','function renderYear()'),ctx,'globalThis.load=loadYear;globalThis.sync=updateYearControls;');
 await assert.rejects(ctx.load(),/synthetic failure/);
 assert.equal(ctx.data,null);assert.equal(rendered,0);assert.equal(ctx.yearContent.dataset.loading,'false');assert.equal(yearRetry.hidden,false);assert.equal(yearRetry.disabled,false);assert.equal(yearError.hidden,false);
 for(const el of [memoInput,memoButton,uiPdf,radio,$('yea-mobile-file-picker')])assert.equal(el.disabled,true);
 assert.equal($('yea-pdf-dropzone').tabIndex,-1);
 fail=false;await ctx.load();assert.equal(rendered,1);assert.equal(yearRetry.hidden,true);assert.equal(yearError.hidden,true);
 for(const el of [memoInput,uiPdf,radio,$('yea-mobile-file-picker')])assert.equal(el.disabled,false);
 assert.equal(memoButton.disabled,true);ctx.memoDirty=true;ctx.sync();assert.equal(memoButton.disabled,false);
 ctx.busy=true;ctx.sync();for(const el of [memoInput,memoButton,uiPdf,radio,yearSelect,backDirectory,yearRetry])assert.equal(el.disabled,true);
}
// M02: preserve the previously verified list on a failed refresh; do not confuse empty and unavailable.
{
 const empty=node(),freshness=node(),old=[{id:'first'}],next=[{id:'second'}];let result=null,renderCount=0;
 const ctx={$:()=>empty,people:[],peopleLoaded:false,peopleStale:false,peopleFreshness:freshness,personList:{childElementCount:0},renderPeople(){renderCount++;},repo:{async people(_read,force,progress){progress(0,1);if(!result)throw new Error('synthetic unavailable');progress(1,1);return result;}}};
 execute(section(year,'async function loadPeople(','function showYearPlaceholders()'),ctx,'globalThis.load=loadPeople;');
 await assert.rejects(ctx.load(),/synthetic unavailable/);assert.equal(ctx.peopleLoaded,false);assert.equal(ctx.peopleStale,true);assert.equal(freshness.hidden,false);assert.equal(renderCount,0);
 result=old;await ctx.load(true);assert.equal(ctx.people,old);assert.equal(ctx.peopleLoaded,true);assert.equal(ctx.peopleStale,false);assert.equal(freshness.hidden,true);
 result=null;await assert.rejects(ctx.load(true),/synthetic unavailable/);assert.equal(ctx.people,old);assert.equal(ctx.peopleStale,true);assert.equal(freshness.hidden,false);assert.match(freshness.textContent,/以前の一覧/);assert.equal(renderCount,1);
 result=next;await ctx.load(true);assert.equal(ctx.people,next);assert.equal(ctx.peopleStale,false);assert.equal(freshness.hidden,true);assert.equal(renderCount,2);
}
// M03: run the actual directory fetch and the relevant controls from updateSaveState.
{
 const upload=read('src/upload.ts'),employerLoad=node(),employerInput=node(),employerStatus=node();const prior=[{id:'fixture',role:'main'}];let fail=true;
 const ctx={employerLoading:false,employerLoadFailed:false,employerDirectory:prior,employerLoad,employerInput,employerStatus,entries:[{form:{job:'main'},employerId:'fixture'}],selectedEntry:()=>ctx.entries[0],saving:false,uploadSaveRecoveryChecking:false,selectedId:null,duplicated:()=>new Set(),reviewForm:{querySelectorAll:()=>[]},captureOperationAuthorization:()=>()=>true,defaultEmployer(){},setReviewed(){},render(){},notice(){},cloudVault:async()=>({readEmployerDirectory:async()=>{if(fail)throw new Error('fixture');return prior;}})};
 const controls=section(upload,'function updateSaveState(): void {','  updateFilePickerState();')+'\n}';
 execute(section(upload,'async function refreshEmployerChoices(','const readResult =')+controls,ctx,'globalThis.load=refreshEmployerChoices;globalThis.sync=updateSaveState;');
 ctx.sync();assert.equal(employerLoad.hidden,true);
 assert.equal(await ctx.load(),false);assert.equal(ctx.employerDirectory,prior);assert.equal(employerLoad.hidden,false);assert.equal(employerLoad.disabled,false);assert.equal(employerLoad.textContent,'再読み込み');
 fail=false;assert.equal(await ctx.load(),true);assert.equal(employerLoad.hidden,true);assert.equal(employerStatus.textContent,'');
}
// M04: exercise the actual ZIP handler, retaining original signature checks and one notification channel.
{
 const main=read('src/main.ts');let handler,failed=false,downloads=0;const notices=[];const rec={id:1,form:{job:'side'}};
 const ctx={sideZipButton:{addEventListener(_name,fn){handler=fn;}},exportingSideZip:false,dashboardLoading:false,dashboardStale:false,deletionBusy:()=>false,yearSelect:{value:'2026'},periodMode:'fiscal',selectedPeriodRecords:()=>[rec],renderPendingDeletion(){},appStatus:{loading:m=>notices.push(['loading',m]),success:m=>notices.push(['success',m]),error:m=>notices.push(['error',m])},loadRecordSummaries:async()=>[rec],recordSignature:r=>String(r.id),getOriginalForBatchExport:async()=>{if(failed)throw new Error('fixture');return new Blob(['fixture']);},createSidePdfZip:async()=>new Blob(['fixture']),URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},document:{createElement:()=>({click(){downloads++;},remove(){}}),body:{append(){}}},setTimeout(){}};
 execute(section(main,"sideZipButton.addEventListener('click'",'function updateYearOptions()'),ctx,'');
 await handler();assert.equal(downloads,1);assert.equal(notices.filter(x=>x[0]==='success').length,1);assert.equal(notices.filter(x=>x[0]==='error').length,0);
 failed=true;notices.length=0;await handler();assert.equal(downloads,1);assert.equal(notices.filter(x=>x[0]==='success').length,0);assert.equal(notices.filter(x=>x[0]==='error').length,1);
 assert.equal(ctx.exportingSideZip,false);assert.doesNotMatch(read('public/index.html'),/id="side-zip-status"/);
}
// M05: actual Graph client, shared parent lookup, per-profile cache, strict path and auth checks.
{
 const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const signed='https://my.microsoftpersonalcontent.com/fixture';const content='ciphertext-fixture';const requests=[];let failId='',authorized=true,notModified=false,oversize=false;
 const graph=new PayrollGraph('fixture',async(url,init={})=>{
  assert.equal(init.method??'GET','GET');requests.push(url);
  if(url===signed){assert.equal(new Headers(init.headers).has('authorization'),false);return new Response(content,{headers:{'Content-Type':'application/octet-stream'}});}
  const path=new URL(url).pathname;
  if(path.endsWith('/special/approot'))return Response.json({id:'root'});
  if(path.endsWith('/items/root:/persons'))return Response.json({id:'persons',folder:{}});
  const id=[a,b].find(x=>path.endsWith(`/items/persons:/${x}/profile.enc`));assert.ok(id,`unexpected path ${path}`);
  if(id===failId)return new Response('',{status:404});
  if(notModified&&new Headers(init.headers).get('if-none-match')===`tag-${id}`)return new Response(null,{status:304});
  return Response.json({id,eTag:`tag-${id}`,size:oversize?9999:content.length,'@microsoft.graph.downloadUrl':signed});
 },()=>{},undefined,()=>{if(!authorized)throw new Error('fixture authorization revoked');}, false);
 const files=await Promise.all([a,b].map(id=>graph.read(['persons',id],'profile.enc',1000,true)));
 assert.deepEqual(files.map(x=>x.id),[a,b]);assert.ok(files.every(x=>x.text===content));
 assert.equal(requests.filter(x=>new URL(x).pathname.endsWith('/items/root:/persons')).length,1);assert.equal(requests.length,8);
 notModified=true;assert.equal((await graph.read(['persons',a],'profile.enc',1000,true)).id,a);assert.equal(requests.length,9);
 failId=b;assert.equal(await graph.read(['persons',b],'profile.enc',1000,true),null);
 const count=requests.length;
 for(const [path,name] of [[['persons','../fixture'],'profile.enc'],[['other',a],'profile.enc'],[['persons',a],'other.enc']])await assert.rejects(graph.read(path,name,1000,true),/参照先が不正/);
 assert.equal(requests.length,count);failId='';notModified=false;oversize=true;await assert.rejects(graph.read(['persons',b],'profile.enc',1000,true),/容量が上限/);
 authorized=false;await assert.rejects(graph.read(['persons',a],'profile.enc',1000,true),/authorization revoked/);
}
// L01-L03: retain accessible markup, no old status selectors and the common modal shell.
assert.match(read('public/index.html'),/href="\.\/upload\/index.html" aria-label="PDFを追加"/);
assert.doesNotMatch(read('public/styles/dashboard.css'),/\.side-zip-status|#side-zip-status/);
assert.match(read('public/year-end-assist/index.html'),/id="yea-create-dialog" class="operation-dialog yea-create-dialog"/);
console.log('PASS: final quality error recovery, stale list, employer retry, ZIP notification, direct Graph profile reads and shared UI contracts');
