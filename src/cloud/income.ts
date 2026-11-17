/** Published Finance income fields only. Do not export salary statement detail/PDFs.
 * Keep a stable Payroll numeric ID so corrected/reimported salaries replace prior values.
 */
export interface PublicIncomeRecord {
  id:number;paymentDate:string;targetMonth:string;job:string;kind:string;
  netPaymentYen:number;grossPaymentYen:number;taxablePaymentYen?:number;revision:number;
}
export function toPublicIncomeRecord(record:{id:number;revision?:number;form:Record<string,string>}):PublicIncomeRecord {
  const form=record.form;
  const net=Number(form.net),gross=Number(form.gross);
  const taxableText=(form.taxable??'').trim();
  const taxable=taxableText===''?undefined:Number(taxableText);
  if(!Number.isSafeInteger(record.id)||record.id<=0||
    !Number.isSafeInteger(net)||net<0||!Number.isSafeInteger(gross)||gross<0||
    (taxable!==undefined&&(!Number.isSafeInteger(taxable)||taxable<0))||
    !Number.isSafeInteger(record.revision??1)||(record.revision??1)<1)
    throw new Error('収入連携データの手取り・額面・課税支給額が不正です。');
  if(!/^\d{4}-\d\d-\d\d$/.test(form.paymentDate??'')||!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.targetMonth??'')||
     !['main','side'].includes(form.job)||!['salary','bonus'].includes(form.kind))
    throw new Error('収入連携データの支給日や勤務先が不正です。');
  return {id:record.id,paymentDate:form.paymentDate,targetMonth:form.targetMonth,job:form.job,kind:form.kind,
    netPaymentYen:net,grossPaymentYen:gross,...(taxable===undefined?{}:{taxablePaymentYen:taxable}),revision:record.revision??1};
}
