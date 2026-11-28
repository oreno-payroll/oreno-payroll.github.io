/** Payroll Phase 2: delayed synthetic OneDrive, verified read-only caches and fail-closed mutations. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const join=(path,name)=>[...path,name].join('/');
const encoder=new TextEncoder();
const store=new Map();
const calls={body:[],meta:[],writes:[],access:0,perf:[]};
let seq=0,hookRead=null,hookWrite=null,hookMetadata=null;
const put=(path,name,value)=>{
 const key=join(path,name),text=JSON.stringify(value);
 store.set(key,{id:key,etag:`revision-${++seq}`,size:encoder.encode(text).byteLength,text});
};
const graph={
 async withWriteLock(operation){return operation();},
 async read(path,name){
  const key=join(path,name);calls.body.push(key);
  if(hookRead)await hookRead(key);
  if(name==='profile.enc'||path.includes('years'))await wait(24);
  else await wait(2);
  const row=store.get(key);return row?{...row}:null;
 },
 async metadata(path,name){
  const key=join(path,name);calls.meta.push(key);await wait(2);
  if(hookMetadata)await hookMetadata(key);
  const row=store.get(key);
  return row?{id:row.id,etag:row.etag,size:row.size}:null;
 },
 async write(path,name,text,prior){
  const key=join(path,name);calls.writes.push(key);
  if(hookWrite)await hookWrite(key);
  const previous=store.get(key);
  if(prior ? !previous||previous.etag!==prior.etag : previous)throw new Error('ETag collision');
  store.set(key,{id:key,etag:`revision-${++seq}`,size:encoder.encode(text).byteLength,text});
 },
 async listFolder(){return []},
};
const parent=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
let currentAccess={path:parent,key:{},salt:'synthetic-salt',graph};
let navigationEpoch='fixture-epoch',navigationCache=null,navigationAuthorized=true;
const navigationVault={yearEndAccess:async()=>{calls.access++;return currentAccess;},
 readPeopleNavigation:async path=>navigationCache?.path===path.join('/')?structuredClone(navigationCache.data):null,
 rememberPeopleNavigation:async(path,data,epoch)=>{if(epoch===navigationEpoch)navigationCache={path:path.join('/'),data:structuredClone(data)};}};
const sandbox={
 crypto:webcrypto,Blob,TextDecoder,TextEncoder,Uint8Array,Number,Set,Map,Date,Error,JSON,Buffer,Promise,structuredClone,
 cloudVault:async()=>navigationVault,mutationEpoch:()=>navigationEpoch,captureOperationAuthorization:()=>()=>navigationAuthorized,
 encryptJson:async(_,obj)=>JSON.stringify(obj),decryptJson:async(_,text)=>JSON.parse(text),
 encryptBytes:async(_,bytes)=>Buffer.from(bytes).toString('base64'),
 decryptBytes:async(_,text)=>new Uint8Array(Buffer.from(text,'base64')),
 isCollision:error=>/collision/.test(error.message),
 beginPerfOperation:operation=>({
  measure:async(_phase,work)=>work(),
  finish:success=>calls.perf.push({operation,success}),
 }),
};
const source=strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear})';
const api=runInNewContext(source,sandbox);
const id=api.randomPersonId(),other=api.randomPersonId(),third=api.randomPersonId(),yearId=api.randomDocumentId();
const at='2026-11-23T00:00:00Z';
const members=[id,other,third];
const idx=()=>({format:'payroll-year-end-index-v1',persons:members.map(personId=>({id:personId,state:'active',createdAt:at,updatedAt:at}))});
put(parent,'index.enc',idx());
for(const personId of members){
 const profile={format:'payroll-year-end-person-v1',id:personId,displayName:'合成人物',alias:'',createdAt:at,updatedAt:at,yearFiles:personId===id?{'2026':yearId}:{}};
 put([...parent,'persons',personId],'profile.enc',profile);
}
const annualPath=[...parent,'persons',id,'years'];
put(annualPath,yearId+'.enc',api.emptyYear(id,2026));
const repo=new api.YearEndRepository();
const reset=()=>{calls.body.length=0;calls.meta.length=0;calls.writes.length=0;calls.access=0;calls.perf.length=0;};
const count=(arr,term)=>arr.filter(item=>item.includes(term)).length;

// The first read must download and validate all profiles; the next read must
// still check each ETag but skip ciphertext transfers when the identity matches.
reset();const t0=performance.now();const first=await repo.people();const initialMs=performance.now()-t0;
assert.equal(first.length,3);
assert.equal(count(calls.body,'/profile.enc'),3,'first read downloads each profile');
reset();const t1=performance.now();const second=await repo.people();const reusedMs=performance.now()-t1;
assert.equal(second.length,3);
assert.equal(count(calls.body,'/profile.enc'),0,'unchanged profiles are not redownloaded');
assert.equal(count(calls.meta,'/profile.enc'),3,'every profile still needs a fresh ETag and identity GET');
assert.equal(count(calls.body,'/index.enc'),1,'employee index remains freshly downloaded for every directory load');
assert.ok(reusedMs<initialMs,`mocked 24ms downloads must improve: ${initialMs.toFixed(1)}ms → ${reusedMs.toFixed(1)}ms`);
console.log(`[Synthetic Graph] directory (3 people): profile ciphertext 3 → 0, metadata 0 → 3, elapsed ${initialMs.toFixed(1)}ms → ${reusedMs.toFixed(1)}ms`);
// Navigation cache is separate from the ordinary fresh repository API. A new
// page can display the validated directory after the live root scope check.
const warmRepo=new api.YearEndRepository();reset();await warmRepo.people(true);
assert.equal(count(calls.body,'/profile.enc'),3);
reset();const fromNavigation=await new api.YearEndRepository().people(true);
assert.equal(fromNavigation.length,3);assert.equal(calls.access,1);
assert.equal(calls.body.length,0);assert.equal(calls.meta.length,0);
fromNavigation[0].displayName='UNSAVED SYNTHETIC EDIT';
assert.notEqual((await new api.YearEndRepository().people(true))[0].displayName,fromNavigation[0].displayName);
reset();await new api.YearEndRepository().people(true,true);assert.equal(count(calls.body,'/index.enc'),1);
assert.equal(count(calls.body,'/profile.enc'),3,'forced refresh bypasses list cache');
const beforeMutation=calls.writes.length;
await assert.rejects(warmRepo.renamePerson(id,'New synthetic name','','wrong prior name'),/従業員名が更新/);
await assert.rejects(warmRepo.deletePerson(id,{state:'active',displayName:'wrong prior name',alias:''}),/従業員名が更新/);
assert.equal(calls.writes.length,beforeMutation,'stale cached name cannot authorize a rename or deletion');
navigationCache.data=[{state:'active',id:'not-a-valid-id'}];reset();await new api.YearEndRepository().people(true);
assert.equal(count(calls.body,'/profile.enc'),3,'invalid cache falls back to authenticated live data');
navigationAuthorized=false;await assert.rejects(new api.YearEndRepository().people(true),/接続状態/);navigationAuthorized=true;
console.log('PASS: employee navigation cache avoids profile/index transfers; force refresh and stale-name checks use live Graph');


reset();const previous=await repo.year(id,2026);
assert.equal(count(calls.body,'/years/'),1);
reset();const repeated=await repo.year(id,2026);
assert.equal(count(calls.body,'/years/'),0,'unchanged annual file reuses verified decrypted JSON only for read-only display');
assert.equal(count(calls.meta,'/years/'),1);
repeated.memo='UNSAVED LOCAL EDIT MUST NOT CONTAMINATE CACHE';
assert.notEqual((await repo.year(id,2026)).memo,repeated.memo,'cached object is returned as a fresh clone');

// Concurrent remote edits invalidate ETag and force authenticated read + validate.
put(annualPath,yearId+'.enc',{...previous,memo:'更新済み'});
reset();const changed=await repo.year(id,2026);
assert.equal(changed.memo,'更新済み');
assert.equal(count(calls.body,'/years/'),1,'new ETag must fetch full encrypted annual data');

// The mutation path must *not* use read-only cached context. It still freshly
// verifies active status and year-file mapping, ETag writes and read-back.
reset();const savedMemo=await repo.saveYearMemo(id,2026,'保存済みの年度メモ');
assert.equal(savedMemo.memo,'保存済みの年度メモ');
assert.equal(savedMemo.memo,JSON.parse(store.get(join(annualPath,yearId+'.enc')).text).memo,'returned data matches persisted annual data');
assert.equal(count(calls.body,'/index.enc'),1,'one fresh active index plus a final ETag check');
assert.equal(count(calls.meta,'/index.enc'),1,'active state is rechecked at final write');
assert.equal(count(calls.body,'/profile.enc'),1,'verified unchanged profile needs one ciphertext GET');
assert.equal(count(calls.meta,'/profile.enc'),1,'final profile identity and ETag are validated');
assert.equal(calls.access,3,'initial access, locked access and immediate pre-write generation/key checks remain');
assert.equal(count(calls.body,'/years/'),2,'live year JSON and post-write readback still occur');
assert.equal(count(calls.writes,'/years/'),1,'one ETag-protected annual write');
assert.equal((await repo.year(id,2026)).memo,'保存済みの年度メモ');

// If another tab changes the employee state between context and saveYear,
// the final fresh profile() checks the index and blocks the write.
hookMetadata=async key=>{
 if(key!==join(parent,'index.enc'))return;
 const changedIndex=idx();changedIndex.persons[0].state='deleting';
 put(parent,'index.enc',changedIndex);hookMetadata=null;
};
reset();await assert.rejects(repo.saveYearMemo(id,2026,'変更してはいけない'),/未登録または削除処理中/);
assert.equal(count(calls.writes,'/years/'),0,'deleting employee must not be written');
hookMetadata=null;put(parent,'index.enc',idx());

// A concurrent update to the year ETag must abort instead of overwriting it.
let injected=false;
hookWrite=async key=>{
 if(key===join(annualPath,yearId+'.enc')&&!injected){
  injected=true;
  const row=store.get(key);put(annualPath,yearId+'.enc',{...JSON.parse(row.text),memo:'別端末のメモ'});
 }
};
reset();await assert.rejects(repo.saveYearMemo(id,2026,'競合しているメモ'),/ETag collision/);
assert.equal((await repo.year(id,2026)).memo,'別端末のメモ');
hookWrite=null;

// Cache scope must include CryptoKey identity. A new key must not see the
// earlier key's decrypted snapshot, even if remote metadata is unchanged.
await repo.year(id,2026);
currentAccess={...currentAccess,key:{}};
reset();assert.equal((await repo.year(id,2026)).memo,'別端末のメモ');
assert.equal(count(calls.body,'/profile.enc'),1,'key change invalidates profile snapshot');
assert.equal(count(calls.body,'/years/'),1,'key change invalidates annual snapshot');

// 404 is fail closed even after a previously verified successful read.
const key=join(annualPath,yearId+'.enc'),backup=store.get(key);store.delete(key);
await assert.rejects(repo.year(id,2026),/年度ファイルが見つかりません/);
store.set(key,backup);

// No persistent plaintext cache, no arbitrary sensitive diagnostics.
const src=read('src/yearEnd/repository.ts');
assert.doesNotMatch(src,/indexedDB|localStorage|sessionStorage|console\.log|console\.info/);
assert.ok(calls.perf.some(x=>x.operation==='yearend-year'));
console.log('PASS: ETag-validated read-only profile/year snapshots; mutations reload live metadata; stale-tab, 404, key-change and ETag collision fail closed');

// Production Graph uses a combined version comparison / changed-file read.
// Existing tests above still cover the original mock interface.
{
 const originalRead=graph.read.bind(graph),originalMetadata=graph.metadata.bind(graph);
 let combined=0;
 graph.readIfChanged=async(path,name,_max,proof,directChild)=>{
  combined++;
  if(name==='profile.enc')assert.equal(directChild,true,'profile read uses existing direct-child route');
  const current=await originalMetadata(path,name);
  if(!current)return null;
  if(current.id===proof.id&&current.etag===proof.etag&&current.size===proof.size)return undefined;
  return originalRead(path,name);
 };
 const freshRepo=new api.YearEndRepository();
 await freshRepo.people();
 await freshRepo.people();
 assert.ok(combined>0,'existing display cache uses combined version check');
 reset();const renamed=await freshRepo.renamePerson(id,'合成名称更新','','合成人物');
 assert.equal(renamed.displayName,'合成名称更新');
 assert.equal(count(calls.body,'/index.enc'),1,'rename reuses authenticated index body only after fresh version probe');
 assert.equal(count(calls.meta,'/index.enc'),1);
 assert.equal(calls.access,3,'root generation still checked before lock, after lock and before write');
 assert.equal(count(calls.writes,'/profile.enc'),1);
 // A state change during the final version probe must block the write.
 hookMetadata=async key=>{if(key===join(parent,'index.enc')){const changed=idx();changed.persons[0].state='deleting';put(parent,'index.enc',changed);hookMetadata=null;}};
 reset();await assert.rejects(freshRepo.renamePerson(id,'拒否対象','','合成名称更新'),/未登録または削除処理中/);
 assert.equal(count(calls.body,'/index.enc'),2,'changed index must be read and validated');assert.equal(calls.writes.length,0);
 put(parent,'index.enc',idx());
 hookMetadata=async key=>{if(key===join(parent,'index.enc')){store.delete(key);hookMetadata=null;}};
 reset();await assert.rejects(freshRepo.renamePerson(id,'拒否対象','','合成名称更新'),/従業員索引が見つかりません/);assert.equal(calls.writes.length,0);
 put(parent,'index.enc',idx());
 delete graph.readIfChanged;
 console.log('PASS: rename uses one live active-index body and one version probe; changed/deleted index blocks mutation');
}

// Round 7: initial display may paint an authenticated navigation preview,
// but a failed live root validation must not become a successful list.
{
 const oldAccess=navigationVault.yearEndAccess;
 navigationCache={path:parent.join('/'),data:first.map(p=>({...p}))};
 navigationVault.previewPeopleNavigation=async()=>structuredClone(navigationCache.data);
 let previewed=false;
 navigationVault.yearEndAccess=async()=>{assert.equal(previewed,true);throw Error('synthetic live root failure');};
 await assert.rejects(new api.YearEndRepository().people(true,false,undefined,list=>{assert.equal(list.length,3);previewed=true;}),/live root failure/);
 navigationVault.yearEndAccess=oldAccess;delete navigationVault.previewPeopleNavigation;
 navigationAuthorized=false;let paints=0;
 navigationVault.previewPeopleNavigation=async()=>structuredClone(navigationCache.data);
 await assert.rejects(new api.YearEndRepository().people(true,false,undefined,()=>paints++),/接続状態/);
 assert.equal(paints,0);navigationAuthorized=true;delete navigationVault.previewPeopleNavigation;
 console.log('PASS: authenticated navigation preview is painted before live root validation; failed/unauthorized reads cannot become success');
}
// Parallel profile/index reads and live verified index reuse. The index may
// change or disappear: no year may be returned for inactive employees.
{
 const originalRead=graph.read.bind(graph),originalMeta=graph.metadata.bind(graph);
 graph.readIfChanged=async(path,name,_max,proof,directChild)=>{
  if(path.includes('years'))assert.equal(directChild,true);
  const current=await originalMeta(path,name);
  if(!current)return null;
  return current.id===proof.id&&current.etag===proof.etag&&current.size===proof.size?undefined:originalRead(path,name);
 };
 const freshRepo=new api.YearEndRepository();
 let profileStarted=false,indexObservedParallel=false;
 hookRead=async key=>{if(key.endsWith('/profile.enc'))profileStarted=true;if(key===join(parent,'index.enc')){await wait(10);indexObservedParallel=profileStarted;}};
 await freshRepo.year(id,2026);hookRead=null;assert.equal(indexObservedParallel,true,'profile read must start before index fetch finishes');
 reset();await freshRepo.year(id,2026);
 assert.equal(count(calls.body,'/index.enc'),0);assert.equal(count(calls.meta,'/index.enc'),1);
 assert.equal(count(calls.body,'/profile.enc'),0);assert.equal(count(calls.meta,'/profile.enc'),1);
 const deleting=idx();deleting.persons[0].state='deleting';put(parent,'index.enc',deleting);
 reset();await assert.rejects(freshRepo.year(id,2026),/未登録または削除処理中/);assert.equal(count(calls.body,'/years/'),0);
 assert.equal(calls.writes.length,0);put(parent,'index.enc',idx());delete graph.readIfChanged;
 console.log('PASS: live index/profile overlap, unchanged index version reuse, changed employee state blocks annual display');
}
