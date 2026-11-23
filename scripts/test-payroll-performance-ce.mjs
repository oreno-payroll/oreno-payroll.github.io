/** C+E: synthetic-only cross-page ETag reuse. Never logs in, writes OneDrive, or opens a GUI browser. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const base=fileURLToPath(new URL('../',import.meta.url));
const built=await build({stdin:{contents:[
 "export {PayrollVault} from './src/cloud/vault.ts'",
 "export {encryptJson,encryptBytes,createSalt,deriveKey} from './src/cloud/crypto.ts'",
 "export {getRecordSummary,getOriginalForVerifiedEdit,recordSignature} from './src/storage/payrollStore.ts'",
 "export {rememberNavigationSnapshot} from './src/cloud/snapshot.ts'",
].join(';'),resolveDir:base,sourcefile:'ce-test-entry.ts',loader:'ts'},
 plugins:[{name:'mock-auth',setup(ctx){
  ctx.onResolve({filter:/^\.\.\/cloud\/auth$/},()=>({namespace:'test',path:'ce-auth'}));
  ctx.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export async function cloudVault(){return globalThis.__ceVault;}',loader:'js'}));
 }}],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
const mod=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const {PayrollVault,encryptJson,encryptBytes,createSalt,deriveKey,getRecordSummary,getOriginalForVerifiedEdit,recordSignature,rememberNavigationSnapshot}=mod;
const storage=new Map();globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
const scope='client-synthetic:identity-synthetic',pass='synthetic-password-for-ce-tests-only';
const encoder=new TextEncoder(),pdf=encoder.encode('%PDF-1.7\nSynthetic encrypted PDF\n%%EOF');
const hash=Buffer.from(await crypto.subtle.digest('SHA-256',pdf)).toString('hex');
const form=(year)=>({job:'main',kind:'salary',targetMonth:year+'-05',paymentDate:year+'-06-01',gross:'250000',net:'220000',taxable:'250000',workDays:'20'});
const make=(id,year,revision=1)=>({id,fileName:`synthetic-${year}.pdf`,originalFileName:'only-synthetic.pdf',fileHash:hash,pdfSize:pdf.length,pdfType:'application/pdf',
 originalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',originalMonth:'2026-05',savedAt:'2026-06-01T00:00:00Z',revision,pages:1,warningsAcknowledged:true,form:form(year)});
const path=(parts,name)=>[...parts,name].join('/');
class FakeGraph{
 files=new Map();seq=0;calls={index:0,annual:0,inventory:0,metadata:0,original:0,write:0};
 onOriginal=null;onAnnual=null;onInventory=null;
 put(parts,name,text){const key=path(parts,name);this.files.set(key,{id:key,etag:`e-${++this.seq}`,size:encoder.encode(text).length,text});}
 async read(parts,name){const key=path(parts,name);
  if(key==='payroll/index.enc')this.calls.index++;
  else if(key.includes('/statements/')){this.calls.annual++;if(this.onAnnual)await this.onAnnual(key);}
  else if(key.includes('/originals/')){this.calls.original++;if(this.onOriginal)await this.onOriginal(key);}
  const x=this.files.get(key);return x?{...x}:null;
 }
 async listFolder(parts){const prefix=parts.join('/')+'/';this.calls.inventory++;
  let result=[...this.files.entries()].filter(([p])=>p.startsWith(prefix)&&!p.slice(prefix.length).includes('/')).map(([p,v])=>({name:p.slice(prefix.length),id:v.id,etag:v.etag,size:v.size,folder:false}));
  if(this.onInventory)result=await this.onInventory(result);
  return result;
 }
 async metadata(parts,name){this.calls.metadata++;const x=this.files.get(path(parts,name));return x?{id:x.id,etag:x.etag,size:x.size}:null;}
 async write(){this.calls.write++;throw Error('CE read-only test must never write to OneDrive');}
 reset(){this.calls={index:0,annual:0,inventory:0,metadata:0,original:0,write:0};}
}
const graph=new FakeGraph(),first=new PayrollVault(graph);
first.setNavigationScope(scope);
const salt=createSalt(),seedKey=await deriveKey(pass,salt),years=['2023','2024','2025','2026'];
const index={format:'payroll-index-v1',years:[...years],incomeYears:[]};
const remoteDoc=(records)=>({format:'payroll-annual-v1',records,deleted:[]});
graph.put(['payroll'],'index.enc',await encryptJson('index',index,seedKey,salt));
const originalRows=new Map();
for(const year of years){
 const records=[make(Number(year),year)];originalRows.set(year,records);
 graph.put(['payroll','statements'],`${year}.enc`,await encryptJson('year',remoteDoc(records),seedKey,salt));
}
graph.put(['payroll','originals','2026','05'],'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.enc',await encryptBytes('original',pdf,seedKey));
await first.unlock(pass);
assert.equal((await first.refresh({forceFresh:true})).length,4);
assert.equal(graph.calls.annual,4,'initial view authenticates each indexed year');
const encrypted=storage.get('payroll-navigation-snapshot-v1');
assert.ok(encrypted?.length>200,'the cross-page encrypted snapshot must exist');
assert.doesNotMatch(encrypted,/synthetic-2026\.pdf|originalId|e-\d+|targetMonth|versions/,'metadata and salary plaintext must not leak into browser storage');
const {key:activeKey}=first.sessionKey();
const returning=new PayrollVault(graph);returning.setNavigationScope(scope);
assert.equal(await returning.resumeFromSnapshot(activeKey,salt),true);
globalThis.__ceVault=returning;
const selectedId=2026;
graph.reset();
const summary=await getRecordSummary(selectedId,'2026');
assert.ok(summary&&summary.id===selectedId&&summary.form.targetMonth==='2026-05');
assert.deepEqual({...graph.calls},{index:1,annual:0,inventory:1,metadata:0,original:0,write:0},'E: one fresh index + one inventory, no annual decrypt');
assert.equal('originalId' in summary,false,'physical storage key is never shown to the editor');
const sig=recordSignature(summary);
graph.reset();
const bytes=await getOriginalForVerifiedEdit(selectedId,sig);
assert.equal(bytes.size,pdf.length);
assert.deepEqual({...graph.calls},{index:2,annual:0,inventory:2,metadata:0,original:1,write:0},'C: before + after require fresh global metadata without N reads');
console.log('PASS C+E: encrypted cross-page metadata reduces 4-year edit to 1 index + 1 listing, PDF verification to 2 listings');

// Untrusted hints cannot suppress source validation, redirect physical storage,
// hide cross-year duplicates, or choose an incorrect edit target.
graph.reset();
const wrongHint=await getRecordSummary(selectedId,'2023');
assert.equal(recordSignature(wrongHint),sig);
assert.equal(graph.calls.inventory,1);
assert.equal(graph.calls.annual,0);
assert.ok((await getRecordSummary(selectedId,'0000'))?.id===selectedId);
assert.equal(graph.calls.write,0);
console.log('PASS E: URL year hint changes priority only; all indexed years and the record ID are still verified');

// An unrelated year changed after the snapshot: decrypt only that year and
// let the existing global revision resolver choose the relocated record.
const moved=make(selectedId,'2025',2);
originalRows.set('2025',[make(2025,'2025'),moved]);
graph.put(['payroll','statements'],'2025.enc',await encryptJson('year',remoteDoc(originalRows.get('2025')),seedKey,salt));
graph.reset();
const movedSummary=await getRecordSummary(selectedId,'2026');
assert.equal(movedSummary.form.targetMonth,'2025-05','the new higher-revision record wins');
assert.equal(graph.calls.annual,1,'only the modified other year is re-fetched and decrypted');
assert.equal(graph.calls.inventory,1);
assert.equal(graph.calls.original,0);
await assert.rejects(getOriginalForVerifiedEdit(selectedId,sig),/更新|再読み込み/,'a stale original cannot escape the source identity check');
assert.equal(graph.calls.original,0,'signature mismatch aborts before PDF download');
console.log('PASS C: cross-year move/ID collision is detected without blindly trusting the hinted year');

// Restore the previous source layout to test races while a PDF is downloading.
originalRows.set('2025',[make(2025,'2025')]);
graph.put(['payroll','statements'],'2025.enc',await encryptJson('year',remoteDoc(originalRows.get('2025')),seedKey,salt));
const currentSummary=await getRecordSummary(selectedId,'2026');
const currentSig=recordSignature(currentSummary);
let raced=false;
graph.onOriginal=async()=>{
 if(raced)return;
 raced=true;
 const updated={...make(selectedId,'2026',3),form:{...make(selectedId,'2026',3).form,net:'210000'}};
 originalRows.set('2026',[updated]);
 graph.put(['payroll','statements'],'2026.enc',await encryptJson('year',remoteDoc([updated]),seedKey,salt));
};
graph.reset();
await assert.rejects(getOriginalForVerifiedEdit(selectedId,currentSig),/PDF取得中に明細が更新/);
graph.onOriginal=null;
assert.equal(raced,true);
assert.equal(graph.calls.annual,1,'changed source year after PDF retrieval gets re-fetched');
assert.equal(graph.calls.original,1);
assert.equal(graph.calls.write,0);
console.log('PASS C: remote update during PDF transfer is caught AFTER decryption and SHA-256 validation');

// If a Graph children listing is incomplete, the editor must not return
// a stale cached record even if the encrypted tab snapshot is still valid.
graph.onInventory=async rows=>rows.filter(row=>row.name!=='2024.enc');
graph.reset();
await assert.rejects(getRecordSummary(selectedId,'2026'),/年度ファイルの一覧|年度メタデータ/);
graph.onInventory=null;
assert.equal(graph.calls.write,0);
// If there is an unexpected index generation, the old per-year proof is invalid.
graph.put(['payroll'],'index.enc',await encryptJson('index',{...index,generation:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},seedKey,salt));
await assert.rejects(getRecordSummary(selectedId,'2026'),/保存世代/);
console.log('PASS C+E: missing inventory and generation change fail closed');

// Older browser snapshots without verified ETags may be used for display only;
// an explicit edit always re-downloads all annual JSON instead of trusting them.
graph.put(['payroll'],'index.enc',await encryptJson('index',index,seedKey,salt));
await rememberNavigationSnapshot(scope,salt,activeKey,{index,years:[...originalRows].map(([year,records])=>[year,remoteDoc(records)])});
const legacy=new PayrollVault(graph);legacy.setNavigationScope(scope);
assert.equal(await legacy.resumeFromSnapshot(activeKey,salt),true);
globalThis.__ceVault=legacy;
graph.reset();
assert.ok(await getRecordSummary(selectedId,'2026'));
assert.equal(graph.calls.annual,4,'old snapshots cannot skip decrypting annual JSON');
console.log('PASS E: legacy snapshots have a safe full-read fallback');

const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const edit=readFileSync(new URL('../src/edit.ts',import.meta.url),'utf8');
const payroll=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
assert.match(main,/hintYear=\$\{encodeURIComponent\(String\(hintedYear\)\)\}/);
assert.match(edit,/getRecordSummary\(id,yearHint\)/);
assert.match(payroll,/bulkYearMetadata:true/);
assert.match(payroll,/await vault\.refresh\(\{forceFresh:true\}\)/,'mutation paths still do full revalidation');
console.log('PASS: UI hints are advisory; write paths retain full remote verification');
