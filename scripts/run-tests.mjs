/** テスト実行を1カ所に統一。監査パッチ未適用のソースにも対応する。 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  ['scripts/test-publish-audit.mjs', true],
  ['scripts/test-high-priority.mjs', true],
  ['scripts/test-medium-priority.mjs', true],
  ['scripts/test-low-priority.mjs', true],
  ['scripts/test-missing-indicator.mjs', true],
  ['scripts/test-optional-zero.mjs', true],
  ['scripts/test-audit-fixes.mjs', false],
  ['scripts/test-bonus-latest.mjs', true],
  ['scripts/test-calendar-year.mjs', true],
  ['scripts/test-side-zip.mjs', true],
  ['scripts/test-target-year.mjs', true],
  ['scripts/test-lazy-pdfs.mjs', true],
  ['scripts/test-pdf-view-service-worker.mjs', true],
  ['scripts/test-viewer-flow.mjs', true],
];
for (const [relative, required] of tests) {
  const target = path.join(root, relative);
  if (!existsSync(target)) {
    if (required) throw new Error(`必須テストがありません: ${relative}`);
    console.log(`SKIP (監査パッチ未適用): ${relative}`);
    continue;
  }
  console.log(`\n▶ ${relative}`);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', target], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\n✅ Payroll 全回帰テスト完了');
