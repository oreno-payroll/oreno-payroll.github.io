/** ブラウザ内の給与明細保管庫。PDF原本と入力値を同一トランザクションで管理する。 */
import { payrollPeriodKey, validatePayrollForm } from './payrollValidation';
import { assertStorageLimits } from './storageLimits';

const DB_NAME = 'payroll-local-v1';
const DB_VERSION = 1;
const STORE = 'payroll-records';

export interface SavedPayrollRecordInput {
  fileName: string;
  originalFileName?: string;
  pdf: Blob;
  fileHash?: string;
  form: Record<string, string>;
  pages: number;
  warningsAcknowledged: boolean;
  /** 確認時の問題を残す。PDFから抽出した生の文字列は記録しない。 */
  reviewedIssues?: string[];
  reviewedAt?: string;
}
export interface SavedPayrollRecord extends SavedPayrollRecordInput {
  id: number;
  savedAt: string;
  /** 旧レコードでは未設定。編集するたびに加算し、タブ間の上書きを拒否する。 */
  revision?: number;
}
export interface ReplacementConflict {
  id: number;
  fileName: string;
  period: string;
  reasons: ('same-pdf' | 'same-period')[];
  /** 確認後にレコードが変更された場合は保存しないためのスナップショット。 */
  signature: string;
  legacyHash?: string;
}

function openPayrollDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDBが利用できません。'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const records = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        records.createIndex('paymentDate', 'form.paymentDate', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('データベースを開けませんでした。'));
    request.onblocked = () => reject(new Error('他のタブがデータベースを使用しています。'));
  });
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, transaction: IDBTransaction, resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  const db = await openPayrollDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result: T;
      let failure: Error | undefined;
      const fail = (error: Error) => { failure = error; try { transaction.abort(); } catch { /* 既に終了済み */ } };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('保存処理が中断されました。'));
      transaction.onerror = () => { /* onabortに集約 */ };
      try { operation(store, transaction, (value) => { result = value; }, fail); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  } finally { db.close(); }
}

