/** Payroll 優先度「高」回帰テスト。実PDF/個人データを利用しない。Node.js 22以上。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePayroll } from '../src/pdf/payrollParser.ts';
import { applicablePayrollForm, validatePayrollForm } from '../src/storage/payrollValidation.ts';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${passed}: ${name}`); }
function cell(text, x, y, page = 1) { return { page, text, x, y, width: 60, height: 10 }; }
function addAmount(cells, label, value, lx, vx, y, page = 1) {
  cells.push(cell(label, lx, y, page), cell(String(value), vx, y, page));
}
function mainSalary(page = 1) {
  const c = [cell('本年累計', 430, 580, page), cell('2026年10月分', 35, 760, page),
    cell('支給日', 30, 740, page), cell('2026/11/30', 110, 740, page)];
  addAmount(c, '基本給', 210000, 160, 255, 625, page);
  addAmount(c, '固定残業手当', 25000, 160, 255, 590, page);
  addAmount(c, '支給合計', 235000, 160, 255, 500, page);
  addAmount(c, '振込支給額', 210000, 440, 530, 630, page);
  addAmount(c, '控除合計', 25000, 300, 400, 500, page);
  addAmount(c, '出勤日数(平日)', 20, 35, 115, 600, page);
  return c;
}
function mainBonus(page = 1) {
  const c = [cell('賞与明細', 30, 780, page), cell('本年累計', 430, 580, page),
    cell('支', 45, 745, page), cell('給日:2026年8月28日', 58, 745, page)];
  addAmount(c, '賞与手当', 100000, 40, 175, 610, page);
  addAmount(c, '支給合計', 100000, 40, 175, 500, page);
  addAmount(c, '振込支給額', 90000, 410, 540, 600, page);
  addAmount(c, '控除合計', 10000, 230, 360, 500, page);
  return c;
}
function sideSalary(page = 1) {
  const c = [cell('基本給(時給)', 30, 680, page),
    cell('支給日:2026/10/25', 30, 770, page)];
  addAmount(c, '課税支給合計', 58000, 30, 145, 690, page);
  addAmount(c, '非税支給合計', 2000, 30, 145, 660, page);
  addAmount(c, '支給合計', 60000, 30, 145, 625, page);
  addAmount(c, '控除合計', 5000, 175, 273, 625, page);
  addAmount(c, '差引支給合計', 55000, 310, 415, 600, page);
  return c;
}
function sideBonus(page = 1) {
  const c = [cell('賞与支給明細', 30, 780, page), cell('支給日:2026/08/25', 30, 750, page)];
  addAmount(c, '賞与', 50000, 30, 145, 690, page);
  addAmount(c, '支給合計', 50000, 30, 145, 625, page);
  addAmount(c, '所得税', 5000, 175, 273, 665, page);
  addAmount(c, '控除合計', 5000, 175, 273, 625, page);
  addAmount(c, '差引支給合計', 45000, 310, 415, 600, page);
  return c;
}

const salary = { job:'main',kind:'salary',targetMonth:'2026-10',paymentDate:'2026-11-30',
  gross:'120000',net:'110000',incomeTax:'10000',bonusBase:'300000',performanceBonus:'80000' };
test('給与への変更: 非表示の賞与項目は永続化対象から除外、元入力は維持', () => {
  const saved = applicablePayrollForm(salary);
  assert.equal(saved.bonusBase, ''); assert.equal(saved.performanceBonus, '');
  assert.equal(salary.bonusBase, '300000');
  assert.deepEqual(validatePayrollForm(salary), { errors: [], warnings: [] });
});
test('賞与への変更: 年調・立替経費・出勤日数は検算/保存から除外', () => {
  const bonus = { ...salary, kind:'bonus', bonusBase:'120000', performanceBonus:'',
    yearEndAdjustment:'-5000',reimbursedExpenses:'2000',workDays:'22' };
  const saved = applicablePayrollForm(bonus);
  for (const key of ['yearEndAdjustment','reimbursedExpenses','workDays']) assert.equal(saved[key], '');
  assert.equal(bonus.yearEndAdjustment, '-5000');
  assert.deepEqual(validatePayrollForm(bonus), { errors: [], warnings: [] });
});
test('本業給与: 支給日と重要な座標アンカーを認識', () => {
  const result = parsePayroll(mainSalary());
  assert.equal(result.profile, 'main'); assert.equal(result.fields.kind, 'salary');
  assert.equal(result.fields.paymentDate, '2026-11-30');
  assert.equal(result.layout?.status, 'matched');
  assert.equal(result.fields.net, '210000');
});
test('本業賞与: 「支」「給日:日付」分割から支給日を取得', () => {
  const result = parsePayroll(mainBonus());
  assert.equal(result.fields.paymentDate, '2026-08-28');
  assert.equal(result.layout?.status, 'matched');
});
test('本業の0円賞与: 振込支給額欄がなくても、元仕様の上部0円を採用', () => {
  const c = [cell('賞与明細',30,780),cell('本年累計',440,580),
    cell('支給日',35,745),cell('2026/02/27',135,745),
    cell('差引支給額',435,695),cell('0',520,695)];
  addAmount(c,'支給合計',0,40,175,520);
  addAmount(c,'控除合計',0,230,360,520);
  const result = parsePayroll(c);
  assert.equal(result.fields.net,'0');
  assert.equal(result.layout?.status, 'matched');
  assert.equal(result.fields.paymentDate, '2026-02-27');
});
test('支給日と年の間にコロンがない明細でも日付を抽出', () => {
  const c = sideSalary().map(item => item.text === '支給日:2026/10/25'
    ? { ...item, text: '支給日 2026年10月25日' } : item);
  assert.equal(parsePayroll(c).fields.paymentDate, '2026-10-25');
});
test('副業給与と副業賞与: 日付・座標検証を維持', () => {
  const regular = parsePayroll(sideSalary());
  assert.equal(regular.profile,'side'); assert.equal(regular.fields.kind,'salary');
  assert.equal(regular.layout?.status, 'matched');
  assert.equal(regular.fields.paymentDate, '2026-10-25');
  const bonus = parsePayroll(sideBonus());
  assert.equal(bonus.profile, 'side'); assert.equal(bonus.fields.kind, 'bonus');
  assert.equal(bonus.layout?.status, 'matched');
  assert.equal(bonus.fields.paymentDate, '2026-08-25');
});
test('日付ラベルが無ければ、PDF内の関係ない日付は支給日として使わない', () => {
  const cells = mainBonus().filter(item => item.text !== '支' && !item.text.startsWith('給日:'));
  cells.push(cell('2026/08/28', 30, 785), cell('2026/08/01', 80, 760));
  const result = parsePayroll(cells);
  assert.equal(result.fields.paymentDate, undefined);
  assert.equal(result.fields.targetMonth, undefined);
  assert.ok(result.warnings.some(w => w.includes('手動確認')));
});
test('単独の「給日:日付」からは支給日を誤認しない', () => {
  const cells = mainBonus().filter(item => item.text !== '支');
  assert.equal(parsePayroll(cells).fields.paymentDate, undefined);
});
test('本業給与: 重要見出しの移動を検知し、要確認にできる', () => {
  const cells = mainSalary().map(item => item.text === '支給合計' ? { ...item, x: 60 } : item);
  const result = parsePayroll(cells);
  assert.equal(result.profile, 'main');
  assert.equal(result.layout?.status, 'suspect');
  assert.ok(result.warnings.some(w => w.includes('自動入力を停止')));
});
test('副業賞与: 重要見出しの移動を検知', () => {
  const cells = sideBonus().map(item => item.text === '控除合計' ? { ...item, x: 25 } : item);
  assert.equal(parsePayroll(cells).layout?.status, 'suspect');
});
test('複数ページ: 書式一致したページを疑わしいページより優先', () => {
  const shifted = mainSalary(1).map(item => item.text === '支給合計' ? { ...item, x: 60 } : item);
  const good = mainSalary(2);
  const result = parsePayroll([...shifted, ...good]);
  assert.equal(result.layout?.status, 'matched');
  assert.equal(result.fields.paymentDate, '2026-11-30');
});
test('保存ボタンのアイコンと文言を別要素で保持', () => {
  const ui = readFileSync(new URL('../public/upload/index.html',import.meta.url),'utf8');
  const logic = readFileSync(new URL('../src/upload.ts',import.meta.url),'utf8');
  assert.match(ui, /id="save-all-label"/);
  assert.match(logic, /saveButtonLabel\.textContent = saving \?/);
  assert.doesNotMatch(logic, /saveButton\.textContent\s*=/);
});
test('未保存離脱警告: アップロードと編集の双方に設定', () => {
  const upload = readFileSync(new URL('../src/upload.ts',import.meta.url),'utf8');
  const edit = readFileSync(new URL('../src/edit.ts',import.meta.url),'utf8');
  assert.match(upload, /addEventListener\("beforeunload"/);
  assert.match(edit, /addEventListener\('beforeunload'/);
  assert.match(upload, /leavingAfterSave = true/);
  assert.match(edit, /leavingAfterSave = true/);
});
console.log(`OK: 高優先度回帰テスト ${passed}件`);
