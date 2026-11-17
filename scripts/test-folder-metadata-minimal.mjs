/** Graph の versions はファイル履歴APIと衝突するため、IDベースで子フォルダーを検索する。 */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({
  entryPoints:[new URL('../src/cloud/graph.ts',import.meta.url).pathname],
  bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollGraph}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const BASE='https://graph.microsoft.com';
const DOWNLOAD='https://my.microsoftpersonalcontent.com/fixture-no-credential';
const E='encrypted-content';
const broken='{"value":['+' '.repeat(451); // HTTP 200だがJSONが461文字で途中終了
function fixture({malformed=false,missing=false,paged=false,create=false,unsafeNext=false,collision=false}={}){
  let lists=0, posts=0;
  const calls=[];
  const http=async (url,init={})=>{
    const method=init.method??'GET',u=new URL(url);
    calls.push({url:String(url),method});
    if(String(url)===DOWNLOAD) return new Response(E,{status:200,headers:{'content-type':'application/octet-stream'}});
    assert.equal(u.origin,BASE);
    const p=u.pathname;
    if(p==='/v1.0/me/drive/special/approot')return Response.json({id:'root'});
    if(p==='/v1.0/me/drive/items/root:/payroll')return Response.json({id:'payroll-id',folder:{}});
    // この経路が呼ばれたら、Graphのファイル履歴APIへ誤接続したことになる。
    if(p.includes(':/versions') || p.endsWith('/versions'))
      throw Error('Reserved Graph version-history endpoint was called');
    if(p==='/v1.0/me/drive/items/payroll-id/children'){
      if(method==='POST'){
        posts++;
        assert.equal(JSON.parse(init.body).name,'versions');
        return collision?Response.json({error:{code:'nameAlreadyExists'}},{status:409}):Response.json({id:'versions-id',name:'versions',folder:{}});
      }
      assert.equal(method,'GET');lists++;
      assert.equal(u.searchParams.get('$select'),'id,name,folder');
      if(malformed) return new Response(broken,{status:200,headers:{'content-type':'application/json'}});
      if(unsafeNext)return Response.json({value:[], '@odata.nextLink':'https://example.org/steal?token=x'});
      if(paged && lists===1)return Response.json({value:[{name:'other',id:'other',folder:{}}],
        '@odata.nextLink':`${BASE}${p}?$select=id,name,folder&$top=200&$skiptoken=opaque`});
      if(missing && !create)return Response.json({value:[]});
      if(collision && lists===1)return Response.json({value:[]});
      if(create && !collision && posts===0)return Response.json({value:[]});
      return Response.json({value:[{name:'versions',id:'versions-id',folder:{}}]});
    }
    if(p==='/v1.0/me/drive/items/versions-id:/generation-id')return Response.json({id:'gen-id',folder:{}});
    if(p==='/v1.0/me/drive/items/gen-id:/statements')return Response.json({id:'statements-id',folder:{}});
    if(p==='/v1.0/me/drive/items/statements-id:/2026.enc')return Response.json({id:'file-id',eTag:'etag',size:E.length,'@microsoft.graph.downloadUrl':DOWNLOAD});
    if(method==='PUT'&&p==='/v1.0/me/drive/items/versions-id:/test.enc:/content')
      return Response.json({id:'file-id',size:init.body.byteLength},{status:201});
    throw Error('Unexpected URL or method: '+method+' '+p);
  };
  return {graph:new PayrollGraph('fixture-token',http),calls,stats:()=>({lists,posts})};
}
{
  const {graph,calls,stats}=fixture();
  const result=await graph.read(['payroll','versions','generation-id','statements'],'2026.enc',2000);
  assert.equal(result?.text,E);
  assert.equal(stats().lists,1);
  assert.equal(calls.filter(c=>c.method!=='GET').length,0);
  assert.ok(calls.some(c=>c.url.includes('/payroll-id/children?$select=')));
  console.log('PASS: versions is found by parent-ID children, not Graph version-history route');
}
{
  const {graph,stats}=fixture({paged:true});
  const result=await graph.read(['payroll','versions','generation-id','statements'],'2026.enc',2000);
  assert.equal(result?.text,E);assert.equal(stats().lists,2);
  console.log('PASS: pagination finds the reserved-name folder on a later page');
}
{
  const {graph,calls}=fixture({missing:true});
  assert.equal(await graph.read(['payroll','versions'],'test.enc',2000),null);
  assert.ok(calls.every(c=>c.method==='GET'));
  console.log('PASS: missing folder is not created during a read');
}
{
  const {graph,stats}=fixture({create:true});
  await graph.write(['payroll','versions'],'test.enc','ciphertext',null,2000);
  assert.equal(stats().posts,1);
  console.log('PASS: missing versions folder can be created by ID-based parent POST');
}
{
  const {graph,stats}=fixture({create:true,collision:true});
  await graph.write(['payroll','versions'],'test.enc','ciphertext',null,2000);
  assert.equal(stats().posts,1);assert.ok(stats().lists>=2);
  console.log('PASS: folder creation conflict re-reads the actual named child');
}
{
  const {graph,calls,stats}=fixture({malformed:true});
  await assert.rejects(graph.read(['payroll','versions'],'test.enc',2000),e=>{
    assert.match(e.message,/保存世代フォルダー一覧の照会/);
    assert.match(e.message,/3回試行/);
    assert.doesNotMatch(e.message,/fixture-token|my\.microsoftpersonalcontent|value/);
    return true;
  });
  assert.equal(stats().lists,3);
  assert.ok(calls.every(c=>c.method==='GET'));
  console.log('PASS: malformed child-list metadata is retried read-only and fails closed');
}
{
  const {graph,calls}=fixture({unsafeNext:true});
  await assert.rejects(graph.read(['payroll','versions'],'test.enc',2000),/許可された範囲外/);
  assert.ok(calls.every(c=>new URL(c.url).hostname==='graph.microsoft.com'));
  console.log('PASS: external pagination URL is rejected without leaking authorization');
}
