/** Phase 3: synthetic-only Graph & cryptographic regression. No Microsoft sign-in or real PDFs. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=fileURLToPath(new URL('../',import.meta.url));
const output=await build({
 stdin:{contents:[
  "export {PayrollVault} from './src/cloud/vault.ts'",
  "export {GraphError} from './src/cloud/graph.ts'",
  "export {encryptJson,encryptBytes,decryptJson} from './src/cloud/crypto.ts'",
  "export {getRecordSummary,getOriginalForVerifiedEdit,updateRecordMetadata,recordSignature} from './src/storage/payrollStore.ts'",
 ].join(';'),resolveDir:root,loader:'ts',sourcefile:'phase03-entry.ts'},
 plugins:[{name:'synthetic-auth-only',setup(ctx){
  ctx.onResolve({filter:/^\.\.\/cloud\/auth$/},()=>({path:'phase03-auth',namespace:'synthetic'}));
  ctx.onLoad({filter:/.*/,namespace:'synthetic'},()=>({contents:'export async function cloudVault(){return globalThis.__phase03Vault;}',loader:'js'}));
 }}],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const mod=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
const {PayrollVault,GraphError,encryptJson,encryptBytes,getRecordSummary,getOriginalForVerifiedEdit,updateRecordMetadata,recordSignature}=mod;
const encode=new TextEncoder();
class FakeGraph{
 async withWriteLock(operation){return operation();}
 files=new Map();reads=new Map();writes=new Map();
 path(parts,name){return [...parts,name].join('/');}
 put(path,text){this.files.set(path,{id:path,etag:'e'+(++this.revision),text,size:encode.encode(text).byteLength});}
 revision=0;
 async read(parts,name){const p=this.path(parts,name);this.reads.set(p,(this.reads.get(p)??0)+1);const row=this.files.get(p);return row?{...row}:null;}
 async metadata(parts,name){const file=this.files.get(this.path(parts,name));return file?{id:file.id,etag:file.etag,size:file.size}:null;}
 async write(parts,name,text,prior){const p=this.path(parts,name),old=this.files.get(p);if(prior?old?.etag!==prior.etag:!!old)throw new GraphError(412,'conflict');
  this.writes.set(p,(this.writes.get(p)??0)+1);this.put(p,text);
 }
 count(prefix){return [...this.reads].filter(([key])=>key.startsWith(prefix)).reduce((a,[,count])=>a+count,0);}
 writesCount(prefix){return [...this.writes].filter(([key])=>key.startsWith(prefix)).reduce((a,[,count])=>a+count,0);}
}
const graph=new FakeGraph(),vault=new PayrollVault(graph);
// Seed a synthetic, authenticated encrypted vault. No personal data.
await vault.unlock('phase03-synthetic-passphrase',true);
const {key,salt}=vault.sessionKey(),id=1337,pdfBytes=encode.encode('%PDF-1.7\nSynthetic-only PDF bytes.\n%%EOF');
const hash=Buffer.from(await crypto.subtle.digest('SHA-256',pdfBytes)).toString('hex');
const originalId=crypto.randomUUID();
const form={job:'main',kind:'salary',targetMonth:'2026-10',paymentDate:'2026-11-25',gross:'230000',net:'230000',taxable:'230000',workDays:'20'};
const source={id,fileName:'synthetic.pdf',originalFileName:'source.pdf',fileHash:hash,pdfSize:pdfBytes.byteLength,pdfType:'application/pdf',
 originalId,originalMonth:'2026-10',savedAt:'2026-11-25T00:00:00Z',revision:1,pages:1,warningsAcknowledged:true,form};
