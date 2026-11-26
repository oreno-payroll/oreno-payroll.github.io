/** Round 4/B: source provenance and opt-in zeros, no OAuth/browser/OneDrive I/O. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
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

// Execute the actual editor shortcut with the normal-save boundary stubbed.
// No authentication state is fabricated and no cloud write is performed.
{
 const edit=src('src/edit.ts'),html=src('public/edit/index.html');
 const extract=(start,end)=>{const a=edit.indexOf(start),b=edit.indexOf(end,a);assert.ok(a>=0&&b>a);return stripTypeScriptTypes(edit.slice(a,b),{mode:'strip'});};
 const code=extract('function zeroInputTargets(', 'function updateUI(')+extract('function saveWithOptionalZeros(', 'zeroSaveButton.addEventListener(');
 assert.match(html,/id="edit-save-zero" type="button"[^>]* disabled/);
 assert.match(edit,/zeroSaveButton.hidden=deletionPending\|\|deletionNeedsReload\|\|zeroCount===0/);
 assert.match(edit,/zeroSaveButton.disabled=saving\|\|employerRefreshing\|\|deletionPending\|\|deletionConfirming\|\|deletionNeedsReload\|\|errors.length>0/);
 for(const mode of ['salary','bonus','warning','invalid','locked','saving','deletion','no-target']){
  const values=form(mode==='bonus'?'bonus':'salary');
  values.transportation='100';values.nonTaxable='100';values.taxable='249900';
  values.yearEndAdjustment='';values.bonusBase='';values.performanceBonus='';values.workDays='';
  if(mode==='warning'){values.taxable='';values.nonTaxable='';}
  if(mode==='no-target')for(const key of emptyOptionalAmounts(values))values[key]='0';
  const controls=PAYROLL_FIELDS.filter(k=>!['job','kind','targetMonth','paymentDate'].includes(k)).map(name=>({name,value:values[name],disabled:false,validity:{badInput:mode==='invalid'&&name==='incomeTax'},closest:()=> (values.kind==='salary'?['bonusBase','performanceBonus']:['workDays','yearEndAdjustment','reimbursedExpenses']).includes(name)?{}:null}));
  let writes=0,focus=0;const status={textContent:'',removeAttribute(){}};
  const ctx={status,record:{},saving:mode==='saving',deletionPending:mode==='deletion',deletionConfirming:false,deletionNeedsReload:false,zeroSaveButton:{disabled:false},reviewApproval:'old',form:{querySelectorAll:()=>controls},emptyOptionalAmounts,captureOperationAuthorization:()=>()=>mode!=='locked',getValues:()=>({...values,...Object.fromEntries(controls.map(x=>[x.name,x.value]))}),clearInlineError(){},errorView:{},reviewConfirmation:{hidden:true},confirmDiff:{disabled:false,focus(){focus++;}},saveButton:{disabled:false,click(){writes++;}},updateUI(){const checked=validatePayrollForm(ctx.getValues());ctx.saveButton.disabled=!!(checked.errors.length||checked.warnings.length);ctx.reviewConfirmation.hidden=!checked.warnings.length;}};
  const run=runInNewContext(code+'\nsaveWithOptionalZeros',ctx);run();
  const changed=ctx.getValues();
  if(['invalid','locked','saving','deletion','no-target'].includes(mode)){assert.equal(writes,0,mode);assert.equal(ctx.reviewApproval,'old',mode);assert.deepEqual(changed,values,mode);continue;}
  assert.equal(changed.gross,values.gross);assert.equal(changed.net,values.net);assert.equal(changed.transportation,'100');assert.equal(changed.workDays,'');assert.equal(changed.residentTax,'0');assert.equal(changed.healthInsurance,'0');assert.equal(ctx.reviewApproval,null);
  if(mode==='bonus'){assert.equal(changed.yearEndAdjustment,'');assert.equal(changed.reimbursedExpenses,'');assert.equal(changed.bonusBase,'0');}
  else{assert.equal(changed.bonusBase,'');assert.equal(changed.performanceBonus,'');assert.equal(changed.yearEndAdjustment,'0');}
  if(mode==='warning'){assert.equal(writes,0);assert.equal(focus,1);assert.match(status.textContent,/まだ保存されていません.*変更を保存/);}else assert.equal(writes,1,mode);
 }
 console.log('PASS: editor zero-save uses existing write boundary; existing values, hidden fields, warnings and operation guards are preserved');
}
