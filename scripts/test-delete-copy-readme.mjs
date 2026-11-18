/** UI labels must reflect the actual OneDrive deletion behavior. No external API or real data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL('../'+path, import.meta.url), 'utf8');
const main = source('src/main.ts');
const edit = source('src/edit.ts');
const readme = source('README.md');
const vault = source('src/cloud/vault.ts');

assert.match(main,/remove\.title = '[^']*PDF原本はOneDriveに保持/);
assert.match(main,/解析・入力情報とFinance連携用の収入情報からこの明細を除外します/);
assert.match(main,/暗号化PDF原本はOneDriveに残ります/);
assert.doesNotMatch(main,/入力情報とPDF原本を両方削除します|明細とPDF原本を削除/);
assert.match(edit,/保存済みの入力情報とFinance連携用の収入情報から除外します/);
assert.match(edit,/暗号化PDF原本はOneDriveに保持されます/);
assert.doesNotMatch(edit,/入力情報とPDF原本が削除されます|件を完全に削除/);
assert.match(vault,/async remove\(id:number\):Promise<void>\s*\{/);
assert.match(vault,/PDF原本は事故時の復元と監査のためOneDriveに保持/);
assert.match(readme,/OneDrive暗号化給与明細管理/);
assert.match(readme,/旧DBを削除.*OneDriveとの照合なし/);
assert.doesNotMatch(readme,/ブラウザのIndexedDBへ保存します|外部APIに送信しません|単一のIndexedDBトランザクション|サーバーへ自動保存しません|IndexedDB全件置換|（\*\*削除しない\*\*）/);
console.log('PASS: 削除確認・元PDF保持・OneDrive READMEの整合性');
