/** Payroll専用の完全バックアップ。PDFバイト列とIndexedDBの各レコードを丸ごと復元する。 */
import type { SavedPayrollRecord } from './payrollStore';
import { readZip, writeZip, type ZipFile } from './zipArchive';
import { verifyPdfBytes, verifyPdfWithPdfJs } from './pdfIntegrity';
import { assertStorageLimits, MAX_RECORDS, MAX_MANIFEST_BYTES, MAX_ARCHIVE_BYTES } from './storageLimits';
import { payrollPeriodKey, validatePayrollForm } from './payrollValidation';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface ManifestEntry {
  pdfPath: string;
  sha256: string;
  pdfMeta: { type: string; isFile: boolean; name?: string; lastModified?: number };
  metadata: Omit<SavedPayrollRecord, 'pdf'>;
}
interface BackupManifest {
  app: 'Payroll';
  schemaVersion: 1;
  exportedAt: string;
  records: ManifestEntry[];
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
async function hash(bytes: Uint8Array): Promise<string> {
  assert(globalThis.crypto?.subtle, '完全性検証が利用できません。localhostまたはHTTPSで開いてください。');
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function validateMetadata(raw: unknown, used: Set<number>): Omit<SavedPayrollRecord, 'pdf'> {
  assert(isObject(raw), '明細のメタデータが不正です。');
  assert(Number.isSafeInteger(raw.id) && (raw.id as number) > 0 && !used.has(raw.id as number), '明細IDが不正または重複しています。');
  used.add(raw.id as number);
  assert(typeof raw.fileName === 'string' && raw.fileName.length > 0 && raw.fileName.length <= 512, '保存ファイル名が不正です。');
  assert(raw.originalFileName === undefined || typeof raw.originalFileName === 'string', '元ファイル名が不正です。');
  assert(typeof raw.savedAt === 'string' && Number.isFinite(Date.parse(raw.savedAt)), '保存日時が不正です。');
  assert(Number.isSafeInteger(raw.pages) && (raw.pages as number) >= 0, 'PDFページ数が不正です。');
  assert(typeof raw.warningsAcknowledged === 'boolean', '警告確認情報が不正です。');
  assert(raw.revision === undefined || (Number.isSafeInteger(raw.revision) && (raw.revision as number) >= 0), '更新番号が不正です。');
  assert(raw.fileHash === undefined || (typeof raw.fileHash === 'string' && /^[a-f0-9]{64}$/.test(raw.fileHash)), 'PDFハッシュが不正です。');
  assert(raw.reviewedIssues === undefined || (Array.isArray(raw.reviewedIssues) && raw.reviewedIssues.length <= 100 && raw.reviewedIssues.every(v => typeof v === 'string' && v.length <= 1000)), '確認済み警告の記録が不正です。');
  assert(raw.reviewedAt === undefined || (typeof raw.reviewedAt === 'string' && Number.isFinite(Date.parse(raw.reviewedAt))), '警告確認日時が不正です。');
  assert(isObject(raw.form) && Object.keys(raw.form).length <= 128, '明細フォームが不正です。');
  for (const [key, value] of Object.entries(raw.form)) {
    assert(key.length <= 100 && typeof value === 'string' && value.length <= 10000, `明細フィールドが不正です: ${key}`);
  }
  const form = raw.form as Record<string, string>;
  assert((form.job === 'main' || form.job === 'side') && (form.kind === 'salary' || form.kind === 'bonus'), '勤務先・明細種別が不正です。');
  const validation = validatePayrollForm(form);
  assert(validation.errors.length === 0, `明細の入力値が不正です: ${validation.errors[0] ?? ''}`);
  // 旧保存データの未承認検算差異はバックアップ不能の原因にしない。復元画面で要確認件数を通知する。
  // アプリが管理するフィールド以外もJSON値のまま保持し、将来の拡張値を勝手に消さない。
  return raw as unknown as Omit<SavedPayrollRecord, 'pdf'>;
}

export async function createBackup(records: SavedPayrollRecord[]): Promise<Blob> {
  assertStorageLimits(records);
  const manifest: BackupManifest = { app: 'Payroll', schemaVersion: 1, exportedAt: new Date().toISOString(), records: [] };
  const files: ZipFile[] = [];
  const used = new Set<number>();
  for (const [index, record] of records.entries()) {
    const { pdf, ...metadata } = record;
    try { validateMetadata(metadata, used); }
    catch (error) { throw new Error(`「${record.fileName}」の保存情報が不正です: ${error instanceof Error ? error.message : String(error)}`); }
    const data = new Uint8Array(await pdf.arrayBuffer());
    try { verifyPdfBytes(data); }
    catch (error) { throw new Error(`「${record.fileName}」の原本PDFが不正です: ${error instanceof Error ? error.message : String(error)}`); }
    const pdfPath = `pdf/${String(index + 1).padStart(6, '0')}.pdf`;
    const pdfMeta = pdf instanceof File
      ? { type: pdf.type, isFile: true, name: pdf.name, lastModified: pdf.lastModified }
      : { type: pdf.type, isFile: false };
    const digest = await hash(data);
    assert(!record.fileHash || record.fileHash === digest, '保存済みPDFのハッシュが一致しません。');
    manifest.records.push({ pdfPath, sha256: digest, pdfMeta, metadata });
    files.push({ name: pdfPath, data });
  }
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  assert(manifestBytes.byteLength <= MAX_MANIFEST_BYTES, 'バックアップの管理情報が8MiBを超えています。');
  files.unshift({ name: 'manifest.json', data: manifestBytes });
  return writeZip(files);
}

export interface LoadedBackup {
  exportedAt: string;
  records: SavedPayrollRecord[];
  bytes: number;
  unreviewedWarnings: number;
  legacyDuplicates: number;
}
export async function readBackup(file: Blob): Promise<LoadedBackup> {
  assert(file.size > 0 && file.size <= MAX_ARCHIVE_BYTES, 'ZIPファイルは512MiB以下にしてください。');
  const files = readZip(await file.arrayBuffer());
  const bytes = files.get('manifest.json');
  assert(bytes && bytes.length <= MAX_MANIFEST_BYTES, 'manifest.jsonが見つからないか、大きすぎます。');
  const manifest: unknown = JSON.parse(decoder.decode(bytes));
  assert(isObject(manifest) && manifest.app === 'Payroll' && manifest.schemaVersion === 1, 'Payroll専用バックアップではないか、未対応のバージョンです。');
  assert(typeof manifest.exportedAt === 'string' && Number.isFinite(Date.parse(manifest.exportedAt)), 'バックアップ作成日時が不正です。');
  assert(Array.isArray(manifest.records) && manifest.records.length <= MAX_RECORDS, '明細件数が不正です。');
  assert(files.size === manifest.records.length + 1, 'ZIP内に予期しないファイルがあります。');
  const usedIds = new Set<number>();
  const usedPaths = new Set<string>();
  const usedPeriods = new Set<string>();
  const usedHashes = new Set<string>();
  const records: SavedPayrollRecord[] = [];
  let total = 0;
  let unreviewedWarnings = 0;
  let legacyDuplicates = 0;
  for (const entry of manifest.records as unknown[]) {
    assert(isObject(entry), '明細一覧が不正です。');
    assert(typeof entry.pdfPath === 'string' && !usedPaths.has(entry.pdfPath), 'PDFパスが不正または重複しています。');
    usedPaths.add(entry.pdfPath);
    assert(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), 'PDFハッシュ形式が不正です。');
    const metadata = validateMetadata(entry.metadata, usedIds);
    if (!metadata.warningsAcknowledged && validatePayrollForm(metadata.form).warnings.length) unreviewedWarnings++;
    const period = payrollPeriodKey(metadata.form);
    if (usedPeriods.has(period) || usedHashes.has(entry.sha256)) legacyDuplicates++;
    usedPeriods.add(period);
    usedHashes.add(entry.sha256);
    const data = files.get(entry.pdfPath);
    assert(data, `PDFが見つかりません: ${entry.pdfPath}`);
    verifyPdfBytes(data);
    assert(await hash(data) === entry.sha256, `PDFのSHA-256検証に失敗しました: ${metadata.fileName}`);
    assert(!metadata.fileHash || metadata.fileHash === entry.sha256, `保存済みPDFのハッシュ情報に矛盾があります: ${metadata.fileName}`);
    // この時点ではまだIndexedDBへ一切書き込んでいない。原本をPDF.jsで実際にパースして検証。
    try { await verifyPdfWithPdfJs(data); }
    catch (error) { throw new Error(`${metadata.fileName}: ${error instanceof Error ? error.message : String(error)}`); }
    assert(isObject(entry.pdfMeta) && typeof entry.pdfMeta.type === 'string' && typeof entry.pdfMeta.isFile === 'boolean', 'PDFの属性情報が不正です。');
    const pdfMeta = entry.pdfMeta;
    assert(!pdfMeta.isFile || (typeof pdfMeta.name === 'string' && pdfMeta.name.length <= 512 && Number.isFinite(pdfMeta.lastModified)), 'PDF元ファイル情報が不正です。');
    const contents = new Uint8Array(data);
    const pdf = pdfMeta.isFile
      ? new File([contents], pdfMeta.name as string, { type: pdfMeta.type as string, lastModified: pdfMeta.lastModified as number })
      : new Blob([contents], { type: pdfMeta.type as string });
    total += data.length;
    records.push({ ...metadata, pdf });
  }
  assertStorageLimits(records);
  return { exportedAt: manifest.exportedAt, records, bytes: total, unreviewedWarnings, legacyDuplicates };
}
