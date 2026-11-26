import assert from 'node:assert/strict';
import {defaultEmployerForecast,validateEmployerForecast} from '../src/storage/employerForecast.ts';
import {validateEmployerDirectory,upsertEmployer,mergeEmployerDirectories,employerDirectorySignature} from '../src/storage/employerDirectory.ts';
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

// The configuration must not introduce zeroes, other employer samples, stale months or real-data writes.
const methodDirectory=(method,mainBonus=[12,2],sideBonus=[12])=>directory.map(e=>e.id===B?{...e,forecast:{salaryMethod:method,bonusMonths:mainBonus}}:e.id===C?{...e,forecast:{salaryMethod:'average',bonusMonths:sideBonus}}:e);
const records=[salary(A,'2026-11',999999),salary(B,'2026-08',100000),salary(B,'2026-09',80000),salary(B,'2026-10',180000),
 salary(C,'2026-08',10000,'side'),salary(C,'2026-09',20000,'side'),salary(C,'2026-10',40000,'side'),
 salary(B,'2026-04',999999),salary(B,'2026-12',999999),
 {...salary(B,'2026-10',999999),form:{...salary(B,'2026-10',999999).form,paymentDate:'2026-10-01'}}];
const snapshot=JSON.stringify(records);
for(const forecast of [calculateAnnualForecast,calculateCalendarForecast]){
 const fiscal=forecast===calculateAnnualForecast;
 const baseline=forecast(records.filter(r=>r.form.paymentDate!=='2026-12-15'),2026,today,true,directory);
 assert.equal(baseline.jobs.main.salaryMethod,'median');assert.deepEqual(baseline.jobs.main.bonusMonths,[2,8]);assert.deepEqual(baseline.jobs.side.bonusMonths,[]);
 assert.equal(baseline.jobs.main.estimates[0]?.values.gross,100000);
 for(const [method,amount,months] of [['latest',180000,['2026-10']],['median',100000,['2026-10','2026-09','2026-08']],['average',120000,['2026-10','2026-09','2026-08']]]){
  // Future salary actuals suppress the registered month, but never become samples.
  const plan=forecast(records.filter(r=>r.form.paymentDate!=='2026-12-15'),2026,today,true,methodDirectory(method));
  assert.deepEqual(plan.jobs.main.sampleMonths,months);assert.equal(plan.jobs.main.estimates[0].values.gross,amount);
  assert.equal(plan.jobs.side.estimates[0].values.gross,23333);assert.equal(plan.jobs.side.bonusEstimates[0].values.gross,40000);
  assert.equal(plan.jobs.side.bonusEstimates[0].job,'side');assert.ok(plan.estimates.includes(plan.jobs.side.bonusEstimates[0]));
  assert.deepEqual(plan.jobs.main.pendingBonusMonths,fiscal?['2026-12','2027-02']:['2026-12']);
  assert.ok(plan.jobs.main.bonusEstimates.every(e=>e.values.gross===180000));
 }
 const noSalary=forecast(records,2026,today,true,methodDirectory('none'));
 assert.equal(noSalary.jobs.main.estimates.length,0);assert.equal(noSalary.jobs.main.bonusEstimates[0].values.gross,180000);assert.match(noSalary.jobs.main.reason,/算出しない/);
 const noBonus=forecast(records,2026,today,true,methodDirectory('latest',[],[]));assert.equal(noBonus.estimates.filter(e=>e.kind==='bonus').length,0);
 const globalOff=forecast(records,2026,today,false,methodDirectory('latest'));assert.equal(globalOff.estimates.filter(e=>e.kind==='bonus').length,0);
 const configuredPast=forecast(records,2026,today,true,methodDirectory('latest',[2,8,10,12]));assert.ok(configuredPast.jobs.main.pendingBonusMonths.every(m=>m>='2026-11'));
 const registered={...salary(B,'2026-11',0,'main','bonus'),form:{...salary(B,'2026-11',0,'main','bonus').form,paymentDate:'2026-12-15'}};
 assert.ok(!forecast([...records,registered],2026,today,true,methodDirectory('latest')).jobs.main.pendingBonusMonths.includes('2026-12'));
 const priorBonus={...registered,employerId:A};assert.ok(forecast([...records,priorBonus],2026,today,true,methodDirectory('latest')).jobs.main.pendingBonusMonths.includes('2026-12'));
 assert.ok(!forecast([...records,{...registered,employerId:undefined}],2026,today,true,methodDirectory('latest')).jobs.main.pendingBonusMonths.includes('2026-12'));
 const missing=salary(B,'2026-11',0);missing.form.gross='';missing.form.net='';missing.form.taxable='';missing.form.nonTaxable='';missing.form.transportation='';missing.form.reimbursedExpenses='';
 const noFuture=records.filter(r=>r.form.paymentDate!=='2026-12-15');
 const incomplete=forecast([...noFuture,missing],2026,today,true,methodDirectory('latest'));
 assert.ok(incomplete.jobs.main.estimates.length);assert.equal(incomplete.jobs.main.estimates[0].values.gross,null);assert.equal(incomplete.jobs.main.bonusEstimates.length,0);assert.match(incomplete.jobs.main.bonusReason,/不足/);
 assert.equal(forecast(records,2025,today,true,methodDirectory('average')).estimates.length,0);
}
assert.equal(JSON.stringify(records),snapshot);
assert.deepEqual(defaultEmployerForecast('main'),{salaryMethod:'median',bonusMonths:[2,8]});assert.deepEqual(defaultEmployerForecast('side'),{salaryMethod:'median',bonusMonths:[]});
assert.deepEqual(validateEmployerForecast({salaryMethod:'average',bonusMonths:[12,1]}),{salaryMethod:'average',bonusMonths:[1,12]});
for(const invalid of [null,{}, {salaryMethod:'bogus',bonusMonths:[]},{salaryMethod:'average',bonusMonths:[0]},{salaryMethod:'median',bonusMonths:[13]},{salaryMethod:'median',bonusMonths:['2']},{salaryMethod:'median',bonusMonths:[2,2]},{salaryMethod:'median',bonusMonths:new Array(1)},{salaryMethod:'none',bonusMonths:[],extra:1}])assert.throws(()=>validateEmployerForecast(invalid),/見込み設定/);
const custom=methodDirectory('latest');assert.deepEqual(validateEmployerDirectory(directory),directory);
assert.notEqual(employerDirectorySignature(custom),employerDirectorySignature(directory));
const configuredPrevious=custom.find(e=>e.id===B);const renamed=upsertEmployer(custom,{id:B,name:'Synthetic renamed',role:'main',current:true});assert.deepEqual(renamed.find(e=>e.id===B).forecast,validateEmployerForecast(configuredPrevious.forecast));
assert.deepEqual(mergeEmployerDirectories(custom,directory),validateEmployerDirectory(custom));assert.deepEqual(mergeEmployerDirectories([],custom),validateEmployerDirectory(custom));
assert.throws(()=>validateEmployerDirectory([{...directory[0],forecast:undefined}]),/見込み設定/);
console.log('PASS: configurable employer salary/bonus, latest missing values, no retroactive configured bonuses, period boundaries, duplicate payments, validated preferences and restore preservation');

