/** Saving UX and Graph's expected 404; no Microsoft account or personal data required. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';

const source = rel => readFileSync(new URL('../'+rel, import.meta.url),'utf8');
// Use the project's esbuild compiler, not TypeScript's removed runtime API.
// Bundling also keeps this test working if the tested modules add relative imports.
const fromTS = async rel => {
 const result=await build({
  entryPoints:[new URL('../'+rel,import.meta.url).pathname],
  bundle:true,platform:'node',format:'esm',target:'es2022',
  write:false,logLevel:'silent',
 });
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
};
const html=source('public/upload/index.html');
const upload=source('src/upload.ts');
const auth=source('src/cloud/auth.ts');
const css=source('public/styles/cloud.css');
assert.match(auth,/ui\.loginForm\.hidden=state==='connected'/,'connected account must suppress the login form');
assert.match(auth,/ui\.button\.disabled=state!=='connected'/,'unlock must wait for connection');
assert.match(auth,/ui\.unlockForm\.hidden=state!=='connected'/);
assert.match(css,/payroll-cloud-error\[hidden\]/,'failed login details must not persist in normal state');
assert.match(html,/id="save-feedback"/);
assert.match(html,/id="save-progress-track"/);
assert.match(html,/id="save-guidance"/);
// The upload UI no longer repeats the persistence explanation in its diagnostic panel.
// Keep the public documentation and verify encryption at the actual Graph write boundary.
assert.match(source('README.md'),/給与の平文PDF・平文JSONをOneDriveへアップロードしません/);
const persistence=source('src/cloud/vault.ts');
assert.match(persistence,/const encrypted=await encryptBytes\('original',bytes,key\);[\s\S]*?this\.graph\.write\(this\.storagePath\('originals',year,mm\),`\$\{uuid\}\.enc`,encrypted,/);
assert.match(persistence,/const encrypted=await encryptJson\('year',merged,this\.unlocked\(\),this\.salt\);[\s\S]*?this\.graph\.write\(this\.storagePath\('statements'\),`\$\{year\}\.enc`,encrypted,/);
assert.doesNotMatch(html,/IndexedDBへ保存します/,'stale persistence instructions must not return');
assert.match(upload,/saveElapsed\.textContent/);
assert.doesNotMatch(upload,/通信応答を待っています|OneDriveの応答待ち/);
assert.match(upload,/document\.addEventListener\('click',event=>/,'block navigation while saving');
assert.match(upload,/stopSaveClock\(\)/,'clear timer on completion and failure');
assert.match(upload,/saveFeedback\.classList\.add\('is-complete'\)/);
assert.match(upload,/saveFeedback\.classList\.add\('is-failed'\)/);
assert.doesNotMatch(upload,/window\.alert\(`\$\{result\.saved\}/,'do not open unnecessary duplicate result modal');
console.log('PASS: authentication UI, honest save progress, completion, navigation guard, copy');

// The Graph folder request deliberately returns HTTP 404 for a missing month.
// That must be followed by a folder creation POST and a successful encrypted file PUT.
const graph=await fromTS('src/cloud/graph.ts');
let folderMissing=0,created=0,put=0;
const remote=async (url,init={})=>{
 const pathname=new URL(url).pathname,method=init.method??'GET';
 if(pathname.endsWith('/me/drive/special/approot'))return Response.json({id:'approot'});
 if(method==='GET'&&pathname.includes(':/payroll'))return Response.json({id:'payroll'});
 if(method==='GET'&&pathname.includes(':/originals'))return Response.json({id:'originals'});
 if(method==='GET'&&pathname.includes(':/2026'))return Response.json({id:'year2026'});
 if(method==='GET'&&pathname.includes(':/08')){folderMissing++;return new Response('',{status:404});}
 if(method==='POST'&&pathname.endsWith('/year2026/children')){created++;return Response.json({id:'august'});}
 if(method==='PUT'&&pathname.includes('/august:/')){put++;return Response.json({id:'encrypted',size:3});}
 throw new Error(`unexpected mock Graph request ${method} ${pathname}`);
};
const g=new graph.PayrollGraph('mock-token',remote, undefined, undefined, undefined, false);
await g.write(['payroll','originals','2026','08'],'sample.enc','abc',null,200);
assert.equal(folderMissing,1);
assert.equal(created,1);
assert.equal(put,1);
console.log('PASS: a missing monthly folder returns expected 404 before successful creation and save');

// The optimized binary decode must not change the AES-GCM envelope or its payload.
const cryptoMod=await fromTS('src/cloud/crypto.ts');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const pass='a-test-passphrase-with-no-real-user-data';
const salt=cryptoMod.createSalt(),key=await cryptoMod.deriveKey(pass,salt);
const bytes=new Uint8Array(1_400_000);
for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
const cipher=await cryptoMod.encryptBytes('original',bytes,key);
const decrypted=await cryptoMod.decryptBytes('original',cipher,key);
assert.deepEqual(decrypted,bytes);
await assert.rejects(cryptoMod.decryptBytes('income',cipher,key),/暗号形式または用途が一致しません/);
console.log('PASS: 1.4MB encrypted original roundtrip unchanged (AES-256-GCM, AAD, Base64)');
