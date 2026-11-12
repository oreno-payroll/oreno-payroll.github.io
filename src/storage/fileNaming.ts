/** 本業は元名のまま。副業は支給月を基準に統一し、賞与は給与と区別する。PDFの内容は変更しない。 */
export function storedPdfName(job: string, kind: string, paymentDate: string, originalName: string): string {
  if (job !== 'side') return originalName;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return originalName;
  const ym = paymentDate.slice(0, 7).replace('-', '');
  return `${ym}_${kind === 'bonus' ? '賞与明細' : '給与明細'}.pdf`;
}
