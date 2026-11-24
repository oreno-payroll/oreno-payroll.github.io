/** Regression: immutable write proofs, changed ETags, safe cutover, bounded PDF ZIP. No user data/network. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const root=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const k=(path,name)=>[...path,name].join('/');
const data=new Map(),calls={indexRead:0,profileRead:0,indexMeta:0,profileMeta:0,yearWrites:0,yearReads:0};
let revision=0,makeIndexDeleting=false,makeProfileMoved=false,changeGeneration=false,generationCalls=0,collision=false;
const stableKey={},rootPath=root.join('/');
const graph={
 async read(path,name){
  const key=k(path,name),v=data.get(key);
  if(name==='index.enc'&&path.join('/')===rootPath)calls.indexRead++;
  if(name==='profile.enc')calls.profileRead++;
  if(path.includes('years'))calls.yearReads++;
  return v?{...v}:null;
 },
 async metadata(path,name){
  const key=k(path,name);
  if(name==='index.enc'&&path.join('/')===rootPath){
   calls.indexMeta++;
   if(makeIndexDeleting){makeIndexDeleting=false;const old=JSON.parse(data.get(key).text);old.persons[0].state='deleting';put(path,name,old);}
  }
  if(name==='profile.enc'){
   calls.profileMeta++;
   if(makeProfileMoved){makeProfileMoved=false;const old=JSON.parse(data.get(key).text);old.yearFiles['2026']='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';put(path,name,old);}
  }
  const v=data.get(key);return v?{id:v.id,etag:v.etag,size:v.size}:null;
 },
 async write(path,name,text,prior){
  if(collision&&path.includes('years')){collision=false;throw Error('ETag collision');}
  const key=k(path,name),before=data.get(key);
  if(prior?before?.etag!==prior.etag:!!before)throw Error('ETag collision');
  if(path.includes('years'))calls.yearWrites++;
  put(path,name,JSON.parse(text));
 },
 async listFolder(){return []}
};
const put=(path,name,value)=>{const text=JSON.stringify(value);data.set(k(path,name),{id:k(path,name),etag:`etag-${++revision}`,size:new TextEncoder().encode(text).length,text});};
const access={path:root,key:stableKey,salt:'synthetic',graph};
const sandbox={crypto:webcrypto,Blob,TextEncoder,TextDecoder,Uint8Array,Map,Set,Number,Date,Error,JSON,Buffer,Promise,structuredClone,
 cloudVault:async()=>({yearEndAccess:async()=>changeGeneration&&++generationCalls>1?{...access,path:[...root,'changed']}:access}),
 encryptJson:async(_,value)=>JSON.stringify(value),decryptJson:async(_,text)=>JSON.parse(text),
 encryptBytes:async()=>'',decryptBytes:async()=>new Uint8Array(),isCollision:e=>/collision/.test(e.message)};
const api=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear})',sandbox);
const id=api.randomPersonId(),yearId=api.randomDocumentId(),timestamp='2026-11-20T00:00:00Z';
const indexPath=root,profilePath=[...root,'persons',id],yearPath=[...profilePath,'years'];
put(indexPath,'index.enc',{format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:timestamp,updatedAt:timestamp}]});
put(profilePath,'profile.enc',{format:'payroll-year-end-person-v1',id,displayName:'架空',alias:'',createdAt:timestamp,updatedAt:timestamp,yearFiles:{'2026':yearId}});
put(yearPath,yearId+'.enc',api.emptyYear(id,2026));
const repo=new api.YearEndRepository();
await repo.saveYearMemo(id,2026,'memo-one');
assert.equal(calls.indexRead,1,'unchanged index must not re-download its encrypted JSON');
assert.equal(calls.profileRead,1,'unchanged profile must not re-download its encrypted JSON');
assert.equal(calls.indexMeta,1);assert.equal(calls.profileMeta,1);
assert.equal(calls.yearWrites,1,'single ETag annual write');
assert.equal((await repo.year(id,2026)).memo,'memo-one');
console.log('PASS: metadata-only ETag reuse avoids duplicate index/profile body loads');
makeIndexDeleting=true;
await assert.rejects(repo.saveYearMemo(id,2026,'memo-two'),/削除処理中|未登録/);
assert.equal(calls.yearWrites,1,'deleting person cannot publish year memo');
const existingIndex=JSON.parse(data.get(k(indexPath,'index.enc')).text);existingIndex.persons[0].state='active';put(indexPath,'index.enc',existingIndex);
makeProfileMoved=true;
await assert.rejects(repo.saveYearMemo(id,2026,'memo-two'),/参照先が更新/);
assert.equal(calls.yearWrites,1,'changed year reference cannot be overwritten');
const existingProfile=JSON.parse(data.get(k(profilePath,'profile.enc')).text);existingProfile.yearFiles['2026']=yearId;put(profilePath,'profile.enc',existingProfile);
generationCalls=0;changeGeneration=true;
await assert.rejects(repo.saveYearMemo(id,2026,'memo-two'),/暗号世代|鍵/);
assert.equal(calls.yearWrites,1,'different vault generation never writes');
changeGeneration=false;
collision=true;
await assert.rejects(repo.saveYearMemo(id,2026,'memo-two'),/ETag collision/);
assert.equal(calls.yearWrites,1,'annual ETag conflict blocks save');
console.log('PASS: changed active index, year reference, vault generation, annual ETag all fail closed');
// Extract the real worker body and run it with deterministic synthetic PDFs.
const main=read('src/main.ts');
const start=main.indexOf('    const originals = new Array<SavedPayrollRecord>(side.length);');
const end=main.indexOf('    const after=await loadRecordSummaries();',start);
assert.ok(start>0&&end>start,'bounded ZIP worker exists');
const source=strip('async function exportSide(side: Array<{id:number;fileName:string}>) {\n'+main.slice(start,end)+'\n return originals;\n}');
async function simulate(failId=0){
 let inFlight=0,max=0,completed=0;
 const side=Array.from({length:8},(_,i)=>({id:i+1,fileName:`mock${i+1}.pdf`}));
 const scope={
  sideZipStatus:{textContent:''},appStatus:{loading:()=>{}},exportMode:'calendar',exportYear:'2026',
  recordSignature:x=>String(x.id),getOriginalForBatchExport:async(id,sig)=>{
   assert.equal(sig,String(id));inFlight++;max=Math.max(max,inFlight);
   await new Promise(resolve=>setTimeout(resolve,(9-id%3)*2));inFlight--;
   if(id===failId)throw Error('synthetic PDF read failed');
   completed++;return {syntheticId:id};
  },
  Array,Math,Error,
 };
 runInNewContext(source+'\nthis.exportSide=exportSide;',scope);
 try{
  const originals=await scope.exportSide(side);
  return {originals,max,completed,error:null};
 }catch(error){return {originals:null,max,completed,error};}
}
const happy=await simulate();
assert.equal(happy.max,2,'must never exceed two parallel original downloads');
assert.equal(happy.completed,8);
assert.deepEqual(happy.originals.map(x=>x.pdf.syntheticId),[1,2,3,4,5,6,7,8],'result order is stable');
const failed=await simulate(3);
assert.equal(failed.originals,null,'failed download must not return a partial ZIP payload');
assert.match(String(failed.error),/synthetic PDF read failed/);
assert.ok(failed.max<=2);
assert.match(main,/const before=await loadRecordSummaries\(\)/);
assert.match(main,/const after=await loadRecordSummaries\(\)/);
console.log('PASS: side ZIP bounded concurrency, stable order, partial-failure suppression, final full verification gate');
