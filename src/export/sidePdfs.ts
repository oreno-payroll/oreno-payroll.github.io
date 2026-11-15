import type { SavedPayrollRecord } from '../storage/payrollStore';
import { writePdfExportZip, type ZipFile } from '../storage/zipArchive';
import { safePdfFileName } from '../storage/fileNaming';

/** 選択中の表示期間で絞り込み済みの副業明細だけを渡す。見込みデータは渡さない。 */
export async function createSidePdfZip(records: readonly SavedPayrollRecord[]): Promise<Blob> {
  const files: ZipFile[] = [];
  const ordered = [...records].sort((a, b) => a.form.paymentDate.localeCompare(b.form.paymentDate) || a.id - b.id);
  for (const [index, record] of ordered.entries()) {
    if (record.form.job !== 'side') throw new Error('副業以外の明細が含まれています。');
    if (record.pdf.type && record.pdf.type !== 'application/pdf') throw new Error('PDF以外の原本が含まれています。');
    const data = new Uint8Array(await record.pdf.arrayBuffer());
    // 保存時のPDFチェックと同様に、先頭1KiB内のPDFヘッダーを認める。
    let pdfHeader = false;
    for (let n = 0; n <= Math.min(1019, data.byteLength - 5); n++) {
      if (data[n] === 37 && data[n + 1] === 80 && data[n + 2] === 68 && data[n + 3] === 70 && data[n + 4] === 45) { pdfHeader = true; break; }
    }
    if (!pdfHeader) {
      throw new Error('PDF原本の形式が正しくありません。');
    }
    files.push({ name: `pdf/${String(index + 1).padStart(6, '0')}_${safePdfFileName(record.fileName, { fallbackStem: 'statement', maxStemLength: 100 })}`, data });
  }
  if (!files.length) throw new Error('対象の副業PDFがありません。');
  return writePdfExportZip(files);
}
