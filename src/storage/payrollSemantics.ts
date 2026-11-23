/**
 * A statement's field names and parser provenance are captured at import time.
 * Do not reinterpret a saved form using a newer PDF parser or relabel past fields.
 * A legacy statement without this property is deliberately left unmodified.
 */
import type {PayrollParseResult} from '../pdf/payrollParser';
import type {PayrollFieldKey} from './payrollValidation';

export const PAYROLL_SEMANTICS_FORMAT='payroll-semantics-v1' as const;
/** Advance this identifier when PDF interpretation rules change. */
export const PAYROLL_PARSER_REVISION='payroll-parser-2026-11-r1' as const;

/** Historical wire-format v1 keys. NEVER derive this from current form fields.
 * When a new salary field is introduced, design semantics v2 and preserve this list. */
export const PAYROLL_SEMANTICS_V1_KEYS = Object.freeze([
 'job','kind','targetMonth','paymentDate','gross','net','taxable','nonTaxable',
 'transportation','reimbursedExpenses','workDays','incomeTax','residentTax',
 'healthInsurance','careInsurance','childcareSupport','pension',
 'employmentInsurance','otherDeductions','yearEndAdjustment','bonusBase','performanceBonus',
] as const);

const FIELD_LABELS:Readonly<Record<PayrollFieldKey,string>>={
 job:'勤務区分',kind:'明細区分',targetMonth:'給与対象年月',paymentDate:'支給日',
 gross:'総支給額',net:'差引支給額',taxable:'課税支給合計',nonTaxable:'非課税支給合計',
 transportation:'非課税通勤費',reimbursedExpenses:'立替経費',workDays:'出勤日数',
 incomeTax:'所得税',residentTax:'住民税',healthInsurance:'健康保険料',careInsurance:'介護保険料',
 childcareSupport:'子ども・子育て支援金',pension:'厚生年金保険料',employmentInsurance:'雇用保険料',
 otherDeductions:'その他控除',yearEndAdjustment:'年末調整税額',bonusBase:'賞与手当',
 performanceBonus:'業績手当',
};

export interface PayrollStatementSemantics {
 format:typeof PAYROLL_SEMANTICS_FORMAT;
 /** Role at the time of import. This is not an employer's permanent identifier. */
 roleAtImport:'main'|'side';
 kindAtImport:'salary'|'bonus';
 parserProfile:'main'|'side'|null;
 parserRevision:string;
 layoutStatus:'matched'|'suspect'|'unknown';
 /** Field-name snapshot; never regenerate it when showing/editing old records. */
 fieldLabels:Record<PayrollFieldKey,string>;
}

export function createPayrollSemantics(form:Record<string,string>,parsed?:PayrollParseResult):PayrollStatementSemantics{
 if(!['main','side'].includes(form.job)||!['salary','bonus'].includes(form.kind))
  throw new Error('明細の勤務区分・種別が不正です。');
 const fieldLabels={...FIELD_LABELS};
 for(const [key,source] of Object.entries(parsed?.fieldSources??{})){
  if(Object.hasOwn(fieldLabels,key)&&source?.label&&source.label.length<=80)
   fieldLabels[key as PayrollFieldKey]=source.label;
 }
 return {
  format:PAYROLL_SEMANTICS_FORMAT,
  roleAtImport:form.job as 'main'|'side',
  kindAtImport:form.kind as 'salary'|'bonus',
  parserProfile:parsed?.profile??null,
  parserRevision:PAYROLL_PARSER_REVISION,
  layoutStatus:parsed?.layout?.status??'unknown',
  fieldLabels,
 };
}

/** Validate optional metadata in an encrypted annual JSON without rewriting it. */
export function isValidPayrollSemantics(value:unknown):value is PayrollStatementSemantics {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const x=value as Partial<PayrollStatementSemantics>;
 if(x.format!==PAYROLL_SEMANTICS_FORMAT||!['main','side'].includes(x.roleAtImport??'')||
    !['salary','bonus'].includes(x.kindAtImport??'')||
    (x.parserProfile!==null&&!['main','side'].includes(x.parserProfile??''))||
    typeof x.parserRevision!=='string'||!/^[a-z0-9_.-]{1,80}$/.test(x.parserRevision)||
    !['matched','suspect','unknown'].includes(x.layoutStatus??''))return false;
 if(!x.fieldLabels||typeof x.fieldLabels!=='object'||Array.isArray(x.fieldLabels))return false;
 const expected:readonly string[]=PAYROLL_SEMANTICS_V1_KEYS;
 const observed=Object.keys(x.fieldLabels);
 return observed.length===expected.length&&expected.every(key=>{
  const label=(x.fieldLabels as Record<string,unknown>)[key];
  return typeof label==='string'&&label.trim().length>0&&label.length<=80;
 });
}
