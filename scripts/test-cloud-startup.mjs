/** Graph concurrency and vault startup contract. No real Microsoft account or payroll data. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
if(!globalThis.crypto) globalThis.crypto=webcrypto;
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({
 stdin:{contents:[
  "export {PayrollVault} from './src/cloud/vault.ts'",
  "export {PayrollGraph} from './src/cloud/graph.ts'",
  "export {encryptJson} from './src/cloud/crypto.ts'",
 ].join(';'),resolveDir:root,sourcefile:'startup-entry.ts',loader:'ts'},
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollVault,PayrollGraph,encryptJson}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const delay=(ms=3)=>new Promise(resolve=>setTimeout(resolve,ms));
const encoder=new TextEncoder();
{
 let rootCalls=0,payrollCalls=0,statementsCalls=0,files=0;
 const http=async (url)=>{
  await delay();
  if(url.endsWith('/me/drive/special/approot')){rootCalls++;return Response.json({id:'root'});}
  if(url.includes('root:/payroll')){payrollCalls++;return Response.json({id:'payroll'});}
  if(url.includes('payroll:/statements')){statementsCalls++;return Response.json({id:'statements'});}
  if(url.includes('statements:/')){files++;return new Response(null,{status:404});}
  throw new Error('unexpected path: '+url.split('?')[0]);
 };
 const g=new PayrollGraph('token',http, undefined, undefined, undefined, false);
 const result=await Promise.all(Array.from({length:10},(_,i)=>g.read(['payroll','statements'],`${2020+i}.enc`,100)));
 assert.equal(result.filter(x=>x!==null).length,0);
 assert.equal(rootCalls,1,'only one concurrent app-folder root request');
 assert.equal(payrollCalls,1,'only one concurrent payroll folder request');
 assert.equal(statementsCalls,1,'only one concurrent statements folder request');
 assert.equal(files,10,'each encrypted data file is checked separately');
 console.log('PASS: 10 simultaneous file reads share root/folder GET but not file metadata checks');
}
{
 let roots=0;
 const http=async url=>{
  if(url.endsWith('/me/drive/special/approot')){
   roots++;
   return roots===1
    ? Response.json({error:{code:'outage'}},{status:503,headers:{'Retry-After':'0'}})
    : Response.json({id:'root'});
  }
  return new Response(null,{status:404});
 };
 const g=new PayrollGraph('token',http, undefined, undefined, undefined, false);
 assert.equal(await g.read(['payroll'],'file.enc',100),null);
 assert.equal(roots,2,'a transient 503 must retry the read-only root lookup once');
 console.log('PASS: a transient root 503 is retried and recovers');
}
{
 let roots=0;
 const http=async url=>{
  if(url.endsWith('/me/drive/special/approot')){
   roots++;
   return roots<=3
    ? Response.json({error:{code:'outage'}},{status:503,headers:{'Retry-After':'0'}})
    : Response.json({id:'root'});
  }
  return new Response(null,{status:404});
 };
 const g=new PayrollGraph('token',http, undefined, undefined, undefined, false);
 await assert.rejects(g.read(['payroll'],'file.enc',100),/HTTP 503/);
 assert.equal(roots,3,'a persistent 503 must stop after two safe retries');
 assert.equal(await g.read(['payroll'],'file.enc',100),null);
 assert.equal(roots,4,'an exhausted failed root lookup must not poison the shared cache');
 console.log('PASS: persistent root 503 fails after bounded retries; next lookup recovers');
}
class FakeGraph {
 async withWriteLock(operation){return operation();}
 files=new Map(); reads=new Map(); writes=new Map(); yearStarts=[]; activeYears=0;maxYears=0;
 path(parts,name){return [...parts,name].join('/');}
 async read(parts,name){
  const p=this.path(parts,name);
  this.reads.set(p,(this.reads.get(p)??0)+1);
  if(p.startsWith('payroll/statements/')){
   this.yearStarts.push(name);
   this.activeYears++;this.maxYears=Math.max(this.maxYears,this.activeYears);
   try{await delay(name==='2025.enc'?12:2);}finally{this.activeYears--;}
  }
  const item=this.files.get(p);
  return item?{...item}:null;
 }
 async write(parts,name,text,prior){
  const path=this.path(parts,name),old=this.files.get(path);
  if(prior && (!old||old.etag!==prior.etag))throw new Error('conflict');
  this.writes.set(path,(this.writes.get(path)??0)+1);
  this.files.set(path,{id:path,etag:'etag-'+(this.writes.get(path)),text,size:encoder.encode(text).length});
 }
 count(path){return this.reads.get(path)??0;}
 put(path,text){this.files.set(path,{id:path,etag:'remote',text,size:encoder.encode(text).length});}
}
{
 const g=new FakeGraph();const v=new PayrollVault(g);
 await v.unlock('example-passphrase-over-12-characters',true);
 const {key,salt}=v.sessionKey();
 const years=['2020','2021','2022','2023','2024','2025'];
 for(const year of years){
  const originalId=crypto.randomUUID();
  const records=year==='2025'?[{
   id:999,fileName:'test.pdf',originalId,originalMonth:'2025-06',pdfSize:9,pdfType:'application/pdf',
   fileHash:'0'.repeat(64),pages:1,revision:1,savedAt:'2025-06-27',warningsAcknowledged:true,
   form:{targetMonth:'2025-06',paymentDate:'2025-06-27',job:'main',kind:'salary',net:'100',gross:'120'},
  }]:[];
  g.put(`payroll/statements/${year}.enc`,await encryptJson('year',{
   format:'payroll-annual-v1',records,deleted:[],
  },key,salt));
 }
 g.put('payroll/index.enc',await encryptJson('index',{
  format:'payroll-index-v1',years,incomeYears:[],
 },key,salt));
 await v.unlockWithKey(key,salt);
 const indexBefore=g.count('payroll/index.enc');
 const progress=[];
 await v.refresh({dashboardStartup:true,priorityYears:['2025'],onProgress:(done,total,year)=>progress.push({done,total,year})});
 assert.equal(g.count('payroll/index.enc'),indexBefore,'startup must reuse the just-verified index once');
 assert.equal(g.yearStarts[0],'2025.enc','priority fiscal year must start first');
 assert.ok(g.maxYears<=4&&g.maxYears>=2,'at most four annual records concurrent');
 assert.equal(progress.length,6);
 assert.equal(progress.at(-1).done,6);
 assert.equal(v.records().length,1);
 assert.equal(v.records()[0].id,999);
 await v.refresh();
 assert.equal(g.count('payroll/index.enc'),indexBefore+1,'all later refreshes fetch the remote index');
 // Error cannot replace a previously complete snapshot; no data ever stored under a false success.
 g.files.delete('payroll/statements/2024.enc');
 await assert.rejects(v.refresh(),/2024年の明細ファイルがありません/);
 assert.equal(v.records().length,1,'failed load preserves previously complete snapshot');
 console.log('PASS: immediate dashboard skips second index GET, prioritizes selected year, caps workers, never skips later revalidation');
}
{
 const auth=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
 const store=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
 const home=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
 assert.match(auth,/result\.expiresOn instanceof Date/);
 assert.match(auth,/expiresAt-60_000/);
 assert.match(auth,/tokenPending/);
 assert.match(auth,/tokenCache=undefined;tokenPending=undefined/);
 assert.match(store,/dashboardStartup:true/);
 assert.match(home,/onProgress:message=>/);
 assert.match(home,/aria-busy/);
 console.log('PASS: expiring in-memory token cache, progress UI, no persistent salary storage');
}
