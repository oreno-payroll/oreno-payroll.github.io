/** ネットワークや実給与を使わない暗号・3way merge・Graph認証テスト */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
async function moduleFromSource(relative) {
 const result=await build({entryPoints:[new URL('../'+relative,import.meta.url).pathname],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const c=await moduleFromSource('src/cloud/crypto.ts');
const key=await c.deriveKey('long-passphrase-for-tests',c.createSalt());
const index=await c.encryptJson('index',{format:'payroll-index-v1',years:['2026'],incomeYears:[]},key,c.createSalt());
assert.equal((await c.decryptJson('index',index,key)).years[0],'2026');
await assert.rejects(c.decryptJson('income',index,key),/形式または用途/,'用途別AADを分離する');
const pdf=new Uint8Array([37,80,68,70,45,49,46,52,0,5,12,255]);
const enc=await c.encryptBytes('original',pdf,key);
assert.deepEqual([...await c.decryptBytes('original',enc,key)],[...pdf]);
assert.notEqual(enc,await c.encryptBytes('original',pdf,key),'暗号化ごとに新しいIVを使う');
const tampered=JSON.parse(enc);tampered.data=tampered.data.slice(0,-5)+'AAAAA';
await assert.rejects(c.decryptBytes('original',JSON.stringify(tampered),key));
const orig=await moduleFromSource('src/cloud/vault.ts');
const base={format:'payroll-annual-v1',records:[],deleted:[]};
const record=(id,gross)=>({id,fileName:`${id}.pdf`,originalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',originalMonth:'2026-11',pdfSize:12,pdfType:'application/pdf',savedAt:'2026-11-16',pages:1,warningsAcknowledged:true,form:{job:'main',kind:'salary',targetMonth:'2026-11',paymentDate:'2026-11-27',gross:String(gross),net:String(gross)}});
const a={...base,records:[record(1,100)]};
const b={...base,records:[record(2,200)]};
assert.deepEqual(orig.mergeAnnual(base,a,b).records.map(r=>r.id).sort(),[1,2]);
const changeA={...a,records:[{...record(1,100),form:{...record(1,100).form,gross:'150'}}]};
const changeB={...a,records:[{...record(1,100),form:{...record(1,100).form,net:'160'}}]};
const merged=orig.mergeAnnual(a,changeA,changeB).records[0];
assert.equal(merged.form.gross,'150');assert.equal(merged.form.net,'160');
const clash={...a,records:[{...record(1,100),form:{...record(1,100).form,gross:'900'}}]};
assert.throws(()=>orig.mergeAnnual(a,changeA,clash),/別端末/);
console.log('PASS: Payroll専用暗号形式、AAD、IV、改ざん検出、ID単位マージ、同一フィールド衝突');
// Index corruption, invalid salt and legitimate key rotation are deliberately
// indistinguishable to a browser remembered key. Do not delete it on failed reads.
{
 const rememberedSalt=c.createSalt();
 const rememberedKey=await c.deriveKey('browser-key-preservation-test',rememberedSalt);
 const indexText=await c.encryptJson('index',{format:'payroll-index-v1',years:[],incomeYears:[]},rememberedKey,rememberedSalt);
 let remote=indexText;
 const graph={async read(parts,name){assert.deepEqual(parts,['payroll']);assert.equal(name,'index.enc');return {id:'index',etag:'e',text:remote,size:remote.length};}};
 const candidate=new orig.PayrollVault(graph);
 await candidate.unlockWithKey(rememberedKey,rememberedSalt);
 const wrongSalt=c.createSalt();
 remote=await c.encryptJson('index',{format:'payroll-index-v1',years:[],incomeYears:[]},rememberedKey,wrongSalt);
 await assert.rejects(candidate.unlockWithKey(rememberedKey,rememberedSalt),/記憶鍵は削除していません/,'salt mismatch is inconclusive');
 const tampered=JSON.parse(indexText);
 tampered.data=(tampered.data[0]==='A'?'B':'A')+tampered.data.slice(1);
 remote=JSON.stringify(tampered);
 await assert.rejects(candidate.unlockWithKey(rememberedKey,rememberedSalt),/記憶鍵は削除していません/,'ciphertext corruption cannot revoke a saved key');
 remote=indexText;
 await candidate.unlockWithKey(rememberedKey,rememberedSalt);
 assert.equal(candidate.isUnlocked(),true,'repaired index can reopen with original key');
}
console.log('PASS: corrupt index and salt changes preserve the recovery key; repaired index reopens');


// OneDrive Personal の署名付きダウンロードURLを全画面のCSPで許可する。
// Graphから返される実ファイル配信先は graph.microsoft.com とは限らない。
for (const page of [
  'public/index.html', 'public/upload/index.html', 'public/edit/index.html',
  'public/view/index.html', 'public/backup/index.html',
]) {
  const html = readFileSync(new URL('../' + page, import.meta.url), 'utf8');
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  assert.ok(csp, `${page}: CSP metaが見つかりません`);
  const connect = csp.split(';').find(part => part.trim().startsWith('connect-src '));
  assert.ok(connect, `${page}: connect-srcが見つかりません`);
  assert.match(connect, /(?:^|\s)https:\/\/my\.microsoftpersonalcontent\.com(?:\s|$)/,
    `${page}: OneDrive Personal配信先が許可されていません`);
  assert.doesNotMatch(connect, /(?:^|\s)\*(?:\s|$)/, `${page}: connect-srcの全面許可は認めません`);
}

// OneDriveの初回/既存ファイル判定：HTML成功応答とサイズ不整合を暗号JSONと混同しない。
const graphModule = await moduleFromSource('src/cloud/graph.ts');
const makeGraph = (source, metaSize) => {
  const signed = 'https://my.microsoftpersonalcontent.com/safe-test-path';
  const fake = async (url, options) => {
    if (url.endsWith('/me/drive/special/approot')) return Response.json({id:'root'});
    if (url.includes(':/payroll')) return Response.json({id:'folder'});
    if (url.includes(':/index.enc')) return Response.json({
      id:'file', eTag:'etag', size:metaSize, '@microsoft.graph.downloadUrl':signed,
    });
    if (url === signed) return new Response(source.body, {
      status:200, headers:{'Content-Type':source.mime},
    });
    throw Error('想定外のテスト通信: '+url.split('?')[0]);
  };
  return new graphModule.PayrollGraph('test-token',fake);
};
const htmlBody='<html><title>Sign in</title></html>';
await assert.rejects(
  makeGraph({body:htmlBody,mime:'text/html'},htmlBody.length).read(['payroll'],'index.enc',1_000_000),
  /HTMLを返しました/,
);
await assert.rejects(
  makeGraph({body:'{wrong',mime:'application/octet-stream'},34).read(['payroll'],'index.enc',1_000_000),
  /ファイルサイズが一致しません/,
);
const validEnvelope=await c.encryptJson('index',{format:'payroll-index-v1',years:[],incomeYears:[]},key,c.createSalt());
const validRead=await makeGraph({body:validEnvelope,mime:'application/octet-stream'},new TextEncoder().encode(validEnvelope).length)
  .read(['payroll'],'index.enc',1_000_000);
assert.equal((await c.decryptJson('index',validRead.text,key)).format,'payroll-index-v1');
assert.match(await c.decryptJson('index','\uFEFF'+validEnvelope,key).then(()=>'ok'),/ok/);
assert.throws(()=>c.parseEnvelope(htmlBody,'index'),/判定: HTML\/XML/);
assert.throws(()=>c.parseEnvelope('', 'index'),/判定: 空ファイル/);
assert.throws(()=>c.parseEnvelope('{broken', 'index'),/判定: 壊れたJSON/);
console.log('PASS: OneDrive配信HTML・サイズ違い・BOM・正常JSONの切り分け');

// 初回作成が中断して残った空索引のみを退避する。削除や他データ上書きは禁止。
const createZeroIndexMock = ({extra=false, indexBytes='', metadataSize=0} = {}) => {
 let archived=false, patchCount=0, putCount=0;
 const urls=[], signed='https://my.microsoftpersonalcontent.com/empty-test';
 const mock = async (url, init={}) => {
  urls.push({url,method:init.method??'GET'});
  if(url.endsWith('/me/drive/special/approot')) return Response.json({id:'root'});
  if(url.includes(':/payroll')) return Response.json({id:'folder'});
  if(url.includes('/children?')) return Response.json({value:[
   ...(archived?[]:[{id:'file',name:'index.enc',size:metadataSize,eTag:'e1'}]),
   ...(extra?[{id:'other',name:'statements',size:0,eTag:'d1'}]:[]),
  ]});
  if(url.includes(':/index.enc') && !url.includes('/content?')) return archived ? new Response('{}',{status:404}) :
   Response.json({id:'file',eTag:'e1',size:metadataSize,'@microsoft.graph.downloadUrl':signed});
  if(url===signed)return new Response(indexBytes,{status:200,headers:{'Content-Type':'application/octet-stream'}});
  if(url.endsWith('/me/drive/items/file')&&init.method==='PATCH') {
   patchCount++;
   assert.equal(init.headers['If-Match'],'e1');
   const name=JSON.parse(init.body).name;
   assert.match(name,/^index-empty-.*\.enc$/);
   archived=true;
   return Response.json({id:'file',name});
  }
  if(url.includes(':/content?')&&init.method==='PUT') {
   putCount++;
   assert.match(url,/@microsoft.graph.conflictBehavior=fail/);
   assert.ok(init.body.byteLength>0);
   const text=new TextDecoder().decode(init.body);
   assert.equal(JSON.parse(text).format,'payroll-cloud-envelope-v1');
   return Response.json({id:'new',size:init.body.byteLength},{status:201});
  }
  throw Error('予期しないクラウド通信: '+url.split('?')[0]);
 };
 return {graph:new graphModule.PayrollGraph('fake-token',mock),stats:()=>({patchCount,putCount,urls})};
};
{
 const {graph,stats}=createZeroIndexMock();
 await assert.rejects(new orig.PayrollVault(graph).unlock('safe-test-passphrase',false), e=>e instanceof orig.EmptyPayrollIndexError);
 const archivedName=await graph.archiveEmptyIndex();
 assert.match(archivedName,/^index-empty-.*\.enc$/);
 assert.equal(stats().patchCount,1);
 assert.equal(await graph.read(['payroll'],'index.enc',1_000_000),null);
 await graph.write(['payroll'],'index.enc',validEnvelope,null,1_000_000);
 assert.equal(stats().putCount,1);
 assert.ok(stats().urls.every(x=>x.method!=='DELETE'));
}
{
 const {graph,stats}=createZeroIndexMock({extra:true});
 await assert.rejects(graph.archiveEmptyIndex(),/空の索引以外のデータ/);
 assert.equal(stats().patchCount,0);
}
{
 const {graph,stats}=createZeroIndexMock({indexBytes:'something',metadataSize:9});
 await assert.rejects(graph.archiveEmptyIndex(),/空の索引以外/);
 assert.equal(stats().patchCount,0);
}
console.log('PASS: 0バイト索引だけを明示退避し、新規索引は単発PUT・サイズ確認。給与データがあれば拒否');
