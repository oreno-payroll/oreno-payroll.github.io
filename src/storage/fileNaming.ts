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

/** 年末調整で登録する原本の表示名は、通常モードの副業と同じ支給年月・種別で採番する。 */
export function yearEndPdfName(kind: string, paymentDate: string, originalName: string): string {
  return storedPdfName('side', kind, paymentDate, originalName);
}

/** 既存UUID名のPDFは表示・ダウンロード時だけ補完し、暗号化済み原本や保存済みJSONを変更しない。 */
export function yearEndVisiblePdfName(kind: string, paymentDate: string, savedName: string): string {
  const uuidName = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:\.pdf)?$/i;
  return uuidName.test(savedName) ? yearEndPdfName(kind, paymentDate, savedName) : savedName;
}

/** 自動名の明細だけ、支給日の訂正と同時に表示名を更新する。独自名は勝手に変えない。 */
export function yearEndUpdatedPdfName(
  oldKind:string,oldPaymentDate:string,savedName:string,newKind:string,newPaymentDate:string,
):string {
  const generated=yearEndPdfName(oldKind,oldPaymentDate,savedName);
  const uuidName=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:\.pdf)?$/i;
  return savedName===generated||uuidName.test(savedName)
    ? yearEndPdfName(newKind,newPaymentDate,savedName)
    : savedName;
}
