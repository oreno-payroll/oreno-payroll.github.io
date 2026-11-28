/** Year-end deferred-name freshness and existing-year root-index dedupe.
 * Pure synthetic Graph, actual TypeScript source, zero real OneDrive connections. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const encoder=new TextEncoder();const key={opaque:true},salt='synthetic-salt';
let seq=0;const files=new Map(),counts={index:0,profile:0,year:0,meta:0};
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const yearFile2026='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const yearFile2025='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const yearFile2024='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const root=['payroll','versions','99999999-9999-4999-8999-999999999999','year-end-assist'];
const person=[...root,'persons',id], years=[...person,'years'];
const path=(parts,name)=>[...parts,name].join('/');
const put=(parts,name,value)=>{const k=path(parts,name),text=JSON.stringify(value);files.set(k,{id:k,etag:'rev-'+(++seq),size:encoder.encode(text).length,text});};
const get=(parts,name)=>files.get(path(parts,name));
const stamp='2026-11-23T00:00:00Z';
const profile=(yearFiles)=>({format:'payroll-year-end-person-v1',id,displayName:'合成従業員',alias:'',createdAt:stamp,updatedAt:stamp,yearFiles});
const originalProfile=()=>profile({'2025':yearFile2025,'2026':yearFile2026});
let readYearHook=null;
const graph={
 async withWriteLock(operation){return operation();},
 async read(parts,name){const item=get(parts,name);if(name==='index.enc')counts.index++;else if(name==='profile.enc')counts.profile++;else if(parts.includes('years')){counts.year++;if(readYearHook)await readYearHook(parts,name);}
  return item?{...item}:null;},
 async metadata(parts,name){counts.meta++;const item=get(parts,name);return item?{id:item.id,etag:item.etag,size:item.size}:null;},
 async listFolder(){return [];},
 async write(){throw Error('no writes permitted in year-end display tests');},
};
const access={path:root,key,salt,graph};let unlocked=true,currentGraph=graph;
const cloudVault=async()=>({graph:currentGraph,yearEndAccess:async()=>access,isUnlocked:()=>unlocked,sessionKey:()=>({key,salt})});
const shared={crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,Blob,Buffer,Map,Set,WeakMap,Promise,structuredClone,performance,
 cloudVault,encryptJson:async(_,v)=>JSON.stringify(v),decryptJson:async(_,s)=>JSON.parse(s),
 encryptBytes:async()=>'',decryptBytes:async()=>new Uint8Array(),isCollision:()=>false,
 beginPerfOperation:()=>({measure:async(_,fn)=>fn(),finish:()=>{}}),
 MAX_RECORDS:2000,MAX_TOTAL_PDF_BYTES:500e6};
const yearApi=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,emptyYear})',shared);
const repo=new yearApi.YearEndRepository();
const makeYear=(year,detectedName)=>{
 const value=yearApi.emptyYear(id,year);
 if(detectedName)value.documents=[{id:'11111111-1111-4111-8111-111111111111',personId:id,kind:'salary',paymentDate:`${year}-05-25`,targetMonth:`${year}-05`,
  taxable:200000,gross:200000,transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
  fileName:'synthetic.pdf',pdfSize:500,fileHash:'a'.repeat(64),confirmedAt:stamp,updatedAt:stamp,source:'pdf-reviewed',revision:1,detectedName}];
 return value;
};
const reset=()=>{files.clear();unlocked=true;currentGraph=graph;readYearHook=null;for(const k in counts)counts[k]=0;
 put(root,'index.enc',{format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:stamp,updatedAt:stamp}]});
 put(person,'profile.enc',originalProfile());
 put(years,yearFile2025+'.enc',makeYear(2025,'旧年度の名前'));
 put(years,yearFile2026+'.enc',makeYear(2026,null));
};
reset();
const first=await repo.yearWithOtherYearNames(id,2026);
assert.equal(first.data.calendarYear,2026);
assert.deepEqual([...await first.otherYearNames()],['旧年度の名前']);
assert.equal(counts.index,1,'unchanged deferred comparison should share initial active index');
assert.equal(counts.profile,1,'unchanged deferred comparison should share verified profile body');
assert.equal(counts.meta,2,'check profile ETag before and after background comparison');
console.log('PASS: unchanged profile uses two lightweight ETag probes, one shared index/profile body');

reset();const newlyAdded=await repo.yearWithOtherYearNames(id,2026);
put(person,'profile.enc',profile({...originalProfile().yearFiles,'2024':yearFile2024}));
put(years,yearFile2024+'.enc',makeYear(2024,'新規年度の名前'));
assert.deepEqual(new Set(await newlyAdded.otherYearNames()),new Set(['旧年度の名前','新規年度の名前']));
assert.equal(counts.index,2,'changed profile must recheck employee active-state index');
assert.equal(counts.profile,2,'changed profile must be fetched and authenticated again');
console.log('PASS: a year added after display is included in deferred name comparison');

reset();const during=await repo.yearWithOtherYearNames(id,2026);
let injected=false;
readYearHook=async(_parts,name)=>{if(name!==yearFile2025+'.enc'||injected)return;injected=true;
 put(person,'profile.enc',profile({...originalProfile().yearFiles,'2024':yearFile2024}));
 put(years,yearFile2024+'.enc',makeYear(2024,'比較中に追加された名前'));
};
assert.deepEqual(new Set(await during.otherYearNames()),new Set(['旧年度の名前','比較中に追加された名前']));
assert.equal(injected,true);
console.log('PASS: profile changed while year JSONs load triggers a fresh comparison');

// A different reader refreshes the shared profile cache while our first
// yearWithOtherYearNames() is waiting for its annual JSON. The associated ETag
// must remain bound to the *older* profile returned by its original read.
reset();
let signalYearStart,releaseAnnual;
const yearStarted=new Promise(resolve=>{signalYearStart=resolve;});
const annualRelease=new Promise(resolve=>{releaseAnnual=resolve;});
let pausedYear=false;
readYearHook=async(_parts,name)=>{
 if(name===yearFile2026+'.enc'&&!pausedYear){pausedYear=true;signalYearStart();await annualRelease;}
};
const pendingDisplay=repo.yearWithOtherYearNames(id,2026);
await yearStarted;
put(person,'profile.enc',profile({...originalProfile().yearFiles,'2024':yearFile2024}));
put(years,yearFile2024+'.enc',makeYear(2024,'並行更新で追加された名前'));
// A second read updates the shared profile cache to the new ETag.
readYearHook=null;
await repo.year(id,2026);
releaseAnnual();
const racedDisplay=await pendingDisplay;
assert.deepEqual(new Set(await racedDisplay.otherYearNames()),
 new Set(['旧年度の名前','並行更新で追加された名前']),
 'the deferred comparison must not pair the old profile with the newer cached ETag');
console.log('PASS: concurrent profile cache refresh during display cannot hide a new year');

reset();const locked=await repo.yearWithOtherYearNames(id,2026);const before=counts.year;unlocked=false;
await assert.rejects(locked.otherYearNames(),/ロック|変更/);
assert.equal(counts.year,before,'locked vault must never read other-year salary data');
console.log('PASS: locked vault blocks background name checks');

reset();const switched=await repo.yearWithOtherYearNames(id,2026);currentGraph={};
await assert.rejects(switched.otherYearNames(),/ロック|変更/);
console.log('PASS: changed connection context blocks background name checks');

// Test the actual commit() implementation (Graph writes are synthetic in memory).
const vaultApi=runInNewContext(strip(read('src/cloud/vault.ts'))+'\n({PayrollVault})',{
 ...shared,cloudVault:undefined,performance,MAX_TOTAL_PDF_BYTES:500e6,
 isCollision:e=>/collision/.test(e?.message??''),
 envelopeSalt:()=>salt,parseEnvelope:()=>({salt}),
 fiscalYearOfTargetMonth:m=>Number(m.slice(0,4)),payrollPeriodKey:r=>r.form.paymentDate,
 isValidPayrollSemantics:()=>true,validEmployerId:v=>v===undefined||/^emp_[0-9a-f]{32}$/.test(v),toPublicIncomeRecord:()=>({}),
 clearNavigationSnapshot:()=>{},rememberNavigationSnapshot:async()=>{},restoredNavigationSnapshot:async()=>null,
 validateEmployerDirectory:entries=>entries,
 PayrollPartialSuccessError:class extends Error{},
});
const emptyDoc=()=>({format:'payroll-annual-v1',records:[],deleted:[]});
const vaultIndex=(year)=>({format:'payroll-index-v1',years:year?['2026']:[],incomeYears:[]});
const simulate=async({existing,conflict,known=false})=>{
 const state={indexReads:0,yearReads:0,writes:0,registered:0,existing,conflicted:false,record:emptyDoc()};
 const g={async write(_parts,name){state.writes++;
    if(name==='2026.enc'&&conflict&&!state.conflicted){state.conflicted=true;throw new Error('simulated 412 collision');}
    state.existing=true;},};
 const v=new vaultApi.PayrollVault(g);v.key=key;v.salt=salt;v.index=vaultIndex(existing);
 v.readIndex=async()=>{state.indexReads++;return {index:vaultIndex(state.registered?true:existing),file:{id:'root',etag:'root-etag',text:'synthetic'}};};
 v.readYear=async()=>{state.yearReads++;return {doc:state.record,file:state.existing?{id:'year',etag:'year-etag',text:JSON.stringify(state.record)}:null};};
 v.registerYear=async()=>{state.registered++;};
 await v.commit('2026',emptyDoc(),undefined,undefined,known);return state;
};
const existing=await simulate({existing:true,conflict:false});
assert.equal(existing.indexReads,3,'registered year must validate root before and after annual write');
assert.equal(existing.yearReads,2,'existing year still requires prewrite year GET and postwrite readback');
console.log('PASS: existing-year commit validates root at preparation, pre-write and readback');
const known=await simulate({existing:true,conflict:false,known:true});
assert.equal(known.indexReads,2,'verified existing year skips only the duplicate preparation read');
assert.equal(known.yearReads,2,'verified existing year still checks live year and readback');
const knownRetry=await simulate({existing:true,conflict:true,known:true});
assert.equal(knownRetry.indexReads,4,'conflict still rechecks index on retry');

const created=await simulate({existing:false,conflict:false});
assert.equal(created.indexReads,4,'new year must recheck after registration and around annual write');
assert.equal(created.registered,1);
console.log('PASS: new-year registration retains the second generation/lock check');
const retried=await simulate({existing:true,conflict:true});
assert.equal(retried.indexReads,5,'ETag conflict retry must recheck index and the final write');
assert.equal(retried.writes,2,'commit should retry after one ETag collision');
console.log('PASS: ETag collision retry revalidates root index');
// A remote rotation lock can appear while the writer awaits the annual GET.
// The pre-write root recheck must prevent a write into the retiring generation.
const lockDuringRead={lock:false,reads:0,writes:0};
const lockGraph={async write(){lockDuringRead.writes++;}};
const lockedWriter=new vaultApi.PayrollVault(lockGraph);
lockedWriter.key=key;lockedWriter.salt=salt;lockedWriter.index=vaultIndex(true);
lockedWriter.readIndex=async()=>{lockDuringRead.reads++;
 if(lockDuringRead.lock)throw new Error('simulated remote rotation lock');
 return {index:vaultIndex(true),file:{id:'root',etag:'live-root',text:'synthetic'}};
};
lockedWriter.readYear=async()=>{
 if(!lockDuringRead.lock)lockDuringRead.lock=true;
 return {doc:emptyDoc(),file:{id:'year',etag:'old-year',text:'synthetic'}};
};
await assert.rejects(lockedWriter.commit('2026',emptyDoc()),/rotation lock/);
assert.equal(lockDuringRead.writes,0,'locked generation must not accept annual writes');
assert.equal(lockDuringRead.reads,2,'the root is rechecked after the annual read');
console.log('PASS: rotation lock inserted during annual fetch blocks old-year commit');
lockDuringRead.lock=false;lockDuringRead.reads=0;
await assert.rejects(lockedWriter.commit('2026',emptyDoc(),undefined,undefined,true),/rotation lock/);
assert.equal(lockDuringRead.writes,0);assert.equal(lockDuringRead.reads,1);
lockedWriter.readYear=async()=>({doc:emptyDoc(),file:null});
await assert.rejects(lockedWriter.commit('2026',emptyDoc(),undefined,undefined,true),/年度ファイルが見つかりません/);
assert.equal(lockDuringRead.writes,0,'a missing verified annual file must not be recreated as an ordinary update');


// If the rotation begins DURING the annual PUT, its read-back must not be
// reported as success or cached for subsequent edits.
const lockDuringPut={lock:false,reads:0,writes:0};
const raceGraph={async write(){lockDuringPut.writes++;lockDuringPut.lock=true;}};
const racedWriter=new vaultApi.PayrollVault(raceGraph);
racedWriter.key=key;racedWriter.salt=salt;racedWriter.index=vaultIndex(true);
racedWriter.readIndex=async()=>{lockDuringPut.reads++;
 if(lockDuringPut.lock)throw new Error('simulated remote rotation lock');
 return {index:vaultIndex(true),file:{id:'root',etag:'root',text:'synthetic'}};
};
racedWriter.readYear=async()=>({doc:emptyDoc(),file:{id:'year',etag:'old-year',text:'synthetic'}});
await assert.rejects(racedWriter.commit('2026',emptyDoc()),/rotation lock/);
assert.equal(lockDuringPut.writes,1,'the remote may have accepted an ambiguous write');
assert.equal(racedWriter.shards.size,0,'an ambiguous write must not become a cached success');
assert.equal(lockDuringPut.reads,3,'root is rechecked after write verification');
console.log('PASS: lock appearing during annual PUT refuses an unverified success');

console.log('PASS: YearEnd freshness and Payroll commit dedupe regression');

// Exercise the new verified index path, including generation and rotation guards.
{
 let reads=0,probes=0;
 const rootValue=vaultIndex(true);
 let current={id:'root',etag:'root-1',size:100,text:JSON.stringify(rootValue)};
 const g={async read(){reads++;return current?{...current}:null;},async readIfChanged(_path,_name,_limit,proof){probes++;return current&&proof.id===current.id&&proof.etag===current.etag&&proof.size===current.size?undefined:current?{...current}:null;}};
 const v=new vaultApi.PayrollVault(g);
 await v.unlockWithKey(key,salt);
 // Initial display consumes the live unlock proof once, while the strict
 // default access used for writes always performs a live probe.
 await v.yearEndAccess(true);assert.equal(probes,0);
 await v.yearEndAccess(true);assert.equal(probes,1);
 await v.unlockWithKey(key,salt);await v.yearEndAccess();assert.equal(probes,2);
 await v.yearEndAccess(true);assert.equal(probes,3,'strict access invalidates the one-shot startup proof');
 await v.unlockWithKey(key,salt);await v.readEmployerDirectory(true);assert.equal(probes,3);
 await v.readEmployerDirectory();assert.equal(probes,4);
 reads=0;probes=0;await v.unlockWithKey(key,salt);
 const first=await v.readIndex();first.index.years.push('2025');
 assert.deepEqual([...((await v.readIndex()).index.years)],['2026'],'returned data cannot mutate proof');
 assert.equal(reads,1);assert.equal(probes,2);
 current={...current,etag:'root-2',text:JSON.stringify({...rootValue,years:['2025','2026']})};
 assert.deepEqual([...((await v.readIndex()).index.years)],['2025','2026']);
 current={...current,etag:'root-3',text:JSON.stringify({...rootValue,generation:'99999999-9999-4999-8999-999999999999'})};
 await assert.rejects(v.readIndex(),/保存世代/);
 current=null;await assert.rejects(v.readIndex(),/索引/);
 v.lock();await assert.rejects(v.readIndex(),/解除/);
}
console.log('PASS: unchanged authenticated root version reused; changed root, generation and missing index revalidated');
