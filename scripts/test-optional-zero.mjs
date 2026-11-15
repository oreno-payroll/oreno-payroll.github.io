/** 社会保険料・住民税・立替経費の空欄0円ルール。保存済みレコードの変更は行わない。 */
import assert from 'node:assert/strict';
import { summary, withEstimates } from '../src/forecast/summary.ts';
import { estimateFromSamples, estimateMainBonus } from '../src/forecast/annualForecast.ts';

let cases = 0;
function check(title, fn) { fn(); console.log(`PASS ${++cases}: ${title}`); }
const base = (job='main', extra={}) => ({
  job, kind:'salary',targetMonth:'2026-10',paymentDate:'2026-11-27',
  gross:'200000',net:'190000',incomeTax:'5000',transportation:'6000',workDays:'20',...extra,
});

check('本業7明細: 住民税・経費・社会保険料の空欄は欠損にせず、既存値を維持', () => {
  const records = Array.from({length:7}, (_,i) => ({form:base('main', {
    residentTax:i<2?'':String(i*1000),
    reimbursedExpenses:i<6?'':'0',
    healthInsurance:i%2===0?'':'8000',
    pension:i%2===0?'7000':'',
    careInsurance:'',childcareSupport:'',employmentInsurance:'',
  })}));
  const before = structuredClone(records);
  const result = summary(records);
  assert.equal(result.sums.residentTax,20000);
  assert.equal(result.sums.reimbursedExpenses,0);
  assert.equal(result.sums.socialInsurance,52000);
  for(const key of ['residentTax','reimbursedExpenses','socialInsurance']) {
    assert.equal(result.missingCounts[key],0,key);
    assert.equal(result.partial[key],false,key);
    assert.equal(result.observed[key],true,key);
  }
  assert.deepEqual(records,before,'入力データを書き換えない');
});
check('副業8明細: 住民税と社会保険料が全件空欄でも0円表示可能', () => {
  const result = summary(Array.from({length:8},()=>({form:base('side', {residentTax:'',
    healthInsurance:'',careInsurance:'',childcareSupport:'',pension:'',employmentInsurance:''})})));
  for (const key of ['residentTax','socialInsurance','reimbursedExpenses']) {
    assert.equal(result.sums[key],0,key);
    assert.equal(result.observed[key],true,key);
    assert.equal(result.missingCounts[key],0,key);
  }
});
check('金額が明記されている控除は0円に置換せず加算する', () => {
  const result = summary([{form:base('side',{residentTax:'4500',reimbursedExpenses:'300',
    healthInsurance:'5000',pension:'6000',employmentInsurance:'700'})}]);
  assert.equal(result.sums.residentTax,4500);
  assert.equal(result.sums.reimbursedExpenses,300);
  assert.equal(result.sums.socialInsurance,11700);
});
check('所得税や交通費など他項目は空欄を未入力のまま残す', () => {
  const result = summary([{form:base('main',{incomeTax:'', transportation:'',workDays:''})}]);
  for (const key of ['incomeTax','transportation','workDays']) {
    assert.equal(result.observed[key],false,key);
    assert.equal(result.missingCounts[key],1,key);
    assert.equal(result.partial[key],true,key);
  }
});
check('通常月見込み: 空欄の対象3項目は0円推計し不完全フラグを付けない', () => {
  const forecast = estimateFromSamples('side','2026-12',[{form:base('side', {residentTax:'',
    reimbursedExpenses:'',healthInsurance:'',careInsurance:'',childcareSupport:'',pension:'',employmentInsurance:''})}]);
  for (const key of ['residentTax','reimbursedExpenses','socialInsurance']) {
    assert.equal(forecast.values[key],0,key);
    assert.equal(forecast.incomplete[key],undefined,key);
  }
  const rolled = withEstimates(summary([]),[forecast]);
  for (const key of ['residentTax','reimbursedExpenses','socialInsurance']) {
    assert.equal(rolled.sums[key],0,key);
    assert.equal(rolled.observed[key],true,key);
    assert.equal(rolled.missingCounts[key],0,key);
  }
});
check('通常月見込み: 一部の社会保険内訳が空欄でも合計値は維持', () => {
  const forecast = estimateFromSamples('main','2026-12', [{form:base('main',{residentTax:'',
    healthInsurance:'10000',careInsurance:'',childcareSupport:'',pension:'15000',employmentInsurance:''})}]);
  assert.equal(forecast.values.socialInsurance,25000);
  assert.equal(forecast.incomplete.socialInsurance,undefined);
  assert.equal(forecast.values.residentTax,0);
});
check('賞与見込み: 住民税・社会保険料が空欄でも0円・未入力なし', () => {
  const forecast = estimateMainBonus('2027-02',[{form:base('main',{
    gross:'200000',net:'190000',taxable:'194000',nonTaxable:'6000',
    reimbursedExpenses:'', residentTax:'', healthInsurance:'',careInsurance:'',childcareSupport:'',pension:'',employmentInsurance:'',
  })}]);
  assert.ok(forecast);
  assert.equal(forecast.values.residentTax,0);
  assert.equal(forecast.values.socialInsurance,0);
  assert.equal(forecast.incomplete.residentTax,undefined);
  assert.equal(forecast.incomplete.socialInsurance,undefined);
});
check('過去の推計レコードでnull／不完全が残っていても対象項目だけ0円扱い', () => {
  const a=summary([{form:base()}]);
  const old={month:'2026-12',job:'side',kind:'salary',values:{gross:100000,net:90000,
    incomeTax:null,residentTax:null,reimbursedExpenses:null,socialInsurance:null,transportation:null,workDays:null},
    incomplete:{residentTax:true,reimbursedExpenses:true,socialInsurance:true,incomeTax:true}};
  const out=withEstimates(a,[old]);
  for (const key of ['residentTax','reimbursedExpenses','socialInsurance']) {
    assert.equal(out.observed[key],true,key);
    assert.equal(out.missingCounts[key],0,key);
  }
  assert.equal(out.missingCounts.incomeTax,1);
  assert.equal(out.missingCounts.transportation,1);
});
check('明細なしでは0円にしない。原本のある明細が0円扱いになる', () => {
  const empty=summary([]);
  for (const key of ['residentTax','reimbursedExpenses','socialInsurance']) {
    assert.equal(empty.observed[key],false,key);
  }
});
console.log(`OK: 任意項目0円扱い回帰テスト ${cases}件`);