/** 保存IDだけでは不十分なので、フォーム・警告記録・リビジョンまで比較する。 */
export function recordSignature(record: SavedPayrollRecord): string {
  return JSON.stringify([record.id, record.savedAt, record.fileName, record.originalFileName ?? '',
    record.fileHash ?? '', record.pdf.size, record.pdf.type, record.pages, record.revision ?? 0,
    record.warningsAcknowledged, record.reviewedAt ?? '', record.reviewedIssues ?? [], record.form]);
}
function conflicting(previous: SavedPayrollRecord, incoming: SavedPayrollRecordInput, oldHash?: string): ('same-pdf' | 'same-period')[] {
  const reasons: ('same-pdf' | 'same-period')[] = [];
  if ((previous.fileHash ?? oldHash) && incoming.fileHash && (previous.fileHash ?? oldHash) === incoming.fileHash) reasons.push('same-pdf');
  if (payrollPeriodKey(previous.form) === payrollPeriodKey(incoming.form)) reasons.push('same-period');
  return reasons;
}
function assertValid(input: SavedPayrollRecordInput, allowLegacyWarning = false): void {
  const { errors, warnings } = validatePayrollForm(input.form);
  if (errors.length) throw new Error(errors[0]);
  if (!allowLegacyWarning && warnings.length && !input.warningsAcknowledged) throw new Error('金額の検算警告が未確認です。');
  if (!(input.pdf instanceof Blob) || input.pdf.size === 0) throw new Error('PDF原本がありません。');
}
function validateBatch(records: SavedPayrollRecordInput[]): void {
  if (!records.length) throw new Error('保存対象がありません。');
  const keys = new Set<string>();
  const hashes = new Set<string>();
  for (const record of records) {
    assertValid(record);
    const key = payrollPeriodKey(record.form);
    if (keys.has(key)) throw new Error('同じ勤務先・明細種別・対象月のPDFがアップロード内に複数あります。保存する1件を選んでください。');
    keys.add(key);
    if (record.fileHash) {
      if (hashes.has(record.fileHash)) throw new Error('同じPDFがアップロード内に複数あります。1件に整理してください。');
      hashes.add(record.fileHash);
    }
  }
}
export async function inspectReplacementConflicts(records: SavedPayrollRecordInput[], excludeId?: number): Promise<ReplacementConflict[]> {
  validateBatch(records);
  const current = await loadRecords();
  const conflicts: ReplacementConflict[] = [];
  for (const old of current) {
    if (old.id === excludeId) continue;
    let legacyHash: string | undefined;
    if (!old.fileHash && records.some(r => Boolean(r.fileHash))) {
      if (!globalThis.crypto?.subtle) throw new Error('SHA-256で既存PDFを照合できません。localhostまたはHTTPSで開いてください。');
      const digest = await crypto.subtle.digest('SHA-256', await old.pdf.arrayBuffer());
      legacyHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    const reasons = [...new Set(records.flatMap(record => conflicting(old, record, legacyHash)))];
    if (reasons.length) conflicts.push({ id: old.id, fileName: old.fileName, period: payrollPeriodKey(old.form), reasons, signature: recordSignature(old), ...(legacyHash ? { legacyHash } : {}) });
  }
  return conflicts;
}
function assertApprovals(existing: SavedPayrollRecord[], records: SavedPayrollRecordInput[], approvals: ReplacementConflict[], excludeId?: number): number[] {
  const allowed = new Map(approvals.map(c => [c.id, c]));
  const conflicts = existing.filter(r => r.id !== excludeId && records.some(v => conflicting(r, v, allowed.get(r.id)?.legacyHash).length));
  if (conflicts.some(r => allowed.get(r.id)?.signature !== recordSignature(r)) || conflicts.length !== allowed.size) {
    throw new Error('保存済みの明細が変わったか、新しい重複が見つかりました。内容を確認してもう一度保存してください。');
  }
  return conflicts.map(r => r.id);
}

export interface SkippedPayroll { fileName: string; reason: 'saved-pdf' | 'saved-period' | 'batch-pdf' | 'batch-period' }
export interface SaveSkipResult { saved: number; skipped: SkippedPayroll[] }

/** 同一PDFまたは同一(勤務先・種別・対象月)は既存優先でスキップ。残りは単一トランザクションで一括登録。 */
export async function saveRecordsSkippingDuplicates(records: SavedPayrollRecordInput[]): Promise<SaveSkipResult> {
  if (!records.length) throw new Error('保存対象がありません。');
  for (const record of records) {
    assertValid(record);
    if (!record.fileHash || !/^[a-f0-9]{64}$/.test(record.fileHash)) throw new Error('PDFハッシュを取得できません。');
  }
  // 旧版ではSHA-256を未保存の場合がある。トランザクションの外で計算し、照合時は内容の変更も検出する。
  const legacyHashes = new Map<number, { snapshot: string; hash: string }>();
  for (const old of await loadRecords()) {
    if (old.fileHash) continue;
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256が使えません。localhostまたはHTTPSから開いてください。');
    const digest = await crypto.subtle.digest('SHA-256', await old.pdf.arrayBuffer());
    legacyHashes.set(old.id, {
      snapshot: recordSignature(old),
      hash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
    });
  }
  return transact<SaveSkipResult>('readwrite', (store, _tx, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      try {
        const old = request.result as SavedPayrollRecord[];
        const hashes = new Set<string>();
        const periods = new Set<string>();
        for (const saved of old) {
          const legacy = legacyHashes.get(saved.id);
          if (!saved.fileHash && (!legacy || legacy.snapshot !== recordSignature(saved))) {
            throw new Error('別タブで保存済み明細が変わりました。重複を再確認して保存してください。');
          }
          hashes.add(saved.fileHash ?? legacy!.hash);
          periods.add(payrollPeriodKey(saved.form));
        }
        const accepted: SavedPayrollRecordInput[] = [];
        const skipped: SkippedPayroll[] = [];
        const batchHashes = new Set<string>();
        const batchPeriods = new Set<string>();
        for (const record of records) {
          const period = payrollPeriodKey(record.form);
          let reason: SkippedPayroll['reason'] | undefined;
          if (hashes.has(record.fileHash!)) reason = 'saved-pdf';
          else if (periods.has(period)) reason = 'saved-period';
          else if (batchHashes.has(record.fileHash!)) reason = 'batch-pdf';
          else if (batchPeriods.has(period)) reason = 'batch-period';
          if (reason) { skipped.push({ fileName: record.fileName, reason }); continue; }
          accepted.push(record);
          batchHashes.add(record.fileHash!);
          batchPeriods.add(period);
        }
        assertStorageLimits([...old, ...accepted]);
        const savedAt = new Date().toISOString();
        for (const record of accepted) store.add({ ...record, savedAt, revision: 1 });
        resolve({ saved: accepted.length, skipped });
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    };
    request.onerror = () => reject(request.error ?? new Error('重複判定に失敗しました。'));
  });
}

export async function loadRecords(): Promise<SavedPayrollRecord[]> {
  return transact<SavedPayrollRecord[]>('readonly', (store, _tx, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as SavedPayrollRecord[]);
    request.onerror = () => reject(request.error ?? new Error('読み込みに失敗しました。'));
  });
}

