/** Real storage, encryption and Graph control-flow; synthetic data, no live service. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({stdin:{contents:[
 "export {PayrollVault} from './src/cloud/vault.ts'",
 "export {PayrollGraph,GraphError} from './src/cloud/graph.ts'",
 "export {decryptJson,encryptJson} from './src/cloud/crypto.ts'",
 "export {getRecordSummary,updateRecordMetadata,recordSignature,saveRecordsSkippingDuplicates,deleteRecords,inspectAdditiveRestore,restoreAdditiveRecords,inspectReplacementRestoreBaseline,replaceAllRecords,inspectEmployerAssignment,assignEmployers} from './src/storage/payrollStore.ts'",
 "export {prepareOptionalZeros,reconcilePayrollZeroResolution} from './src/storage/payrollZeroResolution.ts'",
 "export {inspectUploadRecovery,uploadRecoveryAttempt,requireSafeUploadRecovery} from './src/storage/uploadRecovery.ts'",
 "export {bindPayrollGraphIdentity,MicrosoftSignInRequiredError} from './src/cloud/msalPolicy.ts'",
].join(';'),resolveDir:root,loader:'ts',sourcefile:'integrity-entry.ts'},plugins:[{name:'synthetic-auth-only',setup(ctx){
 ctx.onResolve({filter:/^\.\.\/cloud\/auth$/},()=>({path:'integrity-auth',namespace:'synthetic'}));
 ctx.onLoad({filter:/.*/,namespace:'synthetic'},()=>({contents:'export async function cloudVault(){return globalThis.__p1p7Vault;}',loader:'js'}));
}}],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
const {PayrollVault,PayrollGraph,GraphError,decryptJson,encryptJson,getRecordSummary,updateRecordMetadata,recordSignature,saveRecordsSkippingDuplicates,deleteRecords,inspectAdditiveRestore,restoreAdditiveRecords,inspectReplacementRestoreBaseline,replaceAllRecords,inspectEmployerAssignment,assignEmployers,prepareOptionalZeros,reconcilePayrollZeroResolution,inspectUploadRecovery,uploadRecoveryAttempt,requireSafeUploadRecovery,bindPayrollGraphIdentity,MicrosoftSignInRequiredError}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const enc=new TextEncoder();
class FakeGraph{
 files=new Map(); writes=[]; trashed=[]; beforeTrash=undefined; trashFault=undefined; revision=0; fault=undefined; discard=undefined;
 path(parts,name){return [...parts,name].join('/');}
 async read(parts,name){const row=this.files.get(this.path(parts,name));return row?{...row}:null;}
 async metadata(parts,name){const row=await this.read(parts,name);return row?{id:row.id,etag:row.etag,size:row.size}:null;}
 async listFolder(parts){const prefix=parts.join('/')+'/';const result=new Map();for(const [p,v] of this.files){if(!p.startsWith(prefix))continue;const [name,...rest]=p.slice(prefix.length).split('/');result.set(name,rest.length?{id:prefix+name,name,folder:true,etag:'folder',size:0}:{id:v.id,name,folder:false,etag:v.etag,size:v.size});}return [...result.values()];}
 async trashPayrollOriginal(parts,item,beforeDelete){
  const p=this.path(parts,item.name);await this.beforeTrash?.(p);await beforeDelete();
  const current=this.files.get(p);assert.equal(current?.id,item.id);assert.equal(current?.etag,item.etag);
  if(this.trashFault?.(p))throw new Error('synthetic trash interruption');
  this.trashed.push(p);this.files.delete(p);
 }
 async write(parts,name,text,prior,limit){const p=this.path(parts,name),old=this.files.get(p);if(prior?old?.etag!==prior.etag:!!old)throw new GraphError(412,'conflict');if(this.fault?.(p,old))throw new Error('synthetic write interruption');const size=enc.encode(text).length;assert.ok(size<=limit);this.writes.push(p);if(this.discard?.(p,old))return;this.files.set(p,{id:p,etag:'e'+(++this.revision),text,size});}
}
async function setup(){const graph=new FakeGraph();let vault=new PayrollVault(graph);await vault.unlock('synthetic-integrity-passphrase',true);const {key,salt}=vault.sessionKey();globalThis.__p1p7Vault=vault;return {graph,key,get vault(){return vault;},async reopen(){vault.lock();vault=new PayrollVault(graph);await vault.unlockWithKey(key,salt);await vault.refresh({forceFresh:true});globalThis.__p1p7Vault=vault;return vault;}};}
const A='emp_'+'a'.repeat(32),B='emp_'+'b'.repeat(32);
async function sample(n,employerId,month='2026-12'){
 const bytes=enc.encode('%PDF-1.7\nSynthetic fixture '+n+'\n%%EOF');const fileHash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
 return {fileName:'synthetic.pdf',originalFileName:'synthetic.pdf',pdf:new Blob([bytes],{type:'application/pdf'}),fileHash,pages:1,warningsAcknowledged:true,employerId,form:{job:'main',kind:'salary',targetMonth:month,paymentDate:'2027-01-27',gross:'10000',net:'10000',transportation:'',healthInsurance:''}};
}
async function edit(ctx,id,changes){const current=await getRecordSummary(id);await updateRecordMetadata({...current,...changes(current)},[],recordSignature(current));await ctx.reopen();return await getRecordSummary(id);}
const verify=(ctx,record)=>inspectUploadRecovery(ctx.vault,[uploadRecoveryAttempt(record)],recordSignature);
{
 const ctx=await setup(),base=await sample(1,undefined);Object.assign(base,prepareOptionalZeros(base.form,{},true));
 assert.equal((await saveRecordsSkippingDuplicates([base])).saved,1);await ctx.reopen();const initial=ctx.vault.records()[0],id=initial.id,originalWrites=ctx.graph.writes.filter(x=>x.includes('/originals/')).length;
 let next=await edit(ctx,id,()=>({employerId:A}));assert.equal(next.employerId,A);assert.equal(next.revision,2);
 next=await edit(ctx,id,r=>{const form={...r.form,transportation:'5000'};return {employerId:B,form,zeroResolution:reconcilePayrollZeroResolution(r.zeroResolution,form)};});
 assert.equal(next.employerId,B);assert.equal(next.form.transportation,'5000');assert.deepEqual(next.zeroResolution.confirmedZeroFields,['healthInsurance']);
 next=await edit(ctx,id,r=>{const form={...r.form,healthInsurance:'1000',net:'9000'};return {employerId:undefined,form,zeroResolution:reconcilePayrollZeroResolution(r.zeroResolution,form)};});
 assert.ok(!Object.hasOwn(next,'employerId'));assert.deepEqual(next.zeroResolution.confirmedZeroFields,[]);assert.ok(!Object.hasOwn(next.zeroResolution,'approvedAt'));assert.deepEqual(next.zeroResolution.missingAtImport,initial.zeroResolution.missingAtImport);
 assert.equal(next.revision,4);assert.equal(ctx.graph.writes.filter(x=>x.includes('/originals/')).length,originalWrites);assert.equal((await ctx.vault.original(ctx.vault.records()[0])).size,base.pdf.size);
 const income=await decryptJson('income',ctx.graph.files.get('payroll/income/2027.enc').text,ctx.key);assert.ok(!Object.hasOwn(income.records[0],'employerId'));
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS P1/P3: set/change/clear persisted after fresh vault unlock; zero approvals and original evidence reconciled; Finance payment year verified');
}
{
 const ctx=await setup(),a=await sample(2,A),b=await sample(3,B);assert.equal((await saveRecordsSkippingDuplicates([a,b])).saved,2);await ctx.reopen();assert.equal(ctx.vault.records().length,2);
 const same=await sample(4,A);assert.equal((await saveRecordsSkippingDuplicates([same])).skipped[0].reason,'saved-period');
 assert.equal((await saveRecordsSkippingDuplicates([{...a,form:{...a.form,targetMonth:'2027-01'}}])).skipped[0].reason,'saved-pdf');
 const legacy=await sample(5,undefined);let n=ctx.graph.writes.length;await assert.rejects(saveRecordsSkippingDuplicates([legacy]),/勤務先/);assert.equal(ctx.graph.writes.length,n);
 console.log('PASS P2: explicit distinct employers coexist; same employer/hash skip; mixed legacy identity stops without writes');
}
{
 const ctx=await setup(),a=await sample(6,A);ctx.graph.fault=p=>p.includes('/statements/');await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 let report=await verify(ctx,a);assert.equal(report.detached,1);assert.equal(report.saved,0);assert.equal(report.originalsVerified,1);assert.throws(()=>requireSafeUploadRecovery(report),/未参照原本/);
 const n=ctx.graph.writes.length;await assert.rejects(saveRecordsSkippingDuplicates([a]),/未参照原本/);assert.equal(ctx.graph.writes.length,n);
 assert.equal((await saveRecordsSkippingDuplicates([await sample(7,A)])).saved,1);
 console.log('PASS P4: fresh page/vault cannot duplicate detached original; unrelated same-month PDF allowed');
}
{
 const ctx=await setup(),a=await sample(8,A);ctx.graph.fault=p=>p.includes('/income/');await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 const report=await verify(ctx,a);assert.equal(report.saved,1);assert.equal(report.originalsVerified,1);assert.deepEqual(report.incomeUnsyncedYears,['2027']);const n=ctx.graph.writes.length;await assert.rejects(saveRecordsSkippingDuplicates([a]),/未同期/);assert.equal(ctx.graph.writes.length,n);
 await ctx.vault.syncIncome();await ctx.reopen();assert.deepEqual((await verify(ctx,a)).incomeUnsyncedYears,[]);assert.equal((await saveRecordsSkippingDuplicates([a])).skipped[0].reason,'saved-pdf');
 const wrong=await verify(ctx,{...a,form:{...a.form,targetMonth:'2027-01'}});assert.equal(wrong.saved,0);
 console.log('PASS P5: income-only failure detected after reload; explicit sync repairs; mismatched period is not counted as saved');
}
{
 const ctx=await setup(),a=await sample(9,A);await saveRecordsSkippingDuplicates([a]);const old=await getRecordSummary(ctx.vault.records()[0].id);
 ctx.graph.discard=(p,prior)=>Boolean(prior&&p.includes('/statements/'));await assert.rejects(updateRecordMetadata({...old,employerId:B},[],recordSignature(old)),/保存結果が一致/);await ctx.reopen();assert.equal((await getRecordSummary(old.id)).employerId,A);
 await assert.rejects(ctx.vault.remove(old.id),/保存結果が一致/);await ctx.reopen();assert.equal(ctx.vault.records().length,1);
 console.log('PASS P6: read-back containing old data or undeleted ID cannot be reported successful');
}
{
 const make=()=>{let state={clientId:'client-a',accountId:'account-a',authEpoch:'auth-a',lockEpoch:'lock-a'};const guard=bindPayrollGraphIdentity(()=>state);return {guard,switch(){state={...state,accountId:'account-b'};},lock(){state={...state,lockEpoch:'lock-b'};}};};
 const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
 const a=make(),token=deferred();let sent=0;const g=new PayrollGraph(()=>token.promise,async()=>{sent++;return Response.json({});},()=>{},undefined,a.guard);const pending=g.request('/synthetic');a.switch();token.resolve('synthetic-token');await assert.rejects(pending,MicrosoftSignInRequiredError);assert.equal(sent,0);
 const b=make(),refresh=deferred(),entered=deferred();let reads=0;const h=new PayrollGraph('synthetic-token',async()=>{reads++;return new Response(null,{status:401});},()=>{},{invalidate:()=>{},refresh:()=>{entered.resolve();return refresh.promise;}},b.guard);const recovery=h.request('/synthetic');await entered.promise;b.lock();refresh.resolve('synthetic-refresh');await assert.rejects(recovery,MicrosoftSignInRequiredError);assert.equal(reads,1);
 const c=make();let chunks=0;const u=new PayrollGraph('synthetic-token',async(_url,init)=>{if(init.method==='POST')return Response.json({uploadUrl:'https://synthetic.invalid/upload'});chunks++;c.lock();return new Response(null,{status:202});},()=>{},undefined,c.guard);u.folder=async()=> 'folder';await assert.rejects(u.write(['payroll'],'sample.enc','x'.repeat(4000000),{id:'file',etag:'old'},5000000),MicrosoftSignInRequiredError);assert.equal(chunks,1);
 console.log('PASS P7: deferred token, 401 refresh and signed upload are stopped at changed identity/lock boundaries');
}

