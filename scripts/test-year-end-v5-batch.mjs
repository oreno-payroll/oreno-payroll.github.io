/** Test real repository batch logic against an in-memory ETag/Graph stand-in. No personal data. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const strip=src=>stripTypeScriptTypes(src.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const files=new Map();let seq=0,annualWrites=0,originalWrites=0,originalReads=0,failBeforeYear=false,failRelease=false,checkpoint=0,attempts=0;
const key=(path,name)=>[...path,name].join('/');
const graph={
 async withWriteLock(operation,state){
  if(!state)return operation();
  attempts=checkpoint=0;state.lock='held';
  try{const value=await operation();state.completed=true;if(failRelease)throw Error('synthetic release response lost');state.lock='released';return value;}
  catch(error){state.lock=state.completed?'unknown':attempts===checkpoint?'released':'held';throw error;}
  finally{state.attempted=attempts>0;}
 },
 markUploadCheckpoint(){checkpoint=attempts;},
 async reconcileUploadLock(state){if(state.uncertain||state.lock==='held')throw Error('unknown write');state.lock='released';},
 async read(path,name){const row=files.get(key(path,name));if(name.endsWith('.enc')&&path.includes('originals'))originalReads++;return row?{...row}:null;},
 async write(path,name,text,prior){const k=key(path,name),row=files.get(k);
  if(failBeforeYear&&path.includes('years'))throw Error('synthetic pre-write failure');
  if(prior ? !row||row.etag!==prior.etag : row)throw new Error('ETag collision');
  const next={text,etag:`etag-${++seq}`};files.set(k,next);attempts++;
  if(path.includes('years'))annualWrites++;
  if(path.includes('originals'))originalWrites++;
 },
 async listFolder(path){const prefix=path.join('/')+'/';return [...files.keys()].filter(k=>k.startsWith(prefix)&&!k.slice(prefix.length).includes('/')).map(k=>({name:k.slice(prefix.length),folder:false}));}
};
const parent=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
let access={path:parent,key:{},salt:'testing',graph};
const sandbox={
 crypto:webcrypto,Blob,TextDecoder,TextEncoder,Uint8Array,Number,Set,Map,Date,Error,JSON,Buffer,Promise,
 cloudVault:async()=>({yearEndAccess:async()=>access}),
 encryptJson:async(_,value)=>JSON.stringify(value),decryptJson:async(_,text)=>JSON.parse(text),
 encryptBytes:async(_,bytes)=>Buffer.from(bytes).toString('base64'),
 decryptBytes:async(_,text)=>new Uint8Array(Buffer.from(text,'base64')),
 isCollision:err=>/collision/.test(err.message),
};
const api=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear,validateYear})',sandbox);
const id=api.randomPersonId(),docId=api.randomDocumentId(),yearId=api.randomDocumentId();
const now='2026-11-19T00:00:00Z';
const profile={format:'payroll-year-end-person-v1',id,displayName:'検証',alias:'',createdAt:now,updatedAt:now,yearFiles:{'2026':yearId}};
const original={id:docId,personId:id,kind:'salary',paymentDate:'2026-10-25',targetMonth:'2026-10',taxable:200000,
 gross:205000,transportation:5000,nonTaxable:5000,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
 fileName:'base.pdf',pdfSize:50,fileHash:'a'.repeat(64),confirmedAt:now,updatedAt:now,source:'pdf-reviewed',revision:1};
const year={...api.emptyYear(id,2026),documents:[original]};
files.set(key(parent,'index.enc'),{text:JSON.stringify({format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:now,updatedAt:now}]}),etag:`etag-${++seq}`});
files.set(key([...parent,'persons',id],'profile.enc'),{text:JSON.stringify(profile),etag:`etag-${++seq}`});
files.set(key([...parent,'persons',id,'years'],yearId+'.enc'),{text:JSON.stringify(year),etag:`etag-${++seq}`});
files.set(key([...parent,'persons',id,'originals'],docId+'.enc'),{text:'existing encrypted original',etag:`etag-${++seq}`});
const repo=new api.YearEndRepository();
const draft=(kind,date,taxable)=>({kind,paymentDate:date,targetMonth:date.slice(0,7),taxable,gross:taxable,
 transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,detectedName:null,warnings:[]});
const makeFile=(name,content)=>Object.assign(new Blob([content],{type:'application/pdf'}),{name});
const one=makeFile('new-salary.pdf','%PDF-1.7 synthetic PDF A');
const two=makeFile('new-bonus.pdf','%PDF-1.7 synthetic PDF B');
const result=await repo.saveDocumentsBatch(id,2026,[{documentId:docId,expectedRevision:1,draft:draft('salary','2026-10-25',225000)}],
 [{file:one,draft:draft('salary','2026-11-25',250000)},{file:two,draft:draft('bonus','2026-12-20',350000)}]);
assert.equal(annualWrites,1,'two PDFs + one edit must update annual JSON just once');
assert.equal(originalWrites,2,'both encrypted original files written');
assert.equal(originalReads,2,'both originals read back and SHA-256 verified');
assert.equal(result.data.documents.length,3);
assert.equal(result.data.documents.find(d=>d.id===docId).revision,2);
assert.equal(result.data.documents.reduce((sum,d)=>sum+d.taxable,0),825000);
assert.deepEqual(JSON.parse(JSON.stringify(result.yearFiles)),{'2026':yearId});
assert.equal((await repo.year(id,2026)).documents.length,3);
await assert.rejects(repo.saveDocumentsBatch(id,2026,[{documentId:docId,expectedRevision:1,draft:draft('salary','2026-10-25',300000)}],[]),/他の画面/);
assert.equal(annualWrites,1,'stale revision does not overwrite data');
const sameMonth=makeFile('dup-salary.pdf','%PDF-1.7 synthetic PDF C');
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[{file:sameMonth,draft:draft('salary','2026-11-28',200000)}]),/重複/);
assert.equal(originalWrites,2,'duplicate month rejected before uploading PDF');
// V6: salary + bonus estimates are committed with exactly one encrypted annual-file write.
const current=await repo.year(id,2026);
const preview=await repo.preview(id,2026,'latest',['2026-12'],{'2026-12':0});
const before=annualWrites;
const savedForecast=await repo.replaceIncomeForecasts(id,2026,'latest',['2026-12'],{'2026-12':0},current.estimates,current.noPaymentMonths,
 preview.references,current.bonusEstimates,{month:'2026-09',amount:80000});
assert.equal(annualWrites,before+1,'salary and bonus forecast must share one annual write');
const after=await repo.year(id,2026);
assert.equal(JSON.stringify(savedForecast),JSON.stringify(after),'returned forecast matches the verified persisted year');
assert.equal(after.estimates.find(x=>x.month==='2026-12')?.amount,0);
assert.equal(after.bonusEstimates.find(x=>x.month==='2026-09')?.amount,80000);
assert.deepEqual(JSON.parse(JSON.stringify(after.noPaymentMonths)),[]);
await assert.rejects(repo.replaceIncomeForecasts(id,2026,'manual',[],{},current.estimates,current.noPaymentMonths,
 [],current.bonusEstimates),/別の画面で見込みが変更/);
assert.equal(annualWrites,before+1,'stale bonus snapshot must reject overwrite');

console.log('PASS: 2 encrypted PDFs + 1 edit => one ETag annual write; SHA-256 readback, stale revision and duplicates guarded');

// Verified originals survive a failure before the annual write. Retry the
// exact same in-memory File, not an arbitrary orphan from another operation.
const retryFile=makeFile('retry.pdf','%PDF-1.7 synthetic retry original');
const retryAddition={file:retryFile,draft:draft('bonus','2026-08-20',8000)};
const state=()=>({attempted:false,uncertain:false,completed:false,lock:'none'});
const stopped=state(),beforeOriginals=originalWrites,beforeAnnual=annualWrites;
failBeforeYear=true;
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[retryAddition],false,undefined,[],stopped),/年度データの確定に失敗/);
assert.equal(stopped.lock,'released');assert.equal(originalWrites,beforeOriginals+1);assert.equal(annualWrites,beforeAnnual);
const pending=await repo.recoverDocumentsBatch(id,2026,stopped,[retryFile]);assert.equal(pending.confirmed.size,0);
const orphanEntry=[...files.entries()].find(([name,row])=>name.includes('/originals/')&&Buffer.from(row.text,'base64').toString()==='%PDF-1.7 synthetic retry original');
assert.ok(orphanEntry);
const [orphanKey,validOriginal]=orphanEntry;
files.set(orphanKey,{...validOriginal,text:Buffer.from('corrupt').toString('base64')});failBeforeYear=false;
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[retryAddition],false,undefined,[],state()),/暗号化保存中に問題/);
assert.equal(originalWrites,beforeOriginals+1);assert.equal(annualWrites,beforeAnnual);
files.set(orphanKey,validOriginal);
const lost=state();failRelease=true;
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[retryAddition],false,undefined,[],lost),/release response lost/);
assert.equal(lost.completed,true);assert.equal(originalWrites,beforeOriginals+1,'existing original must be reused, not uploaded again');assert.equal(annualWrites,beforeAnnual+1);
failRelease=false;
const finished=await repo.recoverDocumentsBatch(id,2026,lost,[retryFile]);
assert.ok(finished.confirmed.get(retryFile));assert.equal(finished.data.documents.filter(r=>r.id===finished.confirmed.get(retryFile)).length,1);
assert.equal(lost.lock,'released');assert.equal(annualWrites,beforeAnnual+1,'recovery never commits the annual file again');
const originalAccess=access;access={...access,key:{}};await assert.rejects(repo.recoverDocumentsBatch(id,2026,lost,[retryFile]),/保管庫と一致/);access=originalAccess;
await assert.rejects(repo.recoverDocumentsBatch(id,2027,lost,[retryFile]),/保管庫と一致/);
files.delete(orphanKey);await assert.rejects(repo.recoverDocumentsBatch(id,2026,lost,[retryFile]),/原本が欠落/);files.set(orphanKey,validOriginal);
lost.uncertain=true;await assert.rejects(repo.recoverDocumentsBatch(id,2026,lost,[retryFile]),/unknown write/);
console.log('PASS: verified original reuse, corrupt orphan refusal, release recovery, exact vault identity and unknown-write guard');
