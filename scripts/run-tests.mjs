/** テスト実行を1カ所に統一。監査パッチ未適用のソースにも対応する。 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  ['scripts/test-ci-security-gates.mjs', true],
  ['scripts/test-security-pipeline.mjs', true],
  ['scripts/test-pr-merge-target.mjs', true],
  ['scripts/test-pr-workflow-locked.mjs', true],
  ['scripts/test-payroll-ui-clarity.mjs', true],
  ['scripts/test-cross-tab-lock.mjs', true],
  ['scripts/test-year-end-backup.mjs', true],
  ['scripts/test-year-end-restore-resume.mjs', true],
  ['scripts/test-v25-yearend-safety.mjs', true],
  ['scripts/test-v26-restore-diagnosis.mjs', true],
  ['scripts/test-v27-yearend-clarity.mjs', true],
  ['scripts/test-year-end-pdf-lock.mjs', true],
  ['scripts/test-v22-ux-safety.mjs', true],
  ['scripts/test-theme.mjs', true],
  ['scripts/test-publish-audit.mjs', true],
  ['scripts/test-security-hardening.mjs', true],
  ['scripts/test-high-priority.mjs', true],
  ['scripts/test-medium-priority.mjs', true],
  ['scripts/test-low-priority.mjs', true],
  ['scripts/test-missing-indicator.mjs', true],
  ['scripts/test-optional-zero.mjs', true],
  ['scripts/test-audit-fixes.mjs', false],
  ['scripts/test-bonus-latest.mjs', true],
  ['scripts/test-calendar-year.mjs', true],
  ['scripts/test-home-registration-status.mjs', true],
  ['scripts/test-monthly-registration.mjs', true],
  ['scripts/test-side-zip.mjs', true],
  ['scripts/test-target-year.mjs', true],
  ['scripts/test-lazy-pdfs.mjs', true],
  ['scripts/test-pdf-view-service-worker.mjs', true],
  ['scripts/test-viewer-flow.mjs', true],
  ['scripts/test-pdf-oneclick.mjs', true],
  ['scripts/test-pdf-handoff-lock.mjs', true],
  ['scripts/test-year-end-assist.mjs', true],
  ['scripts/test-year-end-audit-remediation.mjs', true],
  ['scripts/test-year-end-memo-security.mjs', true],
  ['scripts/test-year-end-ui-layout.mjs', true],
  ['scripts/test-year-end-side-upload.mjs', true],
  ['scripts/test-year-end-unified-workspace.mjs', true],
  ['scripts/test-year-end-ux-correction.mjs', true],
  ['scripts/test-year-end-ui-consistency.mjs', true],
  ['scripts/test-year-end-edit-first.mjs', true],
  ['scripts/test-year-end-v5-ux.mjs', true],
  ['scripts/test-year-end-v7-ui-cleanup.mjs', true],
  ['scripts/test-v8-month-settings-status.mjs', true],
  ['scripts/test-v9-clean-home-responsive-status.mjs', true],
  ['scripts/test-v10-yearend-list.mjs', true],
  ['scripts/test-v12-yearend-bottom-alignment.mjs', true],
  ['scripts/test-v11-settings-home-money.mjs', true],
  ['scripts/test-year-end-bulk-responsiveness.mjs', true],
  ['scripts/test-year-end-zip-taxable-copy.mjs', true],
  ['scripts/test-year-end-staged-deletions.mjs', true],
  ['scripts/test-year-end-v5-batch.mjs', true],
  ['scripts/test-year-end-bonus-removal.mjs', true],
  ['scripts/test-cloud-core.mjs', true],
  ['scripts/test-integrity-hardening.mjs', true],
  ['scripts/test-partial-success-types.mjs', true],
  ['scripts/test-rotation-continuity-v5.mjs', true],
  ['scripts/test-delete-copy-readme.mjs', true],
  ['scripts/test-cloud-ux.mjs', true],
  ['scripts/test-ui-polish.mjs', true],
  ['scripts/test-ui-flow-footer.mjs', true],
  ['scripts/test-cloud-auth-form.mjs', true],
  ['scripts/test-cloud-tab-unlock.mjs', true],
  ['scripts/test-msal-auth-resilience.mjs', true],
  ['scripts/test-msal-v5-bridge.mjs', true],
  ['scripts/test-frame-guard.mjs', true],
  ['scripts/test-browser-remembered-key.mjs', true],
  ['scripts/test-signout-security.mjs', true],
  ['scripts/test-readme-and-unique-settings.mjs', true],
  ['scripts/test-cloud-upload-ux.mjs', true],
  ['scripts/test-cloud-batch.mjs', true],
  ['scripts/test-cloud-startup.mjs', true],
  ['scripts/test-navigation-session.mjs', true],
  ['scripts/test-key-rotation-backup.mjs', true],
  ['scripts/test-readonly-diagnostics.mjs', true],
  ['scripts/test-graph-read-retry.mjs', true],
  ['scripts/test-graph-transient-retry.mjs', true],
  ['scripts/test-detached-originals.mjs', true],
  ['scripts/test-folder-metadata-minimal.mjs', true],
  ['scripts/test-backup-layout.mjs', true],
  ['scripts/test-cleanup-guard.mjs', true],
  ['scripts/test-local-db-cleanup.mjs', true],
  ['scripts/test-legacy-cloud-predelete.mjs', true],
  ['scripts/test-cleanup-finance-compat.mjs', true],
  ['scripts/test-income-publication-v132.mjs', true],
  ['scripts/verify-three-features.mjs', true],
  ['scripts/verify-calendar-feature.mjs', true],
];
for (const [relative, required] of tests) {
  const target = path.join(root, relative);
  if (!existsSync(target)) {
    if (required) throw new Error(`必須テストがありません: ${relative}`);
    console.log(`SKIP (監査パッチ未適用): ${relative}`);
    continue;
  }
  console.log(`\n▶ ${relative}`);
  const result = spawnSync(process.execPath, ['--experimental-transform-types', target], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\n✅ Payroll 全回帰テスト完了');