export async function getRecord(id: number): Promise<SavedPayrollRecord | undefined> {
  return transact<SavedPayrollRecord | undefined>('readonly', (store, _tx, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as SavedPayrollRecord | undefined);
    request.onerror = () => reject(request.error ?? new Error('読み込みに失敗しました。'));
  });
}

/** 原本PDFと保存時刻・IDは変えず、明細データのみ更新する。別月との衝突は事前確認必須。 */
export async function updateRecord(record: SavedPayrollRecord, approvals: ReplacementConflict[] = [], expectedSignature?: string): Promise<void> {
  assertValid(record);
  await transact<void>('readwrite', (store, _tx, _resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      try {
        const old = request.result as SavedPayrollRecord[];
        const self = old.find(r => r.id === record.id);
        if (!self || !expectedSignature || recordSignature(self) !== expectedSignature) {
          throw new Error('編集中に元の明細が変更されました。読み直してから編集してください。');
        }
        for (const id of assertApprovals(old, [record], approvals, record.id)) store.delete(id);
        assertStorageLimits([...old.filter(r => r.id !== record.id && !approvals.some(a => a.id === r.id)), record]);
        store.put({ ...record, revision: (self.revision ?? 0) + 1 });
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    };
    request.onerror = () => reject(request.error ?? new Error('明細の再確認に失敗しました。'));
  });
}

/** 1件だけを原本PDFごと削除。読み込み後に別タブが更新した場合は削除せず警告する。
 * IndexedDBの同一トランザクション内で現在のレコードと照合してから削除する。
 */
export async function deleteRecord(id: number, expectedSignature: string): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0 || !expectedSignature) {
    throw new Error('削除対象の情報が不正です。画面を再読み込みしてください。');
  }
  await transact<void>('readwrite', (store, _tx, _resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => {
      try {
        const current = request.result as SavedPayrollRecord | undefined;
        if (!current) {
          throw new Error('対象の明細はすでに削除されています。最新の一覧を確認してください。');
        }
        if (recordSignature(current) !== expectedSignature) {
          throw new Error('別タブなどで明細が更新されています。削除せずに中断しました。最新の内容を確認してください。');
        }
        // 原本と入力情報は1レコードとして保存されているため、この1件のみ削除する。
        store.delete(id);
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    };
    request.onerror = () => reject(request.error ?? new Error('削除対象を読み取れませんでした。'));
  });
}

/** バックアップから全件を原子的に復元。ZIP側の検証に加え書込前にも基本検証する。 */
export async function replaceAllRecords(records: SavedPayrollRecord[]): Promise<void> {
  const ids = new Set<number>();
  for (const r of records) {
    assertValid(r, true); // 旧バージョン由来の未承認差異を消さず、そのまま復元する。
    if (!Number.isSafeInteger(r.id) || r.id <= 0 || ids.has(r.id)) throw new Error('復元データの明細IDが重複しています。');
    ids.add(r.id);
    // 復元は旧版で作られた重複も含めた完全スナップショット。新規保存側で重複を防ぐ。
  }
  assertStorageLimits(records);
  await transact<void>('readwrite', store => {
    store.clear();
    for (const record of records) store.put(record);
  });
}
