/** 月別登録状況を実データで検証。暗号化データ・PDFは読み込まない。 */
import assert from 'node:assert/strict';
import { monthlySalaryRegistration } from '../src/forecast/monthlyRegistration.ts';
const salary=(job,targetMonth,paymentDate,kind='salary')=>({form:{job,kind,targetMonth,paymentDate}});
const records=[
  salary('main','2026-10','2026-11-30'),
  salary('main','2026-10','2026-11-30'),
  salary('side','2026-10','2026-10-25','bonus'),
  salary('side','2027-03','2027-04-01'),
  salary('main','2025-03','2025-04-30'),
  salary('side','2026-11','2026-12-25'),
];
const fiscal=monthlySalaryRegistration(records,2026,'fiscal');
assert.equal(fiscal.length,12);
assert.deepEqual([fiscal[0].key,fiscal[8].key,fiscal[11].key],['2026-04','2026-12','2027-03']);
assert.equal(fiscal[6].main,true,'October main is registered');
assert.equal(fiscal[6].side,false,'bonus is not monthly salary');
assert.equal(fiscal[7].side,true);
assert.equal(fiscal[11].side,true,'March next year is in this fiscal year');
assert.equal(fiscal.filter(x=>x.main).length,1,'duplicate salary must not count twice');
const calendar=monthlySalaryRegistration(records,2026,'calendar');
assert.deepEqual([calendar[0].key,calendar[11].key],['2026-01','2026-12']);
assert.equal(calendar[10].main,true,'payment date November, not October target');
assert.equal(calendar[9].main,false,'October main was not paid until November');
assert.equal(calendar[11].side,true,'December side salary is registered');
assert.equal(calendar.some(x=>x.key==='2027-03'),false);
assert.equal(monthlySalaryRegistration([salary('main','2026-02','2026-99-99')],2026,'calendar').some(x=>x.main),false,'invalid payment month is excluded');
console.log('PASS: fiscal April-March and calendar January-December registration, per-job salary-only and actual dates');
