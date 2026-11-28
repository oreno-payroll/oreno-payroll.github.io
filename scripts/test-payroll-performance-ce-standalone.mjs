/** Platform-independent synthetic check for core CE behavior. */
import assert from 'node:assert/strict';
import {validateEmployerDirectory} from '../src/storage/employerDirectory.ts';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const root=process.argv[2]??fileURLToPath(new URL('../',import.meta.url));
const src=p=>readFileSync(`${root}/${p}`,'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const salt='synthetic-salt',key={nonExtractable:true},years=['2023','2024','2025','2026'];
const enc=new TextEncoder(),pdf=enc.encode('%PDF-1.7\nSynthetic data\n%%EOF');
const hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',pdf)).toString('hex');
const make=(id,year,revision=1)=>({id,revision,form:{targetMonth:`${year}-05`,paymentDate:`${year}-06-01`,job:'main',kind:'salary'},savedAt:'2026-01-01',fileName:'test.pdf',originalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',originalMonth:'2026-05',pdfSize:pdf.length,pdfType:'application/pdf',fileHash:hash,pages:1,warningsAcknowledged:true});
const index={format:'payroll-index-v1',years:[...years],incomeYears:[]};
const files=new Map();let serial=0,cache=null,snapshotWrites=0;
const doc=records=>({format:'payroll-annual-v1',records,deleted:[]});
const put=(p,obj)=>{const text=typeof obj==='string'?obj:JSON.stringify(obj);files.set(p,{id:p,etag:`r-${++serial}`,size:enc.encode(text).length,text})};
put('payroll/index.enc',index);
for(const year of years)put(`payroll/statements/${year}.enc`,doc([make(Number(year),year)]));
put('payroll/originals/2026/05/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.enc','pdf-cipher-placeholder');
const calls={read:[],meta:[],list:[]};let epoch='fixture-epoch';
const graph={
 async withWriteLock(operation){return operation();},
 async read(parts,name){const p=[...parts,name].join('/');calls.read.push(p);return files.get(p)??null},
 async metadata(parts,name){const p=[...parts,name].join('/');calls.meta.push(p);const row=files.get(p);return row?{id:row.id,etag:row.etag,size:row.size}:null},
 async listFolder(parts){const prefix=parts.join('/')+'/';calls.list.push(prefix);return [...files.entries()].filter(([p])=>p.startsWith(prefix)&&!p.slice(prefix.length).includes('/')).map(([p,v])=>({id:v.id,name:p.slice(prefix.length),etag:v.etag,size:v.size,folder:false}))},
 async write(){throw Error('no mutation allowed')}
};
const common={validateEmployerDirectory,crypto:webcrypto,structuredClone,TextEncoder,TextDecoder,Uint8Array,Buffer,Blob,Map,Set,WeakMap,Promise,console,performance,
 envelopeSalt:()=>salt,parseEnvelope:()=>({salt}),decryptJson:async(_,t)=>JSON.parse(t),encryptJson:async(_,v)=>JSON.stringify(v),decryptBytes:async()=>pdf,
 isCollision:()=>false,SNAPSHOT_TTL_MS:600_000,mutationEpoch:()=>epoch,clearNavigationSnapshot:()=>{cache=null},rememberNavigationSnapshot:async(_scope,_salt,_key,data)=>{cache=data;snapshotWrites++},
 restoredNavigationSnapshot:async(_scope,_salt,_key)=>cache?{data:cache,expires:Date.now()+600000}:null,
 fiscalYearOfTargetMonth:v=>Number(v.slice(0,4)),isValidPayrollSemantics:()=>true,validEmployerId:v=>v===undefined||(typeof v==='string'&&/^emp_[0-9a-f]{32}$/.test(v)),payrollPeriodKey:rec=>rec.form.paymentDate,
 beginPerfOperation:()=>({measure:async(_,fun)=>fun(),finish(){}}),
 MAX_RECORDS:2000,MAX_TOTAL_PDF_BYTES:1e9,PayrollPartialSuccessError:class extends Error{},
 toPublicIncomeRecord:()=>{throw Error('not called')},
 setTimeout,
};
const {PayrollVault}=runInNewContext(strip(src('src/cloud/vault.ts'))+'\n({PayrollVault})',common);
let current;
const api=runInNewContext(strip(src('src/storage/payrollStore.ts'))+'\n({previewRecordSummary,getRecordSummary,getOriginalForVerifiedEdit,getRecord,recordSignature})',{
 ...common,cloudVault:async()=>current,PayrollPartialSuccessError:class extends Error{},validatePayrollForm:()=>({errors:[],warnings:[]}),
 isValidPayrollSemantics:()=>true,MAX_PDF_SIZE:50e6,toPublicIncomeRecord:()=>{},
});
const reset=()=>{calls.read.length=0;calls.meta.length=0;calls.list.length=0};
const first=new PayrollVault(graph);first.key=key;first.salt=salt;first.index=index;first.setNavigationScope('client:synthetic');
await first.refresh({forceFresh:true});assert.equal(calls.read.filter(p=>p.includes('statements')).length,4);
assert.equal(cache.versions.length,4,'verified ETags must be placed inside snapshot payload');
const after=new PayrollVault(graph);after.setNavigationScope('client:synthetic');assert.equal(await after.resumeFromSnapshot(key,salt),true);current=after;
reset();const preview=await api.previewRecordSummary(2026);
assert.equal(preview.record.id,2026);assert.equal(preview.record.originalId,undefined);
assert.equal(calls.read.length+calls.meta.length+calls.list.length,0,'preview performs no Graph I/O after restored vault');
preview.record.form.targetMonth='1900-01';assert.equal((await api.previewRecordSummary(2026)).record.form.targetMonth,'2026-05');
assert.equal(after.previewUploadBaseline().length,4,'complete navigation snapshot may propose upload candidates only');
assert.equal(await api.previewRecordSummary(999),null);assert.equal(await api.previewRecordSummary(-1),null);
epoch='mutation';assert.equal(await api.previewRecordSummary(2026),null);assert.equal(after.previewUploadBaseline(),null);epoch='fixture-epoch';
after.snapshotDeadline=Date.now()-1;assert.equal(await api.previewRecordSummary(2026),null);after.snapshotDeadline=Date.now()+600000;
console.log('PASS: display-only preview has zero Graph reads, is a detached copy, expires and respects mutation invalidation');
const beforeEditSnapshot=snapshotWrites;
reset();const record=await api.getRecordSummary(2026,'2026');assert.equal(record.id,2026);
assert.equal(await api.previewRecordSummary(2026),null,'a live read consumes navigation preview eligibility');
assert.equal(snapshotWrites,beforeEditSnapshot,'editing metadata does not serialize a new full navigation snapshot');
assert.equal(calls.read.filter(p=>p.includes('statements')).length,0);
assert.equal(calls.list.length,1);assert.equal(calls.read.filter(p=>p.includes('index.enc')).length,1);
const beforeTargetReads=snapshotWrites;
reset();const b=await api.getOriginalForVerifiedEdit(2026,api.recordSignature(record));
assert.equal(b.size,pdf.length);assert.equal(calls.list.length,2);assert.equal(calls.read.filter(p=>p.includes('statements')).length,0);
console.log('PASS: fresh index/list before and after PDF; warm edit zero year downloads');
reset();const direct=await api.getRecord(2026);assert.equal(direct.pdf.size,pdf.length);
assert.equal(calls.list.length,2);assert.equal(calls.read.filter(p=>p.includes('statements')).length,0);
assert.equal(snapshotWrites,beforeTargetReads,'targeted PDF reads do not serialize the full snapshot');
console.log('PASS: warm direct viewer performs two fresh inventories with zero year body downloads and no full snapshot serialization');
// Move same ID to another year with higher revision.
put('payroll/statements/2025.enc',doc([make(2025,'2025'),make(2026,'2025',2)]));
const beforeChangedSnapshot=snapshotWrites;
reset();const relocated=await api.getRecordSummary(2026,'2026');assert.equal(relocated.form.targetMonth,'2025-05');
assert.equal(snapshotWrites,beforeChangedSnapshot+1,'changed source must replace, not leave a stale home snapshot');
assert.equal(calls.read.filter(p=>p.includes('statements')).length,1);
await assert.rejects(api.getOriginalForVerifiedEdit(2026,api.recordSignature(record)),/更新|再読み込み/);
console.log('PASS: cross-year record movement follows higher revision; stale PDF rejected');
// Untrusted hint not used to select a record, only request priority.
reset();const fallback=await api.getRecordSummary(2026,'2023');assert.equal(api.recordSignature(fallback),api.recordSignature(relocated));
assert.equal(calls.list.length,1);assert.equal(calls.read.filter(p=>p.includes('statements')).length,0);
console.log('PASS: untrusted hint cannot redirect record selection');
// Legacy snapshot with no meta versions must fetch all year bodies.
cache={index,years:years.map(y=>[y,doc(y==='2025'?[make(2025,'2025'),make(2026,'2025',2)]:[make(Number(y),y)])])};
const old=new PayrollVault(graph);old.setNavigationScope('client:synthetic');assert.equal(await old.resumeFromSnapshot(key,salt),true);current=old;
reset();await api.getRecordSummary(2026,'2023');assert.equal(calls.read.filter(p=>p.includes('statements')).length,4);
console.log('PASS: legacy snapshot without ETags falls back to full authenticated read');

// A small inventory uses individual version probes. A changed year is
// decrypted from the already verified response rather than issuing a second GET.
{
 const smallIndex={...index,years:['2026']};
 put('payroll/index.enc',smallIndex);
 put('payroll/statements/2026.enc',doc([make(2026,'2026')]));
 const small=new PayrollVault(graph);small.key=key;small.salt=salt;small.index=smallIndex;small.setNavigationScope('client:synthetic');
 await small.refresh({forceFresh:true});current=small;
 let combined=0;
 graph.readIfChanged=async(parts,name,_limit,proof)=>{
  const p=[...parts,name].join('/'),row=files.get(p);calls.meta.push(p);
  if(!row)return null;
  if(row.id===proof.id&&row.etag===proof.etag&&row.size===proof.size)return undefined;
  if(parts.includes('statements'))combined++;
  return {...row};
 };
 put('payroll/statements/2026.enc',doc([make(2026,'2026',2)]));
 reset();const changed=await api.getRecordSummary(2026,'2026');
 assert.equal(changed.revision,2);assert.equal(combined,1);
 assert.equal(calls.read.filter(p=>p.includes('statements')).length,0,'no second read after the changed-version response');
 await assert.rejects(api.getOriginalForVerifiedEdit(2026,api.recordSignature(make(2026,'2026'))),/更新|再読み込み/);
 delete graph.readIfChanged;
 put('payroll/index.enc',index);
 console.log('PASS: small-inventory edit consumes the verified changed-year response and rejects stale PDF references');
}

// Root proof is paired with the encrypted snapshot's actual validated index.
// A restored proof must still perform a live observation before use.
{
 const scope='client:synthetic',source=new PayrollVault(graph);source.key=key;source.salt=salt;source.index=index;source.setNavigationScope(scope);
 await source.refresh({forceFresh:true});
 const saved=structuredClone(cache),root=files.get('payroll/index.enc');
 assert.deepEqual({...saved.indexVersion},{id:root.id,etag:root.etag,size:root.size});
 assert.equal(saved.indexVersion.text,undefined);
 graph.readIfChanged=async(parts,name,_limit,proof)=>{
  const p=[...parts,name].join('/'),row=files.get(p);calls.meta.push(p);
  return !row?null:row.id===proof.id&&row.etag===proof.etag&&row.size===proof.size?undefined:{...row};
 };
 const restore=async(data)=>{cache=structuredClone(data);const v=new PayrollVault(graph);v.setNavigationScope(scope);assert.equal(await v.resumeFromSnapshot(key,salt),true);return v;};
 const v=await restore(saved);reset();await v.readIndex();
 assert.equal(calls.meta.filter(p=>p==='payroll/index.enc').length,1);assert.equal(calls.read.length,0);
 const legacy=structuredClone(saved);delete legacy.indexVersion;const old=await restore(legacy);reset();await old.readIndex();assert.equal(calls.read.filter(p=>p==='payroll/index.enc').length,1);
 const bad=structuredClone(saved);bad.indexVersion.size=0;const invalid=await restore(bad);reset();await invalid.readIndex();assert.equal(calls.read.filter(p=>p==='payroll/index.enc').length,1);
 const changed=await restore(saved);put('payroll/index.enc',{...index,years:['2026']});reset();assert.deepEqual([...((await changed.readIndex()).index.years)],['2026']);
 const retired=await restore(saved);put('payroll/index.enc',{...index,generation:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});await assert.rejects(retired.readIndex(),/保存世代/);
 const missing=await restore(saved);files.delete('payroll/index.enc');await assert.rejects(missing.readIndex(),/索引/);
 put('payroll/index.enc',index);delete graph.readIfChanged;
 console.log('PASS: encrypted navigation index proof requires live ID/ETag/size, legacy and malformed proof fall back, changed/missing generation rejected');
}

// Exercise the real snapshot functions with WebCrypto and an isolated tab store.
{
 const store=new Map();
 const env={crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Date,Map,Set,Promise,Error,JSON,btoa,atob,
  sessionStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
  clearNavigationNotice(){},resetNotificationHistory(){},dismissOperationDialog(){},dismissRecordDiagnostic(){}};
 const actual=runInNewContext(strip(src('src/cloud/crypto.ts'))+'\n'+strip(src('src/cloud/snapshot.ts'))+'\n({rememberNavigationSnapshot,restoredNavigationSnapshot,invalidateNavigationSnapshot,invalidateAuthSession,mutationEpoch,SNAPSHOT_TTL_MS})',env);
 const k=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const scope='synthetic-scope',s='synthetic-salt';
 assert.equal(actual.SNAPSHOT_TTL_MS,600_000);
 await actual.rememberNavigationSnapshot(scope,s,k,{name:'Synthetic home'});
 await actual.rememberNavigationSnapshot(scope,s,k,[{displayName:'Synthetic employee'}],'people');
 assert.equal(store.size,2);assert.doesNotMatch([...store.values()].join(' '),/Synthetic home|Synthetic employee/);
 assert.equal((await actual.restoredNavigationSnapshot(scope,s,k,'people')).data[0].displayName,'Synthetic employee');
 assert.equal((await actual.restoredNavigationSnapshot(scope,s,k)).data.name,'Synthetic home');
 const pendingRead=actual.restoredNavigationSnapshot(scope,s,k,'people');actual.invalidateNavigationSnapshot();assert.equal(await pendingRead,null);
 assert.equal(store.has('payroll-navigation-snapshot-v1'),false);assert.equal(store.has('payroll-yearend-navigation-snapshot-v1'),false);
 const epoch=actual.mutationEpoch();actual.invalidateNavigationSnapshot();await actual.rememberNavigationSnapshot(scope,s,k,{old:true},'people',epoch);assert.equal(store.has('payroll-yearend-navigation-snapshot-v1'),false);
 await actual.rememberNavigationSnapshot(scope,s,k,[{displayName:'Synthetic employee'}],'people');
 assert.equal(await actual.restoredNavigationSnapshot('different-account',s,k,'people'),null);
 await actual.rememberNavigationSnapshot(scope,s,k,{},'people');const clock=Date.now;Date.now=()=>clock()+600_001;
 try{assert.equal(await actual.restoredNavigationSnapshot(scope,s,k,'people'),null);}finally{Date.now=clock;}
 const pendingWrite=actual.rememberNavigationSnapshot(scope,s,k,{},'people');actual.invalidateAuthSession();await pendingWrite;
 assert.equal(store.has('payroll-yearend-navigation-snapshot-v1'),false);
 console.log('PASS: actual AES-GCM separate tab caches, scope binding, expiry and in-flight read/write invalidation');
}
// A background silent resume and a user-requested unlock can overlap. The
// silent failure must not become a permanent failure of the interactive load.
{
 const source=src('src/cloud/auth.ts'),start=source.indexOf('export async function cloudVault()'),end=source.indexOf('/** Inspect the current Microsoft account',start);
 let rejectProbe,probeCount=0,promptCount=0,allow=true;
 const fakeVault={isUnlocked:()=>true};
 const env={VaultIndexReadError:class extends Error{},vault:undefined,unlocking:undefined,backgroundUnlocking:undefined,tabLocks:{check:()=>allow},validId:()=>true,clientId:()=> 'fixture',captureOperationAuthorization:()=>()=>allow,
  resumeOrPrompt:async(prompt=true)=>{if(!prompt){probeCount++;return await new Promise((_,reject)=>{rejectProbe=reject;});}promptCount++;env.vault=fakeVault;return fakeVault;}};
 const functions=runInNewContext(strip(source.slice(start,end))+'\n({cloudVault,tryResumeCloudVault})',env);
 const background=functions.tryResumeCloudVault(),one=functions.cloudVault(),two=functions.cloudVault();rejectProbe(new Error('silent auth failed'));
 assert.equal(await background,undefined);assert.equal(await one,fakeVault);assert.equal(await two,fakeVault);assert.equal(probeCount,1);assert.equal(promptCount,1);
 env.vault=undefined;const next=functions.tryResumeCloudVault(),blocked=functions.cloudVault();allow=false;rejectProbe(new Error('account changed'));
 await next;await assert.rejects(blocked,/ロック/);assert.equal(promptCount,1);
 console.log('PASS: interactive unlock falls back once after silent failure; lock change blocks stale caller');
}

// A transport failure is independent of the candidate key. Do not repeat
// the same index GET with a second key, or when an overlapping interactive
// caller joins the silent probe. Key mismatch still permits the other key.
{
 const source=src('src/cloud/auth.ts');
 const resume=source.slice(source.indexOf('async function resumeOrPrompt('),source.indexOf('/** An asynchronous confirmation'));
 const cloud=source.slice(source.indexOf('export async function cloudVault()'),source.indexOf('/** Inspect the current Microsoft account'));
 class VaultIndexReadError extends Error{}
 class RememberedKeyMismatchError extends Error{}
 const firstKey={},secondKey={},salt='fixture';
 let failure='network',reads=[],persistentReads=0,gateCount=0,suspended=0;
 const env={VaultIndexReadError,RememberedKeyMismatchError,MicrosoftSignInRequiredError:class extends Error{},
  vault:undefined,unlocking:undefined,backgroundUnlocking:undefined,
  clientId:()=> 'fixture',validId:()=>true,clearTabUnlock:()=>{},captureKeyGeneration:async()=>1,
  getMsal:async()=>({}),account:()=>({}),token:async()=>{},sessionScope:()=> 'fixture',
  tabLocks:{epoch:()=>1,canResume:()=>true,check:()=>true,acceptUnlock:()=>true,canAutoResumePersistent:()=>true,suspendPersistentAutoResume:()=>{suspended++;}},
  restoredKey:async()=>({key:firstKey,salt}),readRememberedBrowserKey:async()=>{persistentReads++;return {key:secondKey,salt,generation:null};},
  payrollGraph:()=>({}),requireCurrentLockEpoch:()=>{},rememberKey:async()=>{},installHomeLock:()=>{},captureOperationAuthorization:()=>()=>true,
  beginUnlock:async()=>{gateCount++;return {manual:true};},
  PayrollVault:class{setNavigationScope(){} async resumeFromSnapshot(){return false;} async unlockWithKey(key){reads.push(key);if(failure==='network'||failure==='persistent-network'&&key===secondKey)throw new VaultIndexReadError('transport');if((failure==='mismatch'||failure==='persistent-network')&&key===firstKey)throw new RememberedKeyMismatchError();this.key=key;} rememberedKeyGeneration(){return null;} sessionKey(){return {key:this.key,salt};} isUnlocked(){return true;}},
 };
 const api=runInNewContext(strip(resume+'\n'+cloud)+'\n({resumeOrPrompt,cloudVault,tryResumeCloudVault})',env);
 await assert.rejects(api.resumeOrPrompt(false),VaultIndexReadError);
 assert.deepEqual(reads,[firstKey]);assert.equal(persistentReads,0);assert.equal(suspended,0);
 reads=[];assert.equal((await api.resumeOrPrompt()).manual,true);assert.deepEqual(reads,[firstKey]);assert.equal(gateCount,1);
 reads=[];const background=api.tryResumeCloudVault(),one=api.cloudVault(),two=api.cloudVault();
 assert.equal(await background,undefined);assert.equal((await one).manual,true);assert.equal((await two).manual,true);
 assert.deepEqual(reads,[firstKey]);assert.equal(gateCount,2,'overlapping callers open a single gate without repeating Graph read');
 reads=[];failure='mismatch';assert.equal((await api.resumeOrPrompt(false)).key,secondKey);assert.deepEqual(reads,[firstKey,secondKey]);assert.equal(persistentReads,1);
 env.vault=undefined;reads=[];failure='persistent-network';await assert.rejects(api.resumeOrPrompt(false),VaultIndexReadError);assert.deepEqual(reads,[firstKey,secondKey]);assert.equal(suspended,0);
 env.vault=undefined;reads=[];failure='none';assert.equal((await api.resumeOrPrompt(false)).key,firstKey,'temporary failures do not disable future automatic unlock');assert.deepEqual(reads,[firstKey]);
 console.log('PASS: index transport failure skips duplicate key probes, preserves consent and allows explicit recovery; mismatch still tries remembered key');
}

// Execute the real editor's async verification boundary with a paused read.
// No UI or storage mocks can confer write permission: only a matching live record does.
{
 const edit=src('src/edit.ts');
 const start=edit.indexOf('async function verifyRecord('),end=edit.indexOf("appStatus.loading('保存済み明細を読み込んでいます…');",start);
 assert.ok(start>=0&&end>start);
 const fixture=(fresh,options={})=>{
  let release,fail;
  const before={id:7,revision:1,form:{net:'100'}},draft={net:'200'};
  const ctx={record:options.cold?undefined:before,verification:'checking',draftTouched:options.touched??true,hasUnsavedChanges:()=>options.touched??true,
   editAuthorized:()=>!ctx.revoked,authorizationFailure:e=>e.message==='auth',recordSignature:r=>JSON.stringify(r),
   employerInput:{value:'',prepend(){},selectedIndex:0},employerDirectory:[],employerRoleSelectionRequired:false,reviewApproval:null,
   refreshEmployerSelect(){},document:{createElement:()=>({})},editor:{hidden:false},appStatus:{clear(){}},noticeReason:()=>undefined,
   updateUI(){},renderRecord(r){ctx.record=r;draft.net=r.form.net;},discardUnauthorizedRecord(){ctx.record=undefined;ctx.editor.hidden=true;},showError(){ctx.error=true;},
   getRecordSummary:async(_id,_hint,cb)=>{await new Promise((resolve,reject)=>{release=resolve;fail=reject;});cb([]);return fresh;}};
  runInNewContext(strip(edit.slice(start,end))+'\nglobalThis.verify=verifyRecord;',ctx);
  return {ctx,draft,run:()=>ctx.verify(7),release:()=>release(),fail:e=>fail(e)};
 };
 const same={id:7,revision:1,form:{net:'100'}},changed={...same,revision:2,form:{net:'300'}};
 for(const [fresh,options,expected] of [[same,{},'ready'],[changed,{},'conflict'],[undefined,{},'conflict'],[changed,{touched:false},'ready'],[same,{cold:true},'ready']]){
  const f=fixture(fresh,options),pending=f.run();assert.equal(f.ctx.verification,'checking');f.release();await pending;assert.equal(f.ctx.verification,expected);
  assert.equal(f.draft.net,options.cold?'100':options.touched===false?'300':'200');
 }
 const f=fixture(same),pending=f.run();f.fail(new Error('temporary'));await pending;assert.equal(f.ctx.verification,'failed');assert.equal(f.draft.net,'200');
 const retry=f.run();f.release();await retry;assert.equal(f.ctx.verification,'ready');assert.equal(f.draft.net,'200');
 const g=fixture(same),revoked=g.run();g.ctx.revoked=true;g.release();await revoked;assert.equal(g.ctx.record,undefined);assert.equal(g.ctx.editor.hidden,true);
 const h=fixture(same),auth=h.run();h.fail(new Error('auth'));await auth;assert.equal(h.ctx.editor.hidden,true);
 assert.match(edit,/if\(!canUseRecord\(\)\)return;/);
 assert.match(edit,/if\(ready\)\{originalLink.href/);
 assert.match(edit,/saveButton.disabled=true;deleteButton.disabled=true;diagnosticButton.disabled=true/);
 console.log('PASS: editor preserves draft during fresh verification/retry, rejects changed/deleted records, handles cold start and authorization loss');
}

// Cold three-year lookup remains parallel; warm PDF boundaries prefer a
// complete live path-based listing, with direct probes as fallback.
{
 const list=years.slice(0,3),smallIndex={...index,years:list};
 const smallFiles=new Map([['payroll/index.enc',{id:'small-index',etag:'root-version',size:100,text:JSON.stringify(smallIndex)}]]);
 for(const y of list){const text=JSON.stringify(doc([make(Number(y),y)]));smallFiles.set(`payroll/statements/${y}.enc`,{id:y,etag:'stable',size:enc.encode(text).length,text});}
 let probes=0,active=0,maxActive=0,lists=0,indexReads=0,fallback=false;
 const smallGraph={...graph,
  async read(parts,name){const k=[...parts,name].join('/');if(name==='index.enc')indexReads++;return smallFiles.get(k)??null;},
  async readIfChanged(parts,name,_max,prior,direct){const k=[...parts,name].join('/');if(name!=='index.enc'){assert.equal(direct,true);probes++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,5));active--;}else indexReads++;const f=smallFiles.get(k);return !f?null:f.id===prior.id&&f.etag===prior.etag&&f.size===prior.size?undefined:f;},
  async listFolder(_parts,_reuse,mode){lists++;if(mode==='display'&&fallback)return null;return list.flatMap(y=>{const f=smallFiles.get(`payroll/statements/${y}.enc`);return f?[{id:f.id,etag:f.etag,size:f.size,name:y+'.enc',folder:false}]:[];});},
  async metadata(parts,name){const f=smallFiles.get([...parts,name].join('/'));return f??null;}
 };
 const v=new PayrollVault(smallGraph);await v.unlockWithKey(key,salt);
 indexReads=0;
 await v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2023,initialPdfRead:true});
 assert.equal(indexReads,0,'initial direct PDF consumes a live unlock observation once');
 await v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2023});
 assert.equal(indexReads,1);assert.equal(probes,0);assert.equal(lists,1,'warm PDF uses one complete listing');
 fallback=true;await v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2023});
 assert.equal(probes,3);assert.equal(maxActive,3);assert.equal(lists,2,'incomplete/unavailable listing falls back to all live probes');fallback=false;
 await v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});assert.equal(lists,3,'write-style full inventory unchanged');
 const saved=smallFiles.get('payroll/statements/2024.enc');const changed=JSON.stringify(doc([make(2024,'2024'),make(2023,'2024',2)]));
 smallFiles.set('payroll/statements/2024.enc',{...saved,etag:'changed',text:changed,size:enc.encode(changed).length});
 const latest=await v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2023});
 assert.equal(latest[0].revision,2,'warm inventory must detect a move to another year');
 smallFiles.delete('payroll/statements/2025.enc');
 assert.equal((await v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2023}))[0].revision,2,'unrelated missing year remains readable');
 await assert.rejects(v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2023,requireComplete:true}),/年度ファイル/);
 smallFiles.delete('payroll/statements/2024.enc');
 await assert.rejects(v.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2023}),/明細ファイル/);
 console.log('PASS: cold/warm display selection, complete live inventory, fallback probes, moved-record and missing-year protection');
}

