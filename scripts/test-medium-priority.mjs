/** Payroll 中優先度の純粋関数・UI制約テスト。個人情報・IndexedDB不要。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { duplicateOwners, pdfFailureMessage, shortFileName } from '../src/pdf/uploadWorkflow.ts';
import { validatePayrollForm } from '../src/storage/payrollValidation.ts';
import { parsePayroll } from '../src/pdf/payrollParser.ts';
import { summary, withEstimates } from '../src/forecast/summary.ts';

let count = 0;
function check(name, fn) { fn(); console.log(`PASS ${++count}: ${name}`); }
const cell = (text,x,y,page=1) => ({ text,x,y,page,width:50,height:9 });
const add = (cs, label, value, x, vx, y, page=1) => cs.push(cell(label,x,y,page), cell(String(value),vx,y,page));
function sampleMain(page=1) {
  const cs = [cell('2026年10月分',30,780,page), cell('支給日:2026年11月27日',30,750,page),cell('本年累計',430,580,page)];
  add(cs, '基本給', 200000, 160,255,620,page);
  add(cs, '固定残業手当', 35000, 160,255,590,page);
  add(cs, '支給合計', 235000, 160,255,500,page);
  add(cs, '振込支給額', 210000, 440,530,630,page);
  add(cs, '控除合計', 25000, 300,400,500,page);
  add(cs, '出勤日数', 20, 35,115,600,page);
  return cs;
}
const payroll = (more={}) => ({ job:'main',kind:'salary',targetMonth:'2026-10',paymentDate:'2026-11-27',gross:'200000',net:'195000',incomeTax:'5000',...more });
check('同じSHA-256の後続ファイルのみ除外', () => {
  assert.deepEqual([...duplicateOwners([{id:1,hash:'abc'},{id:2,hash:'abc'},{id:3,hash:'xyz'},{id:4,hash:'abc'}])],[[2,1],[4,1]]);
});
check('重複元を削除した場合は次のPDFが先頭になる', () => {
  assert.deepEqual([...duplicateOwners([{id:2,hash:'abc'},{id:4,hash:'abc'}])], [[4,2]]);
});
check('ハッシュ未取得は同一PDFとは判定しない', () => {
  assert.equal(duplicateOwners([{id:1},{id:2}]).size,0);
});
check('エラーをPDF保護・破損・制限超過・ネットワークで分類', () => {
  assert.match(pdfFailureMessage(new Error('PasswordException')), /パスワード/);
  assert.match(pdfFailureMessage(new Error('InvalidPDFException')), /破損/);
  assert.match(pdfFailureMessage(new Error('PDFの文字情報が上限を超えています。')), /上限/);
  assert.match(pdfFailureMessage(new Error('UnexpectedResponseException')), /ネットワーク/);
  assert.ok(!pdfFailureMessage(new Error('encrypted salary employee 123')).includes('employee'));
});
check('長いファイル名を短縮できる', () => assert.ok(shortFileName('a'.repeat(80)).length<=52));
check('通常の給与は余分な日付警告が出ない', () => assert.deepEqual(validatePayrollForm(payroll()), {errors:[],warnings:[]}));
check('対象月と支給月が13か月離れたら警告（エラーではない）', () => {
  const v=validatePayrollForm(payroll({targetMonth:'2025-08'}));
  assert.equal(v.errors.length,0); assert.ok(v.warnings.some(x=>x.includes('1年以上')));
});
check('税/非税の内訳が総支給を超過すると警告', () => {
  const v=validatePayrollForm(payroll({taxable:'210000', nonTaxable:'10000', gross:'200000'}));
  assert.ok(v.warnings.some(x=>x.includes('課税支給額')));
});
check('交通費＋経費が非課税支給を上回ると警告', () => {
  const v=validatePayrollForm(payroll({transportation:'5000',reimbursedExpenses:'6000',nonTaxable:'10000'}));
  assert.ok(v.warnings.some(x=>x.includes('立替経費')));
});
check('賞与2項目の内訳が総支給を超えると警告', () => {
  const v=validatePayrollForm(payroll({kind:'bonus', bonusBase:'150000',performanceBonus:'60000'}));
  assert.ok(v.warnings.some(x=>x.includes('業績手当')));
});
check('PDFの直接読取金額は出典ページと座標を記録', () => {
  const found = parsePayroll(sampleMain(2));
  assert.equal(found.sourcePage,2);
  assert.equal(found.fields.gross,'235000');
  assert.deepEqual(found.fieldSources?.gross, { page:2,label:'支給合計',labelX:160,labelY:500,valueX:255,valueY:500 });
  assert.equal(found.fieldSources?.net?.label, '振込支給額');
});
check('大量の無関係な文字が混じっても正しい金額・座標を採用', () => {
  const extras = Array.from({length:12000}, (_,i)=>cell(`none${i}`, 400, 780+i/10000));
  const found = parsePayroll([...extras,...sampleMain()]);
  assert.equal(found.fields.gross,'235000');
  assert.equal(found.layout?.status,'matched');
});
check('主要項目の空欄は未入力、社会保険料の空欄は0円扱い', () => {
  const entries = [
    {form:payroll({incomeTax:'', transportation:'0', workDays:'20', gross:'200000',net:'200000'})},
    {form:payroll({incomeTax:'0', transportation:'0', workDays:'21',gross:'180000',net:'180000'})},
  ];
  const result=summary(entries);
  assert.equal(result.sums.incomeTax,0);
  assert.equal(result.observed.incomeTax,true);
  assert.equal(result.missingCounts.incomeTax,1);
  assert.equal(result.missingCounts.socialInsurance,0);
  assert.equal(result.observed.socialInsurance,true);
  assert.equal(result.sums.socialInsurance,0);
  assert.equal(result.missingCounts.transportation,0);
  assert.equal(result.sums.workDays,41);
});
check('0円賞与は存在しない各控除欄を欠損扱いにしない', () => {
  const result=summary([{form:payroll({kind:'bonus',gross:'0',net:'0',incomeTax:'',transportation:'',reimbursedExpenses:''})}]);
  assert.equal(result.missingCounts.socialInsurance,0);
  assert.equal(result.missingCounts.transportation,0);
  assert.equal(result.missingCounts.reimbursedExpenses,0);
});
check('見込み1件の不完全値は該当カテゴリで一度だけカウント', () => {
  const actual=summary([{form:payroll({incomeTax:'5000'})}]);
  const estimate={values:{gross:150000,net:140000,incomeTax:null,residentTax:0,socialInsurance:5000,transportation:0,reimbursedExpenses:0,workDays:20},incomplete:{gross:false,net:false,incomeTax:true,residentTax:false,socialInsurance:false,transportation:false,reimbursedExpenses:false,workDays:false}};
  const projected=withEstimates(actual,[estimate]);
  assert.equal(projected.missingCounts.incomeTax,actual.missingCounts.incomeTax+1);
  assert.equal(projected.sums.gross,350000);
});
check('編集エラー表示を修正時に解除',()=>{
  const edit=readFileSync(new URL('../src/edit.ts',import.meta.url),'utf8');
  assert.match(edit,/clearInlineError\(errorView\)/);
});
check('画面内で重複と保存対象を区別し、削除時に復旧する',()=>{
  const upload=readFileSync(new URL('../src/upload.ts',import.meta.url),'utf8');
  assert.match(upload,/function activateOrphanDuplicates/);
  assert.match(upload,/const uploadable = candidates\(\)/);
  assert.match(upload,/function abortEntry/);
});
check('解析進捗と自動・手入力の表示を備える',()=>{
  const upload=readFileSync(new URL('../src/upload.ts',import.meta.url),'utf8');
  assert.match(upload,/entry\.currentPage = pageNumber/);
  assert.match(upload,/field--auto/);
  assert.match(upload,/fieldSources/);
});
check('HTML全ページがCSPを持ち、外部スクリプトの実行を制限',()=>{
  for(const name of ['index.html','upload/index.html','edit/index.html','backup/index.html','view/index.html']){
    const html=readFileSync(new URL(`../public/${name}`,import.meta.url),'utf8');
    assert.match(html,/Content-Security-Policy/);
    assert.match(html,/script-src 'self'/);
  }
});
console.log(`OK: 中優先度回帰テスト ${count}件`);
