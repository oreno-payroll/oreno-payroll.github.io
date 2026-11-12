/** 旧版の未使用ルート直下ファイルのみ削除。src/・public/・IndexedDB・local-dataには触れない。 */
import fs from 'node:fs/promises';
import path from 'node:path';
const cwd = process.cwd();
const packageFile = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
if (packageFile.name !== 'payroll') throw new Error('Payrollプロジェクトのルートで実行してください。');
for (const required of ['src/main.ts', 'src/upload.ts', 'scripts/build.mjs']) {
  if (!(await fs.stat(path.join(cwd, required))).isFile()) throw new Error(`現行ファイルが見つかりません: ${required}`);
}
for (const oldFile of ['main.ts', 'upload.ts', 'build.mjs']) {
  await fs.rm(path.join(cwd, oldFile), { force: true });
  console.log(`旧ファイル削除: ${oldFile}`);
}
console.log('完了: 現行src/・public/・保存済みデータには変更していません。');
