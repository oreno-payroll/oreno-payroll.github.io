/** 暗号化完全バックアップの書出・PDF.jsでの復元前検査・全件置換。 */
import { loadRecords, replaceAllRecords } from './storage/payrollStore';
import { createBackup, readBackup, type LoadedBackup } from './storage/payrollBackup';
import { encryptBackup, decryptBackup, isEncryptedBackup } from './storage/encryptedBackup';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`画面の要素が見つかりません: ${id}`);
  return element as T;
};
const exportButton = $<HTMLButtonElement>('export-button');
const exportSummary = $<HTMLElement>('export-summary');
const exportPassword = $<HTMLInputElement>('export-password');
const exportConfirm = $<HTMLInputElement>('export-confirm');
const filePicker = $<HTMLInputElement>('restore-file');
const restorePasswordRow = $<HTMLElement>('restore-password-row');
const restorePassword = $<HTMLInputElement>('restore-password');
const verifyButton = $<HTMLButtonElement>('verify-button');
const restorePreview = $<HTMLElement>('restore-preview');
const ack = $<HTMLInputElement>('restore-ack');
const restoreButton = $<HTMLButtonElement>('restore-button');
const status = $<HTMLElement>('backup-status');
let preview: LoadedBackup | undefined;
let currentCount = 0;
let busy = false;
let loadedDb = false;
let encryptedFile = false;
const sizes = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(0, Math.round(n / 1024))} KiB`;
function updateButtons(): void {
  exportButton.disabled = busy || !loadedDb;
  filePicker.disabled = busy;
  restorePassword.disabled = busy || !encryptedFile;
  verifyButton.disabled = busy || !encryptedFile || !filePicker.files?.length || !restorePassword.value;
  ack.disabled = busy || !preview;
  restoreButton.disabled = busy || !preview || !ack.checked;
}
function info(message: string, isError = false): void {
  status.textContent = message;
  status.style.color = isError ? 'var(--color-danger)' : 'var(--color-success)';
}
function resetPreview(): void {
  preview = undefined;
  ack.checked = false;
  updateButtons();
}
async function refreshCount(): Promise<void> {
  const records = await loadRecords();
  currentCount = records.length;
  loadedDb = true;
  const bytes = records.reduce((sum, r) => sum + r.pdf.size, 0);
  exportSummary.textContent = `保存済み ${currentCount}件 ・ PDF原本 ${sizes(bytes)}`;
}
exportButton.addEventListener('click', async () => {
  if (busy || !loadedDb) return;
  if (exportPassword.value !== exportConfirm.value) { info('2つのパスワードが一致しません。', true); return; }
  if ([...exportPassword.value].length < 12) { info('パスワードは12文字以上にしてください。', true); return; }
  busy = true; updateButtons(); info('暗号化バックアップを作成しています…');
  try {
    const zip = await createBackup(await loadRecords());
    const blob = await encryptBackup(zip, exportPassword.value);
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2,'0')}-${String(today.getHours()).padStart(2,'0')}${String(today.getMinutes()).padStart(2,'0')}${String(today.getSeconds()).padStart(2,'0')}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `payroll-backup-${stamp}.payroll`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    exportPassword.value = '';
    exportConfirm.value = '';
    info(`暗号化バックアップを作成しました（${sizes(blob.size)}）。保存先でファイルがあることを確認してください。`);
  } catch (error) { info(`バックアップに失敗しました: ${error instanceof Error ? error.message : String(error)}`, true); }
  finally { busy = false; updateButtons(); }
});

async function verifyRestore(file: File, password?: string): Promise<void> {
  busy = true; resetPreview(); updateButtons();
  info('バックアップの整合性とPDF原本を検査しています…');
  try {
    const content = password === undefined ? file : await decryptBackup(file, password);
    const loaded = await readBackup(content);
    preview = loaded;
    restorePassword.value = '';
    restorePreview.textContent = `検証完了：${loaded.records.length}件 ・ PDF ${sizes(loaded.bytes)}\n作成日時：${new Date(loaded.exportedAt).toLocaleString('ja-JP')}${loaded.unreviewedWarnings ? `\n旧データの検算未承認：${loaded.unreviewedWarnings}件` : ''}${loaded.legacyDuplicates ? `\n旧データの重複候補：${loaded.legacyDuplicates}件` : ''}`;
    info('ZIP・PDF.js・PDFハッシュの検証が完了しました。内容を確認して復元してください。');
  } catch (error) {
    preview = undefined;
    restorePreview.textContent = '検証失敗。既存データは変更されていません。';
    info(`復元ファイルを検証できませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally { busy = false; updateButtons(); }
}
filePicker.addEventListener('change', async () => {
  resetPreview();
  restorePassword.value = '';
  const file = filePicker.files?.[0];
  if (!file) { restorePreview.textContent = 'バックアップファイルを選択してください。'; return; }
  busy = true; updateButtons();
  try {
    encryptedFile = await isEncryptedBackup(file);
    restorePasswordRow.hidden = !encryptedFile;
    verifyButton.hidden = !encryptedFile;
    if (encryptedFile) {
      restorePreview.textContent = '暗号化されたPayrollバックアップです。パスワードを入力して検証してください。';
      info('暗号化バックアップを検出しました。');
    } else {
      restorePreview.textContent = '従来のZIPを確認します。';
    }
  } catch (error) {
    info(`ファイルを読み取れませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
    return;
  } finally { busy = false; updateButtons(); }
  if (!encryptedFile) await verifyRestore(file);
});
restorePassword.addEventListener('input', () => { resetPreview(); updateButtons(); });
verifyButton.addEventListener('click', async () => {
  const file = filePicker.files?.[0];
  if (!file || !encryptedFile || busy) return;
  await verifyRestore(file, restorePassword.value);
});
ack.addEventListener('change', updateButtons);
restoreButton.addEventListener('click', async () => {
  if (busy || !preview || !ack.checked) return;
  const data = preview;
  if (!window.confirm(`現在の${currentCount}件を削除して、バックアップ内の${data.records.length}件で完全に置き換えます。続けますか？`)) return;
  busy = true; updateButtons(); info('全件復元中です。操作完了を確認してください…');
  try {
    await replaceAllRecords(data.records);
    window.location.assign('../index.html');
  } catch (error) {
    info(`復元に失敗しました。元のデータは保持されています: ${error instanceof Error ? error.message : String(error)}`, true);
    busy = false; updateButtons();
  }
});
void refreshCount().then(updateButtons).catch(error => {
  exportSummary.textContent = '保存済みデータを確認できませんでした。';
  info(error instanceof Error ? error.message : 'データベースの読み込みに失敗しました。', true);
  updateButtons();
});
