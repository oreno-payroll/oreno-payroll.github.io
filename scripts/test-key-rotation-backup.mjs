/** OneDriveを使用しない保管庫パスフレーズ変更・旧データ復元・重複通信抑制のテスト */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=new URL('../',import.meta.url).pathname;
const result=await build({
 stdin:{contents:"export {PayrollVault,InterruptedRotationError} from './src/cloud/vault.ts'; export {GraphError} from './src/cloud/graph.ts'; export {encryptJson,decryptJson} from './src/cloud/crypto.ts';",resolveDir:root,sourcefile:'test-entry.ts',loader:'ts'},
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollVault,InterruptedRotationError,GraphError,encryptJson,decryptJson}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const encoder=new TextEncoder();
class FakeGraph {
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
 const priorPaths=[...graph.files.keys()];
 const result=await vault.changePassphrase(previous,changed);
 assert.ok(result.generation);
 assert.equal(vault.records().length,1);
 assert.equal((await vault.original(records[0])).size,records[0].pdfSize);
 const reopened=new PayrollVault(graph);
 await reopened.unlock(changed);
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
 const code=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
 assert.match(code,/export async function loadRecords\(onProgress/);
 assert.match(code,/const list=await vault\.refresh\(\)/);
 assert.match(code,/Math\.min\(2,list\.length\)/);
 assert.match(code,/payrollSnapshot\(latest\)/);
 assert.doesNotMatch(code,/for\(const item of list\)\{const record=await getRecord/);
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
 assert.match(ui,/vault\.changePassphrase\(changeCurrent\.value,changeNew\.value/);
 assert.match(ui,/await refreshSessionAfterKeyRotation\(\)/);
 assert.match(ui,/const zip=await createBackup\(records\)/);
 assert.match(ui,/setInterval\(display,1000\)/);
 console.log('PASS: backup screen exposes controlled key rotation, download progress and success state');
}
