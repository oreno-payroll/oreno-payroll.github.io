/** Phase 4 synthetic Microsoft Graph tests. No real account, PDF, network, or salary information. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({
 entryPoints:[new URL('../src/cloud/graph.ts',import.meta.url).pathname],
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollGraph,GraphError}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const SIGNED='https://storage.example.invalid/opaque-temporary-download';
const encode=new TextEncoder();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture({delayMs=0,force304=false,first401=false,first429=false}={}) {
 const events=[];
 let body='{"encrypted":"synthetic-A"}',tag='"etag-a"',exists=true;
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
     if(init.headers?.['If-None-Match'])conditional++;
     if(force304||init.headers?.['If-None-Match']===tag)return new Response(null,{status:304});
     return Response.json({id:'record',eTag:tag,size:encode.encode(body).byteLength,'@microsoft.graph.downloadUrl':SIGNED});
   }
   throw new Error('Unexpected synthetic URL');
 };
 const graph=new PayrollGraph(async()=>token,http,()=>{mutations++;},{
   invalidate(){},async refresh(){refreshes++;return (token='token-B');},
 }, undefined, false);
 const read=(limit=1024)=>graph.read(['payroll'],'2026.enc',limit);
 return {graph,read,events,stats:()=>({metaCalls,bodyCalls,conditional,mutations,refreshes}),
   change(text){body=text;tag='"etag-b"';},remove(){exists=false;},
   setHold(promise){holdMeta=promise;},
 };
}
// No cache entry: do not issue If-None-Match. After a verified initial ciphertext
// fetch, re-read issues a conditional GET. Only the 304 branch reuses bytes.
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
assert.match(src,/if\(!readonly&&!lockControl\)\{await this\.verifyWriteOwner\(\);if\(this\.writeOwner\)this\.writeAttempted=true;\}/);
assert.match(src,/if\(name!==PAYROLL_WRITE_LOCK_NAME&&!parts\.includes\('originals'\)\)this\.rememberEncryptedRead\(/);
assert.match(src,/readonly&&accept304&&r\.status===304/);
assert.match(src,/!parts\.includes\('originals'\)/);
assert.match(src,/await this\.readMetadata<Item>\(metadataPath,'年度暗号ファイル情報の照会',cached\.file\.etag\)/);
assert.match(src,/method:'PUT',credentials:'omit'/);
assert.match(src,/headers:\{'If-Match':item\.etag\}/);
console.log('PASS: PDF original bypass, write invalidation, If-Match and no-bearer upload invariant');
