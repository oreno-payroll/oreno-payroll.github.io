/** 年度判定と「3月まで見込み」の回帰テスト。保存済みデータには一切触れません。 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));

async function sourceModule(relativePath) {
  const built = await build({
    entryPoints: [path.join(root, relativePath)],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', write: false, logLevel: 'silent',
  });
  const base64 = Buffer.from(built.outputFiles[0].contents).toString('base64');
  return import(`data:text/javascript;base64,${base64}`);
}
const { fiscalYearOfTargetMonth, salaryPaymentLag } = await sourceModule('src/forecast/payrollCalendar.ts');
const { calculateAnnualForecast } = await sourceModule('src/forecast/annualForecast.ts');

for (const [target, expected] of [
  ['2025-03', 2024], ['2025-04', 2025], ['2026-02', 2025],
  ['2026-03', 2025], ['2026-04', 2026], ['2027-03', 2026],
]) assert.equal(fiscalYearOfTargetMonth(target), expected, `${target}の年度`);
assert.equal(fiscalYearOfTargetMonth('2026-13'), null);
assert.equal(salaryPaymentLag({ targetMonth: '2026-03', paymentDate: '2026-04-30' }), 1);
assert.equal(salaryPaymentLag({ targetMonth: '2026-10', paymentDate: '2026-10-25' }), 0);

function record(job, kind, targetMonth, paymentDate, gross, net, extras = {}) {
  return { form: {
    job, kind, targetMonth, paymentDate,
    gross: String(gross), net: String(net),
    taxable: String(gross - 3000), nonTaxable: '3000', transportation: '3000',
    incomeTax: '4000', residentTax: '0', healthInsurance: '1000', pension: '2000',
    employmentInsurance: '500', ...extras,
  } };
}
const records = [
  record('main', 'salary', '2026-08', '2026-09-30', 240000, 205000),
  record('main', 'salary', '2026-09', '2026-10-30', 250000, 215000),
  record('side', 'salary', '2026-09', '2026-09-25', 45000, 42000),
  record('side', 'salary', '2026-10', '2026-10-25', 48000, 45000),
  record('main', 'bonus', '2026-08', '2026-08-31', 250000, 200000),
];
const now = new Date(2026, 10, 12);
const snapshot = JSON.stringify(records);
const forecast = calculateAnnualForecast(records, 2026, now, true);
assert.deepEqual(forecast.jobs.main.pendingMonths, [
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
]);
assert.deepEqual(forecast.jobs.side.pendingMonths, [
  '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
]);
assert.deepEqual(forecast.jobs.main.sampleMonths, ['2026-09', '2026-08']);
assert.deepEqual(forecast.jobs.main.pendingBonusMonths, ['2027-02']);
assert.equal(forecast.jobs.main.bonusEstimates.length, 1);
assert.equal(forecast.jobs.side.bonusEstimates.length, 0);
assert.equal(forecast.estimates.filter(e => e.kind === 'salary').length, 11);
assert.equal(JSON.stringify(records), snapshot, '見込み計算はデータを変更しない');

const noBonus = calculateAnnualForecast(records, 2026, now, false);
assert.equal(noBonus.jobs.main.bonusEstimates.length, 0, '賞与OFFでは賞与を予測しない');

const withOctoberMain = [
  ...records,
  record('main', 'salary', '2026-10', '2026-11-30', 250000, 215000),
];
const afterSaved = calculateAnnualForecast(withOctoberMain, 2026, now, true);
assert.ok(!afterSaved.jobs.main.pendingMonths.includes('2026-10'), '対象月が登録済みなら二重に推計しない');

const past = calculateAnnualForecast(records, 2025, now, true);
assert.equal(past.estimates.length, 0, '過去年度を推計しない');

console.log('OK: 対象年月での年度区分、翌月払い・当月払いの見込み、重複予測防止、賞与OFF、保存データ不変');
