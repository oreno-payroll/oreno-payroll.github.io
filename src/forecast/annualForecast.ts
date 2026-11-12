/**
 * ホーム画面専用の年度見込み。保存済みフォームを読み取り、結果だけを返す純粋関数。
 * IndexedDBへの書き込み、PDF生成、追加の給与レコード作成は行わない。
 */
import { amountOrMissing } from '../storage/payrollValidation';
import { monthIndex, targetMonthOf, salaryPaymentLag } from './payrollCalendar';

export type ForecastJob = 'main' | 'side';
export type ForecastKind = 'salary' | 'bonus';
export type ForecastKey = 'gross' | 'net' | 'incomeTax' | 'residentTax' | 'socialInsurance' | 'transportation' | 'reimbursedExpenses' | 'workDays';
export const FORECAST_KEYS: readonly ForecastKey[] = [
  'gross', 'net', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses', 'workDays',
];
const SOCIAL_KEYS = [
  'healthInsurance', 'careInsurance', 'childcareSupport', 'pension', 'employmentInsurance',
] as const;

export interface ForecastSource { form: Record<string, string> }
export interface MonthEstimate {
  /** 給与対象年月 (YYYY-MM)。賞与は支給月と同じ年月。 */
  month: string;
  job: ForecastJob;
  kind: ForecastKind;
  values: Record<ForecastKey, number | null>;
  /** サンプルの控除内訳等が未入力の場合は「部分的な推計」として表示する。 */
  incomplete: Partial<Record<ForecastKey, boolean>>;
}
export interface JobForecast {
  job: ForecastJob;
  sampleMonths: string[];
  pendingMonths: string[];
  /** 月給の推計だけ。 */
  estimates: MonthEstimate[];
  /** 本業だけ。既存賞与がある8月・2月は作らない。 */
  bonusEstimates: MonthEstimate[];
  pendingBonusMonths: string[];
  bonusReason?: string;
  reason?: string;
}
export interface AnnualForecast {
  fiscalYear: number;
  applicable: boolean;
  jobs: Record<ForecastJob, JobForecast>;
  /** ホームで加算するすべての推計。保存データには含まない。 */
  estimates: MonthEstimate[];
}
function monthString(index: number): string {
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}
function fieldValue(form: Record<string, string>, key: ForecastKey): { value: number | null; incomplete: boolean } {
  if (key === 'socialInsurance') {
    const parts = SOCIAL_KEYS.map(part => amountOrMissing(form[part]));
    if (parts.every(value => value === null)) return { value: null, incomplete: true };
    return { value: parts.reduce<number>((sum, value) => sum + (value ?? 0), 0), incomplete: parts.some(value => value === null) };
  }
  return { value: amountOrMissing(form[key]), incomplete: false };
}
function estimateFromSamples(job: ForecastJob, month: string, samples: ForecastSource[]): MonthEstimate {
  const values = {} as Record<ForecastKey, number | null>;
  const incomplete: Partial<Record<ForecastKey, boolean>> = {};
  for (const key of FORECAST_KEYS) {
    if (key === 'reimbursedExpenses') {
      // 経費精算は将来も支給されると仮定しない。
      values[key] = 0;
      continue;
    }
    const parts = samples.map(({ form }) => {
      const part = fieldValue(form, key);
      if ((key === 'gross' || key === 'net') && part.value !== null) {
        // 交通費は中央値による見込み対象とするが、経費精算は単発費用として除外する。
        return { ...part, value: part.value - (amountOrMissing(form.reimbursedExpenses) ?? 0) };
      }
      return part;
    });
    values[key] = median(parts.flatMap(part => part.value === null ? [] : [part.value]));
    if (parts.some(part => part.value === null || part.incomplete)) incomplete[key] = true;
  }
  return { month, job, kind: 'salary', values, incomplete };
}

