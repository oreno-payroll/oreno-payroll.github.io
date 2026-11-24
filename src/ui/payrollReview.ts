import {applicablePayrollForm,amountOrMissing,DEDUCTION_KEYS,type PayrollForm} from '../storage/payrollValidation.ts';
export type ReviewRow=readonly [label:string,value:number|string];
export function personalReviewRows(input:PayrollForm):ReviewRow[]{
 const form=applicablePayrollForm(input),gross=amountOrMissing(form.gross),net=amountOrMissing(form.net);
 const deductions=DEDUCTION_KEYS.reduce((sum,key)=>sum+(amountOrMissing(form[key])??0),0);
 const rows:ReviewRow[]=[];
 if(gross!==null&&net!==null&&Number.isSafeInteger(deductions)&&Number.isSafeInteger(gross-deductions)&&Number.isSafeInteger(gross-deductions-net)&&gross-deductions!==net){
  rows.push(['総支給額',gross],['入力済み控除額',deductions],['計算上の手取り',gross-deductions],['入力された手取り',net],['差額（計算値 − 入力値）',gross-deductions-net]);
 }
 const taxable=amountOrMissing(form.taxable),nonTaxable=amountOrMissing(form.nonTaxable);
 rows.push(...taxableReviewRows(gross,taxable,nonTaxable,false));
 const transportation=amountOrMissing(form.transportation),expenses=amountOrMissing(form.reimbursedExpenses);
 if(nonTaxable!==null&&transportation!==null&&expenses!==null&&Number.isSafeInteger(transportation+expenses)&&transportation+expenses>nonTaxable){
  rows.push(['非課税支給額',nonTaxable],['交通費',transportation],['立替経費',expenses],['交通費・立替経費の合計',transportation+expenses],['超過額（非課税支給額との差）',transportation+expenses-nonTaxable]);
 }
 const base=amountOrMissing(form.bonusBase),performance=amountOrMissing(form.performanceBonus);
 if(form.kind==='bonus'&&gross!==null&&base!==null&&performance!==null&&Number.isSafeInteger(base+performance)&&base+performance>gross){
  rows.push(['賞与手当',base],['業績手当',performance],['賞与内訳の合計',base+performance],['総支給額',gross],['超過額（総支給額との差）',base+performance-gross]);
 }
 const date=new Date(`${form.paymentDate}T00:00:00Z`),month=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(form.targetMonth??'');
 if(month&&Number.isFinite(date.getTime())){
  const gap=(date.getUTCFullYear()-Number(month[1]))*12+date.getUTCMonth()+1-Number(month[2]),now=new Date();
  if(Math.abs(gap)>12||date.getTime()>Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+18,1)||date.getTime()<Date.UTC(now.getUTCFullYear()-30,now.getUTCMonth(),1)){
   rows.push(['対象年月',form.targetMonth],['支給日',form.paymentDate],['支給月 − 対象月',`${gap}か月`]);
  }
 }
 return rows;
}
function taxableReviewRows(gross:number|null,taxable:number|null,nonTaxable:number|null,checkNonTaxable:boolean):ReviewRow[]{
 const rows:ReviewRow[]=[];
 if(gross!==null&&taxable!==null&&nonTaxable!==null&&Number.isSafeInteger(taxable+nonTaxable)&&taxable+nonTaxable!==gross){
  rows.push(['総支給額',gross],['課税支給額',taxable],['非課税支給額',nonTaxable],['課税・非課税の合計',taxable+nonTaxable],['差額（内訳合計 − 総支給額）',taxable+nonTaxable-gross]);
 }else if(gross!==null&&((taxable!==null&&taxable>gross)||(checkNonTaxable&&nonTaxable!==null&&nonTaxable>gross))){
  rows.push(['総支給額',gross]);
  if(taxable!==null&&taxable>gross)rows.push(['課税支給額',taxable],['課税支給額の超過額',taxable-gross]);
  if(checkNonTaxable&&nonTaxable!==null&&nonTaxable>gross)rows.push(['非課税支給額',nonTaxable],['非課税支給額の超過額',nonTaxable-gross]);
 }
 return rows;
}
export function yearEndReviewRows(d:{gross:number|null;taxable:number|null;nonTaxable:number|null;transportation:number|null}):ReviewRow[]{
 const {gross,taxable,nonTaxable,transportation}=d;
 const rows=taxableReviewRows(gross,taxable,nonTaxable,true);
 if(transportation!==null&&nonTaxable!==null&&transportation>nonTaxable){
  if(!rows.some(([label])=>label==='非課税支給額'))rows.push(['非課税支給額',nonTaxable]);
  rows.push(['非課税交通費',transportation],['超過額（非課税支給額との差）',transportation-nonTaxable]);
 }
 return rows;
}
/** Consent belongs to this exact in-memory draft, not the currently visible form or an ID. */
export function createDraftReviewConsent<T extends object>(){
 const approvals=new WeakMap<T,string>();
 return {
  set(draft:T,approved:boolean){if(approved)approvals.set(draft,JSON.stringify(draft));else approvals.delete(draft);},
  has(draft:T){return approvals.get(draft)===JSON.stringify(draft);},
 };
}
export interface ReviewConfirmationState {required:boolean;approved:boolean;disabled:boolean;warnings:readonly string[];rows:readonly ReviewRow[]}
/** Static markup owns the checkbox, so updating warnings never replaces the focused input. */
export function renderReviewConfirmation(panel:HTMLElement,checkbox:HTMLInputElement,state:ReviewConfirmationState):void{
 const {required,approved,disabled,warnings,rows}=state;
 panel.hidden=!required;checkbox.checked=required&&approved;checkbox.disabled=!required||disabled;
 const list=panel.querySelector<HTMLElement>('[data-review-warnings]')!;
 const details=panel.querySelector<HTMLElement>('[data-review-rows]')!;
 list.replaceChildren();details.replaceChildren();
 list.hidden=!required||!warnings.length;details.hidden=!required||!rows.length;
 if(!required)return;
 for(const warning of warnings){const li=document.createElement('li');li.textContent=warning;list.append(li);}
 for(const [label,value] of rows){const div=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=typeof value==='number'?`${value.toLocaleString('ja-JP')}円`:value;div.append(dt,dd);details.append(div);}
}

/** Preserve the last recorded approval, never claim that it still approves a changed form. */
export function editedReviewRecord(previous:{reviewedIssues?:string[];reviewedAt?:string},warnings:string[],approved:boolean,now:string){
 if(warnings.length&&!approved)throw new Error('検算警告を確認してください。');
 return {warningsAcknowledged:warnings.length>0&&approved,reviewedIssues:warnings.length?[...warnings]:previous.reviewedIssues,reviewedAt:warnings.length?now:previous.reviewedAt};
}
