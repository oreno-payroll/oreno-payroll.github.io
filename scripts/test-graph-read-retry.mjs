/** Graph read/retry and encrypted cache regression; synthetic HTTP only. */
import assert from 'node:assert/strict';
import {PayrollGraph,GraphError} from '../src/cloud/graph.ts';
import {noticeReason} from '../src/ui/notificationHistory.ts';
// Metadata JSON and missing files
{
const signed='https://my.microsoftpersonalcontent.com/test-safe-no-credentials';
function fixture({badFolder=0,badFile=0,notFound=false}={}) {
 const calls={folder:0,file:0,nonGet:0};
 const fake=async (url,init={})=>{
  const method=init.method??'GET';
  if(method!=='GET'){calls.nonGet++;throw new Error('読み取りテストで書き込みメソッドを検出');}
  if(url===signed)return new Response('ciphertext-placeholder',{status:200,headers:{'Content-Type':'application/octet-stream'}});
  const p=new URL(url).pathname;
  if(p.endsWith('/me/drive/special/approot'))return Response.json({id:'root'});
  if(p.endsWith('/me/drive/items/root:/payroll')){
   calls.folder++;
   return calls.folder<=badFolder ? new Response('{"id":"broken" ',{status:200,headers:{'Content-Type':'application/json'}}):Response.json({id:'folder'});
  }
  if(p.endsWith('/me/drive/items/folder:/2026.enc')){
   calls.file++;
   if(notFound)return Response.json({error:{code:'itemNotFound'}},{status:404});
   return calls.file<=badFile ? new Response('{"id":"broken","items":[}',{status:200,headers:{'Content-Type':'application/json'}}):Response.json({id:'file',eTag:'etag',size:22,'@microsoft.graph.downloadUrl':signed});
  }
  throw new Error('予想外のURL種別');
 };
 return {graph:new PayrollGraph('fake-token',fake, undefined, undefined, undefined, false),calls};
}
{
 const {graph,calls}=fixture({badFolder:2,badFile:2});
 const file=await graph.read(['payroll'],'2026.enc',1000);
 assert.equal(file?.text,'ciphertext-placeholder');
 assert.equal(calls.folder,3);
 assert.equal(calls.file,4); // includes post-download version check
 assert.equal(calls.nonGet,0);
}
{
 const {graph,calls}=fixture({badFile:5});
 await assert.rejects(graph.read(['payroll'],'2026.enc',1000),error=>{
  assert.match(error.message,/年度暗号ファイル情報の照会/);
  assert.match(error.message,/3回試行/);
  assert.equal(noticeReason(error),'graph-json');
  assert.doesNotMatch(error.message,/fake-token|my\.microsoftpersonalcontent\.com|broken/);
  return true;
 });
 assert.equal(calls.file,3);
 assert.equal(calls.nonGet,0);
}
{
 const {graph,calls}=fixture({notFound:true});
 assert.equal(await graph.read(['payroll'],'2026.enc',1000),null);
 assert.equal(calls.file,1,'404は通信エラーではなく不存在。リトライしない');
}
console.log('PASS: Graphメタデータの不正JSONはGETだけ最大3回再試行し、永続失敗では工程を特定。クラウド書き込みなし');
}

