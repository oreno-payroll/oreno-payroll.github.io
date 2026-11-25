/** 必須回帰テストを全件実行し、失敗をまとめて報告する。 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  'scripts/test-payroll-pending-deletion.mjs',
  'scripts/test-payroll-employer-directory.mjs',
  'scripts/test-payroll-employer-selection.mjs',
  'scripts/test-payroll-employer-forecast.mjs',
  'scripts/test-payroll-operation-dialog.mjs',
  'scripts/test-payroll-review-consent.mjs',
  'scripts/test-payroll-settings-diagnostic.mjs',
  'scripts/test-payroll-notification-outcomes.mjs',
  'scripts/test-ci-security-gates.mjs',
  'scripts/test-security-pipeline.mjs',
  'scripts/test-pr-merge-target.mjs',
  'scripts/test-pr-workflow-locked.mjs',
  'scripts/test-payroll-ui-clarity.mjs',
  'scripts/test-cross-tab-lock.mjs',
  'scripts/test-year-end-backup.mjs',
  'scripts/test-year-end-restore-resume.mjs',
  'scripts/test-v25-yearend-safety.mjs',
  'scripts/test-v26-restore-diagnosis.mjs',
  'scripts/test-v27-yearend-clarity.mjs',
  'scripts/test-year-end-pdf-lock.mjs',
  'scripts/test-v22-ux-safety.mjs',
  'scripts/test-theme.mjs',
  'scripts/test-publish-audit.mjs',
  'scripts/test-security-hardening.mjs',
  'scripts/test-high-priority.mjs',
  'scripts/test-medium-priority.mjs',
  'scripts/test-low-priority.mjs',
  'scripts/test-missing-indicator.mjs',
  'scripts/test-optional-zero.mjs',
  'scripts/test-audit-fixes.mjs',
  'scripts/test-bonus-latest.mjs',
  'scripts/test-calendar-year.mjs',
  'scripts/test-home-registration-status.mjs',
  'scripts/test-payroll-ui-followup.mjs',
  'scripts/test-upload-empty-layout.mjs',
  'scripts/test-payroll-forecast-safety.mjs',
  'scripts/test-payroll-history-and-ux.mjs',
  'scripts/test-monthly-registration.mjs',
  'scripts/test-side-zip.mjs',
  'scripts/test-target-year.mjs',
  'scripts/test-lazy-pdfs.mjs',
  'scripts/test-pdf-view-service-worker.mjs',
  'scripts/test-viewer-flow.mjs',
  'scripts/test-pdf-oneclick.mjs',
  'scripts/test-pdf-handoff-lock.mjs',
  'scripts/test-payroll-view-privacy.mjs',
  'scripts/test-year-end-assist.mjs',
  'scripts/test-year-end-audit-remediation.mjs',
  'scripts/test-year-end-memo-security.mjs',
  'scripts/test-year-end-ui-layout.mjs',
  'scripts/test-year-end-side-upload.mjs',
  'scripts/test-year-end-unified-workspace.mjs',
  'scripts/test-year-end-ux-correction.mjs',
  'scripts/test-year-end-ui-consistency.mjs',
  'scripts/test-year-end-edit-first.mjs',
  'scripts/test-year-end-v5-ux.mjs',
  'scripts/test-year-end-bulk-responsiveness.mjs',
  'scripts/test-payroll-yearend-proof-and-zip.mjs',
  'scripts/test-year-end-zip-taxable-copy.mjs',
  'scripts/test-year-end-staged-deletions.mjs',
  'scripts/test-year-end-v5-batch.mjs',
  'scripts/test-year-end-bonus-removal.mjs',
  'scripts/test-cloud-core.mjs',
  'scripts/test-integrity-hardening.mjs',
  'scripts/test-partial-success-types.mjs',
  'scripts/test-rotation-continuity-v5.mjs',
  'scripts/test-delete-copy-readme.mjs',
  'scripts/test-cloud-ux.mjs',
  'scripts/test-ui-polish.mjs',
  'scripts/test-ui-flow-footer.mjs',
  'scripts/test-cloud-auth-form.mjs',
  'scripts/test-payroll-auth-gate-responsive.mjs',
  'scripts/test-cloud-tab-unlock.mjs',
  'scripts/test-msal-auth-resilience.mjs',
  'scripts/test-payroll-msal-reconnect.mjs',
  'scripts/test-payroll-settings-safety.mjs',
  'scripts/test-payroll-upload-recovery.mjs',
  'scripts/test-payroll-p1-p7.mjs',
  'scripts/test-msal-v5-bridge.mjs',
  'scripts/test-frame-guard.mjs',
  'scripts/test-browser-remembered-key.mjs',
  'scripts/test-signout-security.mjs',
  'scripts/test-readme-and-unique-settings.mjs',
  'scripts/test-cloud-upload-ux.mjs',
  'scripts/test-cloud-batch.mjs',
  'scripts/test-payroll-performance-phase01.mjs',
  'scripts/test-payroll-performance-phase02.mjs',
  'scripts/test-payroll-performance-phase03.mjs',
  'scripts/test-payroll-income-inventory.mjs',
  'scripts/test-payroll-performance-ce.mjs',
  'scripts/test-payroll-performance-ce-standalone.mjs',
  'scripts/test-payroll-performance-f.mjs',
  'scripts/test-payroll-optimization-round2.mjs',
  'scripts/test-payroll-graph-upload-epoch.mjs',
  'scripts/test-payroll-yearend-freshness-and-commit.mjs',
  'scripts/test-payroll-semantics-v1-compat.mjs',
  'scripts/test-payroll-zero-resolution.mjs',
  'scripts/test-payroll-employer-identity.mjs',
  'scripts/test-payroll-performance-phase05.mjs',
  'scripts/test-payroll-dashboard-selection.mjs',
  'scripts/test-cloud-startup.mjs',
  'scripts/test-navigation-session.mjs',
  'scripts/test-key-rotation-backup.mjs',
  'scripts/test-readonly-diagnostics.mjs',
  'scripts/test-graph-read-retry.mjs',
  'scripts/test-detached-originals.mjs',
  'scripts/test-folder-metadata-minimal.mjs',
  'scripts/test-backup-layout.mjs',
  'scripts/test-cleanup-guard.mjs',
  'scripts/test-local-db-cleanup.mjs',
  'scripts/test-legacy-cloud-predelete.mjs',
  'scripts/test-cleanup-finance-compat.mjs',
  'scripts/test-income-publication-v132.mjs',
  'scripts/verify-three-features.mjs',
  'scripts/verify-calendar-feature.mjs',
  'scripts/test-payroll-final-quality.mjs',
  'scripts/test-payroll-final-security.mjs',
  'scripts/test-payroll-private-audit.mjs',
  'scripts/test-payroll-cloud-write-lock.mjs',
  'scripts/test-payroll-upload-priority.mjs',
];
const failures = [];
let passed = 0;
const registered = new Set(tests);
if (registered.size !== tests.length) throw new Error('回帰テストの重複登録があります。');
for (const name of readdirSync(path.join(root,'scripts'))) {
  if (/^(?:test|verify)-.+\.mjs$/.test(name) && !registered.has(`scripts/${name}`)) failures.push(`scripts/${name}: 実行一覧に未登録です`);
}
for (const relative of tests) {
  const target = path.join(root, relative);
  console.log(`\n▶ ${relative}`);
  if (!existsSync(target)) {
    failures.push(`${relative}: 必須テストがありません`);
    continue;
  }
  const result = spawnSync(process.execPath, ['--experimental-transform-types', target], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) failures.push(`${relative}: ${result.error?.message??result.signal??result.status}`);
  else passed++;
}
console.log(`\n回帰テスト: ${passed}/${tests.length} PASS, ${failures.length} FAIL`);
if (failures.length) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exitCode = 1;
} else console.log('✅ Payroll 全回帰テスト完了');