{
 const ctx=await setup();
 const a=await sample(21,A),b=await sample(22,B),c=await sample(23,A,'2027-04');
 c.form.paymentDate='2027-04-27';
 await saveRecordsSkippingDuplicates([a,b,c]);await ctx.reopen();
 const targets=ctx.vault.records().map(r=>({id:r.id,signature:recordSignature(r)}));
 const n=ctx.graph.writes.length;
 await assert.rejects(deleteRecords([targets[0],{...targets[1],signature:'stale'}]),/変更/);
 await assert.rejects(deleteRecords([targets[0],targets[0]]),/不正/);
 assert.equal(ctx.graph.writes.length,n,'all targets validated before any write');
 await deleteRecords(targets);await ctx.reopen();
 assert.equal(ctx.vault.records().length,0);
 const writes=ctx.graph.writes.slice(n);
 assert.equal(writes.filter(p=>p.includes('/statements/')).length,2,'one conditional write per affected annual shard');
 assert.equal(writes.filter(p=>p.includes('/income/')).length,1,'one income write per affected payment year');
 assert.equal(writes.filter(p=>p.includes('/originals/')).length,0);
 assert.equal([...ctx.graph.files.keys()].filter(p=>p.includes('/originals/')).length,0,'selected originals trashed after sync');
 assert.equal(ctx.graph.trashed.length,3);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS deletion batch: preflight all targets, two annual shards, one payment year, selected originals trashed');
}
{
 const ctx=await setup(),a=await sample(24,A),b=await sample(25,A,'2027-04');b.form.paymentDate='2027-04-27';
 await saveRecordsSkippingDuplicates([a,b]);await ctx.reopen();
 const targets=ctx.vault.records().sort((x,y)=>x.form.targetMonth.localeCompare(y.form.targetMonth)).map(r=>({id:r.id,signature:recordSignature(r)}));
 ctx.graph.fault=p=>p.endsWith('/statements/2027.enc');
 await assert.rejects(deleteRecords(targets),/一部確定/);ctx.graph.fault=undefined;await ctx.reopen();
 assert.deepEqual(ctx.vault.records().map(r=>r.id),[targets[1].id]);assert.equal(ctx.graph.trashed.length,0);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),['2027']);
 const n=ctx.graph.writes.length;await assert.rejects(deleteRecords(targets),/変更/);assert.equal(ctx.graph.writes.length,n,'uncertain batch cannot be blindly repeated');
 await ctx.vault.syncIncome();assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS deletion batch: interrupted second annual write, no blind replay, explicit Finance recovery');
}
{
 const ctx=await setup(),a=await sample(26,A);await saveRecordsSkippingDuplicates([a]);await ctx.reopen();
 const targets=ctx.vault.records().map(r=>({id:r.id,signature:recordSignature(r)}));ctx.graph.fault=p=>p.includes('/income/');
 await assert.rejects(deleteRecords(targets),error=>error.name==='PayrollPartialSuccessError'&&error.stage==='income-sync');
 ctx.graph.fault=undefined;await ctx.reopen();assert.equal(ctx.vault.records().length,0);assert.equal(ctx.graph.trashed.length,0);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),['2027']);
 const report=await ctx.vault.inspectDetachedOriginals();
 await assert.rejects(ctx.vault.trashDetachedOriginal(report,report.originals[0]),/未同期/);assert.equal(ctx.graph.trashed.length,0);
 await ctx.vault.syncIncome();const fresh=await ctx.vault.inspectDetachedOriginals();await ctx.vault.trashDetachedOriginal(fresh,fresh.originals[0]);assert.equal(ctx.graph.trashed.length,1);
 console.log('PASS deletion batch: exact partial success when income publication fails; explicit recovery requires sync');
}

