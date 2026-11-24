/** 集計はUIと保存方式から独立。特定の任意項目のみ空欄を0円として扱う。 */
import { amountOrMissing } from '../storage/payrollValidation.ts';
import { isZeroIfMissingSummaryKey } from './missingPolicy.ts';
import type { SavedPayrollSummary } from '../storage/payrollStore.ts';
import type { MonthEstimate } from './annualForecast.ts';
export type SummaryKey = 'gross' | 'net' | 'taxable' | 'nonTaxable' | 'incomeTax' | 'residentTax' | 'socialInsurance' | 'transportation' | 'reimbursedExpenses' | 'workDays';
export interface Summary {
  sums: Record<SummaryKey, number>;
  observed: Record<SummaryKey, boolean>;
  partial: Record<SummaryKey, boolean>;
  /** 欠損している明細の件数。複数の社会保険項目が空欄でも1明細につき1件。 */
  missingCounts: Record<SummaryKey, number>;
}
const KEYS: SummaryKey[] = ['gross', 'net', 'taxable', 'nonTaxable', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses', 'workDays'];
const zeros = (): Record<SummaryKey, number> => Object.fromEntries(KEYS.map(k => [k, 0])) as Record<SummaryKey, number>;
export function summary(records: readonly SavedPayrollSummary[]): Summary {
  const sums = zeros();
  const observed = Object.fromEntries(KEYS.map(k => [k, false])) as Record<SummaryKey, boolean>;
  const missingCounts = zeros();
  for (const { form } of records) {
    const absent = new Set<SummaryKey>();
    const zeroBonus = form.kind === 'bonus' && amountOrMissing(form.gross) === 0 && amountOrMissing(form.net) === 0;
    const valueFor = (key: string): string | undefined =>
      ((zeroBonus || form.kind === 'bonus' && (key === 'transportation' || key === 'reimbursedExpenses'))
        && amountOrMissing(form[key]) === null) ? '0' : form[key];
    const add = (key: SummaryKey, raw: string | undefined): void => {
      const parsed = amountOrMissing(raw);
      if (parsed === null && !isZeroIfMissingSummaryKey(key)) { absent.add(key); return; }
      // 住民税・立替経費・社会保険料は、未掲載／未取得なら0円とする。
      // PDF原本や保存されたフォーム値は変更しない。
      observed[key] = true;
      sums[key] += parsed ?? 0;
    };
    for (const key of ['gross', 'net', 'residentTax', 'transportation', 'reimbursedExpenses'] as const) add(key, valueFor(key));
    // 課税・非課税の未取得は、0円の賞与でも暗黙に0円へ変換しない。
    add('taxable', form.taxable);
    add('nonTaxable', form.nonTaxable);
    add('incomeTax', valueFor('incomeTax'));
    const yearEnd = amountOrMissing(form.yearEndAdjustment);
    if (yearEnd !== null) {
      sums.incomeTax += yearEnd;
      observed.incomeTax = true;
      if (amountOrMissing(form.incomeTax) === null && !zeroBonus) absent.add('incomeTax');
    }
    if (form.kind === 'salary') add('workDays', form.workDays);
    for (const key of ['healthInsurance', 'careInsurance', 'childcareSupport', 'pension', 'employmentInsurance']) {
      add('socialInsurance', valueFor(key));
    }
    for (const key of absent) missingCounts[key]++;
  }
  return { sums, observed, missingCounts, partial: Object.fromEntries(KEYS.map(key => [key, missingCounts[key] > 0])) as Record<SummaryKey, boolean> };
}
/** 見込み額の欠損も1見込み月につき1件として数える。 */
export function withEstimates(actual: Summary, estimates: readonly MonthEstimate[]): Summary {
  const sums = { ...actual.sums };
  const observed = { ...actual.observed };
  const missingCounts = { ...actual.missingCounts };
  for (const estimate of estimates) {
    for (const key of KEYS) {
      const missingIsZero = isZeroIfMissingSummaryKey(key);
      const value = estimate.values[key] ?? (missingIsZero ? 0 : null);
      if (!missingIsZero && (value === null || estimate.incomplete[key])) missingCounts[key]++;
      if (value === null) continue;
      sums[key] += value;
      observed[key] = true;
    }
  }
  return { sums, observed, missingCounts, partial: Object.fromEntries(KEYS.map(key => [key, missingCounts[key] > 0])) as Record<SummaryKey, boolean> };
}
