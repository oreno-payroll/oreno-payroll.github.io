/** README/setting regression checks. Files only; does not touch OneDrive or credentials. */
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../', import.meta.url));
const load=relative=>readFileSync(path.join(root,relative),'utf8');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const file=path.join(dir,entry.name);
  return entry.isDirectory()?walk(file):entry.isFile()&&file.endsWith('.html')?[file]:[];
});
for(const file of walk(path.join(root,'public'))){
  const html=readFileSync(file,'utf8'),ids=new Set();
  for(const tag of html.matchAll(/<[A-Za-z][^>]*>/g)){
    for(const attribute of tag[0].matchAll(/\bid\s*=\s*(["'])(.*?)\1/g)){
      const id=attribute[2];
      assert.ok(!ids.has(id),`Duplicate HTML id '${id}' in ${path.relative(root,file)}`);
      ids.add(id);
    }
  }
}
const backup=load('public/backup/index.html');
const auth=load('src/cloud/auth.ts');
const handler=load('src/backup.ts');
const readme=load('README.md');
for(const id of ['remember-browser-title','remember-browser-state','remember-browser-register','remember-browser-forget','remember-browser-feedback']){
  assert.equal([...backup.matchAll(new RegExp(`id="${id}"`,'g'))].length,1,`${id}: exactly one settings widget`);
}
assert.equal([...backup.matchAll(/class="settings-remember-browser"/g)].length,1,'browser remember card is not duplicated');
assert.match(auth,/name="payroll-retention" value="browser"/,'vault login radio remains');
assert.match(handler,/rememberCurrentBrowser\(\)/,'register button still wired');
assert.match(handler,/forgetCurrentBrowser\(\)/,'forget button still wired');
assert.doesNotMatch(readme,/Finance側の読み取りと復号鍵共有は未実装|Financeでは読み込ませないでください/);
assert.match(readme,/### Financeへの収入連携（実装済み）/);
assert.match(readme,/payroll\/versions\/<generation>\//);
assert.match(readme,/payroll-remembered-browser-key-v1/);
assert.match(readme,/## 年末調整サポート/);
console.log('PASS: 全HTMLの重複IDなし、設定欄1個、Finance/ブラウザ記憶/年末調整のREADME整合');