{
 const ctx=await setup();await saveRecordsSkippingDuplicates([await sample(31,A),await sample(32,B)]);await ctx.reopen();
 const targets=ctx.vault.records().map(r=>({id:r.id,signature:recordSignature(r)}));
 // A separate detached object, from an interrupted upload, must not be touched.
 const originals=[...ctx.graph.files].filter(([p])=>p.includes('/originals/'));
 const unrelated=originals[0][0].replace(/[^/]+$/,crypto.randomUUID()+'.enc');ctx.graph.files.set(unrelated,{...originals[0][1],id:unrelated});
 ctx.graph.trashFault=()=>ctx.graph.trashed.length===1;
 await assert.rejects(deleteRecords(targets),e=>e.name==='PayrollPartialSuccessError'&&e.stage==='original-trash');
 assert.equal(ctx.graph.trashed.length,1);assert.ok(ctx.graph.files.has(unrelated));
 ctx.graph.trashFault=undefined;await ctx.reopen();assert.equal(ctx.vault.records().length,0);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 const report=await ctx.vault.inspectDetachedOriginals();assert.equal(report.originals.length,2);
 const remaining=report.originals.find(item=>item.id!==unrelated);assert.ok(remaining);
 await ctx.vault.trashDetachedOriginal(report,remaining);assert.ok(ctx.graph.files.has(unrelated));
 console.log('PASS original trash: partial failure, restart, explicit recovery, unrelated orphan retained');
}
{
 const ctx=await setup();await saveRecordsSkippingDuplicates([await sample(33,A),await sample(34,B)]);await ctx.reopen();
 const path='payroll/statements/2026.enc',file=ctx.graph.files.get(path),doc=await decryptJson('year',file.text,ctx.key);
 const [a,b]=doc.records;const discardedPath=[...ctx.graph.files.keys()].find(p=>p.endsWith(b.originalId+'.enc'));
 Object.assign(b,{originalId:a.originalId,originalMonth:a.originalMonth,pdfSize:a.pdfSize,fileHash:a.fileHash});
 await ctx.graph.write(['payroll','statements'],'2026.enc',await encryptJson('year',doc,ctx.key,ctx.vault.sessionKey().salt),file,30000000);
 await ctx.reopen();await ctx.vault.syncIncome();
 const live=ctx.vault.records().find(r=>r.id===a.id);
 await deleteRecords([{id:live.id,signature:recordSignature(live)}]);await ctx.reopen();
 assert.equal(ctx.vault.records().length,1);assert.equal(ctx.graph.trashed.length,0);assert.ok(ctx.graph.files.has(discardedPath));
 assert.ok((await ctx.vault.original(ctx.vault.records()[0])).size>0);
 console.log('PASS original trash: shared reference retained, unrelated orphan untouched');
}
{
 const ctx=await setup();await saveRecordsSkippingDuplicates([await sample(35,A)]);await ctx.reopen();
 const target=ctx.vault.records()[0];const key=[...ctx.graph.files.keys()].find(p=>p.includes('/originals/'));
 ctx.graph.beforeTrash=()=>{const item=ctx.graph.files.get('payroll/income/2027.enc');ctx.graph.files.set('payroll/income/2027.enc',{...item,text:'synthetic damaged income',etag:'changed'});};
 await assert.rejects(deleteRecords([{id:target.id,signature:recordSignature(target)}]),e=>e.stage==='original-trash');
 assert.equal(ctx.graph.trashed.length,0);assert.ok(ctx.graph.files.has(key));
 console.log('PASS original trash: income changes immediately before DELETE block trash');
}
{
 const ctx=await setup();await saveRecordsSkippingDuplicates([await sample(36,A)]);await ctx.reopen();
 const target=ctx.vault.records()[0];const key=[...ctx.graph.files.keys()].find(p=>p.includes('/originals/'));
 const file=ctx.graph.files.get(key);ctx.graph.files.set(key,{...file,text:'synthetic corrupt original'});
 const n=ctx.graph.writes.length;await assert.rejects(deleteRecords([{id:target.id,signature:recordSignature(target)}]));
 assert.equal(ctx.graph.writes.length,n);assert.equal(ctx.graph.trashed.length,0);await ctx.reopen();assert.equal(ctx.vault.records().length,1);
 console.log('PASS original trash: invalid original blocks before metadata mutation');
}
{
 const ctx=await setup();await saveRecordsSkippingDuplicates([await sample(37,A)]);await ctx.reopen();
 const target=ctx.vault.records()[0];const key=[...ctx.graph.files.keys()].find(p=>p.includes('/originals/'));
 ctx.graph.beforeTrash=()=>{const item=ctx.graph.files.get('payroll/statements/2026.enc');ctx.graph.files.set('payroll/statements/2025.enc',{...item,id:'synthetic orphan annual'});};
 await assert.rejects(deleteRecords([{id:target.id,signature:recordSignature(target)}]),e=>e.stage==='original-trash');
 assert.equal(ctx.graph.trashed.length,0);assert.ok(ctx.graph.files.has(key));
 console.log('PASS original trash: newly appearing orphan annual blocks DELETE');
}
{
 // Real Graph mutation wrapper: authorization guard runs after token acquisition,
 // DELETE is conditional and never replayed, and absence is checked afterwards.
 const item={id:'synthetic-original',name:crypto.randomUUID()+'.enc',etag:'synthetic-etag',size:20,folder:false};
 const path=['payroll','originals','2026','11'];let calls=0,guarded=0,missing=false,fail=false;
 const g=new PayrollGraph(async()=> 'synthetic-token',async(_url,init)=>{
  calls++;assert.equal(guarded,1);assert.equal(init.method,'DELETE');assert.equal(init.headers['If-Match'],item.etag);
  if(fail)return new Response(null,{status:503});missing=true;return new Response(null,{status:204});
 });
 g.listFolder=async()=>[item];g.metadata=async()=>missing?null:{id:item.id,etag:item.etag};
 await assert.rejects(g.trashPayrollOriginal(path,item,async()=>{throw new Error('synthetic stale source');}),/stale source/);assert.equal(calls,0);
 fail=true;await assert.rejects(g.trashPayrollOriginal(path,item,async()=>{guarded++;}),/503/);assert.equal(calls,1);
 guarded=0;fail=false;await g.trashPayrollOriginal(path,item,async()=>{guarded++;});assert.equal(calls,2);
 console.log('PASS original trash: conditional Graph DELETE, final guard, no mutation retry, readback');
}

