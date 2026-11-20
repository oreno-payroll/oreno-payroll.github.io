/** V9 static contracts: no personal data or cloud sign-in needed. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const get=(name)=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const main=get('src/main.ts');
const home=get('public/index.html');
const dash=get('public/styles/dashboard.css');
const backup=get('public/backup/index.html');
const vault=get('public/styles/vault.css');
const style=get('public/styles/style.css');
// Keep slips in month order, without redundant headers or duplicate calendar metadata; monetary totals stay visible.
assert.match(main,/monthKey\(b\)\.localeCompare\(monthKey\(a\)\)/);
assert.doesNotMatch(main,/statement-month-heading|statement-item__meta/);
assert.doesNotMatch(dash,/\.statement-month-heading|\.statement-item__meta/);
assert.doesNotMatch(home,/登録されたPDFを年月別に確認できます/);
assert.match(main,/detail\.append\(link, amounts\)/);
assert.match(main,/\['総支給', record\.form\.gross\]/);
assert.match(main,/\['手取り', record\.form\.net\]/);
assert.match(dash,/\.statement-item__amounts \{/);
// Work days belongs to the supplementary deductions, above net pay.
const days=home.indexOf('id="side-days"');
assert.ok(days>home.indexOf('id="side-social-insurance"'));
assert.ok(days<home.indexOf('id="side-net"'));
assert.doesNotMatch(home,/job-card__supplement/);
// Settings use the same app-shell inner width as the dashboard, not an extra 1050px cap.
assert.match(vault,/\.settings-page \{ max-width: none; width: 100%;/);
assert.doesNotMatch(vault,/\.settings-page \{ max-width: 1050px/);
// Three matching column hierarchies: title, supporting text, then the action (never crammed into the title).
assert.doesNotMatch(backup,/settings-detail-head/);
assert.match(backup,/<h3 id="settings-finance-income-title">[^<]+<\/h3>\s*<p class="settings-note">[\s\S]*?<div class="settings-action-row">\s*<button[^>]+id="payroll-income-publish"/);
assert.match(backup,/<h3 id="settings-orphan-title">[^<]+<\/h3>\s*<p class="settings-note">[\s\S]*?<div class="settings-action-row">\s*<button[^>]+id="orphan-year-check"/);
assert.match(backup,/id="orphan-year-recover"[^>]*hidden disabled/);
assert.match(vault,/\.settings-page \.settings-details-column \.settings-action-row,/);
assert.doesNotMatch(vault,/\.settings-details-column \.settings-action-row[^\n]*margin-top:auto/);
// Notification width & height are capped; errors can be scrolled, other notices stay non-blocking.
assert.match(style,/\.app-status\{[^}]*max-width:min\(380px,calc\(100vw/);
assert.match(style,/max-height:min\(240px,calc\(100dvh/);
assert.match(style,/\.app-status\[data-state="error"\]\{color:var\(--color-danger\);pointer-events:auto\}/);
console.log('PASS: non-duplicated filename and financial figures, side work days, matched settings hierarchy and viewport-safe toast');
