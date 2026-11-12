/** ホームの総支給表示と年度引き継ぎが src/dist 双方に反映済みか確認。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
function read(path) {
  try { return readFileSync(resolve(root, path), 'utf8'); }
  catch { console.error(`NG: ${path} がありません。`); process.exitCode = 1; return ''; }
}
const files = {
  sourceMain: read('src/main.ts'), sourceEdit: read('src/edit.ts'),
  distMain: read('dist/main.js'), distEdit: read('dist/edit.js'),
};
const checks = [
  ['ソース：明細一覧の総支給', files.sourceMain.includes(' / 総支給 ')],
  ['ソース：年度選択のURL保持', files.sourceMain.includes("url.searchParams.set('fy', yearSelect.value)")],
  ['ソース：編集URLへの年度引き継ぎ', files.sourceMain.includes('&fy=${encodeURIComponent(yearSelect.value)}')],
  ['ソース：編集画面からの年度付き戻り', files.sourceEdit.includes('window.location.assign(homeHref)')],
  ['ビルド：総支給表示', files.distMain.includes(' / 総支給 ')],
  ['ビルド：年度引き継ぎ', files.distMain.includes('fy') && files.distMain.includes('edit/index.html?id=')],
  ['ビルド：編集からの戻り', files.distEdit.includes('index.html?fy=') && files.distEdit.includes('homeHref')],
];
for (const [name, ok] of checks) {
  console.log(`${ok ? 'OK' : 'NG'}: ${name}`);
  if (!ok) process.exitCode = 1;
}
if (!process.exitCode) console.log('OK: 総支給表示と年度維持が src/dist の両方に反映されています。');