{
 const ctx=await setup(),a=await sample(41,A),b=await sample(42,B),c=await sample(43,A,'2027-04');
 await saveRecordsSkippingDuplicates([a]);await ctx.reopen();const live=ctx.vault.records()[0];
 const toBackup=(r,id)=>({...r,id,savedAt:'2026-11-24T00:00:00Z',revision:3});
 const backup=[toBackup(a,1001),toBackup(b,1002),toBackup(c,1003),toBackup(await sample(44,A),1004),toBackup(await sample(45,B,'2027-06'),live.id)];
 const existingDirectory=[{id:A,name:'Synthetic current',role:'main',current:true}];
 await ctx.vault.writeEmployerDirectory([],existingDirectory);
 const directory=[{id:A,name:'Synthetic old name',role:'main',current:true},{id:B,name:'Synthetic other',role:'main',current:false}];
 const n=ctx.graph.writes.length;const plan=await inspectAdditiveRestore(backup,directory);
 assert.equal(plan.add,2);assert.equal(plan.samePdf,1);assert.equal(plan.samePeriod,1);assert.equal(plan.sameId,1);assert.equal(plan.employersAdded,1);assert.equal(ctx.graph.writes.length,n);
 await assert.rejects(restoreAdditiveRecords(backup,plan.signature,directory,()=>false),/認証/);assert.equal(ctx.graph.writes.length,n);
 const result=await restoreAdditiveRecords(backup,plan.signature,directory);assert.equal(result.add,2);await ctx.reopen();
 assert.equal(ctx.vault.records().length,3);assert.equal(recordSignature(ctx.vault.records().find(r=>r.id===live.id)),recordSignature(live));
 assert.equal((await ctx.vault.readEmployerDirectory()).find(r=>r.id===A).name,'Synthetic current');
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 const retry=await inspectAdditiveRestore(backup,directory);assert.equal(retry.add,0);assert.equal(retry.samePdf,3);
 const writes=ctx.graph.writes.length;await restoreAdditiveRecords(backup,retry.signature,directory);assert.equal(ctx.graph.writes.length,writes);
 console.log('PASS additive restore: existing metadata, ID, PDF and period conflict; directory merge, readback, no writes on replay');
}
{
 const ctx=await setup(),a=await sample(46,A),b=await sample(47,B,'2027-04');
 const backup=[{...a,id:101,savedAt:'2026-11-24T00:00:00Z'},{...b,id:102,savedAt:'2026-11-24T00:00:00Z'}];
 const plan=await inspectAdditiveRestore(backup);assert.equal(plan.add,2);
 ctx.graph.fault=p=>p.includes('/statements/2027.enc');await assert.rejects(restoreAdditiveRecords(backup,plan.signature));ctx.graph.fault=undefined;await ctx.reopen();
 assert.equal(ctx.vault.records().length,1);const n=ctx.graph.writes.length;
 await assert.rejects(inspectAdditiveRestore(backup),/未参照原本|未同期/);assert.equal(ctx.graph.writes.length,n);
 await ctx.vault.syncIncome();const detached=await ctx.vault.inspectDetachedOriginals();assert.equal(detached.originals.length,1);await ctx.vault.trashDetachedOriginal(detached,detached.originals[0]);
 const retry=await inspectAdditiveRestore(backup);assert.equal(retry.add,1);assert.equal(retry.samePdf,1);
 await restoreAdditiveRecords(backup,retry.signature);await ctx.reopen();assert.equal(ctx.vault.records().length,2);
 console.log('PASS additive restore: partial annual failure, blocked repeat, manual recovery and safe resume');
}
{
 const ctx=await setup(),a=await sample(48,A),b=await sample(49,A),c=await sample(50,undefined);
 const backup=[a,b,c].map((r,i)=>({...r,id:100+i,savedAt:'2026-11-24T00:00:00Z'}));
 const plan=await inspectAdditiveRestore(backup);assert.equal(plan.add,0);assert.equal(plan.backupConflict,3);
 const valid=[{...await sample(51,A,'2027-04'),id:300,savedAt:'2026-11-24T00:00:00Z'}];
 const approved=await inspectAdditiveRestore(valid);await saveRecordsSkippingDuplicates([await sample(52,B,'2027-05')]);const n=ctx.graph.writes.length;
 await assert.rejects(restoreAdditiveRecords(valid,approved.signature),/対象が変更/);assert.equal(ctx.graph.writes.length,n);
 console.log('PASS additive restore: ambiguous backup conflict excluded, stale approval rejected before mutation');
}

