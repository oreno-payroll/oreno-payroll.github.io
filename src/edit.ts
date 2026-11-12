/** 保存済みレコードの検査・編集。PDF原本と保存IDは保持する。 */
import { deleteRecord, getRecord, updateRecord, inspectReplacementConflicts, recordSignature, type SavedPayrollRecord } from './storage/payrollStore';
import { validatePayrollForm, normalizeWorkDays } from './storage/payrollValidation';
import { storedPdfName } from './storage/fileNaming';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`画面の要素が見つかりません: ${id}`);
  return element as T;
};
const form = $<HTMLFormElement>('review-form');
const errorView = $<HTMLElement>('edit-error');
const editor = $<HTMLElement>('editor');
const status = $<HTMLElement>('edit-status');
const saveButton = $<HTMLButtonElement>('edit-save');
const deleteButton = $<HTMLButtonElement>('edit-delete');
const confirmDiff = $<HTMLInputElement>('confirm-diff');
const state = $<HTMLElement>('raw-state');
// ホームから渡された年度を「戻る」リンクと編集保存後の遷移先に引き継ぐ。
const originFiscalYear = new URLSearchParams(window.location.search).get('fy');
const homeHref = originFiscalYear && /^\d{4}$/.test(originFiscalYear) &&
  Number(originFiscalYear) >= 1900 && Number(originFiscalYear) <= 2200
  ? `../index.html?fy=${encodeURIComponent(originFiscalYear)}`
  : '../index.html';
document.querySelectorAll<HTMLAnchorElement>('a[href="../index.html"]').forEach(link => {
  link.setAttribute('href', homeHref);
});
let record: SavedPayrollRecord | undefined;
let url: string | undefined;
let saving = false;

function hideConditional(kind: string): void {
  form.querySelectorAll<HTMLElement>('[data-bonus-only]').forEach(el => { el.hidden = kind !== 'bonus'; });
  form.querySelectorAll<HTMLElement>('[data-salary-only]').forEach(el => { el.hidden = kind === 'bonus'; });
}
function fillForm(values: Record<string, string>): void {
  for (const control of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name],select[name]'))) {
    if (control.type === 'radio' && control instanceof HTMLInputElement) control.checked = values[control.name] === control.value;
    else control.value = values[control.name] ?? '';
  }
  hideConditional(values.kind);
}
function getValues(): Record<string, string> {
  const values: Record<string, string> = { ...(record?.form ?? {}) };
  for (const element of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name],select[name]'))) {
    if (element instanceof HTMLInputElement && element.type === 'radio' && !element.checked) continue;
    values[element.name] = element.value;
  }
  values.workDays = normalizeWorkDays(values.workDays ?? '');
  return values;
}
function updateUI(): void {
  if (!record) return;
  const values = getValues();
  const { errors, warnings } = validatePayrollForm(values);
  confirmDiff.parentElement!.hidden = warnings.length === 0;
  status.textContent = errors[0] ?? (warnings.length ? warnings.join(' / ') : '入力内容を保存できます。PDF原本は変更しません。');
  saveButton.disabled = saving || errors.length > 0 || Boolean(warnings.length && !confirmDiff.checked);
  deleteButton.disabled = saving;
}
function showState(): void {
  if (!record) return;
  const { pdf, ...metadata } = record;
  state.textContent = JSON.stringify({ ...metadata, pdf: { size: pdf.size, type: pdf.type } }, null, 2);
}
function showError(message: string): void {
  errorView.textContent = message;
  errorView.hidden = false;
}
form.addEventListener('input', event => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.name === 'kind') hideConditional(el.value);
  confirmDiff.checked = false;
  updateUI();
});
form.addEventListener('change', event => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.name === 'workDays') {
    el.value = normalizeWorkDays(el.value);
  }
  updateUI();
});
form.addEventListener('submit', event => event.preventDefault());
confirmDiff.addEventListener('change', updateUI);
saveButton.addEventListener('click', async () => {
  if (!record || saving) return;
  const formValues = getValues();
  const checked = validatePayrollForm(formValues);
  if (checked.errors.length) { showError(checked.errors[0]); return; }
  if (checked.warnings.length && !confirmDiff.checked) return;
  saving = true;
  updateUI();
  try {
    const updated: SavedPayrollRecord = {
      ...record,
      fileName: storedPdfName(formValues.job, formValues.kind, formValues.paymentDate, record.originalFileName ?? record.fileName),
      form: formValues,
      warningsAcknowledged: checked.warnings.length ? confirmDiff.checked : record.warningsAcknowledged,
      reviewedIssues: checked.warnings.length ? checked.warnings : record.reviewedIssues,
      reviewedAt: checked.warnings.length ? new Date().toISOString() : record.reviewedAt,
    };
    const conflicts = await inspectReplacementConflicts([updated], updated.id);
    if (conflicts.length) {
      const lines = conflicts.map(c => `・${c.fileName}（${c.period.replaceAll('|', ' / ')}）`).join('\n');
      if (!window.confirm(`編集後の明細が保存済みデータと重複します。\n${lines}\n\n「OK」で上記${conflicts.length}件を完全に削除し、編集中の明細を残します。よろしいですか？`)) {
        saving = false; updateUI(); return;
      }
    }
    await updateRecord(updated, conflicts, recordSignature(record));
    window.location.assign(homeHref);
  } catch (error) {
    saving = false;
    showError(error instanceof Error ? `保存できませんでした: ${error.message}` : '保存できませんでした。');
    updateUI();
  }
});
deleteButton.addEventListener('click', async () => {
  if (!record || saving) return;
  const job = record.form.job === 'main' ? '本業' : '副業';
  const kind = record.form.kind === 'bonus' ? '賞与' : '給与';
  if (!window.confirm(`保存済み明細を1件削除します。\n\n${job} / ${record.form.targetMonth}分 / ${kind}\nファイル: ${record.fileName}\n\n保存済みの入力情報とPDF原本が削除されます。編集中の未保存内容も破棄され、元に戻すには削除前のバックアップが必要です。\n\n本当に削除しますか？`)) return;
  saving = true;
  updateUI();
  try {
    await deleteRecord(record.id, recordSignature(record));
    window.location.assign(homeHref);
  } catch (error) {
    saving = false;
    showError(error instanceof Error ? `削除できませんでした: ${error.message}` : '削除できませんでした。');
    updateUI();
  }
});
window.addEventListener('pagehide', () => { if (url) URL.revokeObjectURL(url); });
void (async () => {
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isSafeInteger(id) || id <= 0) { showError('明細IDが不正です。ホームに戻って選び直してください。'); return; }
  try {
    record = await getRecord(id);
    if (!record) { showError('保存済み明細が見つかりません。'); return; }
    editor.hidden = false;
    $('record-name').textContent = record.fileName;
    $('record-details').textContent = `ID ${record.id} / 登録日時 ${new Date(record.savedAt).toLocaleString('ja-JP')} / PDF ${record.pdf.size.toLocaleString('ja-JP')} bytes`;
    url = URL.createObjectURL(record.pdf);
    const link = $<HTMLAnchorElement>('original-pdf');
    link.href = url;
    const download = $<HTMLAnchorElement>('download-pdf');
    download.href = url;
    download.download = record.fileName;
    fillForm(record.form);
    showState();
    updateUI();
  } catch (error) { showError(error instanceof Error ? error.message : '明細の読み込みに失敗しました。'); }
})();
