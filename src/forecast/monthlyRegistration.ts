/** 保存済みの通常給与だけを対象に、勤務先別の登録有無を12か月で返す。読み取り専用。 */
export type RegistrationPeriod = 'fiscal' | 'calendar';
export type RegistrationJob = 'main' | 'side';
export interface RegistrationSource {
  form: Record<string, string>;
}
export interface RegistrationMonth {
  key: string;
  year: number;
  month: number;
  main: boolean;
  side: boolean;
}

export function monthlySalaryRegistration(
  records: readonly RegistrationSource[], year: number, mode: RegistrationPeriod,
): RegistrationMonth[] {
  const registered = new Set<string>();
  const firstMonth = mode === 'fiscal' ? 4 : 1;
  const permitted = new Set<string>();
  const months = Array.from({ length: 12 }, (_, offset) => {
    const absoluteMonth = firstMonth - 1 + offset;
    const monthYear = year + Math.floor(absoluteMonth / 12);
    const month = absoluteMonth % 12 + 1;
    const key = `${monthYear}-${String(month).padStart(2, '0')}`;
    permitted.add(key);
    return {key, year: monthYear, month, main: false, side: false};
  });
  for (const {form} of records) {
    if (form.kind !== 'salary' || (form.job !== 'main' && form.job !== 'side')) continue;
    const key = mode === 'fiscal' ? form.targetMonth : form.paymentDate?.slice(0, 7);
    // 暦年は支給日として妥当な YYYY-MM-DD、年度は対象月 YYYY-MM のみ判定。
    if (mode === 'calendar' && !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(form.paymentDate ?? '')) continue;
    if (key && permitted.has(key)) registered.add(`${form.job}:${key}`);
  }
  return months.map(row => ({...row,
    main: registered.has(`main:${row.key}`),
    side: registered.has(`side:${row.key}`),
  }));
}