/**
 * 賞与額は本業の通常給与の「交通費・立替経費を除いた月額」をベースにする。
 * 保存フォームには基本給・固定残業手当が個別に残らないため、
 * 課税支給額と非課税支給額が整合するなら課税額を採用し、
 * そうでなければ総支給額-交通費-立替経費を採用する。手取りも同額を除く。
 * 交通費が記載されない月は、総支給額=課税支給額なら交通費ゼロとみなす。
 * どうしても金額が識別できない場合は月給そのものを参考値として採用し、
 * 未確定フラグを付ける（賞与が確実であると断言しない）。
 */
function transportExcludedSalary(form: Record<string, string>): {
  gross: number | null; net: number | null; incomplete: boolean;
} {
  const gross = amountOrMissing(form.gross);
  const net = amountOrMissing(form.net);
  const transport = amountOrMissing(form.transportation);
  const expenses = amountOrMissing(form.reimbursedExpenses);
  const taxable = amountOrMissing(form.taxable);
  const nonTaxable = amountOrMissing(form.nonTaxable);
  if (gross === null || net === null) return { gross: null, net: null, incomplete: true };

  if ((transport !== null || expenses !== null) && (transport ?? 0) >= 0 && (expenses ?? 0) >= 0
      && gross >= (transport ?? 0) + (expenses ?? 0)) {
    const excluded = (transport ?? 0) + (expenses ?? 0);
    const adjustedGross = gross - excluded;
    // 賞与見込みには、交通費だけでなく立替経費も持ち込まない。
    const inconsistent = taxable !== null && taxable !== adjustedGross;
    return { gross: adjustedGross, net: net - excluded, incomplete: inconsistent };
  }
  // 交通費欄が未入力でも、課税/非課税の内訳が揃うなら非課税分を除外。
  if (taxable !== null && nonTaxable !== null && nonTaxable >= 0 && taxable + nonTaxable === gross) {
    return { gross: taxable, net: net - nonTaxable, incomplete: nonTaxable > 0 };
  }
  if (taxable !== null && taxable === gross) {
    return { gross, net, incomplete: false };
  }
  // 交通費の情報が取得できていない場合は、月給をそのまま暫定参考値とする。
  return { gross, net, incomplete: true };
}
function estimateMainBonus(month: string, samples: ForecastSource[]): MonthEstimate | null {
  const adjusted = samples.map(({ form }) => transportExcludedSalary(form));
  const gross = median(adjusted.flatMap(item => item.gross === null ? [] : [item.gross]));
  const net = median(adjusted.flatMap(item => item.net === null ? [] : [item.net]));
  if (gross === null || net === null) return null;
  const values = {} as Record<ForecastKey, number | null>;
  const incomplete: Partial<Record<ForecastKey, boolean>> = {};
  for (const key of FORECAST_KEYS) {
    if (key === 'gross') {
      values[key] = gross;
      if (adjusted.some(item => item.gross === null || item.incomplete)) incomplete[key] = true;
    } else if (key === 'net') {
      values[key] = net;
      if (adjusted.some(item => item.net === null || item.incomplete)) incomplete[key] = true;
    } else if (key === 'transportation' || key === 'reimbursedExpenses' || key === 'workDays') {
      values[key] = 0; // 賞与に通勤費や勤務日数を重ねて計上しない。
    } else {
      // 税額・社会保険料は月給の直近実績から参考値を算出。
      const parts = samples.map(({ form }) => fieldValue(form, key));
      values[key] = median(parts.flatMap(part => part.value === null ? [] : [part.value]));
      if (parts.some(part => part.value === null || part.incomplete)) incomplete[key] = true;
    }
  }
  return { month, job: 'main', kind: 'bonus', values, incomplete };
}

/**
 * 対象は「現在進行中の年度」。給与は支給時差を考慮した未登録の対象月だけ補完し、
 * 本業の賞与だけ8月・翌2月のうち実績がない月を予測する。
 * 過去の賞与が未登録の場合も、年間見込みから漏らさないため推計対象とする。
 * 直近6か月以内の通常給与を、新しい順に最大3対象月採用する。
 * 対象月と支給月のずれは勤務先の通常給与履歴から推定する。
 * 副業の賞与は一切推計しない。賞与表示OFFなら本業の賞与も推計しない。
 */
