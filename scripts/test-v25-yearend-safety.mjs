/** Synthetic UI policy checks. No real employee PDF, name, or token is used. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const source=read('src/year-end-assist.ts');
const block=source.slice(source.indexOf('function updateSaveState(){'),source.indexOf('function renderSelectedReview(){'));
assert.ok(block.startsWith('function updateSaveState(){'),'source policy must remain testable');
function testQueue(statuses,{blocked=false,unapproved=false}={}){
 const progress={textContent:''},saveAll={disabled:null,textContent:''},saveRecheck={disabled:null},saveReload={disabled:null};
 const state={fileQueue:statuses.map(status=>({status,draft:status==='ready'?{}:null})),data:{documents:[]},savedEdits:new Map(),pendingDeletions:new Map(),
  busy:false,saveRecoveryRequired:blocked?{}:null,selected:'synthetic-uuid',savingDocuments:false,
  saveAll,saveRecheck,saveReload,validateQueueItem:()=>null,isChanged:()=>false,validateSavedEdit:()=>null,requiresAmountApproval:()=>unapproved,renderAmountReview:()=>{},$:()=>progress};
 runInNewContext(stripTypeScriptTypes(block,{mode:'strip'})+'\nupdateSaveState()',state);
 return {disabled:saveAll.disabled,text:progress.textContent};
}
const normal=testQueue([...Array(9).fill('ready'),'duplicate']);
assert.equal(normal.disabled,false,'one duplicate must not block nine valid PDFs');
assert.match(normal.text,/新規9件/);assert.match(normal.text,/重複除外1件/);
const onlyDuplicate=testQueue(['duplicate']);
assert.equal(onlyDuplicate.disabled,true);assert.match(onlyDuplicate.text,/重複1件/);
assert.equal(testQueue(['ready','error']).disabled,true,'an unreadable PDF still blocks the batch');
assert.equal(testQueue(['ready','reading']).disabled,true,'never save before parsing completes');
assert.equal(testQueue(['ready'],{blocked:true}).disabled,true,'ambiguous cloud save must stay blocked until reinspection');
assert.equal(testQueue(['ready'],{unapproved:true}).disabled,true,'unapproved warning must block batch');
assert.match(source,/showSkippedResult\(additions\.length,updates\.length,excluded\)/);
assert.match(source,/item\.status='duplicate';item\.error=/);
assert.match(source,/saveRecoveryRequired=.*\?writeState:null/);
assert.match(source,/repo\.recoverDocumentsBatch\(id,year,state,/);
assert.doesNotMatch(source.slice(source.indexOf('async function recoverDocuments()'),source.indexOf('function bind()')),/clearDrafts\(|approveYearEnd\(/);
assert.match(source,/planDocumentRecovery\(before,result\.data/);
const html=read('public/year-end-assist/index.html');
for(const id of ['yea-save-result','yea-save-recovery','yea-save-recheck'])assert.match(html,new RegExp(`id="${id}"`));
assert.doesNotMatch(source,/saveResult\.innerHTML\s*=/,'filenames must be rendered without HTML injection');
const backup=read('src/backup.ts'),backupHtml=read('public/backup/index.html');
for(const id of ['ye-restore-people','ye-restore-people-summary','ye-restore-people-list','ye-restore-recheck'])
 assert.match(backupHtml,new RegExp(`id="${id}"`));
assert.match(backup,/showYearEndPlan\(plan\)/);
assert.match(backup,/label\.textContent=entry\.label/);
assert.match(backup,/yearEndPlan\.restorable/);
assert.match(backup,/yearEndRepo\.previewBackupRestore\(data\)/);
assert.match(backup,/diagnoseIncompleteYearEndRestore\(data\)/);
console.log('PASS: 9 valid PDFs save with 1 duplicate excluded; genuine errors and interrupted writes block');
console.log('PASS: read-only retry controls, safe filenames, employee preview and restore recheck wired');


// The oldest queued copy can be removed by the user. The next identical copy must
// become editable rather than staying excluded forever. Use a fake parser only.
const promotion=source.slice(source.indexOf('function promoteRemainingDuplicate('),source.indexOf('function renderSelectedReview(){'));
assert.ok(promotion.startsWith('function promoteRemainingDuplicate('));
assert.match(source,/fileQueue=fileQueue\.filter\(x=>x!==item\);promoteRemainingDuplicate\(item\)/,'the queued-file delete button must trigger promotion');
const oldest={id:1,hash:'a'.repeat(64),status:'ready',file:{name:'one.pdf'}};
const next={id:2,hash:oldest.hash,status:'duplicate',file:{name:'two.pdf'},error:'duplicate',draft:null};
const last={id:3,hash:oldest.hash,status:'duplicate',file:{name:'three.pdf'},error:'duplicate',draft:null};
const preserved={id:4,hash:'b'.repeat(64),status:'ready',file:{name:'other.pdf'}};
const list=[next,last,preserved];
let parsed=0;
let asynchronous;
const promotionContext={fileQueue:list,data:{documents:[]},pendingDeletions:new Map(),updateDrafts:()=>{},parseAssistedPdf:async file=>{parsed++;return {fileName:file.name}},action:(_label,callback)=>{asynchronous=callback();return asynchronous;},Error};
const promote=runInNewContext(stripTypeScriptTypes(promotion,{mode:'strip'})+'\npromoteRemainingDuplicate',promotionContext);
promote(oldest);
assert.equal(next.status,'reading');
await asynchronous;
assert.equal(next.status,'ready');
assert.equal(parsed,1);
assert.equal(last.status,'duplicate','only one candidate should be promoted');
assert.equal(preserved.status,'ready');
const saved={id:5,hash:'c'.repeat(64),status:'ready',file:{name:'saved.pdf'}};
// Variables declared with let/const in the VM lexical scope are not context properties.
const blocked=runInNewContext(`let fileQueue=[{id:6,hash:'${saved.hash}',status:'duplicate',file:{name:'excluded.pdf'},draft:null}]; const data={documents:[{fileHash:'${saved.hash}'}]}; const pendingDeletions=new Map();\n`+
 stripTypeScriptTypes(promotion,{mode:'strip'})+`\n({promoteRemainingDuplicate,fileQueue})`,{updateDrafts:()=>{},parseAssistedPdf:async()=>{throw new Error('should not parse')},action:()=>{throw new Error('should not start')},Error});
blocked.promoteRemainingDuplicate(saved);
assert.equal(blocked.fileQueue[0].status,'duplicate','a PDF already saved in OneDrive must remain excluded');
console.log('PASS: deleting the primary queued copy promotes only the next duplicate; saved originals remain excluded');

const planStart=source.indexOf('function planDocumentRecovery('),planEnd=source.indexOf('async function saveAllDocuments()',planStart);
const reviewFields=['kind','paymentDate','targetMonth','taxable','gross','transportation','nonTaxable','healthInsurance','pension','employmentInsurance','incomeTax','residentTax'];
const plan=runInNewContext(stripTypeScriptTypes(source.slice(planStart,planEnd),{mode:'strip'})+'\nplanDocumentRecovery',{reviewFields});
const sample={kind:'salary',paymentDate:'2026-10-25',targetMonth:'2026-10',taxable:100,gross:100,transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,detectedName:null};
const prev={...sample,id:'edit',revision:1,fileHash:'edit-hash',pdfSize:10};
const remove={...prev,id:'delete',fileHash:'delete-hash'};
const file={size:15},pendingFile={size:20};
const items=[{id:1,status:'ready',file,hash:'new-hash',draft:{...sample},fieldErrors:new Set()},{id:2,status:'ready',file:pendingFile,hash:'pending-hash',draft:{...sample},fieldErrors:new Set()}];
const edits=new Map([['edit',{draft:{...sample,taxable:200},fieldErrors:new Set()}]]),deletions=new Map([['delete',1]]);
const before={documents:[prev,remove]},latest={documents:[{...prev,taxable:200,revision:2},{...sample,id:'new',fileHash:'new-hash',pdfSize:15,revision:1}]};
const verified=new Map([[file,'new']]);
const recovered=plan(before,latest,verified,items,edits,deletions);
assert.deepEqual([...recovered.completedQueue],[1]);assert.deepEqual([...recovered.completedEdits],['edit','delete']);assert.deepEqual([...recovered.completedDeletions],['delete']);
assert.equal(items.length,2);assert.equal(edits.size,1);assert.equal(deletions.size,1,'plan must not mutate drafts');
const untouched=plan(before,before,new Map(),items,edits,deletions);assert.equal(untouched.completedQueue.size+untouched.completedEdits.size+untouched.completedDeletions.size,0);
assert.throws(()=>plan(before,latest,new Map(),items,edits,deletions),/別の画面/,'hash alone cannot establish this operation committed');
assert.throws(()=>plan(before,{documents:[{...prev,taxable:999,revision:2},remove]},new Map(),items,edits,deletions),/別の画面/,'stale edits are not rebased');
assert.throws(()=>plan(before,{documents:[prev,{...remove,revision:2}]},new Map(),items,edits,deletions),/別の画面/,'stale deletion is not rebased');
assert.throws(()=>plan(before,{documents:[{...latest.documents[0],revision:3},latest.documents[1]]},verified,items,edits,deletions),/別の画面/);
console.log('PASS: committed addition/edit/deletion reconciliation, untouched drafts, conflict refusal without mutation');

// Exercise the actual recovery click handler, not just its comparison helper.
const recoverSource=source.slice(source.indexOf('async function recoverDocuments()'),source.indexOf('function bind()'));
const workspace=(remote,authorization=true)=>{
 const queue=items.map(q=>({...q})),draftEdits=new Map(edits),draftDeletes=new Map(deletions),writeState={lock:'unknown'};
 const ctx={busy:false,selected:'synthetic',activeYear:2026,data:before,saveRecoveryRequired:writeState,captureOperationAuthorization:()=>()=>authorization,
  fileQueue:queue,savedEdits:draftEdits,pendingDeletions:draftDeletes,activeDraft:1,activeSavedId:'delete',memoDirty:true,forecastDirty:true,bonusDirty:true,
  people:[{id:'synthetic',yearFiles:{}}],saveRecoveryStatus:{},uploadAccordion:{},planDocumentRecovery:plan,
  repo:{async recoverDocumentsBatch(id,year,state,files){assert.equal(id,'synthetic');assert.equal(year,2026);assert.equal(state,writeState);assert.deepEqual([...files],[file,pendingFile]);return {data:remote,confirmed:verified,yearFiles:{2026:'synthetic-year'}};}},
  captureForecastInput:()=>({value:'unsaved forecast'}),captureBonusInput:()=>({value:'unsaved bonus'}),
  restoreForecastInput(v){ctx.forecastRestored=v.value;},restoreBonusInput(v){ctx.bonusRestored=v.value;},
  recoveryNoticeTarget:{},appStatus:{begin:()=>({}),show(){}},renderYear(){ctx.rendered=true;},resetSaveRecoveryStateAfterSuccess(){ctx.saveRecoveryRequired=null;},say(){},updateYearControls(){},updateSaveState(){},updateDrafts(){},updateForecastSaveState(){},updateBonusSaveState(){}};
 return {ctx,run:runInNewContext(stripTypeScriptTypes(recoverSource,{mode:'strip'})+'\nrecoverDocuments',ctx)};
};
const good=workspace(latest);await good.run();assert.equal(good.ctx.busy,false);assert.equal(good.ctx.saveRecoveryRequired,null);assert.equal(good.ctx.data,latest);
assert.deepEqual([...good.ctx.fileQueue].map(q=>q.id),[2]);assert.equal(good.ctx.fileQueue[0].file,pendingFile);assert.equal(good.ctx.savedEdits.size,0);assert.equal(good.ctx.pendingDeletions.size,0);
assert.equal(good.ctx.memoDirty,true);assert.equal(good.ctx.forecastRestored,'unsaved forecast');assert.equal(good.ctx.bonusRestored,'unsaved bonus');
const bad=workspace({...latest,documents:[{...latest.documents[0],revision:3},latest.documents[1]]});await bad.run();assert.equal(bad.ctx.busy,false);assert.ok(bad.ctx.saveRecoveryRequired);assert.equal(bad.ctx.data,before);assert.equal(bad.ctx.fileQueue.length,2);assert.equal(bad.ctx.savedEdits.size,1);assert.equal(bad.ctx.pendingDeletions.size,1);
const switched=workspace(latest,false);await switched.run();assert.ok(switched.ctx.saveRecoveryRequired);assert.equal(switched.ctx.data,before);assert.equal(switched.ctx.fileQueue.length,2);
console.log('PASS: recovery UI preserves actual File and remaining inputs, consumes only verified changes, rejects changed authorization/conflict');
