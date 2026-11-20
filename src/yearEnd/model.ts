/** Third-party year-end income records. No main/side or Finance record types appear here. */
export type PersonId = string & {readonly __yearEndPersonId:unique symbol};
export type DocumentId = string & {readonly __yearEndDocumentId:unique symbol};
export type YearFileId = string & {readonly __yearEndYearFileId:unique symbol};
export type PayKind = 'salary' | 'bonus';
export type EstimateMethod = 'latest' | 'average3' | 'manual';
export type PersonState = 'active'|'deleting'|'deleted';
export interface PersonIndexEntry {id:PersonId;state:PersonState;createdAt:string;updatedAt:string}
export interface PersonIndex {format:'payroll-year-end-index-v1';persons:PersonIndexEntry[]}
export interface PersonProfile {format:'payroll-year-end-person-v1';id:PersonId;displayName:string;alias:string;createdAt:string;updatedAt:string;yearFiles:Record<string,YearFileId>}
export interface DocumentRecord {
 id:DocumentId;personId:PersonId;kind:PayKind;paymentDate:string;targetMonth:string;
 taxable:number;gross:number|null;transportation:number|null;nonTaxable:number|null;
 healthInsurance:number|null;pension:number|null;employmentInsurance:number|null;
 incomeTax:number|null;residentTax:number|null;
 fileName:string;pdfSize:number;fileHash:string;detectedName?:string|null;confirmedAt:string;
 updatedAt:string;source:'manual-confirmed'|'pdf-reviewed';revision:number;
}
export interface Estimate {month:string;amount:number;method:EstimateMethod;references:DocumentId[];updatedAt:string}
export interface ChangeEvent {at:string;kind:'estimate-replaced'|'document-corrected'|'document-deleted';month:string;oldValue?:number;newValue?:number;documentId?:DocumentId}
export interface YearData {format:'payroll-year-end-year-v1';personId:PersonId;calendarYear:number;documents:DocumentRecord[];estimates:Estimate[];bonusEstimates:Estimate[];noPaymentMonths:string[];confirmedAt:string|null;history:ChangeEvent[];memo?:string}
export interface DraftDocument {kind:PayKind;paymentDate:string;targetMonth:string;taxable:number|null;gross:number|null;transportation:number|null;nonTaxable:number|null;healthInsurance:number|null;pension:number|null;employmentInsurance:number|null;incomeTax:number|null;residentTax:number|null;detectedName:string|null;warnings:string[]}
export interface ForecastPreview {method:EstimateMethod;months:string[];references:Array<{id:DocumentId;month:string;amount:number}>;estimated:Estimate[];actualSalary:number;actualBonus:number;forecastTotal:number;annualTotal:number}
export const YEAR_MIN=1990,YEAR_MAX=2120;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v:unknown):v is string{return typeof v==='string'&&uuid.test(v);}
export function asPersonId(v:unknown):PersonId{if(!isUuid(v))throw new Error('従業員IDが不正です。');return v as PersonId;}
export function asDocumentId(v:unknown):DocumentId{if(!isUuid(v))throw new Error('明細IDが不正です。');return v as DocumentId;}
export function randomPersonId():PersonId{return crypto.randomUUID() as PersonId;}
export function randomDocumentId():DocumentId{return crypto.randomUUID() as DocumentId;}
export function validYear(y:number):boolean{return Number.isSafeInteger(y)&&y>=YEAR_MIN&&y<=YEAR_MAX;}
export function money(n:unknown):n is number{return typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=999_999_999;}
export function checkedMoney(n:unknown):number{if(!money(n))throw new Error('課税支給額は0円以上の整数で入力してください。');return n;}
export function parseYen(value:string):number|null{const s=value.trim().replace(/[,，￥¥円\s]/g,'');if(!/^\d{1,9}$/.test(s))return null;const n=Number(s);return money(n)?n:null;}
/** A warning, not a read-time schema failure: older accepted annual files must remain readable.
 * The explicit save path requires user acknowledgement when a warning is present. */