// Transient HTTP, token renewal and uncertain PUT
{
const ok=(data)=>Response.json(data);
const BASE='https://graph.microsoft.com/v1.0';
const path='/me/drive/special/approot';
{
 let calls=0;
 const graph=new PayrollGraph('test-token',async(url,init)=>{
  calls++;assert.equal(url,BASE+path);assert.equal(init.method,'GET');
  return calls===1?Response.json({error:{code:'tooManyRequests'}},{status:429,headers:{'Retry-After':'0'}}):ok({id:'root'});
 }, undefined, undefined, undefined, false);
 assert.equal(await graph.root(), 'root');
 assert.equal(calls,2,'429 with Retry-After=0 should repeat GET');
}
{
 let calls=0;
 const graph=new PayrollGraph('test-token',async()=>{
  calls++;return calls<3?Response.json({error:{code:'ServiceUnavailable'}},{status:503,headers:{'Retry-After':'0'}}):ok({id:'root'});
 }, undefined, undefined, undefined, false);
 assert.equal(await graph.root(), 'root');
 assert.equal(calls,3);
}
{
 let calls=0;
 const graph=new PayrollGraph('test-token',async()=>{
  calls++;return Response.json({error:{code:'tooManyRequests'}},{status:429,headers:{'Retry-After':'120'}});
 }, undefined, undefined, undefined, false);
 await assert.rejects(graph.root(),error=>error instanceof GraphError && error.status===429);
 assert.equal(calls,1,'when Retry-After exceeds cap, do not retry too early');
}
{
 let calls=0,renewals=0,invalidations=0;
 const graph=new PayrollGraph('token-old',async(_,init)=>{
  calls++;return init.headers.Authorization==='Bearer token-old'
   ? Response.json({error:{code:'Unauthenticated'}},{status:401}):ok({id:'root'});
 },()=>{}, {invalidate(){invalidations++;},async refresh(){renewals++;return 'token-new';}}, undefined, false);
 assert.equal(await graph.root(),'root');
 assert.deepEqual([calls,renewals,invalidations],[2,1,1]);
}
{
 let writes=0;
 const graph=new PayrollGraph('test-token',async(_,init)=>{
  if(init.method!=='PUT')return ok({id:'root'});
  writes++;return Response.json({error:{code:'throttled'}},{status:503,headers:{'Retry-After':'0'}});
 }, undefined, undefined, undefined, false);
 await assert.rejects(graph.write(['payroll'],'test.enc','cipher',null,1000),error=>error instanceof GraphError && error.status===503);
 assert.equal(writes,1,'never retry an uncertain PUT');
}
{
 let signedAttempts=0;
 const signedUrl='https://download.example.net/signed';
 const graph=new PayrollGraph('test-token',async(url,init)=>{
  if(url===signedUrl){signedAttempts++;assert.equal(init.headers?.Authorization,undefined,'signed URL must never receive bearer');
    return signedAttempts===1?Response.json({}, {status:503,headers:{'Retry-After':'0'}})
      :new Response('cipher',{status:200,headers:{'Content-Type':'application/octet-stream'}});}
  const p=new URL(url).pathname;
  if(p.endsWith('/me/drive/special/approot'))return ok({id:'root'});
  if(p.endsWith('/me/drive/items/root:/payroll'))return ok({id:'folder'});
  if(p.endsWith('/me/drive/items/folder:/test.enc'))return ok({id:'test-id',eTag:'etag',size:6,'@microsoft.graph.downloadUrl':signedUrl});
  throw new Error('unexpected Graph endpoint');
 }, undefined, undefined, undefined, false);
 const file=await graph.read(['payroll'],'test.enc',1000);
 assert.equal(file?.text,'cipher');assert.equal(signedAttempts,2);
}
console.log('PASS: throttled/read errors retry only GET with bounded Retry-After; upload never retried; signed download without bearer');
}