{
 const ctx=await setup(),a=await sample(53,A),b=await sample(54,A,'2027-04');
 const old={...a,id:600,savedAt:'2026-11-24T00:00:00Z'};delete old.fileHash;
 await ctx.vault.save(old);await ctx.reopen();
 const backup=[{...old,id:601,form:{...old.form,targetMonth:'2027-05'}},{...b,id:602,savedAt:old.savedAt}];delete backup[1].fileHash;
 const plan=await inspectAdditiveRestore(backup);assert.equal(plan.samePdf,1);assert.equal(plan.add,1);
 await restoreAdditiveRecords(backup,plan.signature);await ctx.reopen();
 assert.equal(ctx.vault.records().length,2);assert.equal(ctx.vault.records().find(r=>r.id===600).fileHash,undefined);
 assert.equal(ctx.vault.records().find(r=>r.id!==600).fileHash,b.fileHash);
 console.log('PASS additive restore: actual legacy original hash across different target months and legacy backup hash reconstruction');
}
{
 const ctx=await setup(),a=await sample(55,A),b=await sample(56,B,'2027-04');await saveRecordsSkippingDuplicates([a]);await ctx.reopen();
 const backup=[{...b,id:777,savedAt:'2026-11-24T00:00:00Z'}];const plan=await inspectAdditiveRestore(backup);
 const path='payroll/statements/2026.enc',file=ctx.graph.files.get(path),doc=await decryptJson('year',file.text,ctx.key);doc.records[0].fileName='synthetic-concurrent.pdf';
 const ciphertext=await encryptJson('year',doc,ctx.key,ctx.vault.sessionKey().salt);
 ctx.graph.fault=p=>{if(p.includes('/originals/')){ctx.graph.files.set(path,{...file,text:ciphertext,size:enc.encode(ciphertext).length,etag:'concurrent-change'});ctx.graph.fault=undefined;}return false;};
 const n=ctx.graph.writes.length;await assert.rejects(restoreAdditiveRecords(backup,plan.signature),/変更されました/);
 assert.ok(!ctx.graph.writes.slice(n).some(p=>p.includes('/statements/')));await ctx.reopen();assert.equal(ctx.vault.records().length,1);assert.equal(ctx.vault.records()[0].fileName,'synthetic-concurrent.pdf');
 console.log('PASS additive restore: concurrent change during original upload blocks annual writes');
}

