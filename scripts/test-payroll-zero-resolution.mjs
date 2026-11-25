/** Round 4/B: source provenance and opt-in zeros, no OAuth/browser/OneDrive I/O. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  ZERO_OPTIONAL_AMOUNT_LABELS,emptyOptionalAmounts,prepareOptionalZeros,
  isValidPayrollZeroResolution,reconcilePayrollZeroResolution,
} from '../src/storage/payrollZeroResolution.ts';
import {PAYROLL_FIELDS,validatePayrollForm} from '../src/storage/payrollValidation.ts';
const src=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const form=(kind='salary')=>Object.assign(Object.fromEntries(PAYROLL_FIELDS.map(k=>[k,''])),{
 job:'main',kind,targetMonth:'2026-11',paymentDate:'2026-11-27',gross:'250000',net:'220000',
 taxable:'250000',nonTaxable:'0',incomeTax:'30000',workDays:'21',
});
const parsed={
 missingFields:[{field:'residentTax',reason:'absent'},{field:'healthInsurance',reason:'unreadable'},
                {field:'gross',reason:'unreadable'}],
 fields:{nonTaxable:'0'},
 automaticFields:new Set(['nonTaxable']),
 fieldSources:{nonTaxable:{page:1}},
};
{
 const f=form();const {form:unchanged,zeroResolution:proof}=prepareOptionalZeros(f,parsed,false);
 assert.deepEqual(unchanged,f,'OFF must leave every form value intact');
 assert.deepEqual(proof.confirmedZeroFields,[]);
 assert.equal(proof.approvedAt,undefined);
 assert.deepEqual(proof.pdfZeroFields,['nonTaxable'],'literal PDF zero only with direct source and untouched automatic field');
 assert.equal(proof.missingAtImport.find(x=>x.field==='residentTax').reason,'absent');
 assert.equal(proof.missingAtImport.find(x=>x.field==='healthInsurance').reason,'unreadable');
 assert.equal(proof.missingAtImport.find(x=>x.field==='careInsurance').reason,'unclassified');
 assert.equal(isValidPayrollZeroResolution(proof,unchanged),true);
 console.log('PASS: checkbox OFF preserves blanks and provenance; literal PDF zero is distinct');
}
{
 const f=form();const {form:resolved,zeroResolution:proof}=prepareOptionalZeros(f,parsed,true,'2026-11-23T12:00:00.000Z');
 assert.equal(resolved.gross,'250000');assert.equal(resolved.net,'220000');
 assert.equal(resolved.workDays,'21');
 assert.equal(resolved.bonusBase,'','hidden salary bonus field must stay blank');
 assert.equal(resolved.performanceBonus,'');
 assert.equal(resolved.residentTax,'0');assert.equal(resolved.healthInsurance,'0');
 assert.equal(resolved.careInsurance,'0');
 assert.equal(resolved.nonTaxable,'0');
 assert.equal(resolved.yearEndAdjustment,'0');
 assert.equal(proof.confirmedZeroFields.includes('healthInsurance'),true);
 assert.equal(proof.confirmedZeroFields.includes('nonTaxable'),false);
 assert.equal(proof.pdfZeroFields.includes('nonTaxable'),true);
 assert.equal(proof.missingAtImport.some(x=>x.field==='gross'),false);
 assert.equal(isValidPayrollZeroResolution(proof,resolved),true);
 assert.deepEqual(validatePayrollForm(resolved).errors,[]);
 assert.equal(f.residentTax,'','confirmation never mutates the input form');
 assert.deepEqual(prepareOptionalZeros(f,parsed,true,proof.approvedAt).form,resolved,'deterministic batch projection');
 console.log('PASS: consent fills only optional active blanks and authenticates the field-level record');
}
{
 const f=form('bonus');f.workDays='';f.yearEndAdjustment='';f.reimbursedExpenses='';
 f.bonusBase='100000';f.performanceBonus='';
 const {form:resolved,zeroResolution:proof}=prepareOptionalZeros(f,{},true,'2026-11-23T12:00:00Z');
 assert.equal(resolved.reimbursedExpenses,'');
 assert.equal(resolved.yearEndAdjustment,'');
 assert.equal(resolved.workDays,'');
 assert.equal(resolved.performanceBonus,'0');
 assert.equal(proof.confirmedZeroFields.includes('reimbursedExpenses'),false);
 assert.equal(proof.confirmedZeroFields.includes('performanceBonus'),true);
 assert.equal(isValidPayrollZeroResolution(proof,resolved),true);
 console.log('PASS: bonus vs salary hidden/required/non-money fields cannot be rewritten');
}
{
 const f=form();f.taxable='';f.nonTaxable='';
 const proposed=prepareOptionalZeros(f,{},true).form;
 const before=new Set(validatePayrollForm(f).warnings);
 const newWarnings=validatePayrollForm(proposed).warnings.filter(w=>!before.has(w));
 assert.ok(newWarnings.some(x=>x.includes('課税支給額')),'zero conversion can create a new contradiction');
 const upload=src('src/upload.ts');
 assert.match(upload,/zeroIntroducedWarnings\(entry\)/);
 assert.match(upload,/zeroContradictions\.length > 0/);
 assert.match(upload,/approveZero&&zeroIntroducedWarnings\(entry\)\.length/);
 console.log('PASS: new zero-induced arithmetic contradictions block saving');
}
{
 const f=form();const prepared=prepareOptionalZeros(f,parsed,true,'2026-11-23T12:00:00Z');
 const metadata=prepared.zeroResolution;
 const corruptions=[
  {...metadata,format:'unknown'},
  {...metadata,approvedAt:undefined},
  {...metadata,confirmedZeroFields:['gross']},
  {...metadata,confirmedZeroFields:['residentTax','residentTax']},
  {...metadata,missingAtImport:[...metadata.missingAtImport,{field:'residentTax',reason:'absent'}]},
  {...metadata,missingAtImport:metadata.missingAtImport.map(x=>({...x,reason:'surprise'}))},
  {...metadata,pdfZeroFields:['not-payroll-key']},
 ];
 for(const item of corruptions)assert.equal(isValidPayrollZeroResolution(item,prepared.form),false,'invalid proof must be rejected');
 const updated={...prepared.form,residentTax:'5000'};
 assert.equal(isValidPayrollZeroResolution(metadata,updated),false,'stale positive zero claim must be rejected');
 const revised=reconcilePayrollZeroResolution(metadata,updated);
 assert.ok(revised);assert.equal(revised.confirmedZeroFields.includes('residentTax'),false);
 assert.equal(revised.missingAtImport.find(x=>x.field==='residentTax').reason,'absent','underlying PDF evidence is retained');
 assert.equal(isValidPayrollZeroResolution(revised,updated),true);
 assert.equal(reconcilePayrollZeroResolution(undefined,updated),undefined,'legacy records remain untouched');
 console.log('PASS: tampering and stale edits fail closed; legacy metadata is optional');
}
{
 const html=src('public/upload/index.html');const css=src('public/styles/upload.css');const upload=src('src/upload.ts');
 for(const id of ['zero-approval','zero-missing-amounts','zero-approval-list','zero-approval-count'])
  assert.match(html,new RegExp(`id="${id}"`));
 assert.ok(html.indexOf('zero-missing-amounts')<html.indexOf('id="save-all"'));
 assert.match(html,/id="zero-missing-amounts" type="checkbox" autocomplete="off"/);
 assert.match(css,/\.zero-approval\[hidden\]/);
 assert.match(upload,/zeroConsentFingerprint!==fingerprint/,'consent must reset after candidate change');
 assert.match(upload,/zeroCheckbox.checked=false; \/\/ Never restore/,'browser reload cannot restore opt-in');
 assert.match(upload,/const approveZero=zeroCheckbox\.checked&&zeroConsentFingerprint===before/);
 assert.match(upload,/const before=zeroCandidatesFingerprint\(candidates\(\)\)/);
 assert.match(upload,/before!==zeroCandidatesFingerprint\(candidates\(\)\)/);
 assert.match(upload,/zeroResolution: prepared\.zeroResolution/);
 for(const p of ['src/cloud/vault.ts','src/storage/payrollBackup.ts','src/storage/payrollStore.ts'])
  assert.match(src(p),/isValidPayrollZeroResolution\(/,`${p} must fail closed`);
 assert.match(src('src/edit.ts'),/reconcilePayrollZeroResolution\(record\.zeroResolution,formValues\)/);
 assert.equal(Object.keys(ZERO_OPTIONAL_AMOUNT_LABELS).length,15);
 console.log('PASS: opt-in UI wiring, stale consent invalidation and read/write/backup/edit metadata guards');
}
console.log('PASS: Round 4/B zero-resolution and import provenance regression');
