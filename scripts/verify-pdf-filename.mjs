/** 名前付きURL経由のPDF閲覧・元ファイル名の保持・ヘッダー非復活を静的検証する。 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const ts = read('src/view.ts');
const sw = read('public/view/pdf-sw.js');
const html = read('public/view/index.html');
assert.match(ts, /serviceWorker\.register/);
assert.match(ts, /document\.title = record\.fileName/);
assert.match(ts, /encodeURIComponent\(safePdfName\(fileName\)\)/);
assert.match(sw, /'Content-Disposition': contentDisposition\(fileName\)/);
assert.match(sw, /indexedDB\.open\(DB_NAME\)/);
assert.match(sw, /event\.respondWith\(servePdf\(request, id, name\)\)/);
assert.doesNotMatch(html, /<header\b|id=["']pdf-download["']|id=["']pdf-title["']/);
assert.match(html, /id="pdf-reader"/);
if (!process.argv.includes('--source-only')) {
  const builtJs = read('dist/view.js');
  const builtSw = read('dist/view/pdf-sw.js');
  assert.match(builtJs, /serviceWorker\.register/);
  assert.equal(builtSw, sw, 'Service Workerが配信先にコピーされていません。');
}
console.log('OK: PDF閲覧のURLに原本ファイル名を使用し、閲覧専用Service Workerを配置しています。');
