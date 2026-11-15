/** PDF閲覧専用画面からアプリ独自のヘッダーとダウンロードボタンを撤去したことを確認。 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const html = read('public/view/index.html');
const source = read('src/view.ts');
assert.doesNotMatch(html, /<header\b|id=["']pdf-download["']|id=["']pdf-title["']|class=["']toolbar["']/);
assert.doesNotMatch(source, /pdf-download|pdf-title|download\.href|download\.download/);
assert.match(html, /id="pdf-reader"/);
assert.match(html, /height: 100dvh/);
assert.match(source, /await getRecord\(id\)/);
assert.match(source, /URL\.createObjectURL\(record\.pdf\)/);
assert.match(source, /PDFを表示できませんでした/);
if (!process.argv.includes('--source-only')) {
  const builtHtml = read('dist/view/index.html');
  const builtJs = read('dist/view.js');
  assert.equal(builtHtml, html, '配信用HTMLがソースと一致しません。npm run build を実行してください。');
  assert.doesNotMatch(builtJs, /pdf-download|pdf-title/);
  assert.match(builtJs, /createObjectURL/);
}
console.log('OK: PDF閲覧画面の独自ヘッダー・ダウンロードボタンを撤去し、原本表示と遅延読み込みを維持しています。');