const sourceYear='2026';
graph.put('payroll/index.enc',await encryptJson('index',{format:'payroll-index-v1',years:['2026'],incomeYears:[]},key,salt));
graph.put('payroll/statements/2026.enc',await encryptJson('year',{format:'payroll-annual-v1',records:[source],deleted:[]},key,salt));
graph.put(`payroll/originals/2026/10/${originalId}.enc`,await encryptBytes('original',pdfBytes,key));
await vault.unlockWithKey(key,salt);globalThis.__phase03Vault=vault;
const initial=await getRecordSummary(id);
assert.ok(initial);
assert.equal(Object.hasOwn(initial,'pdf'),false,'no fake or real PDF in edit metadata');
assert.equal(Object.hasOwn(initial,'originalId'),false,'physical PDF reference stays inside vault');
assert.equal(graph.count('payroll/originals/'),0,'opening edit performs zero PDF downloads');
const oldSignature=recordSignature(initial);
const changed={...initial,form:{...initial.form,net:'229999'},revision:1};
await updateRecordMetadata(changed,[],oldSignature);
const after=vault.records().find(x=>x.id===id);
assert.equal(after.form.net,'229999');
assert.equal(after.revision,2);
for(const field of ['originalId','originalMonth','pdfSize','pdfType','fileHash'])assert.equal(after[field],source[field],`immutable ${field}`);
assert.equal(graph.count('payroll/originals/'),0,'editing uses no PDF read');
assert.equal(graph.writesCount('payroll/originals/'),0,'editing must not rewrite the original');
assert.equal(graph.writesCount('payroll/statements/2026.enc'),1,'one ETag annual update');
assert.equal(graph.writesCount('payroll/income/2026.enc'),1,'Finance income still synchronized');
console.log('PASS: initial edit and metadata-only update avoid original PDF I/O, preserve physical reference and Finance sync');
// A stale edit must be rejected *before* cloud changes.
await assert.rejects(updateRecordMetadata({...initial,form:{...form,net:'1'}},[],oldSignature),/別端末/);
assert.equal(graph.writesCount('payroll/statements/2026.enc'),1,'stale revision cannot overwrite');
// A PDF is fetched only after a deliberate view/download action, with size and SHA-256 verification.
const latest=await getRecordSummary(id),sig=recordSignature(latest);
const pdf=await getOriginalForVerifiedEdit(id,sig);
assert.equal(pdf.size,pdfBytes.byteLength);
assert.equal(graph.count('payroll/originals/'),1,'one validated PDF fetched on demand');
// Tamper detection: same-length encrypted but different bytes fails SHA-256.
const changedBytes=pdfBytes.slice();changedBytes[7]^=1;
graph.put(`payroll/originals/2026/10/${originalId}.enc`,await encryptBytes('original',changedBytes,key));
await assert.rejects(getOriginalForVerifiedEdit(id,sig),/SHA-256/);
console.log('PASS: on-demand original is verified; tampered ciphertext that decrypts to wrong SHA is rejected');
// Concurrent remote change after the loaded editing snapshot cannot silently overwrite.
const remote={...after,form:{...after.form,net:'220000'},revision:3};
graph.put('payroll/statements/2026.enc',await encryptJson('year',{format:'payroll-annual-v1',records:[remote],deleted:[]},key,salt));
await assert.rejects(updateRecordMetadata({...latest,form:{...latest.form,net:'225000'}},[],sig),/別端末/);
assert.equal(graph.writesCount('payroll/statements/2026.enc'),1,'remote edit remains intact');
vault.lock();
await assert.rejects(getRecordSummary(id),/保管庫|解除|索引/);
console.log('PASS: remote edits reject stale save; locked vault never serves a stale summary');
const edit=readFileSync(new URL('../src/edit.ts',import.meta.url),'utf8');
const dashboard=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
assert.match(edit,/await getRecordSummary\(id,yearHint,directory=>\{employerDirectory=directory;\}\)/);
assert.doesNotMatch(edit,/URL\.createObjectURL\(record\.pdf\)/);
assert.match(edit,/preparePdfHandoff\(/);
assert.match(edit,/getOriginalForVerifiedEdit\(/);
assert.match(edit,/updateRecordMetadata\(updated/);
assert.match(dashboard,/const before=await loadRecordSummaries\(\)/);
assert.match(dashboard,/const after=await loadRecordSummaries\(\)/);
assert.match(dashboard,/getOriginalForBatchExport\(item\.id,recordSignature\(item\)\)/);
console.log('PASS: UI keeps safe view handoff and bulk export uses two verification snapshots instead of N full refreshes');
