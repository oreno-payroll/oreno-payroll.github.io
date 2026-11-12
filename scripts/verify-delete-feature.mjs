/** 適用確認専用。給与情報・IndexedDBにはアクセスしない。 */
import { readFile } from 'node:fs/promises';
const checks = [
  ['src/storage/payrollStore.ts', ['export async function deleteRecord', 'recordSignature(current)', 'store.delete(id)']],
  ['src/main.ts', ['deleteRecord(', 'btn--delete', '#icon-trash']],
  ['src/edit.ts', ["'edit-delete'", 'deleteRecord(', 'window.location.assign(homeHref)']],
  ['public/index.html', ['id="icon-trash"']],
  ['public/edit/index.html', ['id="edit-delete"']],
  ['dist/index.html', ['id="icon-trash"']],
  ['dist/edit/index.html', ['id="edit-delete"']],
  ['dist/main.js', ['削除', '別タブ']],
  ['dist/edit.js', ['削除', '別タブ']],
];
let failed = false;
for (const [path, parts] of checks) {
  try {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const missing = parts.filter(part => !source.includes(part));
    if (missing.length) { failed = true; console.error(`NG: ${path} に ${missing.join(' / ')} が見つかりません。`); }
  } catch (error) {
    failed = true;
    console.error(`NG: ${path} がありません。先に npm run build を実行してください。`);
  }
}
if (failed) process.exitCode = 1;
else console.log('OK: ホーム・編集画面の削除ボタンと競合検出処理が src/dist の両方に反映されています。');