export function documentAmountWarnings(v:Pick<DraftDocument,'taxable'|'gross'|'nonTaxable'|'transportation'>):string[]{
 const warnings:string[]=[];
 if(v.taxable!==null&&v.gross!==null&&v.taxable>v.gross)
  warnings.push('課税支給額が総支給額を上回っています。');
 if(v.gross!==null&&v.taxable!==null&&v.nonTaxable!==null&&v.taxable+v.nonTaxable!==v.gross)
  warnings.push('課税支給額と非課税支給額の合計が総支給額と一致しません。');
 if(v.gross!==null&&v.nonTaxable!==null&&v.nonTaxable>v.gross)
  warnings.push('非課税支給額が総支給額を上回っています。');
 if(v.nonTaxable!==null&&v.transportation!==null&&v.transportation>v.nonTaxable)
  warnings.push('非課税交通費が非課税支給額を上回っています。');
 return [...new Set(warnings)];
}
/** The person's display name is an alias and must never be used as a PDF identity. */
export function normalizeDetectedName(name:string|null|undefined):string|null{
 if(!name)return null;
 const normalized=name.normalize('NFKC').replace(/[\s\u3000]/g,'').trim();
 return normalized.length>=2&&normalized.length<=80?normalized:null;
}
export function inconsistentDetectedNames(names:readonly (string|null|undefined)[]):boolean{
 return new Set(names.map(normalizeDetectedName).filter((n):n is string=>n!==null)).size>1;
}
export function validDate(value:string):boolean{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const dt=new Date(value+'T00:00:00Z');return !Number.isNaN(dt.getTime())&&dt.toISOString().slice(0,10)===value&&validYear(Number(value.slice(0,4)));}
export function monthOf(date:string):string{if(!validDate(date))throw new Error('支給年月日が不正です。');return date.slice(0,7);}
export function yearMonth(y:number,m:number):string{if(!validYear(y)||m<1||m>12||!Number.isInteger(m))throw new Error('年月が不正です。');return `${y}-${String(m).padStart(2,'0')}`;}
export function emptyIndex():PersonIndex{return {format:'payroll-year-end-index-v1',persons:[]};}
export function emptyYear(personId:PersonId,year:number):YearData{if(!validYear(year))throw new Error('暦年が不正です。');return {format:'payroll-year-end-year-v1',personId,calendarYear:year,documents:[],estimates:[],bonusEstimates:[],noPaymentMonths:[],confirmedAt:null,history:[],memo:''};}
export function validateIndex(raw:unknown):PersonIndex{
 const v=raw as PersonIndex;if(v?.format!=='payroll-year-end-index-v1'||!Array.isArray(v.persons)||v.persons.length>2000)throw new Error('従業員索引の形式が不正です。');
 const ids=new Set<string>();for(const p of v.persons){if(!isUuid(p?.id)||ids.has(p.id)||!['active','deleting','deleted'].includes(p.state)||typeof p.createdAt!=='string'||typeof p.updatedAt!=='string')throw new Error('従業員索引が破損しています。');ids.add(p.id);}return v;
}
export function validateProfile(raw:unknown,id:PersonId):PersonProfile{
 const p=raw as PersonProfile;if(p?.format!=='payroll-year-end-person-v1'||p.id!==id||typeof p.displayName!=='string'||p.displayName.length<1||p.displayName.length>80||typeof p.alias!=='string'||p.alias.length>80||typeof p.createdAt!=='string'||typeof p.updatedAt!=='string'||!p.yearFiles||typeof p.yearFiles!=='object'||Array.isArray(p.yearFiles))throw new Error('従業員情報が破損しています。');
 if(Object.keys(p.yearFiles).length>131||!Object.entries(p.yearFiles).every(([year,file])=>validYear(Number(year))&&String(Number(year))===year&&isUuid(file)))throw new Error('年度索引が不正です。');return p;
}
/** Free-form per-person, per-calendar-year note; backward-compatible with old year files. */
export const MAX_YEAR_MEMO=16_000;
export function validYearMemo(value:unknown):boolean{return value===undefined||(typeof value==='string'&&[...value].length<=MAX_YEAR_MEMO);}
export function validateYear(raw:unknown,id:PersonId,year:number):YearData{
 const d=raw as YearData;if(d?.format!=='payroll-year-end-year-v1'||d.personId!==id||d.calendarYear!==year||!Array.isArray(d.documents)||!Array.isArray(d.estimates)||!Array.isArray(d.bonusEstimates)||!Array.isArray(d.noPaymentMonths)||!Array.isArray(d.history)||d.documents.length>300||d.estimates.length>24||d.bonusEstimates.length>24||d.history.length>1000||!validYearMemo(d.memo))throw new Error('年度データが不正です。');
 const docs=new Set<string>();const salaries=new Set<string>();const hashes=new Set<string>();for(const r of d.documents){
  if(!isUuid(r.id)||r.personId!==id||docs.has(r.id)||!['salary','bonus'].includes(r.kind)||!validDate(r.paymentDate)||Number(r.paymentDate.slice(0,4))!==year||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(r.targetMonth)||!money(r.taxable)||!['manual-confirmed','pdf-reviewed'].includes(r.source)||!Number.isSafeInteger(r.revision)||r.revision<1||typeof r.fileName!=='string'||r.fileName.length>250||!Number.isSafeInteger(r.pdfSize)||r.pdfSize<1||r.pdfSize>50_000_000||!/^[a-f0-9]{64}$/.test(r.fileHash))throw new Error('明細データが不正です。');
  for(const k of ['gross','transportation','nonTaxable','healthInsurance','pension','employmentInsurance','incomeTax','residentTax'] as const)if(r[k]!==null&&!money(r[k]))throw new Error('明細金額が不正です。');
  if(r.detectedName!==undefined&&r.detectedName!==null&&(typeof r.detectedName!=='string'||[...r.detectedName].length>80||/[\u0000-\u001f]/.test(r.detectedName)))throw new Error('PDF読み取り氏名の形式が不正です。');
  const month=monthOf(r.paymentDate);if(r.kind==='salary'){if(salaries.has(month))throw new Error('同じ支給月の給与明細が重複しています。');salaries.add(month);}if(hashes.has(r.fileHash))throw new Error('同一PDF原本が二重登録されています。');hashes.add(r.fileHash);docs.add(r.id);
 }
 const estimated=new Set<string>();for(const e of d.estimates){if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(e.month)||!e.month.startsWith(String(year)+'-')||!money(e.amount)||!['latest','average3','manual'].includes(e.method)||!Array.isArray(e.references)||e.references.some(r=>!isUuid(r))||estimated.has(e.month)||salaries.has(e.month))throw new Error('見込み額が実績と重複しています。');estimated.add(e.month);}
 const bonusMonths=new Set(d.documents.filter(r=>r.kind==='bonus').map(r=>monthOf(r.paymentDate)));
 const estimatedBonuses=new Set<string>();
 for(const e of d.bonusEstimates){
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(e.month)||!e.month.startsWith(String(year)+'-')||!money(e.amount)||e.method!=='manual'||e.references.length||estimatedBonuses.has(e.month)||bonusMonths.has(e.month))throw new Error('賞与見込みが不正または実績と重複しています。');
  estimatedBonuses.add(e.month);
 }
 const unpaid=new Set<string>();for(const m of d.noPaymentMonths){if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(m)||!m.startsWith(String(year)+'-')||unpaid.has(m)||estimated.has(m)||salaries.has(m))throw new Error('支給なし月と実績・見込みが重複しています。');unpaid.add(m);}
 return d;
}
export function calculateYear(data:YearData){validateYear(data,data.personId,data.calendarYear);const salary=data.documents.filter(r=>r.kind==='salary').reduce((a,r)=>a+r.taxable,0);const bonus=data.documents.filter(r=>r.kind==='bonus').reduce((a,r)=>a+r.taxable,0);const salaryForecast=data.estimates.reduce((a,r)=>a+r.amount,0);const bonusForecast=data.bonusEstimates.reduce((a,r)=>a+r.amount,0);const forecast=salaryForecast+bonusForecast;return {salary,bonus,actual:salary+bonus,forecast,salaryForecast,bonusForecast,total:salary+bonus+forecast,documents:data.documents.length,unknownMonths:Array.from({length:12},(_,i)=>yearMonth(data.calendarYear,i+1)).filter(m=>!data.documents.some(d=>d.kind==='salary'&&monthOf(d.paymentDate)===m)&&!data.estimates.some(e=>e.month===m)&&!data.noPaymentMonths.includes(m))};}
export function forecastPreview(data:YearData,method:EstimateMethod,months:string[],manual:Record<string,number>={}):ForecastPreview{
 validateYear(data,data.personId,data.calendarYear);if(!months.length||months.length>12||new Set(months).size!==months.length)throw new Error('対象月を選択してください。');
 const actualMonths=new Set(data.documents.filter(d=>d.kind==='salary').map(d=>monthOf(d.paymentDate)));
 const selected=months.slice().sort();for(const m of selected)if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(m)||!m.startsWith(String(data.calendarYear)+'-')||actualMonths.has(m)||data.noPaymentMonths.includes(m))throw new Error('実績確定済み・支給なしの月は見込み対象にできません。');
 const salaryDocuments=data.documents.filter(r=>r.kind==='salary').sort((a,b)=>b.paymentDate.localeCompare(a.paymentDate));
 const past=salaryDocuments.filter(r=>r.paymentDate.slice(0,7)<selected[0]);
 // When missing months precede all confirmed salaries, use the latest confirmed salary
 // rather than silently leaving the entire year's estimate method inoperative.
 const references=(past.length?past:salaryDocuments).slice(0,method==='average3'?3:1);
 if(method!=='manual'&&!references.length)throw new Error('参考にできる確定給与がありません。手動入力を選択してください。');
 const defaultAmount=method==='manual'?0:Math.round(references.reduce((a,r)=>a+r.taxable,0)/references.length);
 const estimates=selected.map(month=>({month,amount:checkedMoney(method==='manual'?manual[month]:manual[month]??defaultAmount),method,references:method==='manual'?[]:references.map(r=>r.id),updatedAt:new Date().toISOString()}));
 const combined=data.estimates.filter(e=>!selected.includes(e.month)).concat(estimates);
 return {method,months:selected,references:references.map(r=>({id:r.id,month:monthOf(r.paymentDate),amount:r.taxable})),estimated:estimates,actualSalary:calculateYear(data).salary,actualBonus:calculateYear(data).bonus,forecastTotal:combined.reduce((a,r)=>a+r.amount,0)+calculateYear(data).bonusForecast,annualTotal:calculateYear(data).actual+combined.reduce((a,r)=>a+r.amount,0)+calculateYear(data).bonusForecast};
}

/** Explicit bonus estimate. Never generated by a salary average or implicitly repeated. */
export function bonusEstimatePreview(data:YearData,month:string,amount:number){
 validateYear(data,data.personId,data.calendarYear);checkedMoney(amount);
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||!month.startsWith(String(data.calendarYear)+'-'))throw new Error('賞与見込みの支給月が不正です。');
 if(data.documents.some(r=>r.kind==='bonus'&&monthOf(r.paymentDate)===month))throw new Error('その月は賞与実績が登録済みです。');
 const base=calculateYear(data);const old=data.bonusEstimates.find(e=>e.month===month)?.amount??0;
 return {month,amount,forecastTotal:base.forecast-old+amount,annualTotal:base.total-old+amount,actual:base.actual};
}