// Conditional reads, coalescing, mutation invalidation and confidentiality
{
const SIGNED='https://storage.example.invalid/opaque-temporary-download';
const encode=new TextEncoder();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture({delayMs=0,force304=false,first401=false,first429=false,failConditional=false,unsolicitedAfterConditional=false,ordinary200=false}={}) {
 const events=[];
 let body='{"encrypted":"synthetic-A"}',tag='"etag-a"',exists=true,itemId='record',reportSize=true;
 let metaCalls=0,bodyCalls=0,conditional=0,mutations=0,refreshes=0,token='token-A';
 let holdMeta=null;
 const http=async (url,init={})=>{
   const method=(init.method??'GET').toUpperCase();
   const u=new URL(url);events.push({path:u.pathname,method,authorization:init.headers?.Authorization??null,ifNoneMatch:init.headers?.['If-None-Match']??null,credentials:init.credentials??null});
   if(u.href===SIGNED){
     assert.equal(method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.headers?.Authorization,undefined,'a signed CDN must not receive a Graph token');
     bodyCalls++;if(delayMs)await pause(delayMs);
     return new Response(body,{status:200,headers:{'Content-Type':'application/octet-stream','Content-Length':String(encode.encode(body).byteLength)}});
   }
   assert.equal(u.hostname,'graph.microsoft.com');
   if(method==='PUT'){
     mutations++;return Response.json({id:'created',size:init.body.byteLength},{status:201});
   }
   assert.equal(method,'GET','writes other than explicit synthetic PUT are forbidden');
   if(u.pathname==='/v1.0/me/drive/special/approot')return Response.json({id:'root'});
   if(u.pathname==='/v1.0/me/drive/items/root:/payroll')return Response.json({id:'folder',folder:{}});
   if(u.pathname==='/v1.0/me/drive/items/folder:/2026.enc'){
     metaCalls++;
     if(delayMs)await pause(delayMs);
     if(holdMeta)await holdMeta;
     if(first401&&metaCalls===1)return Response.json({error:{code:'invalidAuthenticationToken'}},{status:401});
     if(first429&&metaCalls===1)return new Response(JSON.stringify({error:{code:'throttled'}}),{status:429,headers:{'Retry-After':'0'}});
     if(!exists)return Response.json({error:{code:'itemNotFound'}},{status:404});
     if(init.headers?.['If-None-Match']){conditional++;if(failConditional)throw new TypeError('synthetic browser rejects conditional response');}
     if(unsolicitedAfterConditional&&conditional)return new Response(null,{status:304});
     if(force304||!ordinary200&&init.headers?.['If-None-Match']===tag)return new Response(null,{status:304});
     return Response.json({id:itemId,eTag:tag,...(reportSize?{size:encode.encode(body).byteLength}:{}),'@microsoft.graph.downloadUrl':SIGNED});
   }
   throw new Error('Unexpected synthetic URL');
 };
 const graph=new PayrollGraph(async()=>token,http,()=>{mutations++;},{
   invalidate(){},async refresh(){refreshes++;return (token='token-B');},
 }, undefined, false);
 const read=(limit=1024)=>graph.read(['payroll'],'2026.enc',limit);
 return {graph,read,events,stats:()=>({metaCalls,bodyCalls,conditional,mutations,refreshes}),
   change(text){body=text;tag=tag==='"etag-a"'?'"etag-b"':'"etag-c"';},remove(){exists=false;},replaceId(){itemId='replacement';},hideSize(){reportSize=false;},
   setHold(promise){holdMeta=promise;},
 };
}
// No cache entry: do not issue If-None-Match. After a verified initial ciphertext
// fetch, re-read issues a conditional GET. An exact fresh 200 can also reuse the checked bytes.
{
 const f=fixture();const initial=await f.read();
 assert.equal(f.stats().metaCalls,2);assert.equal(f.stats().bodyCalls,1);
 assert.deepEqual(initial,{id:'record',etag:'"etag-a"',text:'{"encrypted":"synthetic-A"}',size:27});
 const unchanged=await f.read();assert.deepEqual(unchanged,initial);
 assert.deepEqual(f.stats(),{metaCalls:3,bodyCalls:1,conditional:1,mutations:0,refreshes:0});
 assert.ok(f.events.some(e=>e.ifNoneMatch==='"etag-a"'));
 f.change('{"encrypted":"synthetic-B"}');
 const changed=await f.read();assert.equal(changed.text,'{"encrypted":"synthetic-B"}');
 assert.equal(changed.etag,'"etag-b"');assert.equal(f.stats().bodyCalls,2,'changed ETag triggers full fresh signed ciphertext download');
 await f.read();assert.equal(f.stats().bodyCalls,2,'new ETag can also return 304');
}
console.log('PASS: first full ciphertext read; unchanged 304 skips signed download; ETag change fetches new encrypted body');
// Graph may return 200 for a valid conditional request. Reuse requires all
// three proof fields and the cached byte count, not ETag alone.
{
 const f=fixture({ordinary200:true});const initial=await f.read();
 assert.deepEqual(await f.read(),initial);assert.equal(f.stats().bodyCalls,1);
 f.replaceId();assert.equal((await f.read()).id,'replacement');assert.equal(f.stats().bodyCalls,2);
 f.hideSize();await f.read();await f.read();assert.equal(f.stats().bodyCalls,4,'unknown size never reuses a 200 response');
 f.remove();assert.equal(await f.read(),null);
}
console.log('PASS: HTTP 200 identical version reuse; different ID and missing size require a fresh download');
// A caller with a previously authenticated JSON version can combine metadata
// comparison and the changed-file download, retaining the post-download check.
{
 const f=fixture({failConditional:true});const prior=await f.read();
 const read=proof=>f.graph.readIfChanged(['payroll'],'2026.enc',1024,proof);
 assert.equal(await read(prior),undefined);
 assert.deepEqual(f.stats(),{metaCalls:3,bodyCalls:1,conditional:0,mutations:0,refreshes:0});
 f.change('{"encrypted":"synthetic-B"}');
 const changed=await read(prior);assert.equal(changed.etag,'"etag-b"');
 assert.equal(f.stats().metaCalls,5,'changed file needs only initial and post-download metadata');
 assert.equal(f.stats().bodyCalls,2);
 assert.equal(await read(changed),undefined);
 assert.equal((await read({...changed,size:undefined})).text,changed.text,'unknown size requires authenticated body');
 assert.equal((await read({...changed,id:'different'})).text,changed.text,'different item requires authenticated body');
 await assert.rejects(f.graph.readIfChanged(['payroll'],'2026.enc',5,changed),/容量|サイズ/);
 f.remove();assert.equal(await read(changed),null);
}
{
 const f=fixture();const prior=await f.read();let resume;
 f.setHold(new Promise(resolve=>{resume=resolve;}));
 const pending=f.graph.readIfChanged(['payroll'],'2026.enc',1024,prior);await pause(2);
 await f.graph.write(['payroll'],'different.enc','new encrypted blob',null,1024);
 resume();await assert.rejects(pending,/読み込み中に保存操作が完了/);
}
console.log('PASS: verified-version read avoids duplicate metadata on changed JSON, checks identity/size/404 and rejects raced writes');
// If the browser rejects a conditional cross-origin response, use an ordinary GET
// within the existing retry budget. Its response must undergo a complete fresh check.
{
 const f=fixture({failConditional:true});await f.read();f.change('{"encrypted":"synthetic-B"}');
 const changed=await f.read();assert.equal(changed.etag,'"etag-b"');assert.equal(changed.text,'{"encrypted":"synthetic-B"}');
 assert.equal(f.stats().conditional,1);assert.equal(f.stats().bodyCalls,2);assert.equal(f.stats().mutations,0);
 const again=await f.read();assert.deepEqual(again,changed);
 assert.equal(f.stats().conditional,1,'successful fallback must not repeat the rejected conditional route');
 f.change('{"encrypted":"synthetic-C"}');assert.equal((await f.read()).text,'{"encrypted":"synthetic-C"}');
 assert.equal(f.stats().conditional,1);assert.equal(f.stats().bodyCalls,3,'ordinary reads reuse identical ID/ETag/size; changed ciphertext is downloaded');
 const rejected=fixture({failConditional:true,unsolicitedAfterConditional:true});await rejected.read();
 await assert.rejects(rejected.read(),e=>e instanceof GraphError&&e.status===304);
 assert.equal(rejected.stats().bodyCalls,1);
}
// If the server mistakenly returns 304 to an unconditional GET, it is NOT a hit:
// without local ciphertext, HTTP 304 must fail and not return a fake empty file.
{
 const f=fixture({force304:true});
 await assert.rejects(f.read(),e=>e instanceof GraphError&&e.status===304);
 assert.equal(f.stats().bodyCalls,0);
}
// Missing file must invalidate any previously cached ciphertext, and a second
// read cannot resurrect deleted content.
{
 const f=fixture();await f.read();f.remove();
 assert.equal(await f.read(),null);assert.equal(await f.read(),null);
 assert.equal(f.stats().bodyCalls,1);
}
console.log('PASS: unsolicited 304 and removed files fail closed; never return orphaned cached ciphertext');
// A single concurrent read for N callers avoids N metadata requests AND N
// signed downloads. A different limit is never allowed to reuse a lax promise.
{
 const f=fixture({delayMs:15});
 const results=await Promise.all(Array.from({length:7},()=>f.read()));
 assert.equal(results.length,7);assert.equal(f.stats().metaCalls,2);assert.equal(f.stats().bodyCalls,1);
 assert.ok(results.every(r=>r?.etag==='"etag-a"'));
 const strict=await f.read(5).then(()=>false,()=>true);assert.equal(strict,true,'per-call size limit is enforced even with cached data');
}
// A strict read and a normal read started together must use distinct promises.
{
 const f=fixture({delayMs:10});
 const [strict,normal]=await Promise.allSettled([f.read(5),f.read(1024)]);
 assert.equal(strict.status,'rejected');assert.match(String(strict.reason),/容量|サイズ/);
 assert.equal(normal.status,'fulfilled');assert.equal(normal.value.text,'{"encrypted":"synthetic-A"}');
 assert.equal(f.stats().metaCalls,3,'different limits are never coalesced');
}
console.log('PASS: seven same-file parallel requests collapse into one pair of metadata GETs plus one encrypted download; strict limits preserved');
// Every write invalidates the encrypted in-memory cache before executing the
// non-idempotent PUT. No mutation is retried behind an optimization.
{
 const f=fixture();await f.read();await f.read();
 const before=f.stats();assert.equal(before.bodyCalls,1);
 await f.graph.write(['payroll'],'different.enc','encrypted synthetic payload',null,1024);
 const latest=await f.read();assert.equal(latest.etag,'"etag-a"');
 assert.equal(f.stats().bodyCalls,2,'after a local mutation no stale ciphertext is served');
 assert.equal(f.stats().conditional,1,'the post-mutation metadata query is unconditional');
 assert.ok(f.stats().mutations>=1);
}
// A mutation while an ETag conditional GET is in-flight must NOT let the old
// GET publish a cached payload, even if that HTTP request eventually returns 304.
{
 const f=fixture();await f.read();
 let resume;const hold=new Promise(resolve=>{resume=resolve;});f.setHold(hold);
 const pending=f.read();await pause(2);
 await f.graph.write(['payroll'],'different.enc','new encrypted blob',null,1024);
 resume();
 await assert.rejects(pending,/読み込み中に保存先の状態が変更/);
 f.setHold(null);await f.read();assert.equal(f.stats().bodyCalls,2);
}
console.log('PASS: writes invalidate cache; raced 304 fails closed; no plaintext, credentials or immutable PDFs cached');
// A token expiry or a throttle does not convert into a synthetic cache hit.
for(const options of [{first401:true},{first429:true}]){
 const f=fixture(options);
 const v=await f.read();assert.equal(v.etag,'"etag-a"');
 assert.equal(f.stats().metaCalls,3);assert.equal(f.stats().bodyCalls,1);
 if(options.first401)assert.equal(f.stats().refreshes,1);
}
console.log('PASS: read-only Graph 401 token refresh and 429 bounded retry continue to fetch verified ciphertext');
// Static confidentiality and mutation invariants deliberately cover non-Graph paths.
const {readFileSync}=await import('node:fs');
const src=readFileSync(new URL('../src/cloud/graph.ts',import.meta.url),'utf8');
assert.match(src,/if\(!readonly&&!lockControl\)\{this\.requireWriteOwner\(\);this\.clearEncryptedReadCache\(\);this\.onMutation\(\);\}/);
assert.match(src,/if\(!readonly&&!lockControl\)\{await this\.clearCheckpointBeforeWrite\(\);await this\.verifyWriteOwner\(\);if\(this\.writeOwner\)\{this\.writeAttempted=true;this\.writeSerial\+\+;\}\}/);
assert.match(src,/if\(name!==PAYROLL_WRITE_LOCK_NAME&&!parts\.includes\('originals'\)\)this\.rememberEncryptedRead\(/);
// Unsolicited 304 rejection is exercised above, including the fallback GET.
assert.match(src,/await this\.readMetadata<Item>\(metadataPath,'年度暗号ファイル情報の照会',cached\.file\.etag\)/);
assert.match(src,/method:'PUT',credentials:'omit'/);
assert.match(src,/headers:\{'If-Match':item\.etag\}/);
console.log('PASS: PDF original bypass, write invalidation, If-Match and no-bearer upload invariant');
}

// Exercise actual header/body deadlines without waiting production intervals.
{
 const nativeSet=globalThis.setTimeout;
 globalThis.setTimeout=(fn,ms,...args)=>nativeSet(fn,ms>=30000?12:1,...args);
 try{
  for(const stage of ['headers','body']){
   let requests=0,canceled=0;
   const graph=new PayrollGraph('synthetic',async(_url,init)=>{
    requests++;assert.equal(init.method,'GET');
    if(stage==='headers')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{canceled++;reject(init.signal.reason);},{once:true}));
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){canceled++;}}),{headers:{'Content-Type':'application/json'}});
   },undefined,undefined,undefined,false);
   await assert.rejects(graph.root());assert.equal(requests,3);assert.equal(canceled,3);
  }
 }finally{globalThis.setTimeout=nativeSet;}
 console.log('PASS: bounded header and response-body deadlines abort all three read attempts');
}

