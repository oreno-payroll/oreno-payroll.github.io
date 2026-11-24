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
  busy:false,saveRecoveryRequired:blocked,selected:'synthetic-uuid',savingDocuments:false,
  saveAll,saveRecheck,saveReload,saveRecoveryChecked:false,saveRecoverySafe:false,validateQueueItem:()=>null,isChanged:()=>false,validateSavedEdit:()=>null,requiresAmountApproval:()=>unapproved,renderAmountReview:()=>{},$:()=>progress};
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
assert.match(source,/saveRecoveryRequired=true;saveRecoveryChecked=false;saveRecoverySafe=false/);
assert.match(source,/inspectUnreferencedOriginals\(id\)/);
assert.match(source,/clearDrafts\(\);resetSaveRecovery\(\)/);
assert.match(source,/OneDriveの状態を再確認/);
const html=read('public/year-end-assist/index.html');
for(const id of ['yea-save-result','yea-save-recovery','yea-save-recheck','yea-save-reload'])assert.match(html,new RegExp(`id="${id}"`));
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
