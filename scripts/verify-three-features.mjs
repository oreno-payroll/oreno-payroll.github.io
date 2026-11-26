/** Current built-artifact smoke check. Run after npm run build. */
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=rel=>readFileSync(path.join(root,rel),'utf8');
const version=JSON.parse(read('package.json')).version;
const main=read('dist/index.html'),backup=read('dist/backup/index.html');
const info=read('dist/build-info.js');
const homeJs=read('dist/main.js'),backupJs=read('dist/backup.js');
assert.match(main,/id="download-side-zip"/);
// Phase 6-C/D: build identification belongs to the settings overview only.
// Check the deployed HTML (not just source) and verify the generated label payload.
assert.equal((backup.match(/\bdata-build-version\b/g)??[]).length,1);
assert.equal((backup.match(/\bdata-build-details\b/g)??[]).length,1);
assert.match(backup,/<button\b(?=[^>]*\btype="button")(?=[^>]*\bid="settings-version")(?=[^>]*\baria-haspopup="dialog")[^>]*>\s*Payroll\s*<span\s+data-build-version>[^<]*<\/span>\s*<\/button>\s*<span\s+data-build-details><\/span>/);
assert.equal((backup.match(/<script\b[^>]*\bsrc="\.\.\/build-info\.js"[^>]*>/g)??[]).length,1);
const prefix=`document.querySelectorAll('[data-build-version]').forEach(el => { el.textContent = ${JSON.stringify(`v${version}`)}; });\n`+
  "document.querySelectorAll('[data-build-details]').forEach(el => { el.textContent = ";
const suffix="; el.title = 'このブラウザが読み込んでいるPayrollのビルド情報'; });\n";
assert.ok(info.startsWith(prefix)&&info.endsWith(suffix),'build-info script must populate the expected marker');
const label=JSON.parse(info.slice(prefix.length,-suffix.length));
const parts=label.split(' · ');
assert.equal(parts.length,2);
const [stamp,revision]=parts;
assert.ok(stamp.trim(),'build-info must include the build timestamp');
assert.match(revision,/^(?:[a-f0-9]{4,64}|local)$/,'build-info must include the build revision');
// Keep the old pages mandatory and check every other distributed HTML too.
for(const file of ['dist/upload/index.html','dist/edit/index.html'])read(file);
function checkOtherPages(dir){
 for(const entry of readdirSync(path.join(root,dir),{withFileTypes:true})){
  const file=path.posix.join(dir,entry.name);
  if(entry.isDirectory())checkOtherPages(file);
  else if(entry.isFile()&&entry.name.endsWith('.html')&&file!=='dist/backup/index.html'){
   assert.doesNotMatch(read(file),/\bdata-build-(?:version|details)\b|\bid="settings-version"|\bclass="[^"\n]*\bbuild-info\b|\bsrc="[^"\n]*build-info\.js"/,`${file}: build label must be settings-only`);
  }
 }
}
checkOtherPages('dist');
for(const id of ['export-password','export-confirm','restore-password']){
 assert.ok(backup.includes(`data-toggle-password="${id}"`));
}
assert.match(homeJs,/payroll-side-/);
// esbuild は日本語文字列を \uXXXX に変換する場合があるため、検査時だけ復号する。
const decodedBackupJs = backupJs.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
assert.ok(backupJs.includes('[data-toggle-password]'), 'ビルド済みのパスワード表示操作が見つかりません');
assert.ok(decodedBackupJs.includes('パスワードを表示'), 'ビルド済みのパスワード表示ラベルが見つかりません');
console.log('PASS: settings-only release version, password visibility, side PDF ZIP and built HTML');
