/** 共通期間・集計条件・文書一覧の条件は独立。ZIPは期間全件を使用する。 */
import {fiscalYearOfTargetMonth} from './payrollCalendar.ts';
import {calendarYearOfPaymentDate} from './calendarForecast.ts';
export type StatementKindFilter = 'all'|'salary'|'bonus';
type PeriodRecord = {form:Record<string,string>};
export function selectDashboardPeriod<T extends PeriodRecord>(records:readonly T[],year:number,mode:'calendar'|'fiscal'):T[]{
 return records.filter(({form})=>(mode==='calendar'?calendarYearOfPaymentDate(form.paymentDate):fiscalYearOfTargetMonth(form.targetMonth))===year);
}
export function selectDashboardIncome<T extends PeriodRecord>(records:readonly T[],includeBonus:boolean):T[]{
 return records.filter(({form})=>includeBonus||form.kind!=='bonus');
}
export function selectDashboardStatements<T extends PeriodRecord>(records:readonly T[],kind:StatementKindFilter):T[]{
 return records.filter(({form})=>kind==='all'||form.kind===kind);
}
