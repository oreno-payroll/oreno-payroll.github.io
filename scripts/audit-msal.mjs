/** Fail closed if bundled MSAL is detached from npm's lock/audit dependency graph. */
import {readFileSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const load=p=>JSON.parse(readFileSync(path.join(root,p),'utf8'));
const pkg=load('package.json'),lock=load('package-lock.json');
const version='5.30.0';
const fail=msg=>{throw Error('MSAL依存監査: '+msg);};
if(pkg.dependencies?.['@azure/msal-browser']!==version)fail('package.jsonのMSALバージョンが固定されていません');
if(lock.packages?.['']?.dependencies?.['@azure/msal-browser']!==version||
   lock.packages?.['node_modules/@azure/msal-browser']?.version!==version)
  fail('package-lock.jsonのMSALが未更新です。npm install --package-lock-only --ignore-scriptsで生成してください');
if(!lock.packages['node_modules/@azure/msal-browser'].integrity)
  fail('lockfileにnpmパッケージのintegrityがありません');
for(const file of ['scripts/msal-entry.mjs','scripts/msal-redirect-bridge.mjs','public/auth/redirect.html'])
  if(!existsSync(path.join(root,file)))fail('認証ブリッジソースがありません: '+file);
const build=readFileSync(path.join(root,'scripts/build.mjs'),'utf8');
if(!build.includes('scripts/msal-entry.mjs')||!build.includes('scripts/msal-redirect-bridge.mjs'))
  fail('MSALのnpmからのビルド設定がありません');
if(existsSync(path.join(root,'public/vendor/msal/msal-browser.bundle.js')))
  fail('監査対象外の旧MSALバンドルがpublicに残っています');
if(process.argv.includes('--built')){
  for(const [file,minBytes] of [['dist/vendor/msal/msal-browser.bundle.js',20000],['dist/auth/redirect-bridge.js',100],['dist/auth/redirect.html',100]]) {
    const abs=path.join(root,file);
    if(!existsSync(abs)||statSync(abs).size<minBytes)fail('配信物が見つからないか小さすぎます: '+file);
  }
}
console.log('[MSAL監査] OK: npm-lock '+version+', direct vendor excluded, dedicated redirect bridge '+(process.argv.includes('--built')?'built':'source'));
