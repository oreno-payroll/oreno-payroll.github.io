/** 保存バッチの回帰テスト。暗号化ファイルとETagを擬似OneDriveで保持し、ネットワーク不使用。 */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({
 stdin:{contents:[
  "export {PayrollVault} from './src/cloud/vault.ts'",
  "export {GraphError} from './src/cloud/graph.ts'",
  "export {encryptJson,decryptJson,decryptBytes} from './src/cloud/crypto.ts'",
 ].join(';'),resolveDir:root,sourcefile:'batch-entry.ts',loader:'ts'},
 bundle:true,format:'esm',platform:'node',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollVault,GraphError,encryptJson,decryptJson,decryptBytes}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const encoder=new TextEncoder();
class FakeGraph {
 files=new Map();reads=new Map();writes=new Map();activeOriginals=0;maxOriginals=0;
 hooks={};
 path(parts,name){return [...parts,name].join('/');}
 async read(parts,name){
  const path=this.path(parts,name);
  this.reads.set(path,(this.reads.get(path)??0)+1);
  if(this.hooks.read)await this.hooks.read(path,this);
  const item=this.files.get(path);
  return item?{...item}:null;
 }
 async write(parts,name,text,prior,limit,progress){
  const path=this.path(parts,name),bytes=encoder.encode(text).byteLength;
  if(bytes>limit)throw new Error('too large');
  this.writes.set(path,(this.writes.get(path)??0)+1);
  const original=parts.includes('originals');
  if(original){this.activeOriginals++;this.maxOriginals=Math.max(this.maxOriginals,this.activeOriginals);}
  try{
   // 独立したWorker同士の進行を意図的に交錯させる。
   if(original)await new Promise(resolve=>setTimeout(resolve,2));
   if(this.hooks.write)await this.hooks.write(path,this);
   const prev=this.files.get(path);
   if(prior && (!prev || prev.etag!==prior.etag))throw new GraphError(412,'conflict');
   if(!prior&&prev)throw new GraphError(409,'conflict');
   const etag=`etag-${Math.random()}`;
   this.files.set(path,{id:path,etag,text,size:bytes});
   progress?.(bytes,bytes);
  }finally{if(original)this.activeOriginals--;}
 }
 count(prefix){return [...this.writes].reduce((n,[path,c])=>n+(path.startsWith(prefix)?c:0),0);}
}
const start=async()=>{
 const graph=new FakeGraph(),vault=new PayrollVault(graph);
 await vault.unlock('test-only-passphrase-long-enough',true);
 return {graph,vault};
};
const sample=async(id,month,job='main')=>{
 const bytes=encoder.encode(`%PDF-1.7 test-document-${id}-${month}`);
 const hash=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));
 return {
  id,fileName:`test-${id}.pdf`,originalFileName:`test-${id}.pdf`,fileHash:Buffer.from(hash).toString('hex'),
  pdf:new Blob([bytes],{type:'application/pdf'}),pages:1,revision:1,warningsAcknowledged:true,
  savedAt:'2026-11-16T00:00:00Z',form:{targetMonth:month,paymentDate:month+'-27',job,kind:'salary',net:String(10000+id),gross:String(11000+id)},
 };
};
const entries=async months=>Promise.all(months.map((month,i)=>sample(101+i,month)));
{
 const {vault,graph}=await start();
 const group=await entries(['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11']);
 const updates=[];
 await vault.saveBatch(group,status=>updates.push(status));
 assert.equal(graph.count('payroll/originals/'),8,'each PDF must be independently uploaded');
 assert.ok(graph.maxOriginals<=2&&graph.maxOriginals===2,'no more than 2 concurrent original uploads');
 assert.equal(graph.count('payroll/statements/'),1,'one annual JSON update for 8 records');
 assert.equal(graph.count('payroll/income/'),1,'one income JSON update for same payment year');
 assert.equal(graph.writes.get('payroll/index.enc'),3,'index created once plus two distinct year registrations');
 assert.equal(vault.records().length,8,'all 8 records visible after commit');
 assert.match(updates.at(-1),/8件のOneDrive保存・読み戻し検証がすべて完了/);
 const data=await graph.read(['payroll','statements'],'2026.enc');
 assert.equal((await decryptJson('year',data.text,vault.sessionKey().key)).records.length,8);
 for(const rec of vault.records()) {
  const original=await vault.original(rec);
  assert.equal(original.size,rec.pdfSize);
 }
 console.log('PASS: 8 PDFs at concurrency 2, one annual JSON and one income JSON; every original verifiable');
}
{
 const {vault,graph}=await start();
 await vault.saveBatch(await entries(['2025-12','2026-01','2026-04','2026-05']));
 assert.equal(graph.count('payroll/statements/'),2,'two fiscal years => two JSON files');
 assert.equal(graph.count('payroll/income/'),2,'two payment years => two income files');
 assert.equal(vault.records().length,4);
 console.log('PASS: independent fiscal-year partitions and payment-year income partitions');
}
{
 const {vault,graph}=await start();
 const records=await entries(['2026-04','2026-05']);
 let hit=false;
 graph.hooks.read=async(path,g)=>{
  if(path!=='payroll/statements/2026.enc'||hit)return;
  hit=true;
  const other=await sample(9899,'2026-04');const {pdf,...summary}=other;
  const doc={format:'payroll-annual-v1',records:[{...summary,pdfSize:pdf.size,pdfType:pdf.type,originalId:crypto.randomUUID(),originalMonth:other.form.targetMonth}],deleted:[]};
  const text=await encryptJson('year',doc,vault.sessionKey().key,vault.sessionKey().salt);
  g.files.set(path,{id:path,etag:'concurrent',text,size:encoder.encode(text).length});
 };
 await assert.rejects(vault.saveBatch(records),/同じ給与を保存/);
 assert.equal(graph.count('payroll/statements/'),0,'conflicting remote period must never be overwritten');
 assert.equal(graph.count('payroll/income/'),0,'income must not sync for conflicted write');
 console.log('PASS: another device inserting same period before commit stops batch safely');
}
{
 const {vault,graph}=await start();
 graph.hooks.write=async path=>{if(path.endsWith('/originals/2026/05/'+path.split('/').at(-1)))throw new Error('simulated network error');};
 await assert.rejects(vault.saveBatch(await entries(['2026-04','2026-05','2026-06'])),/解析明細は未確定/);
 assert.equal(graph.count('payroll/statements/'),0,'no annual data committed on original upload failure');
 assert.equal(graph.count('payroll/income/'),0,'no income data committed on original upload failure');
 console.log('PASS: partial original upload failure stops metadata commit, never reports success');
}
{
 const {vault,graph}=await start();
 const initial=await entries(['2026-04']);
 let conflictOnce=false;
 graph.hooks.write=async(path,g)=>{
  if(path==='payroll/statements/2026.enc'&&!conflictOnce){
   conflictOnce=true;
   const other=await sample(9999,'2026-12');const {pdf,...summary}=other;
   const doc={format:'payroll-annual-v1',records:[{...summary,pdfSize:pdf.size,pdfType:pdf.type,originalId:crypto.randomUUID(),originalMonth:other.form.targetMonth}],deleted:[]};
   const text=await encryptJson('year',doc,vault.sessionKey().key,vault.sessionKey().salt);
   g.files.set(path,{id:path,etag:'new-etag',text,size:encoder.encode(text).length});
  }
 };
 await vault.saveBatch(initial);
 assert.equal(graph.count('payroll/statements/'),2,'ETag mismatch causes safe retry');
 assert.deepEqual(vault.records().map(r=>r.id).sort((a,b)=>a-b),[101,9999]);
 console.log('PASS: ETag collision retries merge independent records without data loss');
}

{
 const {vault,graph}=await start();
 graph.hooks.write=async path=>{if(path==='payroll/income/2026.enc')throw new Error('simulated income outage');};
 await assert.rejects(vault.saveBatch(await entries(['2026-04','2026-05'])),/一部の年度ファイルや収入連携データが更新済みの可能性/);
 assert.equal(graph.count('payroll/statements/'),1,'annual records may be committed before income outage');
 assert.equal(graph.count('payroll/income/'),1,'income write fails and is never reported as success');
 assert.equal(vault.records().length,2,'confirmed annual records remain visible for recovery');
 console.log('PASS: failure after annual commit reports partial state, never claims all saved');
}
{
 const code=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
 assert.match(code,/await vault\.saveBatch\(batch,onProgress\)/,'upload entry point uses cloud batch');
 assert.doesNotMatch(code,/for\(const item of accepted\)\s*\{/,'no per-record roundtrip loop');
 console.log('PASS: upload entry point routes new records into a single batch');
}