// File-distribution and Graph HTTP failures must not be conflated.
{
 const signed='https://storage.example.invalid/synthetic';
 for(const [response,expected] of [[()=>new Response(null,{status:403}),'download-http:403'],[()=>new Response('<html>',{headers:{'Content-Type':'text/html'}}),'download-html'],[()=>new Response('different-size'),'download-size-mismatch']]){
  const graph=new PayrollGraph('synthetic-token',async url=>{
   if(url===signed)return response();
   if(url.endsWith('/special/approot'))return Response.json({id:'root'});
   if(url.includes('root:/payroll'))return Response.json({id:'folder'});
   return Response.json({id:'file',eTag:'etag',size:6,'@microsoft.graph.downloadUrl':signed});
  },undefined,undefined,undefined,false);
  await assert.rejects(graph.read(['payroll'],'index.enc',100),e=>noticeReason(e)===expected);
 }
}

// Every actual transfer is logged automatically, including signed transfers,
// retries and failures; no operation begin/finish is needed for these events.
{
 const {beginPerfOperation}=await import('../src/cloud/perf.ts');
 const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),originalInfo=console.info;
 let enabled=false,logs=[],calls=0;
 const signed='https://storage.example.invalid/synthetic-private-path';
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:key=>key==='payroll-perf-diagnostics'&&enabled?'1':null}});
 console.info=(...args)=>logs.push(args);
 try{
  const graph=new PayrollGraph('synthetic-secret',async(url,init)=>{
   calls++;
   if(url===signed&&init.method==='PUT')return Response.json({id:'synthetic-private-id'});
   if(url===signed)return new Response('synthetic-ciphertext');
   if(calls===2)return new Response(null,{status:429,headers:{'Retry-After':'0'}});
   if(url.endsWith('/failure'))throw new TypeError('synthetic-secret URL '+signed);
   return Response.json({id:'synthetic-private-id'});
  },undefined,undefined,undefined,false);
  await graph.request('/off');assert.equal(logs.length,0);
  enabled=true;
  // No operation summary exists yet, but requests and retries are recorded.
  await graph.request('/retry');
  assert.deepEqual(logs.map(x=>x[0]),['[Payroll transfer]','[Payroll retry]','[Payroll transfer]']);
  assert.equal(JSON.parse(logs[0][1]).httpStatus,429);
  assert.equal(JSON.parse(logs[2][1]).httpStatus,200);
  const op=beginPerfOperation('payroll-edit-load');
  await op.measure('edit-access',()=>graph.request('/ordinary'));
  await graph.download(signed,100);
  await graph.fetchGraphResponse(signed,{method:'PUT'},30000,'encrypted-upload');
  op.finish(true);op.finish(false);
  const summary=JSON.parse(logs.at(-1)[1]);
  assert.deepEqual([summary.graphRequests,summary.encryptedDownloads,summary.encryptedUploads,summary.retries],[1,1,1,0]);
  assert.equal(summary.phases['edit-access'].calls,1);
  await graph.request('/me/drive/items/synthetic-private-id:/index.enc');
  assert.equal(JSON.parse(logs.at(-1)[1]).category,'index');
  await assert.rejects(graph.request('/failure',{method:'POST'}));
  assert.equal(JSON.parse(logs.at(-1)[1]).outcome,'transport-error');
  assert.equal(JSON.parse(logs.at(-1)[1]).httpStatus,null);
  for(const [label,json] of logs){
   assert.equal(typeof json,'string');assert.doesNotThrow(()=>JSON.parse(json));
   assert.match(label,/^\[Payroll (transfer|retry|performance)\]$/);
   assert.doesNotMatch(json,/https?:|synthetic-secret|synthetic-private|synthetic-ciphertext|Authorization/);
  }
  const before=logs.length;enabled=false;await graph.request('/off');assert.equal(logs.length,before);
  enabled=true;console.info=()=>{throw Error('diagnostic sink failed');};
  await graph.request('/logging-failed');
 }finally{
  console.info=originalInfo;
  if(originalStorage)Object.defineProperty(globalThis,'sessionStorage',originalStorage);else delete globalThis.sessionStorage;
 }
 console.log('PASS: opt-in automatic JSON transfer logs, retry and upload coverage, privacy, OFF and non-interference');
}

