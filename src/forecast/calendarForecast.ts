/**
 * 暦年（1〜12月・支給日基準）の見込み。
 * 現在の暦年について、勤務先別の最後の給与支給月の翌月と現在月の遅い方から12月まで推計する。
 * 現在月より前の未登録支給月には見込みを遡及加算しない。
 * 保存レコードの追加・更新は一切行わない。
 */
import { monthIndex,monthStringFromIndex } from './payrollCalendar';
import {activeEmployerSalaries} from './activeEmployer.ts';
import {
  estimateFromSamples, estimateMainBonus,
  type AnnualForecast, type ForecastJob, type ForecastSource, type JobForecast,
} from './annualForecast';

const PAYMENT_DATE = /^(\d{4})-(0[1-9]|1[0-2])-([0-3]\d)$/;

export function calendarYearOfPaymentDate(paymentDate: string | undefined): number | null {
  const match = PAYMENT_DATE.exec(paymentDate ?? '');
  return match ? Number(match[1]) : null;
}

/** 年度見込みと同じ表示形式を使用するが、monthは「支給年月」を表す。 */
export interface CalendarForecast extends Omit<AnnualForecast, 'fiscalYear'> {
  calendarYear: number;
}


export function calculateCalendarForecast(
  records: readonly ForecastSource[], selectedYear: number, today: Date, includeBonus = true,
): CalendarForecast {
  const applicable = selectedYear === today.getFullYear();
  const start = selectedYear * 12;
  const end = start + 11;
  const todayMonth = today.getFullYear() * 12 + today.getMonth();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const jobs = {} as Record<ForecastJob, JobForecast>;

  for (const job of ['main', 'side'] as const) {
    const allSalaries = records.filter(({ form }) => form.job === job && form.kind === 'salary');
    const salaries=activeEmployerSalaries(allSalaries,todayIso);
    const actualPaidMonths = new Set(allSalaries.flatMap(({ form }) => {
      const index = monthIndex(form.paymentDate?.slice(0, 7));
      return calendarYearOfPaymentDate(form.paymentDate) === selectedYear && index !== null ? [index] : [];
    }));
    // 将来日付の保存済み明細も「実績あり」として二重計上しない。
    const latest = actualPaidMonths.size ? Math.max(...actualPaidMonths) : start - 1;
    const pendingMonths: string[] = [];
    if (applicable) {
      // 登録漏れの過去月を推計収入で埋めず、当月以降だけを対象にする。
      for (let index = Math.max(start, latest + 1, todayMonth); index <= end; index++) {
        if (!actualPaidMonths.has(index)) pendingMonths.push(monthStringFromIndex(index));
      }
    }

    // 直近6か月、支給済みの通常給与から最大3件。賞与・年調還付はサンプルに含めない。
    const uniqueMonths = new Set<string>();
    const samples = salaries
      .filter(({ form }) => {
        const paid = monthIndex(form.paymentDate?.slice(0, 7));
        return paid !== null && paid >= todayMonth - 5 && paid <= todayMonth &&
          calendarYearOfPaymentDate(form.paymentDate) !== null && form.paymentDate <= todayIso;
      })
      .sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate))
      .filter(({ form }) => {
        const month = form.paymentDate.slice(0, 7);
        if (uniqueMonths.has(month)) return false;
        uniqueMonths.add(month);
        return true;
      }).slice(0, 3);
    const sampleMonths = samples.map(({ form }) => form.paymentDate.slice(0, 7));
    const estimates = applicable && samples.length
      ? pendingMonths.map(month => estimateFromSamples(job, month, samples)) : [];
    const reason = !applicable ? '現在進行中の暦年以外は予測しません。'
      : !pendingMonths.length ? '12月までの未登録支給月はありません。'
      : !samples.length ? '直近6か月の支給済み給与がなく、見込みを計算できません。'
      : undefined;

    const actualBonusMonths = new Set(records.filter(({ form }) => form.job === 'main' && form.kind === 'bonus')
      .flatMap(({ form }) => calendarYearOfPaymentDate(form.paymentDate) === selectedYear
        ? [form.paymentDate.slice(0, 7)] : []));
    const bonusCandidates = [`${selectedYear}-02`, `${selectedYear}-08`];
    // 年内の未登録賞与は、通常給与の最終支給月より前でも補完する。
    // 例: 10月給与まで登録されていて8月賞与が未登録なら、8月賞与は実績ではなく見込みとして加算。
    const pendingBonusMonths = job === 'main' && applicable && includeBonus
      ? bonusCandidates.filter(month => !actualBonusMonths.has(month)) : [];
    // 賞与だけは通常月の直近6か月制限をかけず、最後の登録済み通常給与1件を参照。
    const latestBonusSalary = job === 'main' ? salaries
      .filter(({ form }) => form.paymentDate <= todayIso)
      .sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate))[0] : undefined;
    const bonusSampleMonth = latestBonusSalary?.form.paymentDate?.slice(0, 7);
    const bonusEstimates = job === 'main' && latestBonusSalary
      ? pendingBonusMonths.flatMap(month => {
        const estimate = estimateMainBonus(month, [latestBonusSalary]);
        return estimate ? [estimate] : [];
      }) : [];
    const bonusReason = job === 'main' && pendingBonusMonths.length && !bonusEstimates.length
      ? '本業賞与の参考になる通常給与の内訳が不足しているため、見込み賞与を算出できません。' : undefined;
    jobs[job] = { job, sampleMonths, pendingMonths, estimates, bonusEstimates, pendingBonusMonths,
      ...(bonusSampleMonth ? { bonusSampleMonth } : {}),
      ...(reason ? { reason } : {}), ...(bonusReason ? { bonusReason } : {}) };
  }
  return { calendarYear: selectedYear, applicable, jobs,
    estimates: [...jobs.main.estimates, ...jobs.side.estimates, ...jobs.main.bonusEstimates] };
}
