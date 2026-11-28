/** OneDrive保存のUX回帰テスト。実アカウント・ネットワーク不要。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const source = relative => readFileSync(new URL('../'+relative,import.meta.url),'utf8');
const keyWorker=source('public/payroll-cloud-session.js');
const fakeSelf = {};
let now=0;
const WorkerDate={now:()=>now};
vm.runInNewContext(keyWorker,{self:fakeSelf,Date:WorkerDate,Map,RegExp,crypto:webcrypto});
const port = ()=>({onmessage:null,start(){},messages:[],postMessage(msg){this.messages.push(msg);}});
const a=port(),b=port();
fakeSelf.onconnect({ports:[a]});fakeSelf.onconnect({ports:[b]});
const key={type:'secret',algorithm:{name:'AES-GCM'},extractable:false};
// Obtain the live worker generation as the browser client does.
a.onmessage({data:{id:0,action:'generation',scope:'client:account'}});
const generation=a.messages.at(-1).result;
assert.match(generation,/^[0-9a-f-]{36}$/i);
a.onmessage({data:{id:1,action:'set',scope:'client:account',generation,key,salt:'salt1'}});
assert.equal(a.messages.at(-1).result,true);
b.onmessage({data:{id:2,action:'get',scope:'client:account',generation}});
assert.equal(b.messages.at(-1).result.key,key,'別ページでも同じCryptoKeyインスタンスを利用');
b.onmessage({data:{id:3,action:'get',scope:'client:another',generation}});
assert.equal(b.messages.at(-1).result,null,'Microsoftアカウントごとに鍵を分離');
now=30*60*1000+1;
b.onmessage({data:{id:4,action:'get',scope:'client:account',generation}});
assert.equal(b.messages.at(-1).result,null,'一定時間経過でセッション鍵は期限切れ');
a.onmessage({data:{id:5,action:'set',scope:'client:account',generation,key,salt:'salt1'}});
b.onmessage({data:{id:6,action:'clear',scope:'client:account',generation}});
a.onmessage({data:{id:7,action:'get',scope:'client:account',generation}});
assert.equal(a.messages.at(-1).result,null,'解除・切替時は明示的に鍵を消去');
const fakeExport={type:'secret',algorithm:{name:'AES-GCM'},extractable:true};
a.onmessage({data:{id:8,action:'set',scope:'client:account',generation,key:fakeExport,salt:'salt1'}});
assert.equal(a.messages.at(-1).result,null,'抽出可能な鍵の共有を拒否');
// A missing generation must not be accepted, including after a valid unlock.
a.onmessage({data:{id:9,action:'set',scope:'client:account',key,salt:'salt1'}});
assert.equal(a.messages.at(-1).result,null,'世代なしの鍵登録を拒否');
a.onmessage({data:{id:10,action:'get',scope:'client:account',generation}});
assert.equal(a.messages.at(-1).result,null,'拒否した鍵が保存されていない');
console.log('PASS: SharedWorkerメモリ鍵、アカウント分離、30分失効、明示削除');

// Graph URLとフォルダーIDの不要な往復を検出。
const graphResult=await build({
 entryPoints:[new URL('../src/cloud/graph.ts',import.meta.url).pathname],
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const graph=await import('data:text/javascript;base64,'+Buffer.from(graphResult.outputFiles[0].contents).toString('base64'));
let rootCalls=0,folderCalls=0,fileCalls=0;
const remote=async (url)=>{
 if(url.endsWith('/me/drive/special/approot')){rootCalls++;return Response.json({id:'root'});}
 if(url.includes(':/payroll')||url.includes(':/statements')){folderCalls++;return Response.json({id:url.includes('statements')?'statements':'payroll'});}
 if(url.includes(':/2026.enc')){fileCalls++;return new Response('',{status:404});}
 throw new Error('未定義の模擬アクセス: '+url.split('?')[0]);
};
const store=new graph.PayrollGraph('test-token',remote, undefined, undefined, undefined, false);
assert.equal(await store.read(['payroll','statements'],'2026.enc',100),null);
assert.equal(await store.read(['payroll','statements'],'2026.enc',100),null);
assert.equal(rootCalls,1);
assert.equal(folderCalls,2,'フォルダーごとのメタデータ再取得を回避');
assert.equal(fileCalls,2,'個別ファイルの更新確認は都度行う');
console.log('PASS: GraphフォルダーIDのみをキャッシュし、明細ファイルの存在確認は継続');

const auth=source('src/cloud/auth.ts'),vault=source('src/cloud/vault.ts');
const upload=source('src/upload.ts'),storeCode=source('src/storage/payrollStore.ts');
assert.match(auth,/restoredKey\(/);
assert.match(auth,/rememberKey\(/);
assert.match(auth,/await candidate\.unlockWithKey\(/);
assert.match(auth,/cacheLocation:'localStorage'/,'MSAL v5による公式キャッシュを使用する');
assert.match(vault,/async unlockWithKey\(/);
assert.doesNotMatch(vault,/try\{await this\.refresh\(\);await this\.syncIncome\(\);\}/,'初回の収入全年度再同期禁止');
assert.match(vault,/async syncIncome\(changedYears\?/);
// The income writer now refreshes source statements before and after the ETag write.
const incomeSync=vault.slice(vault.indexOf(' async syncIncome(changedYears?'));
assert.match(incomeSync,/for\(let attempt=0;attempt<8;attempt\+\+\)/);
// Phase 1: conditional ciphertext reuse still verifies every source ETag before/after income writes.
// The source-inventory behavior is exercised by test-payroll-income-inventory.mjs.
// Keep the shared live-source contract, rather than requiring per-year locals.
assert.match(incomeSync,/const options=\{forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true\}/);
// Intermediate source checks remain fresh, but must not serialize a display snapshot.
for(const phase of ['source-refresh','income-prewrite-refresh'])
 assert.ok(incomeSync.includes(`await perf.measure('${phase}',()=>this.refresh({...options,rememberNavigation:false}))`),`${phase}: fresh verification without a navigation snapshot`);
// The final source check still uses all original verification options and can publish the snapshot.
// Guarded sync additionally captures the exact completed refresh's index observation.
assert.ok(incomeSync.includes("await perf.measure('income-postwrite-refresh',()=>this.refresh(checkSource?{...options,onVerifiedIndex:value=>{observed=value;}}:options))"),
 'postwrite: fresh verification, normal navigation snapshot and guarded index observation');
assert.match(incomeSync,/const finalIndex=checkSource\?\(observed&&same\(observed\.index,this\.index\)\?observed:await this\.readIndex\(\)\):undefined/,
 'guarded sync reuses only the completed refresh observation; otherwise it reads the index again');
assert.match(incomeSync,/!same\(documents\(years\),expected\)/);
assert.match(storeCode,/onProgress\?\./);
// Preserve authorization and the explicit recovery-only cross-month search flag.
assert.match(upload,/saveRecordsSkippingDuplicates\(records,showSaveProgress,writeState,authorized,recoverAcrossMonths,directory=>/);
assert.match(upload,/保存・検証しました/);
assert.match(source('.gitignore'),/!\/public\/payroll-cloud-session\.js/);
console.log('PASS: 認証画面・同一オリジンの鍵継承・保存進捗・変更年のみの同期');

// Shared upload/auth UI and encrypted-write assertions: test-cloud-upload-ux.mjs.