// Integrated audit fixes: use real storage APIs, not mocked control flow.
{
 const ctx=await setup(),a=await sample(100,undefined,'2026-10');
 await ctx.vault.save({...a,fileHash:undefined,id:123,savedAt:'2026-11-01T00:00:00.000Z',revision:1});await ctx.reopen();
 const n=ctx.graph.writes.length;
 const result=await saveRecordsSkippingDuplicates([{...a,employerId:A,form:{...a.form,targetMonth:'2026-11',paymentDate:'2026-11-27'}}]);
 assert.equal(result.saved,0);assert.equal(result.skipped[0].reason,'saved-pdf');assert.equal(ctx.graph.writes.length,n);
 assert.equal(ctx.vault.records().length,1);assert.equal(ctx.vault.records()[0].fileHash,undefined);
 console.log('PASS A1: actual legacy PDF hash blocks cross-month duplicate without metadata mutation');
}
{
 const ctx=await setup(),a=await sample(101,A,'2026-10');ctx.graph.fault=p=>p.includes('/statements/');await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 const corrected={...a,form:{...a.form,targetMonth:'2027-04',paymentDate:'2027-04-27'}};
 const n=ctx.graph.writes.length;await assert.rejects(saveRecordsSkippingDuplicates([corrected]),/未参照原本/);assert.equal(ctx.graph.writes.length,n);
 const report=await verify(ctx,corrected);assert.equal(report.detached,1);assert.equal(report.saved,0);assert.equal(report.originalsVerified,1);
 await assert.rejects(inspectAdditiveRestore([{...corrected,id:124,savedAt:'2026-11-01T00:00:00.000Z',revision:1}]),/未参照原本/);
 console.log('PASS A1: detached PDF detected even across fiscal years in ordinary and additive restore');
}
async function replacementFixture(){
 const ctx=await setup(),a=await sample(102,A,'2026-10'),b=await sample(103,B,'2027-04');
 await saveRecordsSkippingDuplicates([a,b]);await ctx.reopen();
 const keep=ctx.vault.records().find(r=>r.form.targetMonth==='2026-10'),drop=ctx.vault.records().find(r=>r.form.targetMonth==='2027-04');
 const {originalId,originalMonth,pdfSize,pdfType,...summary}=keep;
 const backup={...summary,pdf:a.pdf,form:{...keep.form,gross:'12000',net:'12000'}};
 return {ctx,keep,drop,backup,baseline:await inspectReplacementRestoreBaseline()};
}
{
 const {ctx,drop,backup,baseline}=await replacementFixture();
 const save=ctx.vault.save.bind(ctx.vault);
 ctx.vault.save=async(...args)=>{await save(...args);const other=new PayrollVault(ctx.graph);const {key,salt}=ctx.vault.sessionKey();await other.unlockWithKey(key,salt);await other.refresh({forceFresh:true});const current=other.records().find(r=>r.id===drop.id);await other.save({...current,form:{...current.form,gross:'15000',net:'15000'},revision:(current.revision??0)+1},undefined,()=>true);};
 await assert.rejects(replaceAllRecords([backup],baseline),/変更されました/);await ctx.reopen();
 assert.equal(ctx.vault.records().find(r=>r.id===drop.id).form.gross,'15000');assert.equal(ctx.graph.trashed.length,0);
 console.log('PASS A1: concurrent edit to planned removal after first restore write survives');
}
{
 const {ctx,keep,drop,backup,baseline}=await replacementFixture();
 await replaceAllRecords([backup],baseline);await ctx.reopen();
 assert.deepEqual(ctx.vault.records().map(r=>r.id),[keep.id]);assert.equal(ctx.vault.records()[0].form.gross,'12000');
 assert.equal(ctx.vault.records()[0].originalId,keep.originalId);assert.equal(ctx.graph.trashed.length,1);
 assert.ok(ctx.graph.trashed.some(p=>p.endsWith(drop.originalId+'.enc')));
 assert.ok(!(await ctx.vault.inspectDetachedOriginals()).originals.some(r=>r.uuid===drop.originalId));
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS A1: successful exact replacement preserves kept originals, trashes excluded originals and verifies Finance');
}
{
 const {ctx,backup,baseline}=await replacementFixture();
 await ctx.vault.writeEmployerDirectory([], [{id:A,name:'架空の勤務先',role:'main',current:true}]);
 let n=ctx.graph.writes.length;await assert.rejects(replaceAllRecords([backup],baseline),/変更されました/);assert.equal(ctx.graph.writes.length,n);
 const next=await inspectReplacementRestoreBaseline();await assert.rejects(replaceAllRecords([backup],next,undefined,()=>false),/認証状態/);assert.equal(ctx.graph.writes.length,n);
 const fresh={...backup,id:234,fileHash:'a'.repeat(64)};await assert.rejects(replaceAllRecords([fresh],next),/ハッシュ/);assert.equal(ctx.graph.writes.length,n);
 console.log('PASS A1: stale employer directory, auth and invalid new-ID hash fail before any write');
}
{
 const {ctx,keep,drop,backup,baseline}=await replacementFixture();
 const moved={...backup,form:{...backup.form,targetMonth:'2028-04',paymentDate:'2028-04-27'}};
 const added={...await sample(104,A,'2027-06'),id:234,savedAt:'2026-11-01T00:00:00.000Z',revision:1};
 await replaceAllRecords([moved,added],baseline);await ctx.reopen();
 assert.equal(ctx.vault.records().length,2);const actual=ctx.vault.records().find(r=>r.id===keep.id);
 assert.equal(actual.originalId,keep.originalId);assert.equal(actual.originalMonth,keep.originalMonth);assert.equal(actual.form.targetMonth,'2028-04');
 assert.equal(ctx.vault.records().find(r=>r.id===234).fileHash,added.fileHash);
 assert.ok(ctx.graph.trashed.some(p=>p.endsWith(drop.originalId+'.enc')));
 assert.ok(!(await ctx.vault.inspectDetachedOriginals()).originals.some(r=>r.uuid===drop.originalId));
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027','2028'])),[]);
 console.log('PASS A1: whole restore fiscal-year move, new ID, removed ID and both payment years verified');
}
{
 const ctx=await setup(),a=await sample(105,A,'2026-10'),b=await sample(106,A,'2026-11');await saveRecordsSkippingDuplicates([a]);await ctx.reopen();
 const path='payroll/statements/2026.enc',file=ctx.graph.files.get(path),doc=await decryptJson('year',file.text,ctx.key);doc.records[0].fileHash=undefined;
 const ciphertext=await encryptJson('year',doc,ctx.key,ctx.vault.sessionKey().salt);
 ctx.graph.fault=p=>{if(p.includes('/originals/')){ctx.graph.files.set(path,{...file,text:ciphertext,size:enc.encode(ciphertext).length,etag:'concurrent-legacy-change'});ctx.graph.fault=undefined;}return false;};
 const n=ctx.graph.writes.length;await assert.rejects(saveRecordsSkippingDuplicates([b]),/変更されました/);assert.ok(!ctx.graph.writes.slice(n).some(p=>p.includes('/statements/')));await ctx.reopen();assert.equal(ctx.vault.records().length,1);
 console.log('PASS A1: ordinary upload checks approved source after original transfer, including new legacy hash state');
}