// The real startup block should never trigger getRecordSummary on a warm preview.
{
 const source=src('src/edit.ts'),start=source.indexOf("appStatus.loading('保存済み明細を読み込んでいます…');"),tail=source.slice(start).replace('void (async () => {','globalThis.done=(async () => {');
 for(const preview of [true,false]){
  let reads=0,paints=0;
  const ctx={appStatus:{loading(){},clear(){}},originParams:new URLSearchParams('id=7'),verification:'checking',editAuthorized:()=>false,
   beginPerfOperation:()=>({measure:async(_,work)=>work(),finish(){}}),cloudVault:async()=>({}),captureOperationAuthorization:()=>()=>true,capturePdfHandoffAuthorization:()=>()=>true,
   previewRecordSummary:async()=>preview?{record:{id:7},directory:[]}:null,renderRecord(){paints++;},discardUnauthorizedRecord(){throw Error('unexpected lock');},showError(){throw Error('unexpected startup failure');},noticeReason(){},recheckButton:{addEventListener(){}},verifyRecord:async()=>{reads++;}};
  runInNewContext(strip(tail),ctx);await ctx.done;
  assert.equal(paints,preview?1:0);assert.equal(reads,preview?0:1);
 }
 assert.match(source,/updateRecordMetadata\(updated, conflicts, recordSignature\(record\),stage=>/);
 assert.match(source,/employerDirectorySignature\(employerDirectory\)\);/);
 assert.match(source,/deleteRecords\(\[\{id:target.id,signature\}\]\)/);
 assert.match(source,/getOriginalForVerifiedEdit\(target.id,recordSignature\(target\)\)/);
 console.log('PASS: warm editor does not start inventory, cold editor verifies; actions retain signed live preflights');
}