// A bonus recorded for March but paid in April belongs to the old fiscal year.
// A different target month remains independently eligible, including adjacent schedules.
const delayed={...salary(B,'2027-03',0,'main','bonus'),form:{...salary(B,'2027-03',0,'main','bonus').form,paymentDate:'2027-04-15'}};
const marchToday=new Date(2027,2,10),feb=salary(B,'2027-02',180000),marchPlan=methodDirectory('latest',[3,4]);
for(const employerId of [B,undefined]){
 const actual={...delayed,employerId};
 const annual=calculateAnnualForecast([feb,actual],2026,marchToday,true,marchPlan);
 assert.deepEqual(annual.jobs.main.pendingBonusMonths,[]);assert.equal(annual.jobs.main.bonusEstimates.length,0);
 const calendar=calculateCalendarForecast([feb,actual],2027,marchToday,true,marchPlan);
 assert.deepEqual(calendar.jobs.main.pendingBonusMonths,['2027-03']);
 assert.equal(calendar.jobs.main.bonusEstimates.length,1);
}
assert.deepEqual(calculateAnnualForecast([feb,{...delayed,employerId:A}],2026,marchToday,true,marchPlan).jobs.main.pendingBonusMonths,['2027-03']);
const december={...salary(B,'2026-12',0,'main','bonus'),form:{...salary(B,'2026-12',0,'main','bonus').form,paymentDate:'2027-01-15'}};
const twoMonths=methodDirectory('latest',[12,1]);
assert.deepEqual(calculateAnnualForecast([recent,december],2026,today,true,twoMonths).jobs.main.pendingBonusMonths,['2027-01']);
assert.deepEqual(calculateCalendarForecast([recent,december],2026,today,true,twoMonths).jobs.main.pendingBonusMonths,['2026-12']);
assert.deepEqual(calculateAnnualForecast([salary(B,'2027-04',180000),delayed],2027,new Date(2027,3,20),true,marchPlan).jobs.main.pendingBonusMonths,['2027-04','2028-03']);
console.log('PASS: fiscal/calendar bonus deduplication, March/April and December/January boundaries, zero actuals, adjacent schedules and employer isolation');
