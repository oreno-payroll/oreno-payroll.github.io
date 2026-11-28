/** Production Graph lock protocol, with synthetic in-memory transport only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const receipts=new Map(),checkpoints=new Map();
let checkpointDeleteBlocked=false,checkpointDeleteGate=null;
// Simulated browser-wide lock manager. A terminated context drops its guard
// without running JS cleanup, but the remote lock and receipt survive.
const held=new Map();
const navigator={locks:{async request(name,options,callback){
 assert.equal(options.ifAvailable,true);
 if(held.has(name))return callback(null);
 const guard={name};held.set(name,guard);
 try{return await callback(guard);}finally{if(held.get(name)===guard)held.delete(name);}
}}};
const localStorage={getItem:k=>receipts.get(k)??null,setItem:(k,v)=>receipts.set(k,v),removeItem:k=>receipts.delete(k)};
const src=readFileSync(new URL('../src/cloud/graph.ts',import.meta.url),'utf8');
const {PayrollGraph,PAYROLL_WRITE_LOCK_NAME:name}=runInNewContext(stripTypeScriptTypes(src.replace(/^import[^\n]*\n/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'})+'\n({PayrollGraph,PAYROLL_WRITE_LOCK_NAME})',{
 URL,Response,Request,Headers,AbortController,TextEncoder,TextDecoder,Uint8Array,performance,crypto:webcrypto,setTimeout,clearTimeout,localStorage,navigator,DOMException,
 observeGraphTransfer:()=>{},observeGraphRetry:()=>{},MicrosoftSignInRequiredError:class extends Error{},MicrosoftTemporaryError:class extends Error{},
});
PayrollGraph.prototype.checkpointStorage=async function(receipt,action){
 if(action==='read')return checkpoints.has(receipt);
 if(action==='put'){checkpoints.set(receipt,1);return true;}
 if(checkpointDeleteGate)await checkpointDeleteGate.promise;
 if(checkpointDeleteBlocked)throw Error('synthetic durable transaction failure');
 checkpoints.delete(receipt);return true;
};
function fixture(){
 const state={lock:null,serial:0,writes:0,lostCreate:false,delayedCreate:false,createStatus:201,lostWrite:false,lostRelease:false,blockedRelease:false,events:[],content:null,contentMode:"ok",rejectStatus:0,lockReject:0,sessionReject:0,chunkReject:0,contentReadBlocked:false};
 const meta=()=>({name,id:state.lock.id,eTag:state.lock.etag,size:state.lock.text.length,'@microsoft.graph.downloadUrl':'https://storage.example.test/'+state.lock.id});
 const http=async(raw,init={})=>{
  const u=new URL(raw),method=init.method??'GET';
  if(u.hostname==='storage.example.test'){
   assert.equal(new Headers(init.headers).has('Authorization'),false);
   if(u.pathname==='/upload'&&method==='PUT'){
    if(state.chunkReject)return new Response(null,{status:state.chunkReject});
    return saveContent(init.body);
   }
   assert.equal(method,'GET');
   if(u.pathname==='/data')return state.content?new Response(state.content.text):new Response(null,{status:404});
   return state.lock&&u.pathname==='/'+state.lock.id?new Response(state.lock.text):new Response(null,{status:404});
  }
  assert.equal(u.origin,'https://graph.microsoft.com');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fixture');
  if(u.pathname.endsWith('/special/approot'))return Response.json({id:'root'});
  if(u.pathname.endsWith('/root:/'+name+':/content')&&method==='PUT'){
   assert.equal(u.searchParams.get('@microsoft.graph.conflictBehavior'),'fail');
   if(state.lockReject)return new Response(null,{status:state.lockReject});
   if(state.lock)return new Response(null,{status:409});
   const created={id:'lock-'+(++state.serial),etag:'etag-'+state.serial,text:new TextDecoder().decode(init.body)};
   if(state.delayedCreate){state.delayed=created;throw Error('creation pending');}
   state.lock=created;
   assert.match(state.lock.text,/^[a-f0-9]{64}$/);state.events.push('acquire');
   if(state.lostCreate)throw Error('lost acquire response');return Response.json(meta(),{status:state.createStatus});
  }
  if(u.pathname.endsWith('/root:/'+name)&&method==='GET'){
   if(!state.lock)return new Response(null,{status:404});
   return Response.json(meta());
  }
  if(method==='DELETE'&&u.pathname.includes('/items/lock-')){
   if(!state.lock||!u.pathname.endsWith('/'+state.lock.id))return new Response(null,{status:404});
   if(new Headers(init.headers).get('If-Match')!==state.lock.etag)return new Response(null,{status:412});
   if(state.blockedRelease)throw Error('release unavailable');
   state.lock=null;state.events.push('release');if(state.lostRelease)throw Error('lost release response');return new Response(null,{status:204});
  }
  if(u.pathname.endsWith('/root:/data.enc:/content')&&method==='PUT')return saveContent(init.body);
  if(u.pathname.endsWith('/createUploadSession')&&method==='POST'){
   if(state.sessionReject)return new Response(null,{status:state.sessionReject});
   return Response.json({uploadUrl:'https://storage.example.test/upload'});
  }
  if(u.pathname.endsWith('/root:/data.enc')&&method==='GET'){
   if(state.contentReadBlocked)throw Error('synthetic read unavailable');
   return state.content?Response.json({id:'data',name:'data.enc',eTag:state.content.etag,size:state.content.text.length,'@microsoft.graph.downloadUrl':'https://storage.example.test/data'}):new Response(null,{status:404});
  }
  if(u.pathname.endsWith('/synthetic-write')&&method==='POST'){
   assert.ok(state.lock);if(state.rejectStatus)return new Response(null,{status:state.rejectStatus});state.writes++;state.events.push('write');if(state.lostWrite)throw Error('lost write response');return Response.json({});
  }
  throw Error('unexpected synthetic request '+method+' '+u.pathname);
 };
 const saveContent=body=>{
  assert.ok(state.lock);state.writes++;
  if(state.contentMode==='reject')return new Response(null,{status:429});
  if(state.contentMode==='lost-missing')throw Error('lost without content');
  const text=new TextDecoder().decode(body);
  state.content={text:state.contentMode==='lost-different'?'different':text,etag:'content-'+state.writes};
  if(state.contentMode.startsWith('lost'))throw Error('lost final content reply');
  return Response.json({id:'data',size:text.length},{status:201});
 };
 const graph=()=>new PayrollGraph('fixture',http);
 return {state,graph,write:g=>g.request('/synthetic-write',{method:'POST'})};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
{
 const f=fixture(),a=f.graph(),b=f.graph(),entered=deferred(),resume=deferred();
 await assert.rejects(f.write(a),/ロックを取得していない/);
 const pending=a.withWriteLock(async()=>{entered.resolve();await resume.promise;await f.write(a);return 42;});
 await entered.promise;
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/別の保存処理/);
 resume.resolve();assert.equal(await pending,42);assert.equal(f.state.lock,null);
 assert.deepEqual(f.state.events,['acquire','write','release']);
 await b.withWriteLock(()=>f.write(b));assert.equal(f.state.serial,2);assert.equal(f.state.writes,2);assert.equal(f.state.lock,null);
 console.log('PASS: default mutation guard, two clients, same client, verified release and reacquisition');
}
{
 const f=fixture(),a=f.graph();f.state.lostCreate=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/ロックは解除しました/);assert.equal(f.state.writes,0);assert.equal(f.state.lock,null);
 f.state.lostCreate=false;await a.withWriteLock(()=>f.write(a));assert.equal(f.state.writes,1);
 console.log('PASS: lost acquisition response reconciles exact own lock without writing, then allows retry');
}
{
 const f=fixture(),a=f.graph();f.state.lostWrite=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/ロックが残っている可能性/);assert.equal(f.state.writes,1);assert.ok(f.state.lock);
 console.log('PASS: ambiguous mutation retains lock, no retry');
}
{
 const f=fixture(),a=f.graph();await assert.rejects(a.withWriteLock(async()=>{throw Error('validation failure');}),/validation failure/);assert.equal(f.state.lock,null);
 await assert.rejects(a.withWriteLock(async()=>{await f.write(a);throw Error('late failure');}),/ロックが残っている可能性/);assert.ok(f.state.lock);
 console.log('PASS: validation failure releases; post-write failure retains');
}
{
 const f=fixture(),a=f.graph();await assert.rejects(a.withWriteLock(async()=>{f.state.lock={id:'successor',etag:'new',text:'a'.repeat(64)};await f.write(a);}),/所有権/);assert.equal(f.state.writes,0);assert.equal(f.state.lock.id,'successor');
 console.log('PASS: changed owner blocks mutation and release');
}
{
 const f=fixture(),a=f.graph();f.state.lostRelease=true;
 const state={attempted:false,uncertain:false,completed:false,lock:'none'};
 assert.equal(await a.withWriteLock(async()=>{await f.write(a);return 42;},state),42);
 assert.equal(f.state.writes,1);assert.equal(f.state.lock,null);assert.equal(state.completed,true);assert.equal(state.lock,'released');
 console.log('PASS: lost release reply with verified absence preserves the successful result');
}
// Upload recovery may release only a verified, safely settled own lock.
for(const completed of [false,true]){
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.blockedRelease=true;
 await assert.rejects(a.withWriteLock(async()=>{if(completed)await f.write(a);else throw Error('preflight failed');},state),/解除/);
 assert.equal(state.attempted,completed);assert.equal(state.completed,completed);assert.equal(state.uncertain,false);assert.equal(state.lock,'unknown');assert.ok(f.state.lock);
 f.state.blockedRelease=false;await a.reconcileUploadLock(state);assert.equal(state.lock,'released');assert.equal(f.state.lock,null);assert.equal(f.state.writes,Number(completed));
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};f.state.lostWrite=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a),state));assert.equal(state.uncertain,true);assert.equal(state.attempted,true);
 await assert.rejects(a.reconcileUploadLock(state),/安全に解除できない/);assert.ok(f.state.lock);assert.equal(f.state.writes,1);
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};f.state.lostCreate=true;f.state.blockedRelease=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a),state));assert.equal(state.attempted,false);assert.equal(state.lock,'unknown');
 f.state.blockedRelease=false;await a.reconcileUploadLock(state);assert.equal(state.lock,'released');assert.equal(f.state.lock,null);assert.equal(f.state.writes,0);
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.delayedCreate=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a),state),/取得を確認できません/);
 assert.equal(state.lock,'unknown');assert.equal(f.state.lock,null);
 await assert.rejects(a.reconcileUploadLock(state),/作成結果がまだ不明/);
 // A different owner appearing must not be touched.
 f.state.lock={id:'other',etag:'other-e',text:'f'.repeat(64)};
 await assert.rejects(a.reconcileUploadLock(state),/安全に解除できない/);assert.equal(f.state.lock.id,'other');
 f.state.lock=f.state.delayed;await a.reconcileUploadLock(state);assert.equal(f.state.lock,null);assert.equal(f.state.writes,0);
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.lostWrite=true;await assert.rejects(a.withWriteLock(()=>f.write(a),state));
 // Absence does not establish that a dispatched business write has settled.
 f.state.lock=null;await assert.rejects(a.reconcileUploadLock(state),/安全に解除できない/);
 assert.equal(state.uncertain,true);assert.equal(f.state.writes,1);
}
// A verified partial checkpoint releases only while no subsequent mutation was sent.
for(const laterWrite of ['none','settled','unknown']){
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 await assert.rejects(a.withWriteLock(async()=>{
  await f.write(a);await a.markUploadCheckpoint();
  if(laterWrite!=='none'){f.state.lostWrite=laterWrite==='unknown';await f.write(a);}
  throw Error('next stage failed');
 },state));
 assert.equal(Boolean(f.state.lock),laterWrite!=='none');
 assert.equal(state.uncertain,laterWrite==='unknown');
 assert.equal(state.lock,laterWrite==='none'?'released':'held');
}
// The authoritative payroll checkpoint allows release only if all writes settled.
for(const lostWrite of [false,true]){
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 await assert.rejects(a.withWriteLock(async()=>{
  await f.write(a);state.payrollSaved=true;
  if(lostWrite){f.state.lostWrite=true;await f.write(a);}
  throw Error('Finance unavailable');
 },state));
 assert.equal(state.payrollSaved,true);assert.equal(state.completed,false);assert.equal(state.uncertain,lostWrite);
 assert.equal(Boolean(f.state.lock),lostWrite);assert.equal(state.lock,lostWrite?'held':'released');
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.blockedRelease=true;
 await assert.rejects(a.withWriteLock(async()=>{await f.write(a);state.payrollSaved=true;throw Error('Finance unavailable');},state));
 assert.equal(state.lock,'unknown');f.state.blockedRelease=false;await a.reconcileUploadLock(state);assert.equal(f.state.lock,null);
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 await assert.rejects(a.withWriteLock(async()=>{await f.write(a);throw Error('derived readback unavailable');},state,true));
 assert.equal(state.lock,'released');assert.equal(f.state.lock,null);
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.createStatus=200;
 await assert.rejects(a.withWriteLock(()=>f.write(a),state),/新規作成を確認できません/);
 assert.equal(f.state.writes,0);assert.ok(f.state.lock);
 await assert.rejects(a.reconcileUploadLock(state),/安全に解除できない/);assert.ok(f.state.lock);
}
console.log('PASS: upload write evidence and conditional recovery of settled own locks');
// P01: explicit rejection is not an unknown mutation. No blind resend.
for(const status of [401,403,409,412,429]){
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.rejectStatus=status;
 await assert.rejects(a.withWriteLock(()=>f.write(a),state));
 assert.equal(state.attempted,false);assert.equal(state.uncertain,false);assert.equal(f.state.lock,null);
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.lockReject=429;await assert.rejects(a.withWriteLock(()=>f.write(a),state),/429/);
 assert.equal(state.lock,'none');assert.equal(f.state.lock,null);
}
for(const kind of ['direct','session','chunk']){
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 if(kind==='direct')f.state.contentMode='reject';else if(kind==='session')f.state.sessionReject=429;else f.state.chunkReject=429;
 const prior=kind==='direct'?null:{id:'data',etag:'before'};
 await assert.rejects(a.withWriteLock(()=>a.write([],'data.enc','fresh ciphertext',prior,1000),state),/429/);
 assert.equal(state.attempted,false);assert.equal(state.uncertain,false);assert.equal(f.state.lock,null);
}
{
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 await assert.rejects(a.withWriteLock(async()=>{await f.write(a);await a.markUploadCheckpoint();f.state.rejectStatus=429;await f.write(a);},state),/429/);
 assert.equal(state.uncertain,false);assert.equal(f.state.lock,null);assert.equal(f.state.writes,1);
}
console.log('PASS P01: explicit Graph/fragment 429 rejection and verified checkpoint release');
// A receipt is persisted only at the safe release boundary. A new Graph
// instance (as after browser reload) may reconcile that exact owner, never an active owner.
{
 receipts.clear();const f=fixture(),a=f.graph(),b=f.graph();
 f.state.blockedRelease=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/解除/);
 assert.equal(receipts.size,1);assert.match([...receipts.keys()][0],/^payroll-settled-lock-v1:[a-f0-9]{64}$/);
 assert.deepEqual([...receipts.values()],['1']);
 f.state.blockedRelease=false;await b.withWriteLock(()=>f.write(b));
 assert.equal(f.state.lock,null);assert.equal(f.state.writes,2);assert.equal(receipts.size,0);
}
{
 receipts.clear();const f=fixture(),a=f.graph(),b=f.graph();f.state.blockedRelease=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)));
 f.state.lock={...f.state.lock,etag:'changed'};f.state.blockedRelease=false;
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);assert.equal(f.state.writes,1);assert.equal(f.state.lock.etag,'changed');
}
{
 receipts.clear();const f=fixture(),a=f.graph(),b=f.graph();f.state.lostWrite=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)));assert.equal(receipts.size,0);
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);assert.ok(f.state.lock);
}
console.log('PASS P01: reload recovers only a fingerprint of a settled exact owner');
// Crash before the first write, or at a verified upload checkpoint. While the
// original execution is active a competing tab cannot recover it. After
// termination a fresh instance can recover, without replaying any old writes.
for(const checkpoint of [false,true]){
 receipts.clear();checkpoints.clear();held.clear();const f=fixture(),a=f.graph(),b=f.graph(),entered=deferred();
 void a.withWriteLock(async()=>{
  if(checkpoint){await f.write(a);await a.markUploadCheckpoint();}
  entered.resolve();await new Promise(()=>{});
 });
 await entered.promise;
 const [key]=checkpoints.keys();assert.match(key,/^payroll-settled-lock-v1:[a-f0-9]{64}$/);
 assert.equal(checkpoints.get(key),1);assert.equal(held.has(key),true);
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);
 assert.equal(f.state.writes,Number(checkpoint));
 // Synthetic browser termination: no JS continuation of the old operation.
 held.delete(key);
 await b.withWriteLock(()=>f.write(b));
 assert.equal(f.state.writes,Number(checkpoint)+1);assert.equal(f.state.lock,null);assert.equal(receipts.size,0);assert.equal(checkpoints.size,0);
}
{
 // A new mutation must revoke the checkpoint *before* it is sent, even if the
 // HTTP reply never returns. No elapsed-time heuristic can make it recoverable.
 receipts.clear();checkpoints.clear();held.clear();const f=fixture(),a=f.graph(),b=f.graph();
 f.state.lostWrite=true;
 await assert.rejects(a.withWriteLock(async()=>{assert.equal(checkpoints.size,1);await f.write(a);}));
 assert.equal(receipts.size,0);assert.equal(checkpoints.size,0);assert.ok(f.state.lock);assert.equal(f.state.writes,1);
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);
 assert.equal(f.state.writes,1);
}
{
 // An unremovable recovery marker must never coexist with a dispatched write.
 receipts.clear();checkpoints.clear();held.clear();const f=fixture(),a=f.graph();
 checkpointDeleteBlocked=true;
 try{await assert.rejects(a.withWriteLock(()=>f.write(a)),/復旧情報を更新/);assert.equal(f.state.writes,0);}
 finally{checkpointDeleteBlocked=false;receipts.clear();checkpoints.clear();}
}
{
 // An altered remote identity or another browser without the matching marker
 // is not recoverable, even if there is no active local execution.
 receipts.clear();checkpoints.clear();held.clear();const f=fixture(),a=f.graph(),b=f.graph(),entered=deferred();
 void a.withWriteLock(async()=>{entered.resolve();await new Promise(()=>{});});await entered.promise;
 held.clear();const owner=f.state.lock;f.state.lock={...owner,etag:'other-etag'};
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);assert.equal(f.state.writes,0);assert.equal(f.state.lock.etag,'other-etag');
 f.state.lock=owner;receipts.clear();checkpoints.clear();
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);assert.equal(f.state.writes,0);
}
{
 // Neither parallel request may reach the transport until the revocation
 // transaction completes. The second request must share the first deletion.
 receipts.clear();checkpoints.clear();held.clear();const f=fixture(),a=f.graph(),entered=deferred(),gate=deferred();
 const pending=a.withWriteLock(async()=>{
  checkpointDeleteGate=gate;
  const writes=Promise.all([f.write(a),f.write(a)]);
  entered.resolve();await writes;
 });
 await entered.promise;await new Promise(r=>setTimeout(r,5));assert.equal(f.state.writes,0);assert.equal(checkpoints.size,1);
 gate.resolve();await pending;checkpointDeleteGate=null;assert.equal(f.state.writes,2);assert.equal(checkpoints.size,0);
}
console.log('PASS audit03: browser restart checkpoints, active-owner refusal, durable revocation before parallel dispatch, storage failure, exact identity');
for(const prior of [null,{id:'data',etag:'before'}]){
 receipts.clear();const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.contentMode='lost';
 await a.withWriteLock(()=>a.write([],'data.enc','fresh ciphertext',prior,1000),state);
 assert.equal(state.completed,true);assert.equal(state.uncertain,false);assert.equal(f.state.writes,1);assert.equal(f.state.lock,null);
}
for(const mode of ['lost-missing','lost-different']){
 receipts.clear();const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};f.state.contentMode=mode;
 await assert.rejects(a.withWriteLock(()=>a.write([],'data.enc','fresh ciphertext',null,1000),state));
 assert.equal(state.uncertain,true);assert.ok(f.state.lock);assert.equal(receipts.size,0);
}
{
 // The saved payroll checkpoint permits delayed confirmation of derived data.
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.contentMode='lost';f.state.contentReadBlocked=true;
 await assert.rejects(a.withWriteLock(async()=>{await f.write(a);state.payrollSaved=true;await a.write([],'data.enc','fresh ciphertext',null,1000);},state));
 assert.equal(state.uncertain,true);assert.ok(f.state.lock);
 f.state.contentReadBlocked=false;await a.reconcileUploadLock(state);assert.equal(state.uncertain,false);assert.equal(f.state.lock,null);
}
{
 // Exact body alone must not authorize release of an unverified multi-file transaction.
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.contentMode='lost';f.state.contentReadBlocked=true;
 await assert.rejects(a.withWriteLock(()=>a.write([],'data.enc','fresh ciphertext',null,1000),state));
 f.state.contentReadBlocked=false;await assert.rejects(a.reconcileUploadLock(state),/安全に解除できない/);assert.ok(f.state.lock);
}
{
 // A copied ciphertext is not a fresh per-operation proof.
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};f.state.contentMode='lost';
 await assert.rejects(a.withWriteLock(()=>a.write([],'data.enc','copied ciphertext',null,1000,undefined,false),state));assert.equal(state.uncertain,true);assert.ok(f.state.lock);
}
{
 // Positive proof for one concurrent write must never erase a different lost reply.
 receipts.clear();const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 f.state.contentMode='lost';f.state.lostWrite=true;
 await assert.rejects(a.withWriteLock(async()=>{
  const results=await Promise.allSettled([a.write([],'data.enc','fresh ciphertext',null,1000),f.write(a)]);
  const failure=results.find(r=>r.status==='rejected');throw failure.reason;
 },state));
 assert.equal(state.uncertain,true);assert.ok(f.state.lock);assert.equal(receipts.size,0);
}
{
 // The stored bytes cannot settle an update if the old version is still live.
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};f.state.contentMode='lost';
 await assert.rejects(a.withWriteLock(()=>a.write([],'data.enc','fresh ciphertext',{id:'data',etag:'content-1'},1000),state));
 assert.equal(state.uncertain,true);assert.ok(f.state.lock);
}
{
 // No browser storage permission must not prevent normal saves or same-tab recovery.
 const f=fixture(),a=f.graph(),state={attempted:false,uncertain:false,completed:false,lock:'none'};
 const original=localStorage.setItem;localStorage.setItem=()=>{throw Error('storage denied');};
 try{f.state.blockedRelease=true;await assert.rejects(a.withWriteLock(()=>f.write(a),state));
  f.state.blockedRelease=false;await a.reconcileUploadLock(state);assert.equal(f.state.lock,null);
 }finally{localStorage.setItem=original;}
}
console.log('PASS P01: positive content proof, delayed derived recovery, no release on absence/mismatch/copied ciphertext');

// Actual read path distinguishes pre-dispatch authentication and transport errors.
{
 let calls=0;const a=new PayrollGraph(async()=>{throw Error('synthetic secret');},async()=>{calls++;throw Error('must not send');});
 await assert.rejects(a.root(),e=>/認証処理.*送信前/.test(e.message)&&!e.message.includes('synthetic secret'));assert.equal(calls,0);
 let refreshes=0;const b=new PayrollGraph('old',async(_,init)=>{calls++;return new Headers(init.headers).get('Authorization')==='Bearer new'?Response.json({id:'root'}):new Response(null,{status:401});},undefined,{invalidate(){},refresh:async()=>{refreshes++;return 'new';}});
 assert.equal(await b.root(),'root');assert.equal(calls,2);assert.equal(refreshes,1);
}
{
 const calls=[];const a=new PayrollGraph('fixture',async(raw,init)=>{assert.equal(init.method??'GET','GET');const path=new URL(raw).pathname;calls.push(path);
  if(path.endsWith('/special/approot'))return Response.json({id:'root'});
  if(path.endsWith('/root/children'))return Response.json({value:[{id:'year',name:'2026',eTag:'e',folder:{},size:0}]});
  if(path.endsWith('/year/children'))return Response.json({value:[{id:'month',name:'11',eTag:'e',folder:{},size:0}]});
  if(path.endsWith('/month/children'))return Response.json({value:[]});
  throw Error('redundant child lookup');
 });
 await a.listFolder([],true);await a.listFolder(['2026'],true);await a.listFolder(['2026','11']);assert.equal(calls.length,4);
}
console.log('PASS: authentication stage and token refresh, verified folder IDs avoid redundant child lookup');
// S08: real AES-GCM originals; absent hash is not verified, even with correct bytes.
{
 const {encryptBytes,decryptBytes}=await import('../src/cloud/crypto.ts');
 const vaultSource=readFileSync(new URL('../src/cloud/vault.ts',import.meta.url),'utf8');
 const code=stripTypeScriptTypes(vaultSource.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
 const {PayrollVault}=runInNewContext(code+'\n({PayrollVault})',{crypto:webcrypto,structuredClone,Blob,TextDecoder,TextEncoder,Uint8Array,decryptBytes,encryptBytes});
 const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const bytes=new TextEncoder().encode('%PDF-1.7\nSynthetic original');
 const ciphertext=await encryptBytes('original',bytes,key),hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
 let reads=0;
 const v=new PayrollVault({read:async()=>{reads++;return {text:ciphertext,id:'original',etag:'e',size:ciphertext.length};}});
 v.key=key;v.salt='synthetic-salt';
 const record={originalMonth:'2026-04',originalId:'fixture-original',pdfSize:bytes.length,pdfType:'application/pdf'};
 await assert.rejects(v.original(record),/SHA-256/);assert.equal(reads,0);
 await assert.rejects(v.original({...record,fileHash:'invalid'}),/SHA-256/);assert.equal(reads,0);
 assert.equal(await v.legacyOriginalDigest(record),hash);assert.equal(reads,1);
 await assert.rejects(v.legacyOriginalDigest({...record,fileHash:'invalid'}),/ハッシュ/);
 assert.equal((await v.original({...record,fileHash:hash})).size,bytes.length);
 await assert.rejects(v.original({...record,fileHash:'0'.repeat(64)}),/SHA-256/);
 console.log('PASS: real encrypted original hash required, legacy digest restricted to duplicate detection');
}

// P03: receipt is available only for a complete 201 creation response, for both
// a single PUT and a completed upload session. Other callers keep old fallback.
for(const large of [false,true])for(const variant of ['valid','no-etag','bad-id','folder','wrong-parent','wrong-name','replacement']){
 const text='x'.repeat(large?4*1024*1024+1:12),size=text.length;let puts=0,seen=0;
 const graph=new PayrollGraph('fixture',async(raw,init)=>{
  const u=new URL(raw);
  if(init.method==='POST')return Response.json({uploadUrl:'https://storage.example.test/receipt'});
  assert.equal(init.method,'PUT');puts++;seen+=init.body.length;
  if(large&&seen<size)return new Response(null,{status:202});
  const item={id:variant==='bad-id'?123:'new-file',folder:variant==='folder'?{}:undefined,name:variant==='wrong-name'?'other.enc':'sample.enc',eTag:variant==='no-etag'?undefined:'new-etag',size,parentReference:{id:variant==='wrong-parent'?'other':'parent'}};
  return Response.json(item,{status:variant==='replacement'?200:201});
 },()=>{},undefined,undefined,false);
 graph.folder=async()=> 'parent';
 const receipt=await graph.write(['payroll','originals','2026','11'],'sample.enc',text,null,size);
 assert.equal(puts,large?2:1);
 if(variant==='valid')assert.deepEqual(JSON.parse(JSON.stringify(receipt)),{id:'new-file',etag:'new-etag',size,name:'sample.enc'});
 else assert.equal(receipt,undefined,variant);
}
console.log('PASS P03: verified creation receipt for single PUT and upload session; incomplete/mismatched/non-creation responses retain readback');
