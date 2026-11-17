/** Graphメタデータの一時的な不正JSONを安全に再取得する。PUT/POST/DELETEは再試行しない。 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result=await build({entryPoints:[new URL('../src/cloud/graph.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
const {PayrollGraph}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
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
 return {graph:new PayrollGraph('fake-token',fake),calls};
}
{
 const {graph,calls}=fixture({badFolder:2,badFile:2});
 const file=await graph.read(['payroll'],'2026.enc',1000);
 assert.equal(file?.text,'ciphertext-placeholder');
 assert.equal(calls.folder,3);
 assert.equal(calls.file,3);
 assert.equal(calls.nonGet,0);
}
{
 const {graph,calls}=fixture({badFile:5});
 await assert.rejects(graph.read(['payroll'],'2026.enc',1000),error=>{
  assert.match(error.message,/年度暗号ファイル情報の照会/);
  assert.match(error.message,/3回試行/);
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