// The same logical file is read via a validated relative path from the known
// payroll/generation ID, not by removing the final live file-version check.
{
 const generation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.enc';
 const signed='https://storage.example.invalid/synthetic-read-only', body='synthetic encrypted content';
 const make=(versioned=false)=>{
  const calls=[];let race=false,seen=0,downloads=0;
  const graph=new PayrollGraph('fixture',async(raw,init={})=>{
   assert.equal(init.method??'GET','GET');
   if(raw===signed){downloads++;assert.equal(init.credentials,'omit');return new Response(body);}
   const path=new URL(raw).pathname;calls.push(path);
   if(path.endsWith('/special/approot'))return Response.json({id:'root'});
   if(path.endsWith('/root:/payroll'))return Response.json({id:'payroll-id',folder:{}});
   if(path.endsWith('/payroll-id/children'))return Response.json({value:[{id:'versions-id',name:'versions',folder:{}}]});
   if(path.endsWith('/versions-id:/'+generation))return Response.json({id:'gen-id',folder:{}});
   const parent=versioned?`versions-id:/${generation}`:'payroll-id:';
   if(path.endsWith(`/${parent}/originals/2026/05/${name}`)||path.endsWith(`/${parent}/statements/2026.enc`)||path.endsWith(`/${parent}/income/2026.enc`)){
    seen++;return Response.json({id:'file-id',eTag:race&&seen%2===0?'changed':'version',size:body.length,'@microsoft.graph.downloadUrl':signed});
   }
   throw new Error('unexpected intermediate folder lookup');
  },undefined,undefined,undefined,false);
  const base=versioned?['payroll','versions',generation]:['payroll'];
  return {graph,calls,base,downloadCount:()=>downloads,enableRace(){race=true;seen=0;}};
 };
 for(const versioned of [false,true]){
  const f=make(versioned),parts=[...f.base,'originals','2026','05'];
  assert.equal((await f.graph.read(parts,name,1024,true)).text,body);
  assert.equal(f.calls.length,versioned?5:4,'reserved folder and two file observations only');
  await f.graph.read(parts,name,1024,true);assert.equal(f.downloadCount(),2,'original ciphertext is never cached');
  const annual=await f.graph.read([...f.base,'statements'],'2026.enc',1024,true);
  assert.equal(annual.text,body);
  assert.equal(await f.graph.readIfChanged([...f.base,'statements'],'2026.enc',1024,annual,true),undefined);
  assert.equal((await f.graph.read([...f.base,'income'],'2026.enc',1024,true)).text,body);
  f.enableRace();await assert.rejects(f.graph.read(parts,name,1024,true),/世代が変更/);
  await assert.rejects(f.graph.read([...f.base,'originals','2026','..'],name,1024,true),/直接参照先/);
 }
 console.log('PASS: direct original/annual path, reserved generation lookup, no original cache, post-download version check and invalid path rejection');
}