// Phase 5-A2: same safety path for duplicate cleanup and full replacement.
{
 const {ctx,keep,drop}=await replacementFixture();
 const changed={...keep,form:{...keep.form,targetMonth:drop.form.targetMonth,paymentDate:drop.form.paymentDate},employerId:drop.employerId};
 await updateRecordMetadata(changed,[{id:drop.id,signature:recordSignature(drop)}],recordSignature(keep));await ctx.reopen();
 assert.deepEqual(ctx.vault.records().map(r=>r.id),[keep.id]);assert.equal(ctx.graph.trashed.length,1);assert.ok(ctx.graph.trashed[0].endsWith(drop.originalId+'.enc'));
 assert.ok((await ctx.vault.original(ctx.vault.records()[0])).size>0);
 console.log('PASS A2: duplicate cleanup uses verified original trash and retains the edited original');
}
{
 const {ctx,drop,backup,baseline}=await replacementFixture();
 ctx.graph.trashFault=()=>true;
 await assert.rejects(replaceAllRecords([backup],baseline),e=>e.stage==='original-trash');await ctx.reopen();
 assert.equal(ctx.vault.records().length,1);assert.ok((await ctx.vault.inspectDetachedOriginals()).originals.some(r=>r.uuid===drop.originalId));
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS A2: replacement partial trash failure preserves detached original, no repeated deletion');
}
{
 const ctx=await setup();const directory=[{id:A,name:'Synthetic current',role:'main',current:true},{id:B,name:'Synthetic side',role:'side',current:true}];
 await ctx.vault.writeEmployerDirectory([],directory);
 await saveRecordsSkippingDuplicates([await sample(61,A)]);await ctx.reopen();
 const view=ctx.vault.dashboardEmployerDirectory();assert.deepEqual(view,directory);view[0].name='Synthetic local mutation';assert.deepEqual(ctx.vault.dashboardEmployerDirectory(),directory);
 const old=await getRecordSummary(ctx.vault.records()[0].id),signature=recordSignature(old),dir=JSON.stringify(directory),changed={...old,form:{...old.form,job:'side'}};
 const before=ctx.graph.writes.length;
 await assert.rejects(updateRecordMetadata(changed,[],signature,undefined,dir),/勤務区分/);assert.equal(ctx.graph.writes.length,before);
 await assert.rejects(updateRecordMetadata(changed,[],signature),/勤務区分/);assert.equal(ctx.graph.writes.length,before);
 await assert.rejects(updateRecordMetadata({...changed,employerId:B},[],signature,undefined,'[]'),/勤務先一覧/);assert.equal(ctx.graph.writes.length,before);
 await updateRecordMetadata({...changed,employerId:B},[],signature,undefined,dir);await ctx.reopen();
 const actual=await getRecordSummary(old.id);assert.equal(actual.employerId,B);assert.equal(actual.form.job,'side');assert.equal(actual.pdfSize,old.pdfSize);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS: dashboard directory is a detached view; edit role mismatch and stale directory reject without writes; explicit new role persists with Finance sync');
}

