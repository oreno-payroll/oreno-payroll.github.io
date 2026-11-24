/** OneDriveを使用しない保管庫パスフレーズ変更・旧データ復元・重複通信抑制のテスト */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=new URL('../',import.meta.url).pathname;
const result=await build({
 stdin:{contents:"export {PayrollVault,InterruptedRotationError} from './src/cloud/vault.ts'; export {GraphError} from './src/cloud/graph.ts'; export {encryptJson,decryptJson,encryptBytes} from './src/cloud/crypto.ts';",resolveDir:root,sourcefile:'test-entry.ts',loader:'ts'},
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollVault,InterruptedRotationError,GraphError,encryptJson,decryptJson,encryptBytes}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const encoder=new TextEncoder();
class FakeGraph {
 async withWriteLock(operation){return operation();}
 files=new Map(); failOn=null; modifyOnMetadata=null; writes=[];reads=[];
 path(parts,name){return [...parts,name].join('/');}
 async read(parts,name){
  const path=this.path(parts,name);this.reads.push(path);
  const data=this.files.get(path);return data?{...data}:null;
 }
 async metadata(parts,name){
  const path=this.path(parts,name);
  if(this.modifyOnMetadata&&this.modifyOnMetadata===path){
   this.modifyOnMetadata=null;const old=this.files.get(path);
   if(old)this.files.set(path,{...old,etag:'external-update'});
  }
  const old=this.files.get(path);
  return old?{id:old.id,etag:old.etag,size:old.size}:null;
 }
 async listFolder(parts){
  const prefix=parts.join('/')+'/';
  const contents=new Map();
  for(const [path,file] of this.files){
   if(!path.startsWith(prefix))continue;
   const tail=path.slice(prefix.length),[name,...rest]=tail.split('/');
   if(rest.length)contents.set(name,{id:'folder:'+prefix+name,name,etag:'folder-etag',folder:true,size:0});
   else contents.set(name,{id:file.id,name,etag:file.etag,folder:false,size:file.size});
  }
  return contents.size?[...contents.values()].sort((a,b)=>a.name.localeCompare(b.name)):null;
 }
 async trashPayrollOriginal(parts,item,beforeDelete){
  await beforeDelete();const path=this.path(parts,item.name),actual=this.files.get(path);
  assert.equal(actual?.id,item.id);assert.equal(actual?.etag,item.etag);
  if(this.failTrash)throw new Error('synthetic trash failure');
  this.files.delete(path);
  if(this.failReceipt)this.failOn='payroll/index.enc';
 }
 async trashFolder(parts,item){
  const existing=(await this.listFolder(parts))?.find(v=>v.name===item.name);
  if(!existing||existing.etag!==item.etag||!existing.folder)throw new Error('test cleanup ETag mismatch');
  const prefix=[...parts,item.name].join('/')+'/';
  for(const path of [...this.files.keys()])if(path.startsWith(prefix))this.files.delete(path);
 }
 async write(parts,name,text,prior,limit,progress){
  const path=this.path(parts,name);this.writes.push(path);
  if(this.failOn && path.includes(this.failOn))throw new Error('test offline');
  const existing=this.files.get(path),size=encoder.encode(text).length;
  if(size>limit)throw new Error('too large');
  if(prior && (!existing||existing.etag!==prior.etag))throw new GraphError(412,'collision');
  if(!prior&&existing)throw new GraphError(409,'collision');
  const next={id:path,etag:`tag-${crypto.randomUUID()}`,text,size};
  this.files.set(path,next);progress?.(size,size);
 }
}
const previous='existing-passphrase-12345',changed='new-strong-passphrase-76543';
const sample=async(id=151,month='2026-11')=>{
 const data=encoder.encode(`%PDF-1.7 test-rotation-sample-${id}-${month}`);
 const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(data));
 return {id,fileName:'sample.pdf',originalFileName:'sample.pdf',pdf:new Blob([data],{type:'application/pdf'}),
 fileHash:Buffer.from(digest).toString('hex'),pages:1,revision:1,warningsAcknowledged:true,savedAt:new Date().toISOString(),
 form:{targetMonth:month,paymentDate:month+'-27',job:'main',kind:'salary',net:'180000',gross:'230000'}};
};
async function prepared(){
 const graph=new FakeGraph(),vault=new PayrollVault(graph);
 await vault.unlock(previous,true);await vault.saveBatch([await sample()]);
 return {graph,vault};
}
{
 const {graph,vault}=await prepared(),records=vault.records();
 const directory=[{id:'emp_'+'d'.repeat(32),name:'架空勤務先',role:'main',current:true}];
 await vault.writeEmployerDirectory([],directory);
 const priorPaths=[...graph.files.keys()];
 const result=await vault.changePassphrase(previous,changed);
 assert.ok(result.generation);
 assert.equal(vault.records().length,1);
 assert.equal((await vault.original(records[0])).size,records[0].pdfSize);
 const reopened=new PayrollVault(graph);
 await reopened.unlock(changed);
 assert.deepEqual(await reopened.readEmployerDirectory(),directory);
 assert.equal((await reopened.refresh()).length,1);
 assert.equal((await reopened.original(reopened.records()[0])).size,records[0].pdfSize);
 const wrong=new PayrollVault(graph);
 await assert.rejects(wrong.unlock(previous),/パスフレーズ|破損/);
 for(const path of priorPaths.filter(path=>path!=='payroll/index.enc'))assert.ok(graph.files.has(path),'old data preserved');
 assert.ok([...graph.files.keys()].some(path=>path.startsWith(`payroll/versions/${result.generation}/originals/`)));
 await reopened.saveBatch([await sample(152,'2026-12')]);
 assert.equal(reopened.records().length,2,'new record must write under new generation');
 console.log('PASS: complete key rotation, new-password unlock, old-password rejection, original PDF verification, and post-rotation writes');
}
{
 const {graph,vault}=await prepared();
 graph.failOn='/income/2026.enc';
 await assert.rejects(vault.changePassphrase(previous,changed),/test offline/);
 graph.failOn=null;
 const reopened=new PayrollVault(graph);
 assert.equal(await reopened.unlock(previous),true,'old key must still open after staging failure');
 assert.equal((await reopened.refresh()).length,1);
 assert.equal((await reopened.original(reopened.records()[0])).size,(await sample()).pdf.size);
 console.log('PASS: staging upload failure restores original index; old data and PDF remain readable');
}
{
 const {graph,vault}=await prepared();
 graph.modifyOnMetadata='payroll/statements/2026.enc';
 await assert.rejects(vault.changePassphrase(previous,changed),/別端末/);
 const reopened=new PayrollVault(graph);
 assert.equal(await reopened.unlock(previous),true);
 assert.equal((await reopened.refresh()).length,1);
 console.log('PASS: pre-commit ETag change aborts and restores old index');
}
{
 const {graph,vault}=await prepared();
 const original=vault.records()[0];
 const second=await sample(200,'2026-12');
 await vault.saveBatch([second]);
 const {generation}=await vault.changePassphrase(previous,changed);
 // Rotation is repeatable without relying on legacy path assumptions.
 await vault.changePassphrase(changed,'third-strong-passphrase-13579');
 const last=new PayrollVault(graph);
 await last.unlock('third-strong-passphrase-13579');
 assert.equal((await last.refresh()).length,2);
 assert.equal((await last.original(last.records().find(r=>r.id===original.id))).size,original.pdfSize);
 assert.ok(graph.files.has(`payroll/versions/${generation}/statements/2026.enc`));
 console.log('PASS: second passphrase rotation keeps all PDF records, including previous versions');
}
{
 const {graph,vault}=await prepared();
 const old=graph.files.get('payroll/index.enc'),secret=vault.sessionKey();
 const data=await decryptJson('index',old.text,secret.key);
 const locked={...data,rotation:{id:crypto.randomUUID(),startedAt:Date.now()-31*60*1000}};
 const text=await encryptJson('index',locked,secret.key,secret.salt);
 graph.files.set('payroll/index.enc',{...old,text,size:encoder.encode(text).length,etag:'stale-lock'});
 const blocked=new PayrollVault(graph);
 await assert.rejects(blocked.unlock(previous),InterruptedRotationError);
 assert.equal(await blocked.recoverInterruptedChange(previous),true);
 assert.equal(await blocked.unlock(previous),true);
 assert.equal((await blocked.refresh()).length,1);
 console.log('PASS: stale interrupted key rotation requires explicit recovery, then restores old active index');
}
{
 const {graph,vault}=await prepared();
 await assert.rejects(vault.changePassphrase('wrong-old-passphrase-123',changed));
 const unchanged=new PayrollVault(graph);
 assert.equal(await unchanged.unlock(previous),true);
 console.log('PASS: wrong original passphrase cannot modify any cloud data');
}
{
 const {graph,vault}=await prepared();
 const before=vault.records()[0],secret=vault.sessionKey();
 const bytes=encoder.encode('%PDF-1.7 synthetic distinct orphan');
 const fileHash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
 const originalId=crypto.randomUUID();
 const orphan={...before,id:9876,fileHash,pdfSize:bytes.length,originalId,originalMonth:'2027-04',form:{...before.form,targetMonth:'2027-04',paymentDate:'2027-04-27'}};
 await graph.write(['payroll','originals','2027','04'],`${originalId}.enc`,await encryptBytes('original',bytes,secret.key),null,80_000_000);
 await graph.write(['payroll','statements'],'2027.enc',await encryptJson('year',{
  format:'payroll-annual-v1',records:[orphan],deleted:[]
 },secret.key,secret.salt),null,30_000_000);
 const beforeWrites=graph.writes.length;
 await assert.rejects(vault.changePassphrase(previous,changed),/索引未登録.*2027|2027.*索引未登録/);
 assert.equal(graph.writes.length,beforeWrites,'orphan preflight must abort before a lock or staging writes');
 assert.deepEqual((await vault.inspectOrphanYears()).map(v=>v.year),['2027']);
 assert.equal(await vault.recoverOrphanYears(await vault.inspectOrphanYears()),1);
 const {generation}=await vault.changePassphrase(previous,changed);
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);
 assert.deepEqual((await reopened.refresh()).map(v=>v.id).sort((a,b)=>a-b),[151,9876]);
 assert.ok(graph.files.has(`payroll/versions/${generation}/statements/2027.enc`));
 console.log('PASS: nonempty orphan blocks key rotation with zero writes; explicit recovery preserves orphan in new generation');
}
{
 const {graph,vault}=await prepared();
 const previousRecord=vault.records()[0];
 await vault.remove(previousRecord.id);
 assert.equal(vault.records().length,0);
 const {generation}=await vault.changePassphrase(previous,changed);
 const copied=`payroll/versions/${generation}/originals/2026/11/${previousRecord.originalId}.enc`;
 assert.ok(graph.files.has(copied),'deleted-record original must migrate to new key generation');
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);
 assert.equal((await reopened.original(previousRecord)).size,previousRecord.pdfSize);
 const plan=await reopened.inspectOldEncryptedData();
 assert.ok(plan.targets.length>0);
 await reopened.cleanupOldEncryptedData(plan);
 assert.ok(graph.files.has(copied),'old folder cleanup must retain deleted original in current generation');
 assert.equal((await reopened.original(previousRecord)).size,previousRecord.pdfSize);
 console.log('PASS: a deleted statement original survives key rotation AND old encrypted-folder cleanup');
}
{
 const {graph,vault}=await prepared();
 const prior=vault.records()[0];await vault.remove(prior.id);
 const {generation}=await vault.changePassphrase(previous,changed);
 const copied=`payroll/versions/${generation}/originals/2026/11/${prior.originalId}.enc`;
 graph.files.delete(copied);
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);
 await assert.rejects(reopened.inspectOldEncryptedData(),/旧保存世代のPDF原本.*現行世代にありません/);
 assert.ok(graph.files.has(`payroll/originals/2026/11/${prior.originalId}.enc`));
 console.log('PASS: cleanup refuses preexisting old-only deleted original rather than trashing its only copy');
}
{
 const {graph,vault}=await prepared();
 const {generation}=await vault.changePassphrase(previous,changed);
 const secret=vault.sessionKey();
 // Simulate an old-generation statement created by a previous failed upload.
 // The current key cannot decrypt that old file; merely recognizing the
 // unindexed year is enough to stop destructive cleanup.
 const oldGraph=graph.files.get('payroll/statements/2026.enc');
 graph.files.set('payroll/statements/2027.enc',{...oldGraph,id:'payroll/statements/2027.enc',etag:'old-orphan-2027'});
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);
 await assert.rejects(reopened.inspectOldEncryptedData(),/2027\.enc.*現行索引に登録されていません/);
 assert.ok(graph.files.has('payroll/statements/2027.enc'));
 assert.ok(generation);
 console.log('PASS: cleanup blocks an unregistered annual file left in an older generation');
}
{
 const {graph,vault}=await prepared();
 const key=vault.sessionKey();
 await graph.write(['payroll','statements'],'2027.enc',await encryptJson('year',{
  format:'payroll-annual-v1',records:[],deleted:[]
 },key.key,key.salt),null,30_000_000);
 const orphan=await vault.inspectOrphanYears();
 assert.equal(orphan.length,1,'even empty orphan years must be discoverable');
 assert.deepEqual(orphan.map(v=>[v.year,v.records]),[['2027',0]]);
 await assert.rejects(vault.changePassphrase(previous,changed),/索引未登録/);
 assert.equal(await vault.recoverOrphanYears(orphan),1);
 const {generation}=await vault.changePassphrase(previous,changed);
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);
 const plan=await reopened.inspectOldEncryptedData();
 await reopened.cleanupOldEncryptedData(plan);
 assert.ok(graph.files.has(`payroll/versions/${generation}/statements/2027.enc`));
 console.log('PASS: an empty orphan is recoverable before rotation and does not block subsequent old-folder cleanup');
}
{
 const {graph,vault}=await prepared();
 const prior=vault.records()[0];await vault.remove(prior.id);
 const {generation}=await vault.changePassphrase(previous,changed);
 const path=`payroll/versions/${generation}/originals/2026/11/${prior.originalId}.enc`;
 const old=graph.files.get(path);
 assert.ok(old);
 const tampered=old.text.slice(0,-4)+'xxxx';
 graph.files.set(path,{...old,text:tampered,size:encoder.encode(tampered).length,etag:'tampered-original-copy'});
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);
 await assert.rejects(reopened.inspectOldEncryptedData(),'corrupt deleted-original ciphertext must block cleanup');
 assert.ok(graph.files.has(`payroll/originals/2026/11/${prior.originalId}.enc`));
 console.log('PASS: corrupt current-generation deleted-record PDF stops cleanup before old copy is trashed');
}
{
 const {graph,vault}=await prepared();
 const input=await sample();input.form={...input.form,targetMonth:'2027-04',paymentDate:'2027-04-27'};
 graph.failOn='/statements/2026.enc';
 await assert.rejects(vault.save(input),e=>{
  assert.equal(e.name,'PayrollPartialSuccessError');
  assert.equal(e.stage,'year-move');
  assert.match(e.message,/移動先|年度移動/);
  return true;
 });
 graph.failOn=null;
 assert.ok(graph.files.has('payroll/statements/2027.enc'));
 assert.ok(graph.files.has('payroll/statements/2026.enc'));
 console.log('PASS: failure removing source year after destination write is classified as year-move partial success');
}
{
 const code=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
 const backup=code.match(/export async function loadRecords\(onProgress[\s\S]*?(?=\nexport async function inspectReplacementConflicts\()/)?.[0];
 assert.ok(backup,'backup function must remain independently auditable');
 assert.match(code,/const freshReadOnlyOptions\s*=\s*\{forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true\}/);
 assert.match(backup,/const list=await vault\.refresh\(freshReadOnlyOptions\)/);
 assert.match(backup,/Math\.min\(2,list\.length\)/);
 assert.match(backup,/const latest=await vault\.refresh\(freshReadOnlyOptions\)/);
 assert.equal((backup.match(/vault\.refresh\(/g)??[]).length,2);
 assert.ok(backup.indexOf('const list=await vault.refresh')<backup.indexOf('await vault.original(item)'));
 assert.ok(backup.indexOf('await Promise.all')<backup.indexOf('const latest=await vault.refresh'));
 assert.match(backup,/JSON\.stringify\(payrollSnapshot\(latest\)\)!==JSON\.stringify\(snapshot\)/);
 assert.doesNotMatch(backup,/\bgetRecord\s*\(/);
 console.log('PASS: backup loads annual JSON once, fetches PDFs at concurrency 2, verifies a final snapshot');
}

{
 const html=readFileSync(new URL('../public/backup/index.html',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
 for(const id of ['change-current','change-new','change-confirm','change-ack','change-passphrase-button','change-passphrase-status']) {
  assert.equal((html.match(new RegExp(`id="${id}"`,'g'))??[]).length,1,`missing or duplicate ${id}`);
  assert.ok(ui.includes(id),`missing script control: ${id}`);
 }
 assert.match(html,/<section class="card settings-panel backup-key-change"/);
 assert.match(ui,/vault\.changePassphrase\(currentPass,newPass/);
 assert.match(ui,/await refreshSessionAfterKeyRotation\(\)/);
 assert.match(ui,/const zip=await createBackup\(records,employers\)/);
 assert.match(ui,/setInterval\(display,1000\)/);
 console.log('PASS: backup screen exposes controlled key rotation, download progress and success state');
}

// A2: normal deletion preserves originals; only explicit verified trash authorizes old-copy cleanup.
async function preservedOriginalAfterDeletion(graph,vault,record,current,old){
 const currentBefore=graph.files.get(current),oldBefore=graph.files.get(old);
 assert.ok(currentBefore);assert.ok(oldBefore);
 await vault.removeBatch([{id:record.id,matches:r=>r.originalId===record.originalId}]);
 assert.ok(!vault.records().some(r=>r.id===record.id),'statement deletion must be committed');
 assert.deepEqual(graph.files.get(current),currentBefore,'normal deletion must preserve the current encrypted original');
 assert.deepEqual(graph.files.get(old),oldBefore,'normal deletion must preserve the old encrypted original');
 const index=await decryptJson('index',graph.files.get('payroll/index.enc').text,vault.sessionKey().key);
 assert.equal(index.originalTrashHistory,undefined,'preservation must not authorize old-copy cleanup');
 const report=await vault.inspectDetachedOriginals();
 const candidate=report.originals.find(x=>x.uuid===record.originalId&&x.month===record.originalMonth);
 assert.ok(candidate,'explicit cleanup must discover the preserved original');
 assert.equal(candidate.id,currentBefore.id);assert.equal(candidate.etag,currentBefore.etag);
 return {report,candidate};
}
{
 const {graph,vault}=await prepared();const record=vault.records()[0];
 const {generation}=await vault.changePassphrase(previous,changed);
 const current=`payroll/versions/${generation}/originals/2026/11/${record.originalId}.enc`,old=`payroll/originals/2026/11/${record.originalId}.enc`;
 const annualPath=`payroll/versions/${generation}/statements/2026.enc`,beforeAnnual=graph.files.get(annualPath);
 const {report,candidate}=await preservedOriginalAfterDeletion(graph,vault,record,current,old);
 await vault.trashDetachedOriginal(report,candidate,new Set(['2026']));
 assert.ok(!graph.files.has(current));assert.ok(graph.files.has(old));
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);await reopened.refresh({forceFresh:true});
 const key=reopened.sessionKey().key;
 const index=await decryptJson('index',graph.files.get('payroll/index.enc').text,key);
 assert.equal(index.originalTrashHistory.length,1);assert.equal(index.originalTrashHistory[0].id,graph.files.get(old).id);
 const afterAnnual=graph.files.get(annualPath);graph.files.set(annualPath,beforeAnnual);
 await assert.rejects(reopened.inspectOldEncryptedData(),/有効な給与明細が参照する原本/);
 graph.files.set(annualPath,afterAnnual);
 const oldFile=graph.files.get(old);graph.files.set(old,{...oldFile,etag:'changed-old-copy'});
 await assert.rejects(reopened.inspectOldEncryptedData(),/旧保存世代のPDF原本.*現行世代にありません/);
 graph.files.set(old,oldFile);
 const third='third-synthetic-passphrase-123456';await reopened.changePassphrase(changed,third);
 const newest=new PayrollVault(graph);await newest.unlock(third);await newest.refresh({forceFresh:true});
 const next=await decryptJson('index',graph.files.get('payroll/index.enc').text,newest.sessionKey().key);
 assert.deepEqual(next.originalTrashHistory,index.originalTrashHistory);
 const plan=await newest.inspectOldEncryptedData();await newest.cleanupOldEncryptedData(plan);assert.ok(!graph.files.has(old));
 console.log('PASS A2: receipt survives restart and another key rotation, changed old ETag blocks cleanup');
}
for(const failReceipt of [false,true]){
 const {graph,vault}=await prepared();const record=vault.records()[0];const {generation}=await vault.changePassphrase(previous,changed);
 const current=`payroll/versions/${generation}/originals/2026/11/${record.originalId}.enc`,old=`payroll/originals/2026/11/${record.originalId}.enc`;
 const {report,candidate}=await preservedOriginalAfterDeletion(graph,vault,record,current,old);
 graph.failTrash=!failReceipt;graph.failReceipt=failReceipt;
 await assert.rejects(vault.trashDetachedOriginal(report,candidate,new Set(['2026'])),failReceipt?/test offline/:/synthetic trash failure/);
 graph.failOn=null;graph.failTrash=false;graph.failReceipt=false;
 const reopened=new PayrollVault(graph);await reopened.unlock(changed);await reopened.refresh({forceFresh:true});
 const index=await decryptJson('index',graph.files.get('payroll/index.enc').text,reopened.sessionKey().key);
 assert.equal(index.originalTrashHistory,undefined);assert.ok(graph.files.has(old));
 if(failReceipt){assert.ok(!graph.files.has(current));await assert.rejects(reopened.inspectOldEncryptedData(),/旧保存世代のPDF原本.*現行世代にありません/);}
 else assert.ok(graph.files.has(current));
 console.log('PASS A2: '+(failReceipt?'failed receipt preserves old-only original':'failed DELETE produces no receipt'));
}
