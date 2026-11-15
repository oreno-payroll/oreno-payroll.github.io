/** 本業は元名のまま。副業は支給月を基準に統一し、賞与は給与と区別する。PDFの内容は変更しない。 */
export function storedPdfName(job: string, kind: string, paymentDate: string, originalName: string): string {
  if (job !== 'side') return originalName;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return originalName;
  const ym = paymentDate.slice(0, 7).replace('-', '');
  return `${ym}_${kind === 'bonus' ? '賞与明細' : '給与明細'}.pdf`;
}


/**
 * PDFを閲覧・ダウンロード・ZIP出力する際だけ、OSやURLで危険な名前を整える。
 * 保存済みの原本名やPDFのバイト列は変更しない。
 */
export function safePdfFileName(
  original: string,
  options: { fallbackStem?: string; maxStemLength?: number } = {},
): string {
  const fallback = options.fallbackStem ?? '給与明細';
  const cleaned = original.replace(/[\/\\\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  let stem = cleaned.replace(/\.pdf$/i, '').replace(/[. ]+$/g, '');
  if (!stem) stem = fallback;
  if (options.maxStemLength !== undefined) {
    const maximum = Math.max(1, Math.floor(options.maxStemLength));
    stem = stem.slice(0, maximum).replace(/[. ]+$/g, '') || fallback;
  }
  return `${stem}.pdf`;
}