{
 const generation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',person='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',year='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const signed='https://storage.example.invalid/fixture',body='synthetic encrypted content',calls=[];
 let badPage=false,missing=false;
 const graph=new PayrollGraph('fixture',async(raw,init={})=>{
  assert.equal(init.method??'GET','GET');
  if(raw===signed)return new Response(body);
  const u=new URL(raw),path=u.pathname;calls.push(path);
  if(path.endsWith('/special/approot'))return Response.json({id:'root'});
  if(path.endsWith('/root:/payroll'))return Response.json({id:'payroll',folder:{}});
  if(path.endsWith('/payroll/children'))return Response.json({value:[{id:'versions',name:'versions',folder:{}}]});
  const base=`/versions:/${generation}`;
  if(path.endsWith(base+'/statements'))return Response.json({id:'statements',name:'statements',folder:{}});
  if(path.endsWith('/statements/children')){
   if(u.searchParams.has('$skiptoken'))return Response.json({value:[{id:'b',name:'2025.enc',file:{},eTag:'2',size:10}]});
   return Response.json({value:[{id:'a',name:'2026.enc',file:{},eTag:'1',size:10}], '@odata.nextLink':badPage?'https://example.invalid/not-allowed':`https://graph.microsoft.com/v1.0/me/drive/items/statements/children?$skiptoken=fixture`});
  }
  if([base+'/year-end-assist/index.enc',base+`/year-end-assist/persons/${person}/profile.enc`,base+`/year-end-assist/persons/${person}/years/${year}.enc`].some(s=>path.endsWith(s))){
   if(missing)return new Response('',{status:404});
   return Response.json({id:path.split('/').at(-1),eTag:'fixture',size:body.length,'@microsoft.graph.downloadUrl':signed});
  }
  throw Error('unexpected intermediate folder');
 },undefined,undefined,undefined,false);
 const base=['payroll','versions',generation],assist=[...base,'year-end-assist'];
 assert.equal((await graph.read(assist,'index.enc',1024,true)).text,body);
 assert.equal(calls.length,5,'three root/reserved lookups plus two index version checks');
 const before=calls.length;
 const profile=await graph.read([...assist,'persons',person],'profile.enc',1024,true);
 assert.equal((await graph.read([...assist,'persons',person,'years'],year+'.enc',1024,true)).text,body);
 assert.equal(calls.length-before,4,'no extra year-end/person/generation folder lookup');
 assert.equal(await graph.readIfChanged([...assist,'persons',person],'profile.enc',1024,profile,true),undefined);
 missing=true;assert.equal(await graph.read(assist,'index.enc',1024,true),null);missing=false;
 const beforeList=calls.length;
 assert.equal((await graph.listFolder([...base,'statements'],false,true)).length,2);
 assert.equal(calls.length-beforeList,3,'one direct folder lookup and both inventory pages');
 badPage=true;await assert.rejects(graph.listFolder([...base,'statements'],false,true),/ページングURL/);
 console.log('PASS: direct generation-relative year-end and display inventory paths, reserved-name handling, pagination and missing file safety');
}

