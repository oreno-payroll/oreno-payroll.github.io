/** 必須回帰テストを全件実行し、失敗をまとめて報告する。 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  ['scripts/test-payroll-pending-deletion.mjs', true],
  ['scripts/test-payroll-employer-directory.mjs', true],
  ['scripts/test-payroll-employer-selection.mjs', true],
  ['scripts/test-payroll-employer-forecast.mjs', true],
  ['scripts/test-payroll-operation-dialog.mjs', true],
  ['scripts/test-payroll-review-consent.mjs', true],
  ['scripts/test-payroll-settings-diagnostic.mjs', true],
  ['scripts/test-payroll-notification-outcomes.mjs', true],
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
  ['scripts/test-audit-fixes.mjs', true],
  ['scripts/test-bonus-latest.mjs', true],
  ['scripts/test-calendar-year.mjs', true],
  ['scripts/test-home-registration-status.mjs', true],
  ['scripts/test-payroll-ui-followup.mjs', true],
  ['scripts/test-upload-empty-layout.mjs', true],
  ['scripts/test-payroll-forecast-safety.mjs', true],
  ['scripts/test-payroll-history-and-ux.mjs', true],
  ['scripts/test-monthly-registration.mjs', true],
  ['scripts/test-side-zip.mjs', true],
  ['scripts/test-target-year.mjs', true],
  ['scripts/test-lazy-pdfs.mjs', true],
  ['scripts/test-pdf-view-service-worker.mjs', true],
  ['scripts/test-viewer-flow.mjs', true],
  ['scripts/test-pdf-oneclick.mjs', true],
  ['scripts/test-pdf-handoff-lock.mjs', true],
  ['scripts/test-payroll-view-privacy.mjs', true],
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
  ['scripts/test-payroll-yearend-proof-and-zip.mjs', true],
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
  ['scripts/test-payroll-auth-gate-responsive.mjs', true],
  ['scripts/test-cloud-tab-unlock.mjs', true],
  ['scripts/test-msal-auth-resilience.mjs', true],
  ['scripts/test-payroll-msal-reconnect.mjs', true],
  ['scripts/test-payroll-settings-safety.mjs', true],
  ['scripts/test-payroll-upload-recovery.mjs', true],
  ['scripts/test-payroll-p1-p7.mjs', true],
  ['scripts/test-msal-v5-bridge.mjs', true],
  ['scripts/test-frame-guard.mjs', true],
  ['scripts/test-browser-remembered-key.mjs', true],
  ['scripts/test-signout-security.mjs', true],
  ['scripts/test-readme-and-unique-settings.mjs', true],
  ['scripts/test-cloud-upload-ux.mjs', true],
  ['scripts/test-cloud-batch.mjs', true],
  ['scripts/test-payroll-performance-phase01.mjs', true],
  ['scripts/test-payroll-performance-phase02.mjs', true],
  ['scripts/test-payroll-performance-phase03.mjs', true],
  ['scripts/test-payroll-income-inventory.mjs', true],
  ['scripts/test-payroll-performance-ce.mjs', true],
  ['scripts/test-payroll-performance-ce-standalone.mjs', true],
  ['scripts/test-payroll-performance-f.mjs', true],
  ['scripts/test-payroll-optimization-round2.mjs', true],
  ['scripts/test-payroll-graph-upload-epoch.mjs', true],
  ['scripts/test-payroll-yearend-freshness-and-commit.mjs', true],
  ['scripts/test-payroll-semantics-v1-compat.mjs', true],
  ['scripts/test-payroll-zero-resolution.mjs', true],
  ['scripts/test-payroll-employer-identity.mjs', true],
  ['scripts/test-payroll-performance-phase04.mjs', true],
  ['scripts/test-payroll-performance-phase05.mjs', true],
  ['scripts/test-payroll-dashboard-selection.mjs', true],
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
  ['scripts/test-payroll-final-quality.mjs', true],
  ['scripts/test-payroll-final-security.mjs', true],
  ['scripts/test-payroll-private-audit.mjs', true],
];
const failures = [];
let passed = 0;
const registered = new Set(tests.map(([name])=>name));
if (registered.size !== tests.length) throw new Error('回帰テストの重複登録があります。');
for (const name of readdirSync(path.join(root,'scripts'))) {
  if (/^(?:test|verify)-.+\.mjs$/.test(name) && !registered.has(`scripts/${name}`)) failures.push(`scripts/${name}: 実行一覧に未登録です`);
}
for (const [relative, required] of tests) {
  const target = path.join(root, relative);
  console.log(`\n▶ ${relative}`);
  if (!existsSync(target)) {
    failures.push(`${relative}: ${required?'必須テストがありません':'テストがありません'}`);
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
