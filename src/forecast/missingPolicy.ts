/**
 * 明細に項目がなくても、ダッシュボードでは0円として集計する項目。
 * 社会保険料は健康・介護・支援金・厚生年金・雇用保険の合算値。
 * これは表示・見込み計算に限る規則で、原本PDFや保存済みフォームは書き換えない。
 */
export const ZERO_IF_MISSING_SUMMARY_KEYS = [
  'residentTax', 'reimbursedExpenses', 'socialInsurance',
] as const;
const zeroIfMissing = new Set<string>(ZERO_IF_MISSING_SUMMARY_KEYS);

export function isZeroIfMissingSummaryKey(key: string): boolean {
  return zeroIfMissing.has(key);
}