export function calculateAnnualForecast(
  records: readonly ForecastSource[], selectedYear: number, today: Date, includeBonus = true,
): AnnualForecast {
  const currentMonth = today.getFullYear() * 12 + today.getMonth();
  const currentFiscalYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const applicable = selectedYear === currentFiscalYear;
  const fiscalStart = selectedYear * 12 + 3; // 4月
  const fiscalEnd = (selectedYear + 1) * 12 + 2; // 翌3月
  const jobs = {} as Record<ForecastJob, JobForecast>;
  for (const job of ['main', 'side'] as const) {
    const salaries = records.filter(({ form }) => form.job === job && form.kind === 'salary');
    const paidMonths = new Set(salaries.map(({ form }) => targetMonthOf(form)).filter((month): month is string => month !== null));
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    // 本業は「10月対象→11月支給」、副業は「10月対象→10月支給」など、
    // 保存済み給与から各勤務先の通常の支給タイミングを推定する。
    // 未支給の対象月を見込みから落とさないようにするための補正。
    const recentLags = salaries
      .filter(({ form }) => form.paymentDate <= todayIso)
      .sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate))
      .slice(0, 6)
      .flatMap(({ form }) => {
        const lag = salaryPaymentLag(form);
        return lag === null ? [] : [lag];
      });
    const paymentLag = Math.round(median(recentLags) ?? 0);
    const pendingMonths: string[] = [];
    if (applicable) {
      for (let i = Math.max(fiscalStart, currentMonth - paymentLag); i <= fiscalEnd; i++) {
        const month = monthString(i);
        if (!paidMonths.has(month)) pendingMonths.push(month);
      }
    }
    const seen = new Set<string>();
    const samples = salaries
      .filter(({ form }) => {
        const month = targetMonthOf(form);
        const index = month === null ? null : monthIndex(month);
        return index !== null && index >= currentMonth - 5 && index <= currentMonth && form.paymentDate <= todayIso;
      })
      .sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate))
      .filter(({ form }) => {
        const month = targetMonthOf(form)!;
        if (seen.has(month)) return false;
        seen.add(month);
        return true;
      }).slice(0, 3);
    const sampleMonths = samples.map(({ form }) => targetMonthOf(form)!);
    const estimates = applicable && samples.length
      ? pendingMonths.map(month => estimateFromSamples(job, month, samples)) : [];
    const reason = !applicable ? '現在進行中の年度以外は予測しません。'
      : !pendingMonths.length ? '見込み対象の未登録月はありません。'
      : !samples.length ? '直近6か月に通常給与の実績がなく、予測できません。'
      : undefined;

    const bonusMonths = [`${selectedYear}-08`, `${selectedYear + 1}-02`];
    const paidBonusMonths = new Set(records.filter(({ form }) => form.job === 'main' && form.kind === 'bonus')
      .map(({ form }) => targetMonthOf(form)).filter((month): month is string => month !== null));
    const pendingBonusMonths = job === 'main' && applicable && includeBonus
      ? bonusMonths.filter(month => !paidBonusMonths.has(month)) : [];
    const bonusEstimates = job === 'main' && pendingBonusMonths.length && samples.length
      ? pendingBonusMonths.flatMap(month => {
        const estimate = estimateMainBonus(month, samples);
        return estimate ? [estimate] : [];
      }) : [];
    const bonusReason = job === 'main' && applicable && includeBonus && pendingBonusMonths.length && !bonusEstimates.length
      ? '本業賞与は8月・2月を想定していますが、月給の参照データが不足しています。' : undefined;

    jobs[job] = { job, sampleMonths, pendingMonths, estimates, bonusEstimates, pendingBonusMonths,
      ...(reason ? { reason } : {}), ...(bonusReason ? { bonusReason } : {}) };
  }
  return { fiscalYear: selectedYear, applicable, jobs, estimates: [
    ...jobs.main.estimates, ...jobs.side.estimates, ...jobs.main.bonusEstimates,
  ] };
}
