/** Read-only Graph throttling: Retry-After, transient HTTP status, 401 and signed URLs. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:[new URL('../src/cloud/graph.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
const {PayrollGraph,GraphError}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
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
