/** Real PayrollGraph source in a delayed, in-memory fake Graph HTTP server.
 * No network, OAuth credentials, browser storage or actual OneDrive writes. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {performance} from 'node:perf_hooks';
const src=readFileSync(new URL('../src/cloud/graph.ts',import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import[^\n]*\n/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const {PayrollGraph}=runInNewContext(strip(src)+'\n({PayrollGraph})',{
 URL,Response,Request,Headers,TextEncoder,TextDecoder,Uint8Array,performance,
 observeGraphTransfer:()=>{},observeGraphRetry:()=>{},setTimeout,clearTimeout,
 MicrosoftSignInRequiredError:class extends Error{},MicrosoftTemporaryError:class extends Error{},
});
const encoder=new TextEncoder();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const original='ciphertext-before';const updated='ciphertext-after';
const make=()=>{
 const state={text:original,etag:'version-old',writes:0,metadata:0,downloads:0,mutation:0,fail:false,
  pauseDownload:null,pausePut:null,putStarted:null,downloadStarted:null};
 const http=async(url,init={})=>{
  const method=(init.method??'GET').toUpperCase();
  if(new URL(url).origin === 'https://graph.microsoft.com'&&method==='GET'){
   state.metadata++;
   const current={id:'file-id',eTag:state.etag,size:encoder.encode(state.text).length,
    '@microsoft.graph.downloadUrl':'https://storage.example.test/download'};
   const conditional=init.headers?.['If-None-Match'];
   if(conditional===state.etag)return new Response(null,{status:304});
   return Response.json(current);
  }
  if(new URL(url).origin === 'https://graph.microsoft.com'&&method==='POST')
   return Response.json({uploadUrl:'https://storage.example.test/upload'});
  if(url==='https://storage.example.test/upload'&&method==='PUT'){
   state.putStarted?.resolve();
   if(state.pausePut)await state.pausePut.promise;
   state.writes++;
   if(state.fail)return new Response('simulated failure',{status:500});
   state.text=new TextDecoder().decode(init.body);state.etag='version-new';
   return Response.json({id:'file-id',size:encoder.encode(state.text).length},{status:200});
  }
  if(url==='https://storage.example.test/download'&&method==='GET'){
   state.downloads++;
   const observed=state.text;
   state.downloadStarted?.resolve();
   if(state.pauseDownload)await state.pauseDownload.promise;
   return new Response(observed,{headers:{'Content-Type':'application/octet-stream'}});
  }
  throw Error('unexpected mock HTTP call: '+method+' '+url);
 };
 const graph=new PayrollGraph('mock-token',http,()=>state.mutation++, undefined, undefined, false);
 graph.folder=async()=> 'folder-1';
 const parts=['payroll','statements'],name='2026.enc',limit=10_000;
 const read=()=>graph.read(parts,name,limit);
 const write=()=>graph.write(parts,name,updated,{id:'file-id',etag:original},limit);
 return {state,graph,http,read,write};
};
{
 // Exact origin matching prevents a misleading Graph-looking host from being
 // accepted by the in-memory mock Graph endpoint (GET and POST paths).
 const {state,http}=make();
 await assert.rejects(
  http('https://graph.microsoft.com.attacker.example/v1.0/me/drive',{method:'GET'}),
  /unexpected mock HTTP call/,
 );
 // A misleading URL with a Graph-looking username is still on the attacker's host.
 // Construct it through URL so the test source contains no email-shaped literal.
 const misleadingUserinfoUrl=new URL('https://attacker.example/v1.0/me/drive');
 misleadingUserinfoUrl.username='graph.microsoft.com';
 assert.equal(misleadingUserinfoUrl.hostname,'attacker.example');
 await assert.rejects(
  http(misleadingUserinfoUrl.href,{method:'POST'}),
  /unexpected mock HTTP call/,
 );
 assert.equal(state.metadata,0,'spoofed Graph origins must never serve fake metadata');
 console.log('PASS: mock Graph HTTP rejects misleading hostnames for GET and POST');
}
{
 const {state,read,write}=make();
 assert.equal((await read()).text,original);
 state.pauseDownload=deferred();state.pausePut=deferred();state.putStarted=deferred();state.downloadStarted=deferred();
 const pendingWrite=write();await state.putStarted.promise;
 const pendingRead1=read(),pendingRead2=read();
 await state.downloadStarted.promise;
 state.pausePut.resolve();await pendingWrite;
 state.pauseDownload.resolve();
 await assert.rejects(pendingRead1,/保存操作が始まりました|保存操作が完了しました/);
 await assert.rejects(pendingRead2,/保存操作が始まりました|保存操作が完了しました/);
 assert.equal((await read()).text,updated,'post-upload must read fresh ciphertext');
 assert.equal(state.mutation,2,'session start and upload completion invalidate navigation and read caches');
 console.log('PASS: final signed PUT invalidates in-flight reads and cached pre-upload ciphertext');
}
{
 const {state,read,write}=make();
 await read();
 state.fail=true;state.pauseDownload=deferred();state.pausePut=deferred();state.putStarted=deferred();state.downloadStarted=deferred();
 const saving=write();await state.putStarted.promise;
 const reading=read();await state.downloadStarted.promise;
 state.pausePut.resolve();await assert.rejects(saving,/HTTP 500/);
 state.pauseDownload.resolve();await assert.rejects(reading,/保存操作が始まりました|保存操作が完了しました/);
 assert.equal((await read()).text,original,'ambiguous upload failure must never reuse the pending pre-failure body');
 assert.equal(state.mutation,2,'failed upload invalidates both at start and at end');
 console.log('PASS: failed upload-session PUT invalidates overlapping GETs and cached ciphertext');
}
{
 const {state,read,graph}=make();
 state.downloadStarted=deferred();state.pauseDownload=deferred();
 const reading=read();await state.downloadStarted.promise;
 // Directly simulate a different short write finishing in the current tab.
 const direct=graph.write(['payroll','statements'],'new.enc','new-encrypted-file',null,1_000);
 // Fake server only needs to support short PUT for this check.
 await assert.rejects(direct,/unexpected mock HTTP call/);
 state.pauseDownload.resolve();await assert.rejects(reading,/保存操作が始まりました|保存操作が完了しました/);
 console.log('PASS: even a failed short-write path invalidates a pending read');
}
console.log('PASS: delayed HTTP graph upload epoch regression');
