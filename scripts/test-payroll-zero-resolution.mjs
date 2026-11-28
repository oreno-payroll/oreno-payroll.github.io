/** Round 4/B: source provenance and opt-in zeros, no OAuth/browser/OneDrive I/O. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {
  ZERO_OPTIONAL_AMOUNT_LABELS,emptyOptionalAmounts,prepareOptionalZeros,
  isValidPayrollZeroResolution,reconcilePayrollZeroResolution,
} from '../src/storage/payrollZeroResolution.ts';
import {PAYROLL_FIELDS,validatePayrollForm,applicablePayrollForm,normalizeWorkDays} from '../src/storage/payrollValidation.ts';
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
 for(const id of ['zero-approval','zero-missing-amounts','zero-approval-count'])
  assert.match(html,new RegExp(`id="${id}"`));
 assert.ok(html.indexOf('zero-missing-amounts')<html.indexOf('id="save-all"'));
 assert.match(html,/id="zero-missing-amounts" type="checkbox" autocomplete="off"/);
 assert.match(css,/\.zero-approval\[hidden\]/);
 assert.doesNotMatch(html,/zero-approval-(?:list|details)/);
 assert.doesNotMatch(css,/\.zero-approval__details/);
 assert.doesNotMatch(upload,/zeroList|zero-approval-list/);
 const start=upload.indexOf('  const zeroCounts=');const end=upload.indexOf('  saveButton.disabled',start);
 assert.ok(start>=0&&end>start);
 const count=runInNewContext(`(uploadable,emptyOptionalAmounts,zeroCheckbox,zeroApproval,zeroCount,zeroIntroducedWarnings)=>{const saving=false,uploadSaveRecoveryRequired=false,pending=false,badPdf=null,invalidEntry=null,unreviewed=[];${upload.slice(start,end)}}`);
 for(const [fields,checked,contradiction,expected,hidden] of [
  [[[],[]],false,false,'0件・0項目（未選択時は空欄）',true],
  [[['a','b'],[],['c']],false,false,'2件・3項目（未選択時は空欄）',false],
  [[['a'],['b']],true,false,'2件・2項目（未選択時は空欄）',false],
  [[['a']],true,true,'1件・1項目（未選択時は空欄）',false],
 ]){
  const approval={},label={},checkbox={checked};
  count(fields.map(form=>({form})),form=>form,checkbox,approval,label,()=>contradiction?['warning']:[]);
  assert.equal(approval.hidden,hidden);assert.equal(label.textContent,expected);assert.equal(checkbox.checked,checked);
 }
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

// The editor previews zero conversion without mutating the controls; normal save uses the preview.
{
 const edit=src('src/edit.ts'),html=src('public/edit/index.html');
 const extract=(start,end)=>{const a=edit.indexOf(start),b=edit.indexOf(end,a);assert.ok(a>=0&&b>a);return stripTypeScriptTypes(edit.slice(a,b),{mode:'strip'});};
 const code=extract('function zeroInputTargets(', 'function updateUI(');
 assert.doesNotMatch(html,/id="edit-save-zero"/);
 assert.match(html,/id="zero-missing-amounts" type="checkbox"/);
 assert.match(edit,/applicablePayrollForm\(effectiveValues\(\)\)/);
 for(const mode of ['salary','bonus','invalid','unchecked']){
  const values=form(mode==='bonus'?'bonus':'salary');
  values.transportation='100';values.nonTaxable='100';values.taxable='249900';
  values.yearEndAdjustment='';values.bonusBase='';values.performanceBonus='';values.workDays='';
  const controls=PAYROLL_FIELDS.filter(k=>!['job','kind','targetMonth','paymentDate'].includes(k)).map(name=>({name,value:values[name],disabled:false,validity:{badInput:mode==='invalid'&&name==='incomeTax'},closest:()=> (values.kind==='salary'?['bonusBase','performanceBonus']:['workDays','yearEndAdjustment','reimbursedExpenses']).includes(name)?{}:null}));
  const ctx={zeroCheckbox:{checked:mode!=='unchecked'},form:{querySelectorAll:()=>controls},emptyOptionalAmounts,getValues:()=>({...values,...Object.fromEntries(controls.map(x=>[x.name,x.value]))})};
  const effective=runInNewContext(code+'\neffectiveValues()',ctx);
  assert.deepEqual(ctx.getValues(),values,'preview must not change inputs');
  if(mode==='invalid'||mode==='unchecked'){assert.deepEqual({...effective},values);continue;}
  assert.equal(effective.gross,values.gross);assert.equal(effective.net,values.net);assert.equal(effective.transportation,'100');assert.equal(effective.workDays,'');assert.equal(effective.residentTax,'0');
  if(mode==='bonus'){assert.equal(effective.yearEndAdjustment,'');assert.equal(effective.reimbursedExpenses,'');assert.equal(effective.bonusBase,'0');}
  else{assert.equal(effective.bonusBase,'');assert.equal(effective.performanceBonus,'');assert.equal(effective.yearEndAdjustment,'0');}
 }
 console.log('PASS: editor zero checkbox previews only eligible empty fields without modifying draft inputs');
}

// The actual edit guard compares what would be persisted, not hidden fields.
{
 const edit=src('src/edit.ts'),start=edit.indexOf('function hasUnsavedChanges()'),end=edit.indexOf('function approvalFingerprint()',start);
 assert.ok(start>=0&&end>start);
 const previous={...form('salary'),bonusBase:'4000'},employerId='emp_'+'a'.repeat(32);
 let draft={...previous,bonusBase:'9000'};
 const ctx={record:{form:previous,employerId},employerInput:{value:employerId},effectiveValues:()=>draft,applicablePayrollForm,normalizeWorkDays};
 const changed=runInNewContext(stripTypeScriptTypes(edit.slice(start,end),{mode:'strip'})+'\nhasUnsavedChanges',ctx);
 assert.equal(changed(),false,'inactive salary bonus fields cannot trigger a save');
 draft={...draft,residentTax:'0'};assert.equal(changed(),true,'blank and explicitly approved zero must differ');
 draft={...previous};ctx.employerInput.value='';assert.equal(changed(),true,'employer change must be saved');
 ctx.employerInput.value=employerId;draft={...previous,kind:'bonus'};assert.equal(changed(),true,'kind change must be saved');
 ctx.record.form={...form('bonus'),workDays:'21'};draft={...ctx.record.form,workDays:'10'};assert.equal(changed(),false,'inactive bonus work days cannot trigger a save');
 draft={...draft,gross:'260000'};assert.equal(changed(),true,'active money changes must be saved');
 assert.match(edit,/JSON\.stringify\(applicablePayrollForm\(effectiveValues\(\)\)\)!==JSON\.stringify\(formValues\)/,'final approval compares the same effective draft as the saved payload');
 console.log('PASS: semantic no-op, blank vs zero, employer/kind/amount edits and final effective-form guard');
}
