/** Phase 0+1: synthetic delayed Graph, conditional reuse and strict income integrity. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=fileURLToPath(new URL('../',import.meta.url));
const bundled=await build({
  stdin:{contents:[
    "export {PayrollVault} from './src/cloud/vault.ts'",
    "export {GraphError} from './src/cloud/graph.ts'",
    "export {encryptJson,decryptJson} from './src/cloud/crypto.ts'",
    "export {beginPerfOperation,observeGraphTransfer} from './src/cloud/perf.ts'",
  ].join(';'),resolveDir:root,sourcefile:'performance-entry.ts',loader:'ts'},
  bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollVault,GraphError,encryptJson,decryptJson,beginPerfOperation,observeGraphTransfer}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].contents).toString('base64'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const encoder=new TextEncoder();
class GraphMock {
 async withWriteLock(operation){return operation();}
  files=new Map();
  body=0;metadataCount=0;yearReads=0;yearMetadata=0;writes=0;delayBody=0;delayMeta=0;hook=null;
  path(parts,name){return [...parts,name].join('/');}
  async read(parts,name){
    const key=this.path(parts,name);this.body++;
    if(key.includes('/statements/')){this.yearReads++;await wait(this.delayBody);}
    if(this.hook)await this.hook(key);
    const file=this.files.get(key);
    return file?{...file}:null;
  }
  async metadata(parts,name){
    const key=this.path(parts,name);this.metadataCount++;
    if(key.includes('/statements/')){this.yearMetadata++;await wait(this.delayMeta);}
    const file=this.files.get(key);
    return file?{id:file.id,etag:file.etag,size:file.size}:null;
  }
  async write(parts,name,text,prior){
    const key=this.path(parts,name),existing=this.files.get(key);
    if(prior?(!existing||existing.etag!==prior.etag):Boolean(existing))throw new GraphError(prior?412:409,'conflict');
    this.set(key,text);
    this.writes++;
  }
  set(key,text){
    const old=this.files.get(key);
    const etag='rev-'+(Number(old?.etag?.split('-').at(-1)??0)+1);
    this.files.set(key,{id:key,etag,text,size:encoder.encode(text).byteLength});
  }
  reset(){this.body=0;this.metadataCount=0;this.yearReads=0;this.yearMetadata=0;this.writes=0;}
}
const salary=(id,month)=>({
  id,fileName:'synthetic.pdf',originalId:'00000000-0000-4000-8000-000000000001',
  originalMonth:month,pdfSize:128,pdfType:'application/pdf',fileHash:'a'.repeat(64),
  pages:1,revision:1,savedAt:'2026-01-01',form:{
    targetMonth:month,paymentDate:month+'-27',job:'main',kind:'salary',
    net:'100',gross:'120',taxable:'110',
  },
});
const graph=new GraphMock(),vault=new PayrollVault(graph);
await vault.unlock('a-fake-password-for-tests-only',true);
const {key,salt}=vault.sessionKey();
const years=['2023','2024','2025','2026'];
for(const year of years){
  const doc={format:'payroll-annual-v1',records:[salary(Number(year),year+'-05')],deleted:[]};
  graph.set(`payroll/statements/${year}.enc`,await encryptJson('year',doc,key,salt));
}
graph.set('payroll/index.enc',await encryptJson('index',{format:'payroll-index-v1',years,incomeYears:[]},key,salt));
await vault.unlockWithKey(key,salt);
graph.delayBody=45;graph.delayMeta=1;
graph.reset();
const fullStart=performance.now();await vault.refresh({forceFresh:true});const fullMs=performance.now()-fullStart;
assert.equal(graph.yearReads,4);
graph.reset();
const reuseStart=performance.now();await vault.refresh({forceFresh:true,reuseVerifiedYears:true});const reuseMs=performance.now()-reuseStart;
assert.equal(graph.yearReads,0,'unchanged verified documents do not redownload the ciphertext');
assert.equal(graph.yearMetadata,4,'every cached document must have freshly checked metadata');
assert.ok(reuseMs<fullMs,`simulated slow downloads should improve wall time: before ${fullMs}ms, after ${reuseMs}ms`);
console.log(`[Performance synthetic] four years: full ${fullMs.toFixed(1)}ms / ETag-reused ${reuseMs.toFixed(1)}ms; body GET 4 → 0, metadata GET 0 → 4`);

graph.reset();
const changed={format:'payroll-annual-v1',records:[salary(2026,'2026-05'),salary(3000,'2026-06')],deleted:[]};
graph.set('payroll/statements/2026.enc',await encryptJson('year',changed,key,salt));
await vault.refresh({forceFresh:true,reuseVerifiedYears:true});
assert.equal(graph.yearReads,1,'changed ETag must trigger actual decryption of the year file');
assert.equal(vault.records().length,5,'new remote record must be visible');
assert.equal(graph.yearMetadata,4,'unmodified years still checked');

graph.reset();
const before=vault.records().map(x=>x.id).sort();
const saved=graph.files.get('payroll/statements/2025.enc');
graph.files.delete('payroll/statements/2025.enc');
await assert.rejects(vault.refresh({forceFresh:true,reuseVerifiedYears:true}),/明細ファイルがありません/);
assert.deepEqual(vault.records().map(x=>x.id).sort(),before,'failed ETag check cannot install partial data');
graph.files.set('payroll/statements/2025.enc',saved);
await vault.refresh({forceFresh:true,reuseVerifiedYears:true});

// On the first income read, another device updates the source year.
// The prewrite check must notice and regenerate from the new source, not overwrite it.
let raced=false;
graph.hook=async path=>{
  if(!path.endsWith('/income/2026.enc')||raced)return;
  raced=true;
  const changedAgain={format:'payroll-annual-v1',records:[...changed.records,salary(3001,'2026-07')],deleted:[]};
  graph.set('payroll/statements/2026.enc',await encryptJson('year',changedAgain,key,salt));
};
graph.delayBody=1;graph.reset();
await vault.syncIncome(new Set(['2026']));
const incomeFile=graph.files.get('payroll/income/2026.enc');
assert.ok(incomeFile,'verified encrypted Finance income must exist');
const decoded=await decryptJson('income',incomeFile.text,key);
assert.deepEqual(decoded.records.map(r=>r.id),[2026,3000,3001], 'income must reflect the concurrent update');
assert.equal(graph.files.get('payroll/index.enc')?.id,'payroll/index.enc');
assert.ok(graph.yearMetadata>=4,'source was rechecked at each consistency boundary');
assert.ok(raced,'simulated racing writer executed');
assert.equal(graph.writes,2,'exactly one income file update and one index registration');
console.log('PASS: stale ETag invalidation, fail-closed metadata, concurrent-source retry, encrypted Finance income content');

// After lock/re-unlock, no prior year's decryption may be reused.
vault.lock();await vault.unlock('a-fake-password-for-tests-only');graph.reset();
await vault.refresh({forceFresh:true,reuseVerifiedYears:true});
assert.equal(graph.yearReads,4,'lock must invalidate all prior-year cache entries');

// Opt-in telemetry contains only allowlisted operation labels and counts.
const originalSession=globalThis.sessionStorage,originalInfo=console.info;
const logs=[];
try{
  globalThis.sessionStorage={getItem:k=>k==='payroll-perf-diagnostics'?'1':null};
  console.info=(...args)=>logs.push(args);
  const op=beginPerfOperation('finance-income-sync');
  observeGraphTransfer('graph-api',4);observeGraphTransfer('encrypted-download',8);
  await op.measure('income-read',async()=>wait(1));op.finish(true);
  assert.equal(logs.length,1);
  assert.equal(logs[0][1].graphRequests,1);assert.equal(logs[0][1].encryptedDownloads,1);
  assert.doesNotMatch(JSON.stringify(logs),/accessToken|fileName|targetMonth|paymentDate|Authorization|https?:\/\//);
}finally{
  console.info=originalInfo;
  if(originalSession===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=originalSession;
}
console.log('PASS: performance counters are opt-in and contain no payroll or authentication fields');
