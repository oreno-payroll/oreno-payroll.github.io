/** Synthetic in-memory Graph: filename contract, bounded parallel reads and verified ten-PDF batch. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const source=strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear,yearEndPdfName,yearEndVisiblePdfName,yearEndUpdatedPdfName})';
const store=new Map();let sequence=0,profileActive=0,maxProfile=0,writeActive=0,maxWrites=0;
let originalWrites=0,originalReads=0,yearWrites=0,corruptNextOriginal=false,corruptOriginalName=null;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const root=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const key=(path,name)=>[...path,name].join('/');
const graph={
 async withWriteLock(operation){return operation();},
 async read(path,name){
  if(name==='profile.enc'){profileActive++;maxProfile=Math.max(profileActive,maxProfile);await wait(5);profileActive--;}
  if(path.includes('originals'))originalReads++;
  const value=store.get(key(path,name));
  if(value&&path.includes('originals')&&name===corruptOriginalName)return {...value,text:Buffer.from('simulated network bit rot').toString('base64')};
  return value?{...value}:null;
 },
 async write(path,name,text,prior){
  const k=key(path,name),current=store.get(k);
  if(prior?current?.etag!==prior.etag:!!current)throw Error('ETag conflict');
  if(path.includes('originals')){
   if(corruptNextOriginal){corruptOriginalName=name;corruptNextOriginal=false;}
   writeActive++;maxWrites=Math.max(writeActive,maxWrites);await wait(3);writeActive--;originalWrites++;
  }
  if(path.includes('years'))yearWrites++;
  store.set(k,{text,etag:'etag-'+(++sequence)});
 },
 async listFolder(){return [];},
};
const context={path:root,key:{},salt:'synthetic',graph};
const sandbox={crypto:webcrypto,Blob,TextDecoder,TextEncoder,Uint8Array,Number,Set,Map,Date,Error,JSON,Buffer,Promise,
 cloudVault:async()=>({yearEndAccess:async()=>context}),
 encryptJson:async(_,v)=>JSON.stringify(v),decryptJson:async(_,v)=>JSON.parse(v),
 encryptBytes:async(_,b)=>Buffer.from(b).toString('base64'),decryptBytes:async(_,v)=>new Uint8Array(Buffer.from(v,'base64')),
 isCollision:()=>false};
const api=runInNewContext(source,sandbox);
assert.equal(api.yearEndPdfName('salary','2026-11-25','fa7b.pdf'),'202611_給与明細.pdf');
assert.equal(api.yearEndPdfName('bonus','2026-11-25','fa7b.pdf'),'202611_賞与明細.pdf');
const uuid='12345678-1234-4234-8234-123456789abc.pdf';
assert.equal(api.yearEndVisiblePdfName('salary','2026-10-25',uuid),'202610_給与明細.pdf');
assert.equal(api.yearEndVisiblePdfName('salary','2026-10-25','original.pdf'),'original.pdf');
assert.equal(api.yearEndUpdatedPdfName('salary','2026-10-25','202610_給与明細.pdf','bonus','2026-12-25'),'202612_賞与明細.pdf');
assert.equal(api.yearEndUpdatedPdfName('salary','2026-10-25','custom.pdf','bonus','2026-12-25'),'custom.pdf');
const id=api.randomPersonId(),yearId=api.randomDocumentId(),at=new Date().toISOString();
const personIds=[id,...Array.from({length:11},()=>api.randomPersonId())];
store.set(key(root,'index.enc'),{text:JSON.stringify({format:'payroll-year-end-index-v1',persons:personIds.map(i=>({id:i,state:'active',createdAt:at,updatedAt:at}))}),etag:'etag-'+(++sequence)});
for(const i of personIds){
 const profile={format:'payroll-year-end-person-v1',id:i,displayName:'検証',alias:'',createdAt:at,updatedAt:at,yearFiles:i===id?{'2026':yearId}:{}};
 store.set(key([...root,'persons',i],'profile.enc'),{text:JSON.stringify(profile),etag:'etag-'+(++sequence)});
}
store.set(key([...root,'persons',id,'years'],yearId+'.enc'),{text:JSON.stringify(api.emptyYear(id,2026)),etag:'etag-'+(++sequence)});
const repo=new api.YearEndRepository();
const people=await repo.people();assert.equal(people.length,12);
assert.ok(maxProfile>1&&maxProfile<=5,`expected parallel <=5 profile GETs, saw ${maxProfile}`);
const added=Array.from({length:10},(_,i)=>{
 const day=`2026-${String(i+1).padStart(2,'0')}-25`;
 const draft={kind:'salary',paymentDate:day,targetMonth:day.slice(0,7),taxable:200000+i,gross:200000+i,
  transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
  detectedName:null,warnings:[]};
 const file=Object.assign(new Blob([`%PDF-1.7 synthetic safe sample ${i}`],{type:'application/pdf'}),{name:`${i}.pdf`});
 return {file,draft};
});
const progress=[];
const outcome=await repo.saveDocumentsBatch(id,2026,[],added,false,(done,total)=>progress.push([done,total]));
assert.equal(outcome.data.documents.length,10);
assert.equal(yearWrites,1,'all ten PDFs yield exactly one annual ETag commit');
assert.equal(originalWrites,10);assert.equal(originalReads,10,'every PDF has read-back and SHA-256 verification');
assert.ok(maxWrites>1&&maxWrites<=3,`expected parallel <=3 writes, saw ${maxWrites}`);
assert.deepEqual(progress.map(([done])=>done).sort((a,b)=>a-b),Array.from({length:10},(_,i)=>i+1));
assert.ok(progress.every(([,total])=>total===10));
assert.ok(outcome.data.documents.every((d,i)=>/^2026(?:0[1-9]|10)_給与明細\.pdf$/.test(d.fileName)));
// A failed SHA readback must stop the YEAR ETag commit and let the other in-flight
// writes settle before the API rejects (no hidden upload continuing afterward).
corruptNextOriginal=true;
const failedAdditions=Array.from({length:3},(_,i)=>({
 file:Object.assign(new Blob([`%PDF-1.7 failing synthetic bonus ${i}`],{type:'application/pdf'}),{name:`failure${i}.pdf`}),
 draft:{...added[i].draft,kind:'bonus',taxable:5000+i,gross:5000+i}
}));
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],failedAdditions),/暗号化保存中に問題/);
assert.equal(writeActive,0,'no original upload remains in flight when failure is reported');
assert.equal(yearWrites,1,'never commit the year when any SHA readback fails');
console.log('PASS: bounded profiles (5) and 10-PDF uploads (3), full SHA readback, single ETag commit, naming, progress, no commit after integrity failure');
