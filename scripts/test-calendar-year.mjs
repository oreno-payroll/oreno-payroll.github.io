/** 暦年（支給日基準）の見込みと年度境界の回帰試験。 npm run check 後の単体実行も可。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(path.join(os.tmpdir(), 'payroll-calendar-test-'));
const require = createRequire(import.meta.url);
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function salary(job, paymentDate, targetMonth, gross = 240000) {
  return { form: { job, kind: 'salary', paymentDate, targetMonth,
    gross: String(gross), net: String(gross - 45000), incomeTax: '4500', residentTax: '9000',
    transportation: '9000', reimbursedExpenses: '1800', healthInsurance: '11000',
    pension: '20000', employmentInsurance: '1200', careInsurance: '0', childcareSupport: '0', workDays: '20',
    yearEndAdjustment: '-30000',
  } };
}
function bonus(paymentDate) { return { form: { job:'main', kind:'bonus', paymentDate, targetMonth: paymentDate.slice(0,7), gross:'400000',net:'320000' } }; }
try {
  // このプロジェクトが使用するesbuildで純粋関数だけをバンドルする。
  // TypeScriptのメジャー更新によるテスト用CLIオプションの差異を避ける。
  await build({
    entryPoints: [
      path.join(root, 'src/forecast/calendarForecast.ts'),
      path.join(root, 'src/forecast/annualForecast.ts'),
      path.join(root, 'src/forecast/payrollCalendar.ts'),
    ],
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    outdir: temp, outExtension: { '.js': '.cjs' }, logLevel: 'silent',
  });
  const { calculateCalendarForecast, calendarYearOfPaymentDate } = require(path.join(temp, 'calendarForecast.cjs'));
  const { calculateAnnualForecast } = require(path.join(temp, 'annualForecast.cjs'));
  const { fiscalYearOfTargetMonth } = require(path.join(temp, 'payrollCalendar.cjs'));
  const today = new Date(2026, 10, 12);
  const records = [
    salary('main', '2026-08-28','2026-07'),
    salary('main', '2026-09-30','2026-08'),
    salary('main', '2026-10-30','2026-09'),
    salary('side', '2026-09-25','2026-09', 60000),
    salary('side', '2026-10-25','2026-10', 50000),
    bonus('2026-08-28'),
  ];
  test('支給日を優先し、対象月に惑わされず暦年を決定する', () => {
    assert.equal(calendarYearOfPaymentDate('2026-01-31'), 2026);
    assert.equal(calendarYearOfPaymentDate('2025-12-31'), 2025);
    assert.equal(calendarYearOfPaymentDate(''), null);
    assert.equal(fiscalYearOfTargetMonth('2025-12'), 2025);
    assert.equal(fiscalYearOfTargetMonth('2026-03'), 2025);
  });
  test('10月が最後の実績なら、両勤務先とも11月・12月のみ推計する', () => {
    const plan = calculateCalendarForecast(records, 2026, today);
    assert.deepEqual(plan.jobs.main.pendingMonths, ['2026-11','2026-12']);
    assert.deepEqual(plan.jobs.side.pendingMonths, ['2026-11','2026-12']);
    // 賞与実績が8月のみの場合、過ぎた2月も未登録なら賞与見込み1件を加える。
    assert.equal(plan.estimates.length, 5);
    assert.deepEqual(plan.jobs.main.bonusEstimates.map(e => e.month), ['2026-02']);
    assert.deepEqual(plan.jobs.main.sampleMonths, ['2026-10','2026-09','2026-08']);
    assert.equal(plan.jobs.main.estimates[0].values.gross, 238200);
    assert.equal(plan.jobs.main.estimates[0].values.incomeTax, 4500);
    assert.equal(plan.jobs.main.estimates[0].values.socialInsurance, 32200);
    assert.equal(plan.jobs.main.estimates[0].values.reimbursedExpenses, 0);
  });
  test('年末調整の一時的な還付は予測所得税に持ち込まない', () => {
    const plan = calculateCalendarForecast(records, 2026, today);
    assert.equal(plan.jobs.main.estimates[0].values.incomeTax, 4500);
  });
  test('賞与OFFなら賞与予測ゼロ、副業賞与予測は常にゼロ', () => {
    const plan = calculateCalendarForecast(records, 2026, today, false);
    assert.equal(plan.jobs.main.bonusEstimates.length, 0);
    assert.equal(plan.jobs.side.bonusEstimates.length, 0);
  });
  test('2026年の12月給与が保存済みなら重複予測しない', () => {
    const withDecember = [...records, salary('main', '2026-12-30', '2026-11')];
    const plan = calculateCalendarForecast(withDecember, 2026, today);
    assert.equal(plan.jobs.main.estimates.length, 0);
    assert.deepEqual(plan.jobs.side.pendingMonths, ['2026-11','2026-12']);
  });
  test('過年度の暦年に架空の見込みを追加しない', () => {
    const plan = calculateCalendarForecast(records, 2025, today);
    assert.equal(plan.applicable, false);
    assert.equal(plan.estimates.length, 0);
  });
  test('過去に未登録の中間月があっても、最後の実績より前を推測しない', () => {
    const plan = calculateCalendarForecast([
      salary('main','2026-08-31','2026-07'),
      salary('main','2026-10-31','2026-09'),
    ], 2026, today);
    assert.deepEqual(plan.jobs.main.pendingMonths, ['2026-11','2026-12']);
  });
  test('11月時点で8月が最後なら9・10月を遡及予測せず11・12月だけ推計する', () => {
    const plan = calculateCalendarForecast([salary('main','2026-08-31','2026-07')], 2026, today);
    assert.deepEqual(plan.jobs.main.pendingMonths, ['2026-11','2026-12']);
    assert.deepEqual(plan.jobs.main.estimates.map(item => item.month), ['2026-11','2026-12']);
    assert.ok(!plan.jobs.main.pendingMonths.includes('2026-09'));
    assert.ok(!plan.jobs.main.pendingMonths.includes('2026-10'));
  });
  test('当月に通常給与が登録済みなら翌月以降だけを推計する', () => {
    const plan = calculateCalendarForecast([salary('main','2026-11-12','2026-10')], 2026, today);
    assert.deepEqual(plan.jobs.main.pendingMonths, ['2026-12']);
  });
  test('1月時点では12月まで予測し、本業2月・8月賞与のみ追加する', () => {
    const plan = calculateCalendarForecast([salary('main','2025-12-26','2025-11')], 2026, new Date(2026,0,10));
    assert.equal(plan.jobs.main.estimates.length, 12);
    assert.deepEqual(plan.jobs.main.bonusEstimates.map(x=>x.month), ['2026-02','2026-08']);
  });
  test('本業の8月賞与が既にある場合は同月の賞与を再計上しない', () => {
    const plan = calculateCalendarForecast([
      salary('main','2026-07-30','2026-06'), bonus('2026-08-28'),
    ], 2026, new Date(2026, 6, 31));
    assert.equal(plan.jobs.main.bonusEstimates.filter(e=>e.month==='2026-08').length, 0);
  });
  test('直近給与がない場合に架空の額面を作らない', () => {
    const plan = calculateCalendarForecast([salary('side','2026-01-30','2026-01')], 2026, today);
    assert.equal(plan.jobs.side.pendingMonths.length, 11);
    assert.equal(plan.jobs.side.estimates.length, 0);
    assert.match(plan.jobs.side.reason ?? '', /直近6か月/);
  });
  test('既存の年度見込み関数の機能を維持している', () => {
    const plan = calculateAnnualForecast(records, 2026, today);
    assert.equal(plan.applicable, true);
    assert.ok(plan.jobs.main.pendingMonths.includes('2027-03'));
  });
  for (const [name, fn] of tests) { fn(); console.log('PASS', name); }
  console.log(`OK: 暦年集計と12月見込み ${tests.length}件の回帰テストに成功`);
} finally { rmSync(temp, { recursive:true, force:true }); }