// Some browser adapters expose an empty stream even for a bodyless response.
// A successful lock DELETE must not be reconstructed with a forbidden body.
{
 const calls=[];
 const graph=new PayrollGraph('fixture',async(_url,init)=>{
  calls.push(init.method);
  const result=new Response(new Uint8Array(0),{status:200});
  Object.defineProperty(result,'status',{value:204});
  return result;
 },undefined,undefined,undefined,false);
 const response=await graph.request('/me/drive/items/synthetic-lock',{method:'DELETE'},false,undefined,true);
 assert.equal(response.status,204);assert.deepEqual(calls,['DELETE']);
 console.log('PASS: bodyless DELETE 204 is not reconstructed with a forbidden response body');
}

// Strict inventory uses the same folder-ID cache as before, but resolves the
// fixed generation/month path without walking every intermediate folder.
{
 const generation='11111111-1111-4111-8111-111111111111',uuid='22222222-2222-4222-8222-222222222222';
 const parts=['payroll','versions',generation,'originals','2026','05'];
 const calls=[];let badPage=false;
 const graph=new PayrollGraph('fixture-token',async(url,init)=>{
  const u=new URL(url),p=u.pathname;calls.push(p);assert.equal(init.method,'GET');
  if(p.endsWith('/special/approot'))return Response.json({id:'root'});
  if(p.endsWith('/items/root:/payroll'))return Response.json({id:'payroll-id',folder:{}});
  if(p.endsWith('/items/payroll-id/children'))return Response.json({value:[{name:'versions',id:'versions-id',folder:{}}]});
  if(p.endsWith(`/items/versions-id:/${generation}/originals/2026/05`))return Response.json({id:'month-id',name:'05',folder:{}});
  if(p.endsWith('/items/month-id/children'))return Response.json({value:[{id:'original-id',name:uuid+'.enc',eTag:'original-tag',size:100,file:{}}],...(badPage?{'@odata.nextLink':'https://example.invalid/unsafe'}:{})});
  if(p.endsWith(`/items/versions-id:/${generation}/originals/2026/05/${uuid}.enc`))return Response.json({id:'original-id',eTag:'original-tag',size:100,file:{}});
  if(p.endsWith(`/items/versions-id:/${generation}/statements`))return Response.json({id:'statements-id',name:'statements',folder:{}});
  if(p.endsWith('/items/statements-id/children'))return Response.json({value:[]});
  throw Error('unexpected fixture request');
 },undefined,undefined,undefined,false);
 const first=await graph.listFolder(parts,false,'strict');assert.equal(first[0].id,'original-id');assert.equal(calls.length,5);
 const before=calls.length;await graph.listFolder(parts,false,'strict');assert.equal(calls.length-before,1);
 assert.deepEqual(await graph.metadata(parts,uuid+'.enc',true),{id:'original-id',etag:'original-tag',size:100});
 assert.equal(calls.length-before,2);
 const start=calls.length;await graph.listFolder(['payroll','versions',generation,'statements'],false,'strict');assert.equal(calls.length-start,2);
 badPage=true;await assert.rejects(graph.listFolder(parts,false,'strict'),/ページングURL/);
 assert.ok(calls.every(p=>!p.endsWith('/versions')));
 console.log('PASS: direct strict inventory, repeated listing uses cached folder ID, original metadata and unsafe pagination rejection');
}

