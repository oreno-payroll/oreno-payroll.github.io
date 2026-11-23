/**
 * Import-time provenance of optional salary amounts. Never infer a value from
 * a missing PDF field. An explicit user opt-in may fill only eligible blanks.
 * This metadata is stored INSIDE encrypted annual JSON, not in browser storage.
 */
import {applicablePayrollForm,type PayrollFieldKey} from './payrollValidation.ts';

export const ZERO_OPTIONAL_AMOUNT_LABELS = {
  taxable:'課税支給額', nonTaxable:'非課税支給額', transportation:'交通費',
  reimbursedExpenses:'立替経費', incomeTax:'所得税', residentTax:'住民税',
  healthInsurance:'健康保険料', careInsurance:'介護保険料',
  childcareSupport:'子ども・子育て支援金', pension:'厚生年金保険料',
  employmentInsurance:'雇用保険料', otherDeductions:'その他控除',
  yearEndAdjustment:'年調過不足税額', bonusBase:'賞与手当',
  performanceBonus:'業績手当',
} as const satisfies Partial<Record<PayrollFieldKey,string>>;
export type ZeroOptionalAmountField=keyof typeof ZERO_OPTIONAL_AMOUNT_LABELS;
export type ZeroMissingReason='absent'|'unreadable'|'unclassified';
export interface PayrollZeroResolutionV1 {
  format:'payroll-zero-resolution-v1';
  /** The parser's observation at import. Not a conclusion about the current edited value. */
  missingAtImport:Array<{field:ZeroOptionalAmountField;reason:ZeroMissingReason}>;
  /** Fields explicitly filled with 0 by a single user action at import, still 0 after edits. */
  confirmedZeroFields:ZeroOptionalAmountField[];
  /** Direct PDF coordinate evidence of a literal zero at import (not a derived value). */
  pdfZeroFields:ZeroOptionalAmountField[];
  /** Set only for an actual opt-in that changed at least one blank. */
  approvedAt?:string;
}
export interface MissingAtParse {field?:PayrollFieldKey;reason:'absent'|'unreadable'}
export interface ImportZeroEvidence {
  missingFields?:readonly MissingAtParse[];
  fields?:Partial<Record<PayrollFieldKey,string>>;
  /** The upload UI clears this set when the user manually edits a field. */
  automaticFields?:ReadonlySet<PayrollFieldKey>;
  fieldSources?:Partial<Record<PayrollFieldKey,{page:number}>>;
}
const ALL_FIELDS=Object.keys(ZERO_OPTIONAL_AMOUNT_LABELS) as ZeroOptionalAmountField[];
const FIELD_SET=new Set<string>(ALL_FIELDS);
export function eligibleZeroFields(form:Record<string,string>):ZeroOptionalAmountField[] {
  const inactive=form.kind==='bonus'
    ? new Set<string>(['reimbursedExpenses','yearEndAdjustment'])
    : form.kind==='salary' ? new Set<string>(['bonusBase','performanceBonus'])
    : new Set<string>(ALL_FIELDS);
  return ALL_FIELDS.filter(field=>!inactive.has(field));
}
export function emptyOptionalAmounts(form:Record<string,string>):ZeroOptionalAmountField[] {
  const actual=applicablePayrollForm(form);
  return eligibleZeroFields(actual).filter(field=>typeof actual[field]==='string'&&actual[field].trim()==='');
}
export function prepareOptionalZeros(
  form:Record<string,string>,evidence:ImportZeroEvidence={},approveZero=false,approvedAt=new Date().toISOString(),
):{form:Record<string,string>;zeroResolution:PayrollZeroResolutionV1} {
  const actual=applicablePayrollForm(form);
  const eligible=eligibleZeroFields(actual);
  const blanks=emptyOptionalAmounts(actual);
  const missing=new Map<ZeroOptionalAmountField,ZeroMissingReason>();
  for(const row of evidence.missingFields??[]){
    if(row.field&&FIELD_SET.has(row.field)&&eligible.includes(row.field as ZeroOptionalAmountField))
      missing.set(row.field as ZeroOptionalAmountField,row.reason);
  }
  for(const field of blanks)if(!missing.has(field))missing.set(field,'unclassified');
  const pdfZeroFields=eligible.filter(field=>
    actual[field]==='0'&&evidence.fields?.[field]==='0'&&
    evidence.automaticFields?.has(field)===true&&Boolean(evidence.fieldSources?.[field]));
  if(approveZero)for(const field of blanks)actual[field]='0';
  const approved=approveZero&&blanks.length>0;
  return {form:actual,zeroResolution:{
    format:'payroll-zero-resolution-v1',
    missingAtImport:[...missing].map(([field,reason])=>({field,reason})),
    confirmedZeroFields:approved?[...blanks]:[], pdfZeroFields,
    ...(approved?{approvedAt}:{}),
  }};
}
function distinctFields(values:unknown,limit:number):values is ZeroOptionalAmountField[]{
  return Array.isArray(values)&&values.length<=limit&&new Set(values).size===values.length&&
    values.every(value=>typeof value==='string'&&FIELD_SET.has(value));
}
export function isValidPayrollZeroResolution(value:unknown,form:Record<string,string>):value is PayrollZeroResolutionV1 {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Partial<PayrollZeroResolutionV1>;
  if(v.format!=='payroll-zero-resolution-v1'||!Array.isArray(v.missingAtImport)||
      v.missingAtImport.length>ALL_FIELDS.length||
      !distinctFields(v.confirmedZeroFields,ALL_FIELDS.length)||
      !distinctFields(v.pdfZeroFields,ALL_FIELDS.length))return false;
  const eligible=new Set(eligibleZeroFields(form));
  const seen=new Set<string>();
  for(const row of v.missingAtImport){
    if(!row||typeof row!=='object'||!FIELD_SET.has(row.field)||!eligible.has(row.field)||
        !['absent','unreadable','unclassified'].includes(row.reason)||seen.has(row.field))return false;
    seen.add(row.field);
  }
  if(v.pdfZeroFields.some(field=>!eligible.has(field)))return false;
  if(v.confirmedZeroFields.some(field=>!eligible.has(field)||!seen.has(field)||form[field]!=='0'))return false;
  if(v.confirmedZeroFields.length){
    if(typeof v.approvedAt!=='string'||v.approvedAt.length>40||!/^\d{4}-\d\d-\d\dT/.test(v.approvedAt)||!Number.isFinite(Date.parse(v.approvedAt)))return false;
  }else if(v.approvedAt!==undefined)return false;
  return true;
}
/** A metadata-only edit cannot keep claiming an opt-in for a changed nonzero field. */
export function reconcilePayrollZeroResolution(
  previous:PayrollZeroResolutionV1|undefined,form:Record<string,string>,
):PayrollZeroResolutionV1|undefined {
  if(!previous)return undefined;
  const eligible=new Set(eligibleZeroFields(form));
  const confirmedZeroFields=previous.confirmedZeroFields.filter(field=>eligible.has(field)&&form[field]==='0');
  const missingAtImport=previous.missingAtImport.filter(row=>eligible.has(row.field));
  const pdfZeroFields=previous.pdfZeroFields.filter(field=>eligible.has(field));
  const next:PayrollZeroResolutionV1={
    format:'payroll-zero-resolution-v1',missingAtImport,confirmedZeroFields,pdfZeroFields,
    ...(confirmedZeroFields.length?{approvedAt:previous.approvedAt}:{}),
  };
  if(!isValidPayrollZeroResolution(next,form))throw new Error('明細の0円確認情報が不正です。再読込してください。');
  return next;
}
