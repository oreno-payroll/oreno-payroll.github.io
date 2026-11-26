/**
 * ホーム画面専用の年度見込み。保存済みフォームを読み取り、結果だけを返す純粋関数。
 * IndexedDBへの書き込み、PDF生成、追加の給与レコード作成は行わない。
 */
import { amountOrMissing } from '../storage/payrollValidation.ts';
import { isZeroIfMissingSummaryKey } from './missingPolicy.ts';
import { monthIndex, targetMonthOf, salaryPaymentLag, monthStringFromIndex } from './payrollCalendar.ts';
import {forecastEmployerScope,type ForecastEmployerSetting} from './activeEmployer.ts';
import {defaultEmployerForecast,type SalaryForecastMethod} from '../storage/employerForecast.ts';

export type ForecastJob = 'main' | 'side';
export type ForecastKind = 'salary' | 'bonus';
export type ForecastKey = 'gross' | 'net' | 'taxable' | 'nonTaxable' | 'incomeTax' | 'residentTax' | 'socialInsurance' | 'transportation' | 'reimbursedExpenses' | 'workDays';
export const FORECAST_KEYS: readonly ForecastKey[] = [
  'gross', 'net', 'taxable', 'nonTaxable', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses', 'workDays',
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
  /** 勤務先ごとの未登録賞与の参考推計。 */
  bonusEstimates: MonthEstimate[];
  pendingBonusMonths: string[];
  /** 賞与見込みの参照元：直近登録済み通常給与の支給年月。 */
  bonusSampleMonth?: string;
  bonusReason?: string;
  reason?: string;
  employerName?: string;
  salaryMethod:SalaryForecastMethod;
  bonusMonths:number[];
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
export function estimateFromSamples(job: ForecastJob, month: string, samples: ForecastSource[], method:Exclude<SalaryForecastMethod,'none'>='median'): MonthEstimate {
  if(method==='latest')samples=[...samples].sort((a,b)=>b.form.paymentDate.localeCompare(a.form.paymentDate)).slice(0,1);
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
      if (key === 'nonTaxable' && part.value !== null) {
        // 経費の非課税区分を明細内訳で確認できる場合だけ、見込みから除く。
        const expenses = amountOrMissing(form.reimbursedExpenses) ?? 0;
        const taxable = amountOrMissing(form.taxable);
        const gross = amountOrMissing(form.gross);
        if (expenses > 0 && (part.value < expenses || taxable === null || gross === null || taxable + part.value !== gross))
          return {value:null,incomplete:true};
        return {...part,value:part.value-expenses};
      }
      return part;
    });
    const known=parts.flatMap(part=>part.value===null?[]:[part.value]);
    values[key] = method==='average'&&known.length ? Math.round(known.reduce((sum,v)=>sum+v,0)/known.length) : median(known);
    if (parts.some(part => part.value === null || part.incomplete)) incomplete[key] = true;
  }
  return { month, job, kind: 'salary', values, incomplete };
}

/**
 * 賞与額は勤務先の通常給与の「交通費・立替経費を除いた月額」をベースにする。
 * 保存フォームには基本給・固定残業手当が個別に残らないため、
 * 給与明細の課税支給額（PDF解析時に基本給＋固定残業代で検算）を参照する。
 * 交通費・立替経費が分かる場合は総支給からその合計を除外して照合し、
 * 手取りからも同額を除外する。
 * 交通費が記載されない月は、総支給額=課税支給額なら交通費ゼロとみなす。
 * 金額を識別できない場合は見込みを算出しない。
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
 * 未登録賞与は、支給済みの最新「通常給与」1件だけを基準にする。
 * 8月に実績として存在する業績給はその明細の実績にのみ含め、
 * 将来の2月賞与や未登録8月賞与へ業績給を横展開しない。
 * 保存フォームは基本給/固定残業代を個別保持していないため、
 * 解析済みの課税支給額、または総支給-交通費-立替経費を用いる。
 */
export function estimateBonus(job:ForecastJob,month: string, samples: ForecastSource[]): MonthEstimate | null {
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
    } else if (key === 'taxable' || key === 'nonTaxable') {
      // 賞与モデルは交通費・経費を除く。課税内訳に根拠がある場合だけ推計する。
      const taxable = amountOrMissing(latest.form.taxable);
      const known = !adjusted.incomplete && taxable !== null && taxable === adjusted.gross;
      values[key] = known ? (key === 'taxable' ? adjusted.gross : 0) : null;
      if (!known) incomplete[key] = true;
    } else if (key === 'transportation' || key === 'reimbursedExpenses' || key === 'workDays') {
      values[key] = 0;
    } else {
      // 控除も同じ月給1件だけから参考推計。年末調整の一時的な還付/追徴は含めない。
      const part = fieldValue(latest.form, key);
      values[key] = part.value;
      if (part.value === null || part.incomplete) incomplete[key] = true;
    }
  }
  return { month, job, kind: 'bonus', values, incomplete };
}
/** Existing callers/tests of the original main-employer model. */
export function estimateMainBonus(month:string,samples:ForecastSource[]):MonthEstimate|null {
 return estimateBonus('main',month,samples);
}

