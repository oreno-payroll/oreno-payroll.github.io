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
reset();await repo.saveYearMemo(id,2026,'保存済みの年度メモ');
assert.equal(count(calls.body,'/index.enc'),1,'one fresh active index plus a final ETag check');
assert.equal(count(calls.meta,'/index.enc'),1,'active state is rechecked at final write');
assert.equal(count(calls.body,'/profile.enc'),1,'verified unchanged profile needs one ciphertext GET');
assert.equal(count(calls.meta,'/profile.enc'),1,'final profile identity and ETag are validated');
assert.equal(calls.access,2,'initial access and immediate pre-write generation/key check remain');
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
