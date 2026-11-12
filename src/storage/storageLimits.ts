/** ZIP32 / ブラウザメモリの限界を考慮し、保存・書出・復元で共通の容量上限を使用する。 */
export const MAX_RECORDS = 2000;
export const MAX_PDF_SIZE = 50 * 1024 * 1024;
export const MAX_TOTAL_PDF_BYTES = 480 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const encoder = new TextEncoder();

export function assertStorageLimits(records: readonly { pdf: Blob }[]): void {
  if (records.length > MAX_RECORDS) throw new Error(`保存できる明細は最大${MAX_RECORDS}件です。`);
  let totalPdf = 0;
  let totalMetadata = 80; // manifest の固定フィールド分
  for (const record of records) {
    if (!(record.pdf instanceof Blob) || record.pdf.size === 0 || record.pdf.size > MAX_PDF_SIZE) {
      throw new Error('PDF原本は1件50MB以下の正常なファイルが必要です。');
    }
    totalPdf += record.pdf.size;
    if (totalPdf > MAX_TOTAL_PDF_BYTES) throw new Error('PDF原本の合計が480MiBを超えています。完全バックアップ可能な容量に収めてください。');
    const { pdf: _pdf, ...metadata } = record;
    totalMetadata += encoder.encode(JSON.stringify(metadata)).byteLength + 600; // ZIP内の属性／各エントリを含む余裕値
    if (totalMetadata > MAX_MANIFEST_BYTES) throw new Error('明細の保存情報が8MiBを超えています。');
  }
}
