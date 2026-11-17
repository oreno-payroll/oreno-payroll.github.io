/** Finance v1.1.1 fields and publish controls must not be overwritten by cleanup patch. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {toPublicIncomeRecord} from '../src/cloud/income.ts';
const input={id:125,revision:3,form:{net:'180000',gross:'235000',taxable:'230000',paymentDate:'2026-11-27',targetMonth:'2026-11',job:'main',kind:'salary'}};
const converted=toPublicIncomeRecord(input);
assert.deepEqual({net:converted.netPaymentYen,gross:converted.grossPaymentYen,taxable:converted.taxablePaymentYen,revision:converted.revision},
  {net:180000,gross:235000,taxable:230000,revision:3});
const src=readFileSync(new URL('../src/cloud/vault.ts',import.meta.url),'utf8');
const backup=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/backup/index.html',import.meta.url),'utf8');
assert.match(src,/\.map\(toPublicIncomeRecord\)/);
assert.match(src,/async syncIncome\(/);
assert.match(backup,/['"]payroll-income-publish['"]/);
assert.match(backup,/vault\.syncIncome\(\)/);
assert.match(ui,/id="payroll-income-publish"/);
// The numeric grossPaymentYen field is verified above using real conversion.
// Display text is not part of the Finance data contract.
assert.match(ui, /<h2 id="settings-finance-income-title">Financeへの給与連携<\/h2>/);
assert.match(ui,/id="cloud-cleanup-check"/);
assert.match(ui,/id="legacy-cleanup-check"/);
console.log('PASS: Finance income fields, sync, manual republish and cleanup controls coexist');
