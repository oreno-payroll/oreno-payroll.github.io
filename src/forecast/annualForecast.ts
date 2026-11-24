/**
 * ホーム画面専用の年度見込み。保存済みフォームを読み取り、結果だけを返す純粋関数。
 * IndexedDBへの書き込み、PDF生成、追加の給与レコード作成は行わない。
 */
import { amountOrMissing } from '../storage/payrollValidation.ts';
import { isZeroIfMissingSummaryKey } from './missingPolicy.ts';
import { monthIndex, targetMonthOf, salaryPaymentLag, monthStringFromIndex } from './payrollCalendar.ts';
import {activeEmployerSalaries} from './activeEmployer.ts';

export type ForecastJob = 'main' | 'side';
export type ForecastKind = 'salary' | 'bonus';
export type ForecastKey = 'gross' | 'net' | 'incomeTax' | 'residentTax' | 'socialInsurance' | 'transportation' | 'reimbursedExpenses' | 'workDays';
export const FORECAST_KEYS: readonly ForecastKey[] = [
  'gross', 'net', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses', 'workDays',
];
const SOCIAL_KEYS = [
  'healthInsurance', 'careInsurance', 'childcareSupport', 'pension', 'employmentInsurance',
] as const;

export interface ForecastSource { form: Record<string, string>; employerId?: string }
export interface MonthEstimate {
  /** 推計対象年月 (YYYY-MM)。年度見込みは給与対象月、暦年見込みは支給月。 */
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
  /** 賞与見込みの参照元：直近登録済み通常給与の支給年月。 */
  bonusSampleMonth?: string;
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
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}
function fieldValue(form: Record<string, string>, key: ForecastKey): { value: number | null; incomplete: boolean } {
  if (key === 'socialInsurance') {
    // 社会保険各項目の記載がなければ0円。存在する内訳は従来どおり足す。
    const value = SOCIAL_KEYS.reduce((sum, part) => sum + (amountOrMissing(form[part]) ?? 0), 0);
    return { value, incomplete: false };
  }
  const value = amountOrMissing(form[key]);
  return { value: value ?? (isZeroIfMissingSummaryKey(key) ? 0 : null), incomplete: false };
}
export function estimateFromSamples(job: ForecastJob, month: string, samples: ForecastSource[]): MonthEstimate {
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
 * 給与明細の課税支給額（PDF解析時に基本給＋固定残業代で検算）を参照する。
 * 交通費・立替経費が分かる場合は総支給からその合計を除外して照合し、
 * 手取りからも同額を除外する。
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
  // 交通費・立替経費が不明な月の総支給を、そのまま賞与額面にはしない。
  // 多めの賞与見込みを出す危険があるため、判定できない場合は予測を見送る。
  return { gross: null, net: null, incomplete: true };
}
/**
 * 本業の未登録賞与は、支給済みの最新「通常給与」1件だけを基準にする。
 * 8月に実績として存在する業績給はその明細の実績にのみ含め、
 * 将来の2月賞与や未登録8月賞与へ業績給を横展開しない。
 * 保存フォームは基本給/固定残業代を個別保持していないため、
 * 解析済みの課税支給額、または総支給-交通費-立替経費を用いる。
 */
export function estimateMainBonus(month: string, samples: ForecastSource[]): MonthEstimate | null {
  const latest = [...samples].sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate))[0];
  if (!latest) return null;
  const adjusted = transportExcludedSalary(latest.form);
  if (adjusted.gross === null || adjusted.net === null) return null;
  const values = {} as Record<ForecastKey, number | null>;
  const incomplete: Partial<Record<ForecastKey, boolean>> = {};
  for (const key of FORECAST_KEYS) {
    if (key === 'gross') {
      values[key] = adjusted.gross;
      if (adjusted.incomplete) incomplete[key] = true;
    } else if (key === 'net') {
      values[key] = adjusted.net;
      if (adjusted.incomplete) incomplete[key] = true;
    } else if (key === 'transportation' || key === 'reimbursedExpenses' || key === 'workDays') {
      values[key] = 0;
    } else {
      // 控除も同じ月給1件だけから参考推計。年末調整の一時的な還付/追徴は含めない。
      const part = fieldValue(latest.form, key);
      values[key] = part.value;
      if (part.value === null || part.incomplete) incomplete[key] = true;
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
    const allSalaries = records.filter(({ form }) => form.job === job && form.kind === 'salary');
    const paidMonths = new Set(allSalaries.map(({ form }) => targetMonthOf(form)).filter((month): month is string => month !== null));
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const salaries=activeEmployerSalaries(allSalaries,todayIso);
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
        const month = monthStringFromIndex(i);
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
    // 給与の通常月見込みは「直近6か月・最大3件」。賞与だけは最後の登録済み通常給与1件を使う。
    // 賞与見込みが古い給与からでも算出できるよう、通常月見込みのサンプルとは独立させる。
    const latestBonusSalary = job === 'main' ? salaries
      .filter(({ form }) => form.paymentDate <= todayIso)
      .sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate))[0] : undefined;
    const bonusSampleMonth = latestBonusSalary?.form.paymentDate?.slice(0, 7);
    const bonusEstimates = job === 'main' && pendingBonusMonths.length && latestBonusSalary
      ? pendingBonusMonths.flatMap(month => {
        const estimate = estimateMainBonus(month, [latestBonusSalary]);
        return estimate ? [estimate] : [];
      }) : [];
    const bonusReason = job === 'main' && applicable && includeBonus && pendingBonusMonths.length && !bonusEstimates.length
      ? '本業賞与の参考になる通常給与の内訳が不足しているため、見込み賞与を算出できません。' : undefined;

    jobs[job] = { job, sampleMonths, pendingMonths, estimates, bonusEstimates, pendingBonusMonths,
      ...(bonusSampleMonth ? { bonusSampleMonth } : {}),
      ...(reason ? { reason } : {}), ...(bonusReason ? { bonusReason } : {}) };
  }
  return { fiscalYear: selectedYear, applicable, jobs, estimates: [
    ...jobs.main.estimates, ...jobs.side.estimates, ...jobs.main.bonusEstimates,
  ] };
}
