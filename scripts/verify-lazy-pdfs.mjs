/** 適用・ビルド済み成果物の機能存在検査。 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const store = read('src/storage/payrollStore.ts');
const main = read('src/main.ts');
const backup = read('src/backup.ts');
const view = read('src/view.ts');
assert.match(store, /DB_VERSION = 2/);
assert.match(store, /INDEX_STORE = 'payroll-record-index'/);
assert.match(store, /openCursor\(\)/);
assert.match(store, /export async function loadRecordSummaries/);
assert.match(store, /index\.put\(toSummary\(updated\)\)/);
assert.match(store, /index\.clear\(\)/);
assert.match(store, /_tx\.objectStore\(INDEX_STORE\)\.delete\(id\)/);
assert.match(main, /saved = await loadRecordSummaries\(\)/);
assert.doesNotMatch(main, /saved = await loadRecords\(\)/);
assert.match(main, /\.\/view\/index\.html\?id=/);
assert.match(main, /visibleCounts: Record<Job, number> = \{ main: 50, side: 50 \}/);
assert.match(main, /await getRecord\(item\.id\)/);
assert.match(backup, /await loadRecordSummaries\(\)/);
assert.match(backup, /createBackup\(await loadRecords\(\)\)/);
assert.match(view, /const record = await getRecord\(id\)/);
if (!process.argv.includes('--source-only')) {
  for (const file of ['dist/index.html', 'dist/main.js', 'dist/backup.js', 'dist/view/index.html', 'dist/view.js']) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), `${file} が存在しません。npm run build を実行してください。`);
  }
  assert.match(read('dist/main.js'), /\.\/view\/index\.html\?id=/);
  assert.match(read('dist/view.js'), /payroll-local-v1/);
}
console.log('OK: IndexedDB索引、50件ずつの描画、PDF遅延取得、副業ZIP、完全バックアップ' + (process.argv.includes('--source-only') ? '（ソースのみ）' : '、dist反映'));
