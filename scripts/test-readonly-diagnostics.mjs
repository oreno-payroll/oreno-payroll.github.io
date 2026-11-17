/** Read-only cloud diagnosis: distinguish transport from authenticated malformed JSON. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=new URL('../',import.meta.url).pathname;
const {outputFiles}=await build({stdin:{contents:"export {PayrollVault} from './src/cloud/vault.ts'; export {createSalt,deriveKey,encryptJson} from './src/cloud/crypto.ts';",resolveDir:root,loader:'ts',sourcefile:'read-diagnostic.ts'},bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
const {PayrollVault,createSalt,deriveKey,encryptJson}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
const pass='diagnostic-passphrase-long';
const salt=createSalt(),key=await deriveKey(pass,salt);
const index={format:'payroll-index-v1',years:['2026'],incomeYears:[]};
const indexText=await encryptJson('index',index,key,salt);
const malformed=await encryptJson('year',{format:'payroll-annual-v1',records:[],deleted:[]},key,salt);
const brokenPlain='{ "format": "payroll-annual-v1", "records": [1,], "deleted": [] }';
// Encrypt an authenticated, malformed plaintext. A real transport corruption would fail GCM earlier.
const iv=crypto.getRandomValues(new Uint8Array(12));
const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('Payroll OneDrive annual records v1')},key,new TextEncoder().encode(brokenPlain));
const badFile=JSON.stringify({format:'payroll-cloud-envelope-v1',kind:'year',salt,iterations:310000,iv:Buffer.from(iv).toString('base64'),data:Buffer.from(cipher).toString('base64')});
const makeGraph=(text,fetchErr=false)=>({async read(parts,name){if(name==='index.enc')return {id:'idx',etag:'i1',size:indexText.length,text:indexText};if(fetchErr)throw new SyntaxError('bad response JSON');return {id:'2026',etag:'y1',size:text.length,text};}});
{
 const vault=new PayrollVault(makeGraph(badFile));
 assert.equal(await vault.unlock(pass),true);
 await assert.rejects(vault.refresh(),e=>e.message.includes('2026年度')&&e.message.includes('復号後のyearデータ')&&e.message.includes('変更していません'));
 assert.deepEqual(vault.records(),[]);
}
{
 const vault=new PayrollVault(makeGraph(malformed,true));
 assert.equal(await vault.unlock(pass),true);
 await assert.rejects(vault.refresh(),e=>e.message.includes('Graph API/配信応答')&&e.cause instanceof SyntaxError);
}
{
 const vault=new PayrollVault(makeGraph(malformed));
 assert.equal(await vault.unlock(pass),true);
 assert.deepEqual(await vault.refresh(),[]);
}
console.log('PASS: read-only diagnosis labels annual year, separates transport/JSON failures and preserves data');
