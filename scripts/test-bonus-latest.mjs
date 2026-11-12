/** 本業の賞与見込み: 最後の通常給与1件、業績給非引継ぎ、実績との二重計上防止。 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function load(relative) {
  const output = await build({
    entryPoints: [path.join(root, relative)], bundle: true,
    platform: 'node', format: 'esm', target: 'node20', write: false, logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`);
}
const { calculateAnnualForecast, estimateMainBonus } = await load('src/forecast/annualForecast.ts');
const { calculateCalendarForecast } = await load('src/forecast/calendarForecast.ts');
let passed = 0;
function test(label, fn) { fn(); passed++; console.log(`PASS: ${label}`); }
const today = new Date(2026, 10, 12);
function salary(paymentDate, targetMonth, extra = {}) {
  return { form: {
    job: 'main', kind: 'salary', paymentDate, targetMonth,
    gross: '235760', taxable: '215000', nonTaxable: '20760',
    transportation: '9000', reimbursedExpenses: '11760',
    net: '199014', incomeTax: '4120', residentTax: '0', healthInsurance: '11264',
    pension: '20130', employmentInsurance: '1232', yearEndAdjustment: '',
    ...extra,
  } };
}
function bonus(paymentDate, gross = 385800) {
  return { form: { job: 'main', kind: 'bonus', paymentDate, targetMonth: paymentDate.slice(0, 7), gross: String(gross), net: String(gross - 80000), performanceBonus: '150000' } };
}
const older = salary('2026-09-30', '2026-08', {
  gross: '400000', taxable: '390000', nonTaxable:'10000',transportation:'10000',reimbursedExpenses:'',net:'340000',
});
const newest = salary('2026-10-30','2026-09');
const records = [older, newest, bonus('2026-08-28')];
const original = JSON.stringify(records);

test('最新の通常給与1件のみ。3件中央値や8月給与を使わない', () => {
  const estimate = estimateMainBonus('2027-02', [older, newest]);
  assert.equal(estimate.values.gross, 215000);
  assert.equal(estimate.values.net, 178254);
  assert.equal(estimate.values.transportation, 0);
  assert.equal(estimate.values.reimbursedExpenses, 0);
  assert.equal(estimate.values.incomeTax, 4120);
});
test('年度：8月に業績給付き実績があれば、2月の見込みに業績給を足さない', () => {
  const forecast = calculateAnnualForecast(records, 2026, today, true);
  assert.deepEqual(forecast.jobs.main.pendingBonusMonths, ['2027-02']);
  assert.equal(forecast.jobs.main.bonusEstimates[0].values.gross, 215000);
  assert.equal(forecast.jobs.main.bonusEstimates[0].values.net, 178254);
});
test('年度：8月未登録なら8月・2月を見込み、2件登録なら見込みなし', () => {
  const missingBoth = calculateAnnualForecast([older, newest], 2026, today);
  assert.deepEqual(missingBoth.jobs.main.pendingBonusMonths, ['2026-08','2027-02']);
  assert.deepEqual(missingBoth.jobs.main.bonusEstimates.map(e => e.values.gross), [215000,215000]);
  const bothSaved = calculateAnnualForecast([...records, bonus('2027-02-26', 235800)], 2026, today);
  assert.equal(bothSaved.jobs.main.bonusEstimates.length, 0);
});
test('年度：0円賞与も実績として認識し、同月の推計を重複させない', () => {
  const zero = calculateAnnualForecast([older, newest, bonus('2026-08-28', 0)], 2026, today);
  assert.deepEqual(zero.jobs.main.pendingBonusMonths, ['2027-02']);
});
test('暦年：通常給与最終月より前でも、未登録の2月賞与を補完', () => {
  const forecast = calculateCalendarForecast(records, 2026, today);
  assert.deepEqual(forecast.jobs.main.pendingBonusMonths, ['2026-02']);
  assert.equal(forecast.jobs.main.bonusEstimates[0].values.gross, 215000);
});
test('暦年：2月だけ実績があれば未登録の8月賞与を補完', () => {
  const forecast = calculateCalendarForecast([older, newest, bonus('2026-02-27')], 2026, today);
  assert.deepEqual(forecast.jobs.main.pendingBonusMonths, ['2026-08']);
});
test('副業賞与は従来通り：仮想賞与は0件、保存済み実績の変更なし', () => {
  const sideBonus = { form: { job:'side',kind:'bonus',paymentDate:'2026-03-25',targetMonth:'2026-03',gross:'50000',net:'40000' } };
  const entries = [...records, sideBonus];
  const fiscal = calculateAnnualForecast(entries, 2026, today);
  const calendar = calculateCalendarForecast(entries, 2026, today);
  assert.equal(fiscal.jobs.side.bonusEstimates.length, 0);
  assert.equal(calendar.jobs.side.bonusEstimates.length, 0);
  assert.equal(sideBonus.form.gross, '50000');
});
test('賞与表示OFFは本業の見込みを加算しない', () => {
  assert.equal(calculateAnnualForecast(records, 2026, today, false).jobs.main.bonusEstimates.length, 0);
  assert.equal(calculateCalendarForecast(records, 2026, today, false).jobs.main.bonusEstimates.length, 0);
});
test('給与見込みの6か月制限と切り離し、最新の登録済み通常給与を賞与に使う', () => {
  const oldOnly = salary('2026-03-31','2026-02');
  const fiscal = calculateAnnualForecast([oldOnly], 2026, today);
  assert.equal(fiscal.jobs.main.estimates.length, 0);
  assert.equal(fiscal.jobs.main.bonusSampleMonth, '2026-03');
  assert.equal(fiscal.jobs.main.bonusEstimates[0].values.gross, 215000);
  const calendar = calculateCalendarForecast([oldOnly], 2026, today);
  assert.equal(calendar.jobs.main.estimates.length, 0);
  assert.equal(calendar.jobs.main.bonusSampleMonth, '2026-03');
  assert.equal(calendar.jobs.main.bonusEstimates[0].values.gross, 215000);
});
test('交通費が未判明の給与を賞与見込みへ丸ごと転記しない', () => {
  const ambiguous = salary('2026-10-30','2026-09', {
    transportation:'',reimbursedExpenses:'',taxable:'',nonTaxable:''
  });
  assert.equal(estimateMainBonus('2027-02',[ambiguous]), null);
});
test('保存済みデータは読み取り専用', () => assert.equal(JSON.stringify(records), original));
console.log(`OK: 最新通常給与ベースの本業賞与見込み ${passed}件に成功`);
