/** Contract lock: saved semantics-v1 is validated against historic keys, not the latest form. */
import assert from 'node:assert/strict';
import {PAYROLL_SEMANTICS_FORMAT,PAYROLL_SEMANTICS_V1_KEYS,createPayrollSemantics,isValidPayrollSemantics} from '../src/storage/payrollSemantics.ts';
import {PAYROLL_FIELDS} from '../src/storage/payrollValidation.ts';
const historical=[
 'job','kind','targetMonth','paymentDate','gross','net','taxable','nonTaxable',
 'transportation','reimbursedExpenses','workDays','incomeTax','residentTax',
 'healthInsurance','careInsurance','childcareSupport','pension',
 'employmentInsurance','otherDeductions','yearEndAdjustment','bonusBase','performanceBonus',
];
assert.deepEqual([...PAYROLL_SEMANTICS_V1_KEYS],historical,
 'historical semantics v1 key list must never change during a field extension');
assert.equal(PAYROLL_SEMANTICS_FORMAT,'payroll-semantics-v1');
assert.deepEqual([...PAYROLL_FIELDS],historical,
 'new fields require an explicit semantic-format migration rather than silently extending v1');
const saved=createPayrollSemantics({job:'main',kind:'salary'});
assert.equal(isValidPayrollSemantics(saved),true);
assert.equal(isValidPayrollSemantics({...saved,fieldLabels:{...saved.fieldLabels,unknownNewField:'新しい控除'}}),false);
assert.equal(isValidPayrollSemantics({...saved,fieldLabels:{...saved.fieldLabels,incomeTax:undefined}}),false);
const old=structuredClone(saved);
assert.equal(isValidPayrollSemantics(old),true);
console.log('PASS: historical v1 schema remains explicit; new payroll fields require a version bump');
