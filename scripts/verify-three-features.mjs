/** npm run build後に実行。配信成果物まで3機能が反映されたことを検査する。 */
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = file => readFileSync(file, 'utf8');
const main = read('dist/index.html');
const backup = read('dist/backup/index.html');
const info = read('dist/build-info.js');
const homeJs = read('dist/main.js');
const backupJs = read('dist/backup.js');
assert.match(main, /id="download-side-zip"/);
assert.match(main, /data-build-version/);
assert.match(backup, /data-toggle-password="export-password"/);
assert.match(backup, /data-toggle-password="export-confirm"/);
assert.match(backup, /data-toggle-password="restore-password"/);
assert.match(info, /v1\.1\.0/);
assert.match(homeJs, /payroll-side-/);
assert.match(backupJs, /パスワードを表示/);
for (const file of ['dist/upload/index.html', 'dist/edit/index.html']) {
  assert.match(read(file), /data-build-version/);
}
assert.ok(existsSync('dist/build-info.js'));
console.log('OK: バージョン表示・パスワード可視化・副業PDF ZIP出力が配信ファイルに反映されています。');
