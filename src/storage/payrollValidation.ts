/** アップロード・編集・ZIP復元で共通の明細スキーマ／金額検算。空欄と0円は区別する。 */
export const PAYROLL_FIELDS = [
  'job', 'kind', 'targetMonth', 'paymentDate', 'gross', 'net',
  'taxable', 'nonTaxable', 'transportation', 'reimbursedExpenses', 'workDays', 'incomeTax',
  'residentTax', 'healthInsurance', 'careInsurance', 'childcareSupport',
  'pension', 'employmentInsurance', 'otherDeductions', 'yearEndAdjustment', 'bonusBase', 'performanceBonus',
] as const;
export type PayrollFieldKey = typeof PAYROLL_FIELDS[number];
export type PayrollForm = Record<string, string>;
export const DEDUCTION_KEYS = [
  'incomeTax', 'yearEndAdjustment', 'residentTax', 'healthInsurance', 'careInsurance',
  'childcareSupport', 'pension', 'employmentInsurance', 'otherDeductions',
] as const;
const NONNEGATIVE_KEYS = [
  'gross', 'net', 'taxable', 'nonTaxable', 'transportation', 'reimbursedExpenses',
  'bonusBase', 'performanceBonus',
] as const;

/** 明細種別を切り替えても入力途中の画面値は維持する。
 * 検証・永続化では、その種別で表示しない項目を必ず空欄にする。
 * 既存保存レコードの書き換えやIndexedDBの構造変更は行わない。
 */
export function applicablePayrollForm<T extends PayrollForm>(form: T): T {
  const copy = { ...form };
  const inactive: readonly PayrollFieldKey[] = form.kind === 'bonus'
    ? ['reimbursedExpenses', 'workDays', 'yearEndAdjustment']
    : form.kind === 'salary' ? ['bonusBase', 'performanceBonus'] : [];
  for (const key of inactive) copy[key as keyof T] = '' as T[keyof T];
  return copy;
}

export interface FormValidation { errors: string[]; warnings: string[] }

function validDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  if (y < 1900 || y > 9999) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}
export function normalizeWorkDays(value: string): string {
  if (value.trim() === '') return '';
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && Number.isSafeInteger(Math.ceil(n)) ? String(Math.ceil(n)) : value;
}
export function amountOrMissing(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function validatePayrollForm(input: PayrollForm): FormValidation {
  const form = applicablePayrollForm(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (form.job !== 'main' && form.job !== 'side') errors.push('勤務先を選択してください。');
  if (form.kind !== 'salary' && form.kind !== 'bonus') errors.push('明細種別を選択してください。');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.targetMonth ?? '')) errors.push('対象年月が不正です。');
  if (!validDate(form.paymentDate ?? '')) errors.push('支給日が不正です。');
  const allowed = new Set<string>(PAYROLL_FIELDS);
  for (const [key, raw] of Object.entries(form)) {
    if (!allowed.has(key)) { errors.push(`不明な入力項目があります: ${key}`); continue; }
    if (['job', 'kind', 'targetMonth', 'paymentDate'].includes(key)) continue;
    if (typeof raw !== 'string') { errors.push(`${key}の形式が不正です。`); continue; }
    if (raw.trim() === '') {
      if (key === 'gross' || key === 'net') errors.push(`${key === 'gross' ? '総支給額' : '手取り'}は必須です。`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || (key === 'workDays' ? !Number.isSafeInteger(Math.ceil(n)) : !Number.isSafeInteger(n)) ||
      (key === 'workDays' && n < 0) || NONNEGATIVE_KEYS.some(k => k === key) && n < 0) {
      errors.push(`${key}の金額または日数が不正です。`);
    }
  }
  for (const key of ['gross', 'net'] as const) {
    if (!Object.hasOwn(form, key)) errors.push(`${key}がありません。`);
  }
  if (errors.length) return { errors, warnings };
  const gross = amountOrMissing(form.gross)!;
  const net = amountOrMissing(form.net)!;
  const deductions = DEDUCTION_KEYS.reduce((sum, key) => sum + (amountOrMissing(form[key]) ?? 0), 0);
  if (!Number.isSafeInteger(deductions) || !Number.isSafeInteger(gross - net)) errors.push('金額の合計が扱える範囲を超えています。');
  else if (gross - deductions !== net) {
    warnings.push(`手取りの検算が一致しません（総支給額 ${gross.toLocaleString('ja-JP')}円 − 入力済み控除 ${deductions.toLocaleString('ja-JP')}円 ≠ 手取り ${net.toLocaleString('ja-JP')}円）。未入力の控除や原本を確認してください。`);
  }
  const taxable = amountOrMissing(form.taxable);
  const nonTaxable = amountOrMissing(form.nonTaxable);
  if (taxable !== null && nonTaxable !== null && taxable + nonTaxable !== gross) {
    warnings.push('課税支給額と非課税支給額の合計が総支給額と一致しません。');
  }
  if (taxable !== null && taxable > gross) warnings.push('課税支給額が総支給額を上回っています。原本を確認してください。');
  const transportation = amountOrMissing(form.transportation);
  const expenses = amountOrMissing(form.reimbursedExpenses);
  if (nonTaxable !== null && transportation !== null && expenses !== null && transportation + expenses > nonTaxable) {
    warnings.push('交通費と立替経費の合計が非課税支給額を上回っています。');
  }
  if (form.kind === 'bonus') {
    const base = amountOrMissing(form.bonusBase);
    const performance = amountOrMissing(form.performanceBonus);
    if (base !== null && performance !== null && base + performance > gross) {
      warnings.push('賞与手当と業績手当の合計が総支給額を上回っています。');
    }
  }
  // 払い日のズレは賞与・遡及支給もあるためエラーにせず、確認事項にする。
  const month = /^([0-9]{4})-([0-9]{2})$/.exec(form.targetMonth ?? '');
  const paymentDate = new Date(`${form.paymentDate}T00:00:00Z`);
  if (month && Number.isFinite(paymentDate.getTime())) {
    const monthGap = (paymentDate.getUTCFullYear() - Number(month[1])) * 12 + paymentDate.getUTCMonth() + 1 - Number(month[2]);
    if (Math.abs(monthGap) > 12) warnings.push('給与対象年月と支給日が1年以上離れています。対象月の入力をご確認ください。');
    const now = new Date();
    if (paymentDate.getTime() > Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 18, 1))
      warnings.push('支給日が現在から1年半以上先の日付です。');
    if (paymentDate.getTime() < Date.UTC(now.getUTCFullYear() - 30, now.getUTCMonth(), 1))
      warnings.push('支給日が30年以上前です。入力誤りでないか確認してください。');
  }
  return { errors, warnings };
}

/** 1つの勤務先・種類・対象月につき1件を標準とする。賞与の同月複数回も確認が必要。 */
export function payrollPeriodKey(form: PayrollForm): string {
  return `${form.job ?? ''}|${form.kind ?? ''}|${form.targetMonth ?? ''}`;
}
