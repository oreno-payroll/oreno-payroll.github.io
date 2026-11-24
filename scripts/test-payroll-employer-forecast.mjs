import assert from 'node:assert/strict';
import {calculateAnnualForecast} from '../src/forecast/annualForecast.ts';
import {calculateCalendarForecast} from '../src/forecast/calendarForecast.ts';
import {employerAssignmentAllowed,employerDisplayName,legacyEmployers} from '../src/ui/employerSelection.ts';
const A='emp_'+'a'.repeat(32),B='emp_'+'b'.repeat(32),C='emp_'+'c'.repeat(32);
const directory=[{id:A,name:'Synthetic previous',role:'main',current:false},{id:B,name:'Synthetic current',role:'main',current:true},{id:C,name:'Synthetic side',role:'side',current:true}];
const salary=(id,month,gross,job='main',kind='salary')=>({employerId:id,form:{job,kind,targetMonth:month,paymentDate:month+'-15',gross:String(gross),net:String(gross),taxable:String(gross),nonTaxable:'0',transportation:'0',reimbursedExpenses:'0'}});
const today=new Date(2026,10,24),old=salary(A,'2026-11',250000),recent=salary(B,'2026-10',300000),future=salary(A,'2026-12',250000),unknown=salary(undefined,'2026-12',20000);
for(const forecast of [calculateAnnualForecast,calculateCalendarForecast]){
 const none=forecast([old,future],2026,today,true,directory);assert.equal(none.jobs.main.estimates.length,0);assert.equal(none.jobs.main.bonusEstimates.length,0);assert.match(none.jobs.main.reason,/現在の勤務先/);
 const data=[old,recent,future];const original=JSON.stringify(data),plan=forecast(data,2026,today,true,directory);
 assert.equal(plan.jobs.main.employerName,'Synthetic current');assert.deepEqual(plan.jobs.main.sampleMonths,['2026-10']);assert.ok(plan.jobs.main.pendingMonths.includes('2026-11'));assert.ok(plan.jobs.main.pendingMonths.includes('2026-12'));assert.ok(plan.jobs.main.estimates.every(e=>e.values.gross===300000));assert.ok(plan.jobs.main.pendingBonusMonths.every(m=>m>='2026-11'));assert.equal(JSON.stringify(data),original);
 const uncertain=forecast([...data,unknown],2026,today,true,directory);assert.ok(!uncertain.jobs.main.pendingMonths.includes('2026-12'));
 const actual=forecast([...data,salary(B,'2026-11',310000)],2026,today,true,directory);assert.ok(!actual.jobs.main.pendingMonths.includes('2026-11'));
 const inactive=forecast(data,2026,today,true,directory.map(e=>({...e,current:false})));assert.equal(inactive.jobs.main.estimates.length,0);assert.equal(inactive.jobs.main.bonusEstimates.length,0);assert.match(inactive.jobs.main.reason,/未設定/);
 const legacy=forecast([old],2026,today,true);assert.ok(legacy.jobs.main.estimates.length);assert.equal(legacy.jobs.main.estimates[0].values.gross,250000);
}
const previous={employerId:A,form:{job:'main'}};
assert.equal(employerAssignmentAllowed(directory,'main',A,previous),true);
assert.equal(employerAssignmentAllowed(directory,'side',A,previous),false);
assert.equal(employerAssignmentAllowed(directory,'side',C,previous),true);
assert.equal(employerAssignmentAllowed(directory,'side',undefined,previous),true);
assert.equal(employerAssignmentAllowed([],'main',A,previous),true);
assert.equal(employerAssignmentAllowed([],'side',A,previous),false);
assert.equal(employerAssignmentAllowed(directory,'main',C,previous),false);
assert.equal(employerDisplayName(directory,A),'Synthetic previous');assert.equal(employerDisplayName(directory,A,'side'),'Synthetic previous（勤務区分不一致）');assert.equal(employerDisplayName(directory,undefined),'勤務先未設定');assert.equal(employerDisplayName([],A,undefined,legacyEmployers([old],[])),'未登録の勤務先 1');
console.log('PASS: explicit current employer forecasts, legacy fallback, no double-counting unknown actuals, retired role, assignment compatibility and private display labels');