// R14: initial authenticated byte equality is bound to the immutable selected
// Blob and consumed once; retain the final live metadata probe, not ciphertext.
{
 const path='payroll/originals/2026/05/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.enc';
 const fixture=files.get(path);assert.ok(fixture);
 const v=new PayrollVault(graph);v.key=key;v.salt=salt;v.index=index;
 const root=files.get('payroll/index.enc');
 const item={id:fixture.id,etag:fixture.etag,size:fixture.size,month:'2026-05',uuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 const report={generation:'',indexEtag:root.etag,years:[],originals:[item]};
 const selected=new Blob([pdf]),record={pdf:selected,fileHash:hash},attempt=[{targetMonth:item.month,fileHash:hash}];
 reset();let [match]=await v.inspectDetachedUploadMatches(report,attempt,new Map([[hash,selected]]));
 assert.ok(match);assert.equal(calls.read.filter(p=>p===path).length,1);
 reset();await v.verifyDetachedUploadMatch(report,match,record);
 assert.equal(calls.read.filter(p=>p===path).length,0);assert.equal(calls.meta.filter(p=>p===path).length,1);
 reset();await v.verifyDetachedUploadMatch(report,match,record);assert.equal(calls.read.filter(p=>p===path).length,1,'proof is single use');
 [match]=await v.inspectDetachedUploadMatches(report,attempt,new Map([[hash,selected]]));
 files.set(path,{...fixture,etag:'changed-detached'});
 await assert.rejects(v.verifyDetachedUploadMatch(report,match,record),/原本が更新/);files.set(path,fixture);
 [match]=await v.inspectDetachedUploadMatches(report,attempt,new Map([[hash,selected]]));
 reset();await v.verifyDetachedUploadMatch(report,match,{...record,pdf:new Blob([pdf])});
 assert.equal(calls.read.filter(p=>p===path).length,1,'different selected Blob needs full recheck');
 await assert.rejects(v.inspectDetachedUploadMatches(report,attempt,new Map([[hash,new Blob(['not the selected PDF'])]])),/一致しません/);
 [match]=await v.inspectDetachedUploadMatches(report,attempt);
 reset();await v.verifyDetachedUploadMatch(report,match,record);assert.equal(calls.read.filter(p=>p===path).length,1,'explicit recovery does not retain proof');
 console.log('PASS R14: initial byte equality, one-use Blob identity proof, final live metadata and strict fallback');
}

// R13: two independent originals overlap, return stable order, and drain
// the second in-flight read even if the first one fails immediately.
{
 const v=new PayrollVault(graph);v.key=key;v.salt=salt;v.index=index;
 const root=files.get('payroll/index.enc'),uuid1='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',uuid2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const paths=[uuid1,uuid2].map(uuid=>`payroll/originals/2026/05/${uuid}.enc`);
 const first=files.get(paths[0]);files.set(paths[1],{...first,id:paths[1],etag:'r13-second'});
 const originals=paths.map((path,i)=>{const row=files.get(path);return {id:row.id,etag:row.etag,size:row.size,month:'2026-05',uuid:[uuid1,uuid2][i]};});
 const report={generation:'',indexEtag:root.etag,years:[],originals};
 const priorRead=graph.read;
 let active=0,peak=0,finished=0;
 graph.read=async(parts,name)=>{
  const path=[...parts,name].join('/');if(!paths.includes(path))return priorRead(parts,name);
  active++;peak=Math.max(active,peak);await new Promise(r=>setTimeout(r,path===paths[0]?10:1));active--;finished++;return files.get(path);
 };
 try{
  const matches=await v.inspectDetachedUploadMatches(report,[{targetMonth:'2026-05',fileHash:hash}]);
  assert.equal(peak,2);assert.equal(finished,2);assert.equal(matches.length,2);
  assert.equal(matches[0].original.uuid,uuid1);assert.equal(matches[1].original.uuid,uuid2);
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  graph.read=async(parts,name)=>{const path=[...parts,name].join('/');if(path===paths[0])throw Error('synthetic candidate failure');if(path===paths[1]){entered();await gate;return files.get(path);}return priorRead(parts,name);};
  let settled=false;const pending=v.inspectDetachedUploadMatches(report,[{targetMonth:'2026-05',fileHash:hash}]).finally(()=>settled=true);
  await started;await new Promise(r=>setTimeout(r,0));assert.equal(settled,false,'wait for other in-flight candidate before throwing');
  release();await assert.rejects(pending,/synthetic candidate failure/);
 }finally{graph.read=priorRead;files.delete(paths[1]);}
 console.log('PASS R13: two candidate inspections overlap, stable result order, all in-flight reads drained on failure');
}

// B01: a failed year stops dispatch; all active reads settle before retry.
{
 const moreYears=['2021','2022','2023','2024','2025','2026'];
 const v=new PayrollVault(graph);v.key=key;v.salt=salt;v.index=index;
 await v.refresh({forceFresh:true});
 const oldShards=v.shards,oldVersions=v.shardVersions,oldSnapshotWrites=snapshotWrites;
 const priorRead=graph.read,priorIndex=files.get('payroll/index.enc');
 const started=[],finished=[],progress=[];
 const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
 const gates=new Map(moreYears.map(year=>[year,deferred()]));
 const ready=deferred();const firstFailure=Error('synthetic first year failure');
 put('payroll/index.enc',{...index,years:moreYears});
 graph.read=async(parts,name)=>{
  if(!parts.includes('statements'))return priorRead(parts,name);
  const year=name.slice(0,4);started.push(year);if(started.length===4)ready.resolve();
  try{return await gates.get(year).promise;}finally{finished.push(year);}
 };
 try{
  let settled=false;
  const result=v.refresh({forceFresh:true,onProgress:(_n,_total,year)=>progress.push(year)}).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  await ready.promise;
  assert.deepEqual(started,['2026','2025','2024','2023']);
  gates.get('2026').reject(firstFailure);
  await new Promise(r=>setTimeout(r,0));assert.equal(settled,false,'must drain active reads before rejection');
  gates.get('2025').reject(Error('synthetic later year failure'));
  gates.get('2024').resolve(files.get('payroll/statements/2024.enc'));
  await new Promise(r=>setTimeout(r,0));
  assert.equal(settled,false,'last in-flight worker still pending');
  assert.equal(started.length,4,'no new year after first failure');
  gates.get('2023').resolve(files.get('payroll/statements/2023.enc'));
  const error=await result;assert.equal(error?.cause,firstFailure,'preserve the first read error');
  assert.equal(finished.length,4);assert.equal(started.length,4);assert.deepEqual(progress,[]);
  assert.equal(v.shards,oldShards);assert.equal(v.shardVersions,oldVersions);assert.equal(snapshotWrites,oldSnapshotWrites);
 }finally{graph.read=priorRead;files.set('payroll/index.enc',priorIndex);}
 reset();assert.equal((await v.refresh({forceFresh:true})).length,v.records().length);
 assert.equal(calls.read.filter(p=>p.includes('statements')).length,index.years.length);
 console.log('PASS B01: first failure stops queued years, drains all active reads, preserves complete snapshot and permits retry');
}