// Phase 5-B2: actual encrypted annual writes, metadata-only, no original mutations.
async function assignmentFixture(){
 const ctx=await setup(),dir=[{id:A,name:'Synthetic main',role:'main',current:true},{id:B,name:'Synthetic side',role:'side',current:true}];
 await ctx.vault.writeEmployerDirectory([],dir);
 await saveRecordsSkippingDuplicates([await sample(701,undefined,'2026-10'),await sample(702,undefined,'2026-11'),await sample(703,undefined,'2027-04')]);await ctx.reopen();
 const original=ctx.vault.records(),targets=original.map(r=>({id:r.id,signature:recordSignature(r)})),signature=JSON.stringify(dir);
 return {ctx,dir,original,targets,signature};
}
{
 const {ctx,original,targets,signature}=await assignmentFixture(),before=ctx.graph.writes.length;
 const plan=await inspectEmployerAssignment(targets,A,signature,()=>true);assert.equal(plan.count,3);assert.equal(ctx.graph.writes.length,before);
 await assert.rejects(assignEmployers(targets,B,signature,plan.signature,()=>true),/変更/);assert.equal(ctx.graph.writes.length,before);
 await assert.rejects(assignEmployers(targets,A,signature,plan.signature,()=>false),/認証/);assert.equal(ctx.graph.writes.length,before);
 await assignEmployers(targets,A,signature,plan.signature,()=>true);await ctx.reopen();
 for(const r of ctx.vault.records()){const prior=original.find(x=>x.id===r.id);assert.deepEqual(r,{...prior,employerId:A,revision:(prior.revision??0)+1});}
 assert.equal(ctx.graph.writes.slice(before).filter(x=>x.includes('/statements/')).length,2);
 assert.equal(ctx.graph.writes.slice(before).filter(x=>x.includes('/income/')).length,1);
 assert.ok(!ctx.graph.writes.slice(before).some(x=>x.includes('/originals/')));assert.equal(ctx.graph.trashed.length,0);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 await assert.rejects(inspectEmployerAssignment(targets,A,signature,()=>true),/変更/);
 console.log('PASS B2: three metadata-only assignments across two fiscal years, one Finance payment-year write, originals and amounts unchanged');
}
{
 const {ctx,targets,signature}=await assignmentFixture();const plan=await inspectEmployerAssignment(targets,A,signature,()=>true);
 const other=ctx.vault.records()[0];await ctx.vault.save({...other,form:{...other.form,gross:'12000',net:'12000'},revision:(other.revision??0)+1},undefined,()=>true);
 const before=ctx.graph.writes.length;await assert.rejects(assignEmployers(targets,A,signature,plan.signature,()=>true),/変更/);assert.equal(ctx.graph.writes.length,before);
 console.log('PASS B2: stale selection refused without writing');
}
{
 const {ctx,dir,targets,signature}=await assignmentFixture();const plan=await inspectEmployerAssignment(targets,A,signature,()=>true);
 await ctx.vault.writeEmployerDirectory(dir,dir.map(x=>x.id===A?{...x,name:'Synthetic renamed'}:x));
 const before=ctx.graph.writes.length;await assert.rejects(assignEmployers(targets,A,signature,plan.signature,()=>true),/勤務先一覧/);assert.equal(ctx.graph.writes.length,before);
 console.log('PASS B2: directory changes invalidate consent');
}
{
 const {ctx,targets,signature}=await assignmentFixture(),plan=await inspectEmployerAssignment(targets,A,signature,()=>true);
 let writes=0;ctx.graph.fault=p=>p.includes('/statements/')&&++writes===2;
 await assert.rejects(assignEmployers(targets,A,signature,plan.signature,()=>true),e=>e.stage==='employer-assignment');ctx.graph.fault=undefined;await ctx.reopen();
 const records=ctx.vault.records(),remaining=records.filter(r=>!r.employerId);assert.ok(remaining.length>0&&remaining.length<3);
 const before=ctx.graph.writes.length;await assert.rejects(assignEmployers(targets,A,signature,plan.signature,()=>true),/変更/);assert.equal(ctx.graph.writes.length,before);
 const nextTargets=remaining.map(r=>({id:r.id,signature:recordSignature(r)}));const next=await inspectEmployerAssignment(nextTargets,A,signature,()=>true);
 await assert.rejects(assignEmployers(nextTargets,A,signature,next.signature,()=>true),/未同期/);assert.equal(ctx.graph.writes.length,before);
 await ctx.vault.syncIncome();
 await assignEmployers(nextTargets,A,signature,next.signature,()=>true);await ctx.reopen();assert.ok(ctx.vault.records().every(r=>r.employerId===A));assert.equal(ctx.graph.trashed.length,0);
 console.log('PASS B2: partial annual failure, no blind replay, explicit repair and remaining assignments');
}
{
 const {ctx,targets,signature}=await assignmentFixture();const first=ctx.vault.records()[0];
 const year=first.form.targetMonth<'2027-04'?'2026':'2027',path=`payroll/statements/${year}.enc`,file=ctx.graph.files.get(path),doc=await decryptJson('year',file.text,ctx.key);
 doc.records.push({...first,id:987654,employerId:A});const cipher=await encryptJson('year',doc,ctx.key,ctx.vault.sessionKey().salt);ctx.graph.files.set(path,{...file,text:cipher,size:enc.encode(cipher).length,etag:'synthetic-duplicate'});await ctx.reopen();
 const before=ctx.graph.writes.length;await assert.rejects(inspectEmployerAssignment(targets,A,signature,()=>true),/重複/);assert.equal(ctx.graph.writes.length,before);
 console.log('PASS B2: duplicate period blocked without deleting or modifying any statement');
}
