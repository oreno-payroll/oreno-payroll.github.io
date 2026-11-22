/** Current built-artifact smoke check. Run after npm run build. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=rel=>readFileSync(path.join(root,rel),'utf8');
const version=JSON.parse(read('package.json')).version;
const main=read('dist/index.html'),backup=read('dist/backup/index.html');
const info=read('dist/build-info.js');
const homeJs=read('dist/main.js'),backupJs=read('dist/backup.js');
assert.match(main,/id="download-side-zip"/);
assert.match(main,/data-build-version/);
for(const id of ['export-password','export-confirm','restore-password']){
 assert.ok(backup.includes(`data-toggle-password="${id}"`));
}
assert.ok(info.includes(`v${version}`),'build-info version must match package.json');
assert.match(homeJs,/payroll-side-/);
assert.match(backupJs,/パスワードを表示/);
for(const file of ['dist/upload/index.html','dist/edit/index.html'])assert.match(read(file),/data-build-version/);
console.log('PASS: current release version, password visibility, side PDF ZIP and built HTML');
