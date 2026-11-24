/** UI labels must reflect the actual OneDrive deletion behavior. No external API or real data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL('../'+path, import.meta.url), 'utf8');
const main = source('src/main.ts');
const edit = source('src/edit.ts');
const readme = source('README.md');
const vault = source('src/cloud/vault.ts');

assert.match(main,/remove\.title = '[^']*PDF原本はOneDriveに保持/);
assert.match(main,/解析・入力情報とFinance連携用の収入情報から選択した明細を除外します/);
assert.match(main,/未参照になった暗号化PDF原本をごみ箱へ移動します/);
assert.doesNotMatch(main,/入力情報とPDF原本を両方削除します|明細とPDF原本を削除/);
assert.match(edit,/保存済みの入力情報とFinance連携用の収入情報から除外します/);
assert.match(edit,/未参照になった暗号化PDF原本をごみ箱へ移動します/);
assert.doesNotMatch(edit,/入力情報とPDF原本が削除されます|件を完全に削除/);
assert.match(vault,/async remove\(id:number,expectedMatch\?:\(current:CloudRecord\)=>boolean,checkConflicts\?:\(records:readonly CloudRecord\[\],year:string\)=>void\):Promise<void>\s*\{/);
assert.match(vault,/PDF原本は事故時の復元と監査のためOneDriveに保持/);
assert.match(readme,/OneDrive暗号化給与明細管理/);
assert.match(readme,/旧データを削除.*OneDriveにある明細と暗号化PDF原本を全件照合/);
assert.doesNotMatch(readme,/旧DBの削除のみならOneDrive接続は必要ありません|OneDriveとの照合なしで実行できます/);
assert.doesNotMatch(readme,/ブラウザのIndexedDBへ保存します|外部APIに送信しません|単一のIndexedDBトランザクション|サーバーへ自動保存しません|IndexedDB全件置換|（\*\*削除しない\*\*）/);
console.log('PASS: 削除確認・未参照PDFごみ箱移動・OneDrive READMEの整合性');
