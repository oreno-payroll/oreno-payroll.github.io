/** Payrollの会計年度は「支給日」ではなく、明細の給与対象年月で区分する。 */
export function monthStringFromIndex(index:number):string {
 return `${Math.floor(index/12)}-${String(index%12+1).padStart(2,'0')}`;
}
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function targetMonthOf(form: { targetMonth?: string }): string | null {
  return MONTH_PATTERN.test(form.targetMonth ?? '') ? form.targetMonth! : null;
}

export function monthIndex(ym: string | undefined): number | null {
  const match = MONTH_PATTERN.exec(ym ?? '');
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

export function fiscalYearOfTargetMonth(targetMonth: string | undefined): number | null {
  const match = MONTH_PATTERN.exec(targetMonth ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  return Number(match[2]) >= 4 ? year : year - 1;
}

/** 月給の「対象月→支給月」の差。別紙・異常日付は推定に使わない。 */
export function salaryPaymentLag(form: { targetMonth?: string; paymentDate?: string }): number | null {
  const target = monthIndex(form.targetMonth);
  const payment = monthIndex(form.paymentDate?.slice(0, 7));
  if (target === null || payment === null || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(form.paymentDate ?? '')) return null;
  const lag = payment - target;
  return lag >= 0 && lag <= 2 ? lag : null;
}
