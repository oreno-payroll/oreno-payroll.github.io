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
 async withWriteLock(operation){return operation();}
 markUploadCheckpoint(){} // FakeGraph has no remote lock; real ownership is tested separately.
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
 async write(parts,name,text,prior,limit){const p=this.path(parts,name),old=this.files.get(p);if(prior?old?.etag!==prior.etag:!!old)throw new GraphError(412,'conflict');if(this.fault?.(p,old))throw new Error('synthetic write interruption');const size=enc.encode(text).length;assert.ok(size<=limit);this.writes.push(p);if(this.discard?.(p,old))return;const row={id:p,etag:'e'+(++this.revision),text,size};this.files.set(p,row);if(!prior)return {id:row.id,etag:row.etag,size,name};}
}
async function setup(){const graph=new FakeGraph();let vault=new PayrollVault(graph);await vault.unlock('synthetic-integrity-passphrase',true);const {key,salt}=vault.sessionKey();globalThis.__p1p7Vault=vault;return {graph,key,get vault(){return vault;},async reopen(){vault.lock();vault=new PayrollVault(graph);await vault.unlockWithKey(key,salt);await vault.refresh({forceFresh:true});globalThis.__p1p7Vault=vault;return vault;}};}
async function removeFixtureHash(ctx,id){
 const path='payroll/statements/2026.enc',file=ctx.graph.files.get(path),doc=await decryptJson('year',file.text,ctx.key);
 delete doc.records.find(r=>r.id===id).fileHash;
 await ctx.graph.write(['payroll','statements'],'2026.enc',await encryptJson('year',doc,ctx.key,ctx.vault.sessionKey().salt),file,30000000);
 await ctx.reopen();
}
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
 const originals=ctx.graph.writes.filter(p=>p.includes('/originals/')).length;
 assert.equal((await saveRecordsSkippingDuplicates([a])).saved,1);await ctx.reopen();
 assert.equal(ctx.graph.writes.filter(p=>p.includes('/originals/')).length,originals);
 assert.equal((await verify(ctx,a)).detached,0);assert.equal((await verify(ctx,a)).saved,1);
 console.log('PASS P4: fresh page/vault reuses authenticated detached original without duplicate PUT');
}
{
 const ctx=await setup(),a=await sample(106,A,'2026-10'),b=await sample(107,A,'2027-04');
 ctx.graph.fault=p=>p.includes('/statements/2027.enc');
 await assert.rejects(saveRecordsSkippingDuplicates([a,b]));ctx.graph.fault=undefined;await ctx.reopen();
 const report=await inspectUploadRecovery(ctx.vault,[a,b].map(uploadRecoveryAttempt),recordSignature);
 assert.equal(report.saved,1);assert.equal(report.detached,1);assert.deepEqual(report.incomeUnsyncedYears,['2027']);
 const originalWrites=ctx.graph.writes.filter(p=>p.includes('/originals/')).length;
 const prior=ctx.vault.records()[0],priorSignature=recordSignature(prior);
 const result=await saveRecordsSkippingDuplicates([a,b]);assert.equal(result.saved,1);assert.equal(result.skipped[0].reason,'saved-pdf');await ctx.reopen();
 assert.equal(ctx.graph.writes.filter(p=>p.includes('/originals/')).length,originalWrites);
 assert.equal(ctx.vault.records().length,2);assert.equal(recordSignature(ctx.vault.records().find(r=>r.id===prior.id)),priorSignature);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS partial ordinary upload: derived repair plus missing annual only, no PDF rewrite or confirmed-record overwrite');
}
{
 const ctx=await setup(),a=await sample(108,A);ctx.graph.fault=p=>p.includes('/statements/');
 await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 const [path,original]=[...ctx.graph.files].find(([p])=>p.includes('/originals/'));
 const duplicate=path.replace(/[^/]+\.enc$/,crypto.randomUUID()+'.enc');
 ctx.graph.files.set(duplicate,{...original,id:duplicate,etag:'duplicate-fixture'});
 const before=ctx.graph.writes.length;
 await assert.rejects(saveRecordsSkippingDuplicates([a]),/未参照原本が複数/);
 assert.equal(ctx.graph.writes.length,before);assert.equal(ctx.vault.records().length,0);
 console.log('PASS ambiguous duplicate detached originals: no arbitrary selection or write');
}
{
 const ctx=await setup(),a=await sample(8,A);ctx.graph.fault=p=>p.includes('/income/');await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 const report=await verify(ctx,a);assert.equal(report.saved,1);assert.equal(report.originalsVerified,1);assert.deepEqual(report.incomeUnsyncedYears,['2027']);const originals=ctx.graph.writes.filter(p=>p.includes('/originals/')||p.includes('/statements/')).length;
 assert.equal((await saveRecordsSkippingDuplicates([a])).skipped[0].reason,'saved-pdf');await ctx.reopen();
 assert.equal(ctx.graph.writes.filter(p=>p.includes('/originals/')||p.includes('/statements/')).length,originals);assert.deepEqual((await verify(ctx,a)).incomeUnsyncedYears,[]);
 const wrong=await verify(ctx,{...a,form:{...a.form,targetMonth:'2027-01'}});assert.equal(wrong.saved,0);
 console.log('PASS P5: income-only failure detected after reload; duplicate-only retry repairs; mismatched period is not counted as saved');
}
{
 const ctx=await setup(),a=await sample(208,A,'2026-10'),b=await sample(209,A,'2026-11');
 await saveRecordsSkippingDuplicates([a]);await ctx.reopen();
 const prior=ctx.vault.records()[0],signature=recordSignature(prior);
 ctx.graph.files.delete('payroll/income/2027.enc');
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),['2027']);
 assert.equal((await saveRecordsSkippingDuplicates([b])).saved,1);await ctx.reopen();
 assert.equal(ctx.vault.records().length,2);assert.equal(recordSignature(ctx.vault.records().find(r=>r.id===prior.id)),signature);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS ordinary upload with stale Finance: new payroll commits and derived income is repaired without editing old payroll');
}
{
 const ctx=await setup(),a=await sample(210,A,'2026-10');
 const originalRead=ctx.graph.read.bind(ctx.graph);ctx.graph.read=async(parts,name)=>{if(parts.at(-1)==='income')throw new Error('synthetic income read outage');return originalRead(parts,name);};
 const state={attempted:false,uncertain:false,completed:false,lock:'none'};
 await assert.rejects(saveRecordsSkippingDuplicates([a],undefined,state),error=>error.name==='PayrollPartialSuccessError'&&error.stage==='income-sync');
 assert.equal(state.payrollSaved,true);assert.equal(ctx.vault.records().length,1);
 ctx.graph.read=originalRead;await ctx.reopen();assert.equal((await verify(ctx,a)).saved,1);
 assert.equal((await saveRecordsSkippingDuplicates([a])).saved,0);assert.deepEqual((await verify(ctx,a)).incomeUnsyncedYears,[]);
 console.log('PASS Finance read outage does not prevent payroll commit; retry only syncs income');
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
 const a=make(),token=deferred();let sent=0;const g=new PayrollGraph(()=>token.promise,async()=>{sent++;return Response.json({});},()=>{},undefined,a.guard, false);const pending=g.request('/synthetic');a.switch();token.resolve('synthetic-token');await assert.rejects(pending,MicrosoftSignInRequiredError);assert.equal(sent,0);
 const b=make(),refresh=deferred(),entered=deferred();let reads=0;const h=new PayrollGraph('synthetic-token',async()=>{reads++;return new Response(null,{status:401});},()=>{},{invalidate:()=>{},refresh:()=>{entered.resolve();return refresh.promise;}},b.guard, false);const recovery=h.request('/synthetic');await entered.promise;b.lock();refresh.resolve('synthetic-refresh');await assert.rejects(recovery,MicrosoftSignInRequiredError);assert.equal(reads,1);
 const c=make();let chunks=0;const u=new PayrollGraph('synthetic-token',async(_url,init)=>{if(init.method==='POST')return Response.json({uploadUrl:'https://synthetic.invalid/upload'});chunks++;c.lock();return new Response(null,{status:202});},()=>{},undefined,c.guard, false);u.folder=async()=> 'folder';await assert.rejects(u.write(['payroll'],'sample.enc','x'.repeat(4000000),{id:'file',etag:'old'},5000000),MicrosoftSignInRequiredError);assert.equal(chunks,1);
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
 assert.equal([...ctx.graph.files.keys()].filter(p=>p.includes('/originals/')).length,3,'selected originals retained after sync');
 assert.equal(ctx.graph.trashed.length,0);
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS deletion batch: preflight all targets, two annual shards, one payment year, selected originals retained');
}
{
 const ctx=await setup();await saveRecordsSkippingDuplicates([await sample(29,A)]);await ctx.reopen();
 const prior=ctx.vault.records()[0],path='payroll/statements/2026.enc',before=ctx.graph.files.get(path),write=ctx.graph.write.bind(ctx.graph);
 let reappeared=false;
 ctx.graph.write=async(...args)=>{await write(...args);if(args[0].includes('income')&&!reappeared){reappeared=true;ctx.graph.files.set(path,{...before,etag:'synthetic-reappearance'});}};
 await assert.rejects(deleteRecords([{id:prior.id,signature:recordSignature(prior)}]),e=>e.stage==='income-sync');
 assert.equal(reappeared,true);assert.equal(ctx.graph.trashed.length,0);
 console.log('PASS: shared sync detects reappearing deleted statement without reporting success');
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
 await deleteRecords(targets);
 const beforeTrash=await ctx.vault.inspectDetachedOriginals();
 const selected=beforeTrash.originals.filter(item=>item.id!==unrelated);
 assert.equal(selected.length,2);
 await ctx.vault.trashDetachedOriginal(beforeTrash,selected[0]);
 ctx.graph.trashFault=()=>ctx.graph.trashed.length===1;
 const nextReport=await ctx.vault.inspectDetachedOriginals();
 await assert.rejects(ctx.vault.trashDetachedOriginal(nextReport,nextReport.originals.find(item=>item.id===selected[1].id)),/synthetic trash interruption/);
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
 await deleteRecords([{id:target.id,signature:recordSignature(target)}]);
 const detached=await ctx.vault.inspectDetachedOriginals();
 await assert.rejects(ctx.vault.trashDetachedOriginal(detached,detached.originals[0]));
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
 await deleteRecords([{id:target.id,signature:recordSignature(target)}]);
 const detached=await ctx.vault.inspectDetachedOriginals();
 await assert.rejects(ctx.vault.trashDetachedOriginal(detached,detached.originals[0]));
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
 }, undefined, undefined, undefined, false);
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
 await ctx.vault.save({...old,fileHash:a.fileHash});await removeFixtureHash(ctx,old.id);
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
 await ctx.vault.save({...a,id:123,savedAt:'2026-11-01T00:00:00.000Z',revision:1});await removeFixtureHash(ctx,123);
 await assert.rejects(ctx.vault.original(ctx.vault.records()[0]),/SHA-256/);
 const n=ctx.graph.writes.length;
 const result=await saveRecordsSkippingDuplicates([{...a,employerId:A,form:{...a.form,targetMonth:'2026-11',paymentDate:'2026-11-27'}}]);
 assert.equal(result.saved,0);assert.equal(result.skipped[0].reason,'saved-pdf');assert.equal(ctx.graph.writes.length,n);
 assert.equal(ctx.vault.records().length,1);assert.equal(ctx.vault.records()[0].fileHash,undefined);
 console.log('PASS A1: actual legacy PDF hash blocks cross-month duplicate without metadata mutation');
}
{
 const ctx=await setup(),a=await sample(101,A,'2026-10');ctx.graph.fault=p=>p.includes('/statements/');await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 const corrected={...a,form:{...a.form,targetMonth:'2027-04',paymentDate:'2027-04-27'}};
 const n=ctx.graph.writes.length;
 const report=await verify(ctx,corrected);assert.equal(report.detached,1);assert.equal(report.saved,0);assert.equal(report.originalsVerified,1);
 await assert.rejects(inspectAdditiveRestore([{...corrected,id:124,savedAt:'2026-11-01T00:00:00.000Z',revision:1}]),/未参照原本/);assert.equal(ctx.graph.writes.length,n);
 const originals=ctx.graph.writes.filter(p=>p.includes('/originals/')).length;
 assert.equal((await saveRecordsSkippingDuplicates([corrected],undefined,undefined,()=>true,true)).saved,1);await ctx.reopen();
 assert.equal(ctx.vault.records()[0].originalMonth,'2026-10');assert.equal(ctx.vault.records()[0].form.targetMonth,'2027-04');
 assert.equal(ctx.graph.writes.filter(p=>p.includes('/originals/')).length,originals);
 assert.equal((await ctx.vault.original(ctx.vault.records()[0])).size,a.pdf.size);
 console.log('PASS A1: explicit recovery reuses cross-year detached PDF; additive restore retains its guard');
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
 assert.equal(ctx.vault.records()[0].originalId,keep.originalId);assert.equal(ctx.graph.trashed.length,0);
 assert.ok([...ctx.graph.files.keys()].some(p=>p.endsWith(drop.originalId+'.enc')));
 assert.ok((await ctx.vault.inspectDetachedOriginals()).originals.some(r=>r.uuid===drop.originalId));
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS A1: successful exact replacement preserves kept originals, retains excluded originals and verifies Finance');
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
 assert.ok([...ctx.graph.files.keys()].some(p=>p.endsWith(drop.originalId+'.enc')));
 assert.ok((await ctx.vault.inspectDetachedOriginals()).originals.some(r=>r.uuid===drop.originalId));
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
 assert.deepEqual(ctx.vault.records().map(r=>r.id),[keep.id]);assert.equal(ctx.graph.trashed.length,0);assert.ok((await ctx.vault.inspectDetachedOriginals()).originals.some(r=>r.uuid===drop.originalId));
 assert.ok((await ctx.vault.original(ctx.vault.records()[0])).size>0);
 console.log('PASS A2: duplicate cleanup preserves detached originals and retains the edited original');
}
{
 const {ctx,drop,backup,baseline}=await replacementFixture();
 ctx.graph.trashFault=()=>true;
 await replaceAllRecords([backup],baseline);await ctx.reopen();
 const detached=await ctx.vault.inspectDetachedOriginals();
 await assert.rejects(ctx.vault.trashDetachedOriginal(detached,detached.originals.find(r=>r.uuid===drop.originalId)),/synthetic trash interruption/);
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

// A directory change between the shared edit preflight and the write lock must
// still invalidate the approved directory, without another unlocked index GET.
{
 const ctx=await setup(),dir=[{id:A,name:'Synthetic main',role:'main',current:true}];
 await ctx.vault.writeEmployerDirectory([],dir);await saveRecordsSkippingDuplicates([await sample(695,A)]);await ctx.reopen();
 const prior=await getRecordSummary(ctx.vault.records()[0].id),before=ctx.graph.writes.length,save=ctx.vault.save.bind(ctx.vault);
 ctx.vault.save=async(...args)=>{await ctx.vault.writeEmployerDirectory(dir,dir.map(e=>({...e,name:'Synthetic renamed'})));return save(...args);};
 await assert.rejects(updateRecordMetadata({...prior,form:{...prior.form,net:'9000'}},[],recordSignature(prior),undefined,JSON.stringify(dir)),/勤務先一覧/);
 assert.deepEqual(ctx.graph.writes.slice(before),['payroll/index.enc']);
 console.log('PASS: shared edit snapshot still rejects directory drift under the write lock');
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
 // Stale derived income must not block remaining assignments.
 await assignEmployers(nextTargets,A,signature,next.signature,()=>true);await ctx.reopen();assert.ok(ctx.vault.records().every(r=>r.employerId===A));assert.equal(ctx.graph.trashed.length,0);
 console.log('PASS B2: partial annual failure, no blind replay, remaining assignments repair affected income');
}
{
 const ctx=await setup(),dir=[{id:A,name:'Synthetic main',role:'main',current:true}];
 await ctx.vault.writeEmployerDirectory([],dir);
 const fixtures=await Promise.all(Array.from({length:22},async(_,i)=>{
  const month=`${2024+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;
  const rec=await sample(900+i,undefined,month);rec.form.paymentDate=month+'-27';return rec;
 }));
 assert.equal((await saveRecordsSkippingDuplicates(fixtures)).saved,22);await ctx.reopen();
 const original=ctx.vault.records(),targets=original.map(r=>({id:r.id,signature:recordSignature(r)})),signature=JSON.stringify(dir);
 ctx.graph.files.delete('payroll/income/2024.enc');
 const counts={refresh:0,read:0,listFolder:0};
 for(const [obj,key] of [[ctx.vault,'refresh'],[ctx.graph,'read'],[ctx.graph,'listFolder']]){const orig=obj[key].bind(obj);obj[key]=(...args)=>{counts[key]++;return orig(...args);};}
 const before=ctx.graph.writes.length,plan=await inspectEmployerAssignment(targets,A,signature,()=>true);assert.equal(plan.count,22);
 const verified=await assignEmployers(targets,A,signature,plan.signature,()=>true);
 console.log('BULK COUNTS '+JSON.stringify(counts));
 assert.ok(counts.refresh<=11&&counts.read<=36&&counts.listFolder<=12,JSON.stringify(counts));
 await ctx.reopen();
 assert.deepEqual(verified.sort((a,b)=>a.id-b.id),ctx.vault.records().sort((a,b)=>a.id-b.id));
 assert.equal(ctx.vault.records().length,22);
 for(const r of ctx.vault.records()){const prior=original.find(x=>x.id===r.id);assert.deepEqual(r,{...prior,employerId:A,revision:(prior.revision??0)+1});}
 assert.ok(!ctx.graph.writes.slice(before).some(x=>x.includes('/originals/')));
 assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2024','2025'])),[]);
 console.log('PASS: 22 employer assignments with stale derived income, unchanged PDFs and amounts');
}
{
 const {ctx,targets,signature}=await assignmentFixture(),plan=await inspectEmployerAssignment(targets,A,signature,()=>true);
 // A single payment year must also check the identity of its verified income
 // file. A bypassing client changes it during the final metadata sweep.
 const metadata=ctx.graph.metadata.bind(ctx.graph);let changed=false;
 ctx.graph.metadata=async(parts,name)=>{
  if(parts.includes('income')&&!changed){
   changed=true;const path=ctx.graph.path(parts,name),old=ctx.graph.files.get(path);
   const text=await encryptJson('income',{format:'payroll-income-v1',year:name.slice(0,-4),records:[]},ctx.key,ctx.vault.sessionKey().salt);
   ctx.graph.files.set(path,{...old,text,size:enc.encode(text).length,etag:'synthetic-race'});
  }
  return metadata(parts,name);
 };
 await assignEmployers(targets,A,signature,plan.signature,()=>true);
 assert.equal(changed,true);assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
 console.log('PASS: shared final verification detects single-year income replacement and repairs projection');
}
{
 const {ctx,targets,signature}=await assignmentFixture(),plan=await inspectEmployerAssignment(targets,A,signature,()=>true);
 ctx.graph.fault=p=>p.includes('/income/');
 await assert.rejects(assignEmployers(targets,A,signature,plan.signature,()=>true),e=>e.stage==='income-sync');
 ctx.graph.fault=undefined;await ctx.reopen();assert.ok(ctx.vault.records().every(r=>r.employerId===A));
 console.log('PASS: Finance failure after employer assignment is a partial success');
}

{
 const {ctx,targets,signature}=await assignmentFixture();const first=ctx.vault.records()[0];
 const year=first.form.targetMonth<'2027-04'?'2026':'2027',path=`payroll/statements/${year}.enc`,file=ctx.graph.files.get(path),doc=await decryptJson('year',file.text,ctx.key);
 doc.records.push({...first,id:987654,employerId:A});const cipher=await encryptJson('year',doc,ctx.key,ctx.vault.sessionKey().salt);ctx.graph.files.set(path,{...file,text:cipher,size:enc.encode(cipher).length,etag:'synthetic-duplicate'});await ctx.reopen();
 const before=ctx.graph.writes.length;await assert.rejects(inspectEmployerAssignment(targets,A,signature,()=>true),/重複/);assert.equal(ctx.graph.writes.length,before);
 console.log('PASS B2: duplicate period blocked without deleting or modifying any statement');
}

{
 const ctx=await setup();
 for(const [i,month] of ['2024-04','2025-04','2026-04'].entries()){
  const rec=await sample(800+i,A,month);rec.form.paymentDate=month+'-27';
  await saveRecordsSkippingDuplicates([rec]);
 }
 const counts={refresh:0,read:0,listFolder:0,metadata:0,write:0};
 for(const method of ['read','listFolder','metadata','write']){
  const original=ctx.graph[method].bind(ctx.graph);ctx.graph[method]=async(...args)=>{counts[method]++;return original(...args);};
 }
 const refresh=ctx.vault.refresh.bind(ctx.vault);ctx.vault.refresh=async(...args)=>{counts.refresh++;return refresh(...args);};
 const rec=await sample(804,A,'2026-05');rec.form.paymentDate='2026-05-27';
 assert.equal((await saveRecordsSkippingDuplicates([rec])).saved,1);
 assert.equal(ctx.vault.records().length,4);
 assert.equal(counts.write,3);
 assert.ok(counts.refresh<=8,'ordinary upload must not repeat consecutive full-year checks');
 assert.ok(counts.read<=26,'unchanged annual bodies must not be downloaded again');
 assert.ok(counts.listFolder<=24,'one redundant inventory request was removed');
 console.log('PHASE3 COUNTS '+JSON.stringify(counts));
}

{
 const ctx=await setup();const first=await sample(810,A,'2026-04');first.form.paymentDate='2026-04-27';
 await saveRecordsSkippingDuplicates([first]);
 const file=ctx.graph.files.get('payroll/statements/2026.enc');
 const doc=await decryptJson('year',file.text,ctx.key);
 doc.records[0].form.gross='12000';doc.records[0].revision++;
 const text=await encryptJson('year',doc,ctx.key,ctx.vault.sessionKey().salt);
 const next=await sample(811,A,'2026-05');next.form.paymentDate='2026-05-27';
 const writes=ctx.graph.writes.length;
 ctx.graph.withWriteLock=async operation=>{
  // A client that bypasses the write lock changes the baseline after the
  // caller's first read. The live check under the lock must reject it.
  ctx.graph.files.set('payroll/statements/2026.enc',{...file,etag:'changed-at-lock',text,size:enc.encode(text).length});
  return operation();
 };
 await assert.rejects(saveRecordsSkippingDuplicates([next]),/保存前の照合後に明細/);
 assert.equal(ctx.graph.writes.length,writes,'changed baseline must be rejected before any original or annual write');
 console.log('PASS Phase 3: concurrent change before lock is rejected with no writes');
}

{
 const ctx=await setup(),a=await sample(820,A,'2026-04');a.form.paymentDate='2026-04-27';
 await saveRecordsSkippingDuplicates([a]);
 const before=await ctx.vault.inspectDetachedOriginals();
 const originalRead=ctx.graph.read.bind(ctx.graph);let yearReads=0;
 ctx.graph.read=async(parts,name)=>{if(parts.includes('statements'))yearReads++;return originalRead(parts,name);};
 assert.deepEqual(await ctx.vault.inspectDetachedOriginals(true),before);
 assert.equal(yearReads,0,'verified annual body reused only after fresh listing');
 const path='payroll/statements/2026.enc',old=ctx.graph.files.get(path);
 ctx.graph.files.set(path,{...old,etag:'modified-annual'});
 assert.notEqual((await ctx.vault.inspectDetachedOriginals(true)).years[0].etag,before.years[0].etag);
 assert.equal(yearReads,1,'changed ETag forces a real read');
 ctx.graph.files.delete(path);
 await assert.rejects(ctx.vault.inspectDetachedOriginals(true),/明細がありません/);
 console.log('PASS Phase 3-B: live inventory cache identity, changed ETag read, missing year rejection');
}
{
 const ctx=await setup(),a=await sample(821,A,'2026-04'),b=await sample(822,A,'2026-05');
 ctx.graph.fault=p=>p.includes('/statements/');await assert.rejects(saveRecordsSkippingDuplicates([a,b]));ctx.graph.fault=undefined;await ctx.reopen();
 let scans=0,hashScans=0;const inventory=ctx.vault.inspectDetachedOriginals.bind(ctx.vault),matches=ctx.vault.inspectDetachedUploadMatches.bind(ctx.vault);
 ctx.vault.inspectDetachedOriginals=async(...args)=>{scans++;return inventory(...args);};
 ctx.vault.inspectDetachedUploadMatches=async(...args)=>{hashScans++;return matches(...args);};
 const originals=ctx.graph.writes.filter(p=>p.includes('/originals/')).length;
 assert.equal((await saveRecordsSkippingDuplicates([a,b])).saved,2);
 assert.equal(scans,3,'two preflight inventories plus one final shared revalidation');assert.equal(hashScans,1,'single detached hash scan');
 assert.equal(ctx.graph.writes.filter(p=>p.includes('/originals/')).length,originals);
 console.log('PASS Phase 3-B: two recovered PDFs share final inventory, no repeated hash scan or original PUT');
}
{
 const ctx=await setup(),a=await sample(823,A,'2026-04');
 ctx.graph.fault=p=>p.includes('/statements/');await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 const inventory=ctx.vault.inspectDetachedOriginals.bind(ctx.vault);let scans=0;
 ctx.vault.inspectDetachedOriginals=async(...args)=>{
  if(++scans===3){const [path,file]=[...ctx.graph.files].find(([p])=>p.includes('/originals/'));ctx.graph.files.set(path,{...file,etag:'changed-before-reuse'});}
  return inventory(...args);
 };
 const writes=ctx.graph.writes.length;
 await assert.rejects(saveRecordsSkippingDuplicates([a]),/原本一覧か年別明細が更新/);
 assert.equal(ctx.graph.writes.length,writes,'changed detached original must not be linked or written');
 console.log('PASS Phase 3-B: detached inventory change between preflight and reuse rejects without writes');
}

{
 const ctx=await setup(),a=await sample(824,A,'2026-04'),b=await sample(825,A,'2026-05');
 await saveRecordsSkippingDuplicates([a]);
 let scans=0;const inventory=ctx.vault.inspectDetachedOriginals.bind(ctx.vault);
 ctx.vault.inspectDetachedOriginals=async(...args)=>{scans++;return inventory(...args);};
 assert.equal((await saveRecordsSkippingDuplicates([b])).saved,1);
 assert.equal(scans,1,'clean ordinary upload performs one scoped inventory');
 assert.equal(ctx.vault.records().length,2);
 console.log('PASS P02: clean upload performs one scoped inventory; explicit cross-month recovery remains strict');
}
{
 const ctx=await setup(),a=await sample(826,A,'2026-04'),b=await sample(827,A,'2026-05');
 await saveRecordsSkippingDuplicates([a]);
 const [path]=[...ctx.graph.files].find(([p])=>p.includes('/originals/'));ctx.graph.files.delete(path);
 const writes=ctx.graph.writes.length;
 assert.equal((await saveRecordsSkippingDuplicates([b])).saved,1);
 assert.ok(ctx.graph.writes.length>writes);
 await assert.rejects(()=>ctx.vault.inspectDetachedOriginals(),/参照する原本が見つかりません/);
 await assert.rejects(()=>saveRecordsSkippingDuplicates([a]),/原本/);
 console.log('PASS P02: missing unrelated historical original does not block new upload; full audit and duplicate verification still reject');
}

// P02/P03: five years of unrelated historical originals do not create a scan or
// download in a normal save. A complete creation receipt is sufficient; incomplete
// receipts retain the original readback, and restore keeps the strict path.
{
 const ctx=await setup();
 for(let i=0;i<5;i++)await saveRecordsSkippingDuplicates([await sample(850+i,A,`${2021+i}-04`)]);
 const old=await sample(860,A,'2025-05');ctx.graph.fault=p=>p.includes('/statements/');
 await assert.rejects(saveRecordsSkippingDuplicates([old]));ctx.graph.fault=undefined;await ctx.reopen();
 const lists=[],reads=[];
 const list=ctx.graph.listFolder.bind(ctx.graph),read=ctx.graph.read.bind(ctx.graph);
 ctx.graph.listFolder=async(parts,...args)=>{if(parts.includes('originals'))lists.push(parts.join('/'));return list(parts,...args);};
 ctx.graph.read=async(parts,...args)=>{if(parts.includes('originals'))reads.push(parts.join('/'));return read(parts,...args);};
 const fresh=await sample(861,A,'2026-11');
 assert.equal((await saveRecordsSkippingDuplicates([fresh])).saved,1);
 assert.deepEqual(lists,['payroll/originals/2026/11']);assert.deepEqual(reads,[]);
 assert.equal((await ctx.vault.original(ctx.vault.records().find(r=>r.fileHash===fresh.fileHash))).size,fresh.pdf.size);
 console.log('PASS P02/P03: one target-month list, zero historical orphan downloads, zero new-original readback across five years');
}
{
 const ctx=await setup(),a=await sample(862,A,'2026-11');
 const write=ctx.graph.write.bind(ctx.graph),read=ctx.graph.read.bind(ctx.graph);let reads=0;
 ctx.graph.write=async(parts,...args)=>{const result=await write(parts,...args);return parts.includes('originals')?undefined:result;};
 ctx.graph.read=async(parts,...args)=>{if(parts.includes('originals'))reads++;return read(parts,...args);};
 assert.equal((await saveRecordsSkippingDuplicates([a])).saved,1);assert.equal(reads,1);
 const b=await sample(863,A,'2026-12');ctx.graph.discard=p=>p.includes('/originals/');
 await assert.rejects(saveRecordsSkippingDuplicates([b]),/読み戻せません/);
 assert.equal(ctx.vault.records().length,1);
 console.log('PASS P03: missing creation receipt uses authenticated readback and blocks missing original');
}
{
 const ctx=await setup(),a=await sample(864,A,'2026-11');ctx.graph.fault=p=>p.includes('/statements/');
 await assert.rejects(saveRecordsSkippingDuplicates([a]));ctx.graph.fault=undefined;await ctx.reopen();
 const corrected={...a,form:{...a.form,targetMonth:'2026-12'}};
 assert.equal((await saveRecordsSkippingDuplicates([corrected])).saved,1);
 assert.equal((await ctx.vault.inspectDetachedOriginals()).originals.length,1);
 assert.equal(ctx.vault.records().length,1);
 console.log('PASS P02: ordinary cross-month retry preserves older detached original; no double payroll record');
}

{
 const ctx=await setup(),a=await sample(865,A,'2026-11');
 const read=ctx.graph.read.bind(ctx.graph);let reads=0;
 ctx.graph.read=async(parts,...args)=>{if(parts.includes('originals'))reads++;return read(parts,...args);};
 const uuid=crypto.randomUUID();
 await ctx.vault.storeOriginal(a,uuid,a.form.targetMonth);
 assert.equal(reads,1,'strict non-ordinary save still reads back despite receipt');
 reads=0;await ctx.vault.storeOriginal(a,uuid,a.form.targetMonth,undefined,true);
 assert.equal(reads,1,'collision reads authenticated original only once');
 const different=await sample(866,A,'2026-11');
 await assert.rejects(ctx.vault.storeOriginal(different,uuid,a.form.targetMonth,undefined,true),/異なるPDF/);
 console.log('PASS P03: strict save retains readback; collision compares existing original once and refuses differing bytes');
}

// Join the real Graph lock/request state machine to the encrypted in-memory
// vault fixture. Fail after verified payroll writes, or before verification.
for(const operation of ['edit','move','remove','batch']){
 for(const fault of ['finance-read','finance-write-unknown','annual-readback',...(['move','batch'].includes(operation)?['later-annual']:[])]){
  const ctx=await setup();
  await saveRecordsSkippingDuplicates([await sample(701,A,'2026-11'),await sample(702,A,'2025-12')]);
  await ctx.reopen();
  const rows=ctx.vault.records(),target=rows[0],g=ctx.graph;
  let lock=null,serial=0,failed=false,annualWritten=false,annualWrites=0,financeWrites=0;
  const real=new PayrollGraph('synthetic-token',async(url,init)=>{
   const path=new URL(url).pathname;
   if(path.endsWith('/content')&&init.method==='PUT'){
    assert.equal(lock,null);lock={id:'lock-'+(++serial),etag:'lock-etag-'+serial,text:new TextDecoder().decode(init.body),size:64};
    return Response.json({id:lock.id,eTag:lock.etag,name:'payroll-write-lock-v1.bin',size:64},{status:201});
   }
   if(init.method==='DELETE'){
    assert.ok(lock);assert.ok(path.endsWith('/'+lock.id));assert.equal(new Headers(init.headers).get('If-Match'),lock.etag);
    lock=null;return new Response(null,{status:204});
   }
   assert.equal(init.method,'POST');assert.ok(lock);
   if(path.endsWith('/synthetic-income')){
    financeWrites++;
    if(fault==='finance-write-unknown'&&!failed){failed=true;throw Error('synthetic lost income write response');}
   }
   return Response.json({});
  });
  real.root=async()=> 'synthetic-root';
  real.read=async()=>lock?{...lock}:null;
  real.metadata=async()=>lock?{id:lock.id,etag:lock.etag,size:lock.size}:null;
  g.withWriteLock=real.withWriteLock.bind(real);
  const write=g.write.bind(g),read=g.read.bind(g);
  g.write=async(parts,name,...args)=>{
   if(parts.includes('statements')){
    if(fault==='later-annual'&&annualWrites>0&&(operation==='batch'||name===target.form.targetMonth.slice(0,4)+'.enc')){failed=true;throw Error('synthetic later annual write unavailable');}
    annualWrites++;
   }
   await real.request(parts.includes('income')?'/synthetic-income':'/synthetic-annual',{method:'POST'});
   await write(parts,name,...args);
   if(parts.includes('statements'))annualWritten=true;
  };
  g.read=async(parts,name)=>{
   if(!failed&&annualWritten&&((fault==='finance-read'&&parts.includes('income'))||(fault==='annual-readback'&&parts.includes('statements')))){
    failed=true;throw Error('synthetic read unavailable');
   }
   return read(parts,name);
  };
  const execute=()=>operation==='batch'?ctx.vault.removeBatch(rows.map(r=>({id:r.id,matches:x=>recordSignature(x)===recordSignature(r)}))):
   operation==='remove'?ctx.vault.remove(target.id,x=>recordSignature(x)===recordSignature(target)):
   ctx.vault.save({...target,revision:target.revision+1,form:{...target.form,gross:'12000',net:'12000',...(operation==='move'?{targetMonth:'2028-04'}:{})}},undefined,x=>recordSignature(x)===recordSignature(target));
  await assert.rejects(execute(),error=>{
   assert.equal(/ロックが残っている可能性/.test(error.message),fault!=='finance-read');
   if(fault.startsWith('finance-'))assert.match(error.message,/Finance連携/);
   return true;
  });
  assert.ok(failed);assert.equal(Boolean(lock),fault!=='finance-read');
  assert.equal([...g.files.keys()].filter(p=>p.includes('/originals/')).length,2);
  if(fault==='finance-read'){
   assert.equal(financeWrites,0);
   await ctx.reopen();
   const live=ctx.vault.records();
   if(operation==='edit'||operation==='move'){
    assert.equal(live.find(r=>r.id===target.id).form.net,'12000');
    if(operation==='move')assert.equal(live.find(r=>r.id===target.id).form.targetMonth,'2028-04');
   }else assert.equal(live.length,operation==='batch'?0:1);
   await ctx.vault.syncIncome(new Set(['2027']));assert.equal(lock,null);
   assert.deepEqual(await ctx.vault.inspectIncomeConsistency(new Set(['2027'])),[]);
  }
 }
 console.log('PASS verified payroll lock release and uncertain write protection: '+operation);
}
