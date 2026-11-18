/** No real OAuth, OneDrive, or payroll data. Fail-safe consistency regressions. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({stdin:{contents:[
 "export {PayrollVault} from './src/cloud/vault.ts'",
 "export {GraphError} from './src/cloud/graph.ts'",
 "export {encryptJson,decryptJson} from './src/cloud/crypto.ts'",
].join(';'),resolveDir:root,sourcefile:'integrity-entry.ts',loader:'ts'},
 bundle:true,format:'esm',platform:'node',target:'es2022',write:false,logLevel:'silent'});
const {PayrollVault,GraphError,encryptJson,decryptJson}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const encoder=new TextEncoder();
class Graph {
 files=new Map();writes=new Map();hooks={};
 path(parts,name){return [...parts,name].join('/');}
 async read(parts,name){const path=this.path(parts,name);await this.hooks.read?.(path,this);return this.files.get(path)??null;}
 async write(parts,name,text,prior,limit,progress){
  const path=this.path(parts,name);
  this.writes.set(path,(this.writes.get(path)??0)+1);
  await this.hooks.write?.(path,this);
  const prev=this.files.get(path);
  if(prior && (!prev||prior.etag!==prev.etag))throw new GraphError(412,'conflict');
  if(!prior&&prev)throw new GraphError(409,'conflict');
  const size=encoder.encode(text).byteLength;
  if(size>limit)throw new Error('too large');
  this.files.set(path,{id:path,etag:`etag-${this.writes.get(path)}`,text,size});
  progress?.(size,size);
 }
 async listFolder(parts){const prefix=parts.join('/')+'/';return [...this.files]
  .filter(([path])=>path.startsWith(prefix)&&!path.slice(prefix.length).includes('/'))
  .map(([path,v])=>({id:path,name:path.slice(prefix.length),etag:v.etag,folder:false,size:v.size}));}
 count(prefix){return [...this.writes].reduce((total,[key,n])=>total+(key.startsWith(prefix)?n:0),0);}
}
const open=async()=>{const graph=new Graph(),vault=new PayrollVault(graph);await vault.unlock('integrity-test-passphrase-123456',true);return {graph,vault};};
const sample=async(id,month='2026-04')=>{
 const bytes=encoder.encode(`%PDF-1.7  mock-original-${id}`);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return {id,fileName:`${id}.pdf`,fileHash:Buffer.from(digest).toString('hex'),
  pdf:new Blob([bytes],{type:'application/pdf'}),savedAt:'2026-11-16',pages:1,warningsAcknowledged:true,revision:1,
  form:{job:'main',kind:'salary',targetMonth:month,paymentDate:month+'-27',net:String(1000+id),gross:String(2000+id)}};
};
const cloudRecord=(record,id,month)=>{const {pdf,...metadata}=record;return {...metadata,originalId:id,originalMonth:month,pdfSize:pdf.size,pdfType:pdf.type};};
const put=async(graph,path,text)=>{const bytes=encoder.encode(text).byteLength;graph.files.set(path,{id:path,etag:`injected-${bytes}-${crypto.randomUUID()}`,text,size:bytes});};
{
 const {graph,vault}=await open();
 graph.hooks.write=async(path)=>{if(path==='payroll/index.enc')throw new Error('index upload offline');};
 await assert.rejects(vault.saveBatch([await sample(11)]),/索引|offline/);
 const year=graph.files.get('payroll/statements/2026.enc');
 assert.ok(year,'initial year file is safely created');
 const data=await decryptJson('year',year.text,vault.sessionKey().key);
 assert.equal(data.records.length,0,'no populated records are written before year registration');
 const index=await decryptJson('index',graph.files.get('payroll/index.enc').text,vault.sessionKey().key);
 assert.deepEqual(index.years,[],'index remains unchanged after failed registration');
 console.log('PASS: index registration failure cannot orphan populated annual statements');

 // Simulate an old version having written a populated file before index registration failed.
 graph.hooks.write=undefined;
 const record=await sample(11);
 const originalPath=[...graph.files.keys()].find(k=>k.startsWith('payroll/originals/2026/04/'));
 assert.ok(originalPath);
 const originalId=originalPath.split('/').at(-1).slice(0,-4);
 await put(graph,'payroll/statements/2026.enc',await encryptJson('year',{
  format:'payroll-annual-v1',records:[cloudRecord(record,originalId,'2026-04')],deleted:[]
 },vault.sessionKey().key,vault.sessionKey().salt));
 const candidates=await vault.inspectOrphanYears();
 assert.deepEqual(candidates.map(x=>[x.year,x.records]),[['2026',1]]);
 assert.equal(await vault.recoverOrphanYears(candidates),1);
 assert.deepEqual(vault.records().map(x=>x.id),[11]);
 console.log('PASS: orphan annual file can be authenticated, inspected, and explicitly recovered');
}
{
 const {graph,vault}=await open();
 await vault.saveBatch([await sample(17,'2026-04')]);
 let injected=false;
 graph.hooks.write=async(path)=>{
  if(path!=='payroll/income/2026.enc'||injected)return;
  injected=true;
  const other=await sample(18,'2026-05');const current=vault.records()[0];
  const yearPath='payroll/statements/2026.enc';
  await put(graph,yearPath,await encryptJson('year',{
   format:'payroll-annual-v1',records:[current,cloudRecord(other,crypto.randomUUID(),'2026-05')],deleted:[]
  },vault.sessionKey().key,vault.sessionKey().salt));
 };
 // Make the income document stale so a second, conflicting update is required.
 const incomePath='payroll/income/2026.enc';
 await put(graph,incomePath,await encryptJson('income',{format:'payroll-income-v1',year:'2026',records:[]},vault.sessionKey().key,vault.sessionKey().salt));
 await vault.syncIncome(new Set(['2026']));
 const actual=await decryptJson('income',graph.files.get(incomePath).text,vault.sessionKey().key);
 assert.deepEqual(actual.records.map(r=>r.id),[17,18]);
 console.log('PASS: a source update during income write is detected and stale income is regenerated');
}
{
 const {graph,vault}=await open();await vault.saveBatch([await sample(19)]);
 graph.hooks.write=async path=>{if(path==='payroll/income/2026.enc')throw new Error('income offline');};
 await assert.rejects(vault.remove(19),/削除済みですが/);
 assert.equal((await vault.refresh({forceFresh:true})).length,0);
 console.log('PASS: partial deletion reports committed statement and unsynced income distinctly');
}
{
 const {graph,vault}=await open();
 let injected=false;
 graph.hooks.write=async path=>{
  if(injected||!path.startsWith('payroll/originals/'))return;
  injected=true;
  const {key,salt}=vault.sessionKey();
  const index=await decryptJson('index',graph.files.get('payroll/index.enc').text,key);
  await put(graph,'payroll/index.enc',await encryptJson('index',{...index,years:['2026']},key,salt));
  const existing=Array.from({length:2000},(_,i)=>({
   id:100000+i,fileName:`old-${i}.pdf`,originalId:crypto.randomUUID(),originalMonth:'2025-04',
   pdfSize:10,pdfType:'application/pdf',savedAt:'2025-04-01',pages:1,warningsAcknowledged:true,
   form:{job:'side',kind:'salary',targetMonth:'2025-04',paymentDate:'2025-04-27',gross:'100',net:'90'}
  }));
  await put(graph,'payroll/statements/2026.enc',await encryptJson('year',{format:'payroll-annual-v1',records:existing,deleted:[]},key,salt));
 };
 await assert.rejects(vault.saveBatch([await sample(20,'2026-04')]),/上限2000件|最大2000件/);
 assert.equal(graph.count('payroll/statements/'),0,'capacity abort before any annual file write');
 console.log('PASS: remote records added during upload trigger precommit capacity revalidation');
}
{
 const store=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
 const start=store.indexOf('async function pdfSha256('),end=store.indexOf('/** 移行用：',start);
 assert.ok(start>0&&end>start);
 const code=store.slice(start,end).replace('export async function replaceAllRecords','async function replaceAllRecords');
 const contents=`const MAX_RECORDS=2000,MAX_TOTAL_PDF_BYTES=480*1024*1024;
 const cloudVault=async()=>globalThis.__fakeRestoreVault;
 const recordSignature=(record)=>JSON.stringify([record.id,record.fileHash,record.form]);
 const payrollSnapshot=records=>records.map(recordSignature).sort();
 const toSummary=record=>{const {pdf,...meta}=record;return {...meta,pdfSize:pdf.size,pdfType:pdf.type}};
 const assertValid=()=>{};
 ${code}
 export {replaceAllRecords,payrollSnapshot};`;
 const result=await build({stdin:{contents,sourcefile:'restore-preflight.ts',loader:'ts'},bundle:true,format:'esm',platform:'node',target:'es2022',write:false,logLevel:'silent'});
 const {replaceAllRecords,payrollSnapshot}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
 const existing={id:123,form:{job:'main'},fileHash:undefined,pdfSize:13,pdfType:'application/pdf'};
 const back={id:123,form:{job:'side'},fileHash:undefined,pdf:new Blob(['different-pdf'])};
 let writes=0;
 globalThis.__fakeRestoreVault={refresh:async()=>[existing],original:async()=>new Blob(['old-original']),save:async()=>{writes++;},remove:async()=>{writes++;},records:()=>[existing]};
 try{await assert.rejects(replaceAllRecords([back],payrollSnapshot([existing])),/PDF原本がバックアップと異なります/);}
 finally{delete globalThis.__fakeRestoreVault;}
 assert.equal(writes,0,'no records were changed before the mismatch was detected');
 console.log('PASS: missing PDF hashes cannot permit a mismatched restore on an existing ID');
}
console.log('PASS: all payroll integrity hardening checks');
