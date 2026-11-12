/** PDFの最低限の形式を保存前とバックアップ時に同じ基準で検査する。 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { MAX_PDF_SIZE } from './storageLimits';
export const MAX_STORED_PDF_BYTES = MAX_PDF_SIZE;
export function verifyPdfBytes(bytes: Uint8Array): void {
  if (!bytes.length || bytes.length > MAX_STORED_PDF_BYTES) throw new Error('PDFは1件50MB以下で指定してください。');
  let header = false;
  for (let i = 0; i <= Math.min(1019, bytes.length - 5); i++) {
    if (bytes[i] === 37 && bytes[i + 1] === 80 && bytes[i + 2] === 68 && bytes[i + 3] === 70 && bytes[i + 4] === 45) { header = true; break; }
  }
  if (!header) throw new Error('PDFヘッダーがありません。破損したPDFや別形式のファイルは保存できません。');
}

/** 復元前にPDF.jsの実際のパーサーで開けるか確かめる。正規のPDFをコピーしてWorkerへ渡す。 */
export async function verifyPdfWithPdfJs(bytes: Uint8Array): Promise<void> {
  verifyPdfBytes(bytes);
  GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
  const task = getDocument({ data: bytes.slice(), stopAtErrors: true });
  try {
    const document = await task.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 5000) {
      throw new Error('PDFページ数が不正です。');
    }
    // 開始ページと最終ページを検査。すべての描画ストリームの無欠陥性までは保証しない。
    await document.getPage(1);
    if (document.numPages > 1) await document.getPage(document.numPages);
  } catch (error) {
    throw new Error(`PDF.jsで開けない原本です: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await task.destroy();
  }
}