// Warm display inventory reads the live relative path, not a cached statements
// folder ID. An incomplete page is discarded without following its nextLink.
{
 const generation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',calls=[];let nextPage=false,missing=false;
 const graph=new PayrollGraph('fixture',async(raw,init={})=>{
  assert.equal(init.method??'GET','GET');const u=new URL(raw);calls.push(u.pathname);
  if(u.pathname.endsWith('/special/approot'))return Response.json({id:'root'});
  if(u.pathname.endsWith('/root:/payroll'))return Response.json({id:'payroll',folder:{}});
  if(u.pathname.endsWith('/payroll/children'))return Response.json({value:[{id:'versions',name:'versions',folder:{}}]});
  if(u.pathname.endsWith('/payroll:/index.enc'))return Response.json({id:'index',eTag:'1',size:10});
  if(u.pathname.endsWith('/versions:/'+generation+'/statements/2026.enc'))return Response.json({id:'annual',eTag:'1',size:10});
  if(u.pathname.endsWith('/payroll:/statements:/children')||u.pathname.endsWith('/versions:/'+generation+'/statements:/children')){
   if(missing)return new Response('',{status:404});
   return Response.json({value:[{id:'annual',name:'2026.enc',eTag:'1',size:10,file:{}}],...(nextPage?{'@odata.nextLink':'https://example.invalid/no-follow'}:{})});
  }
  throw Error('unexpected folder lookup or continuation');
 },undefined,undefined,undefined,false);
 assert.equal(await graph.listFolder(['payroll','statements'],false,'display'),null);assert.equal(calls.length,0);
 await graph.metadata(['payroll'],'index.enc');
 let before=calls.length;assert.equal((await graph.listFolder(['payroll','statements'],false,'display')).length,1);assert.equal(calls.length-before,1);
 const base=['payroll','versions',generation,'statements'];await graph.metadata(base,'2026.enc',true);
 before=calls.length;assert.equal((await graph.listFolder(base,false,'display')).length,1);assert.equal(calls.length-before,1);
 nextPage=true;before=calls.length;assert.equal(await graph.listFolder(base,false,'display'),null);assert.equal(calls.length-before,1);
 nextPage=false;missing=true;assert.equal(await graph.listFolder(base,false,'display'),null);
 await assert.rejects(graph.listFolder(['payroll','originals'],false,'display'),/直接参照先/);
 console.log('PASS: warm path-addressed inventory, reserved generation anchor, incomplete page and unavailable path fall back safely');
}