/** Calculate bonus schedules in the selected period. For a registered current employer,
 * compare payment months (including unassigned legacy actuals), never fill earlier months.
 * Role-only legacy records retain the original historical bonus behavior and annual target-month check.
 */
export function pendingForecastBonusMonths(records:readonly ForecastSource[],job:ForecastJob,scope:{current?:ForecastEmployerSetting;inactive:boolean},months:readonly number[],start:number,end:number,todayIso:string,applicable:boolean,includeBonus:boolean,fiscal:boolean):string[]{
 if(!applicable||!includeBonus||scope.inactive||!months.length)return [];
 const registered=records.filter(r=>r.form.job===job&&r.form.kind==='bonus'&&(!scope.current||r.employerId===scope.current.id||r.employerId===undefined));
 const paid=new Set(registered.flatMap(({form})=>{
  const payment=form.paymentDate?.slice(0,7);
  // Keep the exact legacy annual target-month rule when no directory is registered.
  return fiscal&&!scope.current?[targetMonthOf(form)]:[payment];
 }));
 const candidates:string[]=[];
 for(let i=start;i<=end;i++){
  const month=monthStringFromIndex(i);
  if(months.includes(i%12+1)&&!paid.has(month)&&(!scope.current||month>=todayIso.slice(0,7)))candidates.push(month);
 }
 return candidates;
}
/** 現在年度の未登録対象月のみ給与見込みを計算。勤務先別の賞与予定月は同月の支給予定として扱う。 */
export function calculateAnnualForecast(
  records: readonly ForecastSource[], selectedYear: number, today: Date, includeBonus = true, directory:readonly ForecastEmployerSetting[] = [],
): AnnualForecast {
  const currentMonth = today.getFullYear() * 12 + today.getMonth();
  const currentFiscalYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const applicable = selectedYear === currentFiscalYear;
  const fiscalStart = selectedYear * 12 + 3; // 4月
  const fiscalEnd = (selectedYear + 1) * 12 + 2; // 翌3月
  const jobs = {} as Record<ForecastJob, JobForecast>;
  for (const job of ['main', 'side'] as const) {
    const allSalaries = records.filter(({ form }) => form.job === job && form.kind === 'salary');
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const scope=forecastEmployerScope(allSalaries,job,todayIso,directory);
    const salaries=scope.samples;
    const {salaryMethod,bonusMonths}=scope.current?.forecast??defaultEmployerForecast(job);
    const paidMonths = new Set(scope.registered.map(({ form }) => targetMonthOf(form)).filter((month): month is string => month !== null));
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
    const eligibleSamples = salaries
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
    const samples=salaryMethod==='none'?[]:salaryMethod==='latest'?eligibleSamples.slice(0,1):eligibleSamples;
    const sampleMonths = samples.map(({ form }) => targetMonthOf(form)!);
    const estimates = applicable && salaryMethod!=='none' && samples.length
      ? pendingMonths.map(month => estimateFromSamples(job, month, samples,salaryMethod)) : [];
    const reason = !applicable ? '現在進行中の年度以外は予測しません。'
      : scope.inactive ? '現在の勤務先が未設定のため、見込みを計算しません。'
      : salaryMethod==='none' ? '給与見込みを算出しない設定です。'
      : scope.current&&!samples.length ? '現在の勤務先の直近6か月の給与実績がなく、見込みを計算できません。'
      : !pendingMonths.length ? '見込み対象の未登録月はありません。'
      : !samples.length ? '直近6か月に通常給与の実績がなく、予測できません。'
      : undefined;

    const pendingBonusMonths=pendingForecastBonusMonths(records,job,scope,bonusMonths,fiscalStart,fiscalEnd,todayIso,applicable,includeBonus,true);
    // 賞与は給与見込みの設定・サンプル期間と独立して、最後の支給済み通常給与を参照する。
    const latestBonusSalary = pendingBonusMonths.length ? [...salaries].sort((a,b)=>b.form.paymentDate.localeCompare(a.form.paymentDate))[0] : undefined;
    const bonusSampleMonth = latestBonusSalary?.form.paymentDate?.slice(0,7);
    const bonusEstimates = latestBonusSalary ? pendingBonusMonths.flatMap(month=>{
      const estimate=estimateBonus(job,month,[latestBonusSalary]);return estimate?[estimate]:[];
    }):[];
    const bonusReason = scope.inactive ? '現在の勤務先が未設定のため、見込みを計算しません。'
      : !bonusMonths.length ? '賞与見込みを算出しない設定です。'
      : pendingBonusMonths.length&&!bonusEstimates.length ? '賞与の参考になる通常給与の内訳が不足しているため、見込み賞与を算出できません。' : undefined;

    jobs[job] = { job, salaryMethod,bonusMonths, sampleMonths, pendingMonths, estimates, bonusEstimates, pendingBonusMonths,
      ...(scope.current ? {employerName:scope.current.name} : {}),
      ...(bonusSampleMonth ? { bonusSampleMonth } : {}),
      ...(reason ? { reason } : {}), ...(bonusReason ? { bonusReason } : {}) };
  }
  return { fiscalYear: selectedYear, applicable, jobs, estimates: [
    ...jobs.main.estimates, ...jobs.side.estimates, ...jobs.main.bonusEstimates, ...jobs.side.bonusEstimates,
  ] };
}
