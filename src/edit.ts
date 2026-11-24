import { createAppStatus } from './ui/appStatus';
import { safePdfFileName } from './storage/fileNaming';
import {preparePdfHandoff} from './pdf/handoff';
import {capturePdfHandoffAuthorization} from './cloud/auth';
/** 保存済みレコードの検査・編集。PDF原本と保存IDは保持する。 */
import {deleteRecord,getRecordSummary,getOriginalForVerifiedEdit,updateRecordMetadata,inspectReplacementConflicts,recordSignature,type SavedPayrollSummary} from './storage/payrollStore';
import {reconcilePayrollZeroResolution} from './storage/payrollZeroResolution';
import {validEmployerId,createEmployerId} from './storage/employerIdentity';
import { validatePayrollForm, normalizeWorkDays, applicablePayrollForm } from './storage/payrollValidation';
import { storedPdfName } from './storage/fileNaming';
import { showInlineError, clearInlineError } from './ui/feedback';
import {PayrollPartialSuccessError} from './storage/operationError';
import {incompleteDeleteIncomeNotice} from './ui/deleteOutcome';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`画面の要素が見つかりません: ${id}`);
  return element as T;
};
const form = $<HTMLFormElement>('review-form');
const errorView = $<HTMLElement>('edit-error');
const editor = $<HTMLElement>('editor');
const appStatus=createAppStatus();
const status = $<HTMLElement>('edit-status');
const saveButton = $<HTMLButtonElement>('edit-save');
const deleteButton = $<HTMLButtonElement>('edit-delete');
const confirmDiff = $<HTMLInputElement>('confirm-diff');
const state = $<HTMLElement>('raw-state');
// ホームで選択した集計モードと年を、編集・削除後の戻り先にも引き継ぐ。
// 旧形式の ?fy=2025 もそのまま利用できる。
const originParams = new URLSearchParams(window.location.search);
const originMode = originParams.get('mode') === 'calendar' ? 'calendar' : 'fiscal';
const originYear = originParams.get('year') ?? originParams.get('fy');
const homeHref = originYear && /^\d{4}$/.test(originYear) &&
  Number(originYear) >= 1900 && Number(originYear) <= 2200
  ? `../index.html?mode=${originMode}&year=${encodeURIComponent(originYear)}`
  : '../index.html';
document.querySelectorAll<HTMLAnchorElement>('a[href="../index.html"]').forEach(link => {
  link.setAttribute('href', homeHref);
});
let record: SavedPayrollSummary | undefined;
let pdfDownloading=false;
let saving = false;
let leavingAfterSave = false;

const employerInput=$<HTMLInputElement>('employer-id');
const employerCreate=$<HTMLButtonElement>('employer-create');
employerCreate.addEventListener('click',()=>{
 if(saving||!record)return;
 if(employerInput.value.trim()){employerInput.focus();employerInput.select();return;}
 employerInput.value=createEmployerId();employerInput.focus();employerInput.select();updateUI();
});
employerInput.addEventListener('input',()=>{clearInlineError(errorView);updateUI();});
function hideConditional(kind: string): void {
  form.querySelectorAll<HTMLElement>('[data-bonus-only]').forEach(el => { el.hidden = kind !== 'bonus'; });
  form.querySelectorAll<HTMLElement>('[data-salary-only]').forEach(el => { el.hidden = kind === 'bonus'; });
}
function fillForm(values: Record<string, string>): void {
  employerInput.value=record?.employerId??'';
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
/** 既存PDFはそのまま。フォームの実質的な編集がある時だけ離脱警告。 */
function hasUnsavedChanges(): boolean {
  if (!record) return false;
  const current = getValues();
  const previous = record.form;
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)]);
  for (const key of keys) {
    const oldValue = key === 'workDays' ? normalizeWorkDays(previous[key] ?? '') : (previous[key] ?? '');
    if ((current[key] ?? '') !== oldValue) return true;
  }
  return (employerInput.value.trim()||undefined)!==record.employerId;
}
function updateUI(): void {
  if (!record) return;
  const values = getValues();
  const { errors, warnings } = validatePayrollForm(values);
  if(!validEmployerId(employerInput.value.trim()||undefined))errors.unshift('勤務先IDの形式が不正です。');
  confirmDiff.parentElement!.hidden = warnings.length === 0;
  const changed = hasUnsavedChanges();
  status.textContent = errors[0] ?? (warnings.length ? warnings.join(' / ') : changed
    ? '変更内容を保存できます。PDF原本は変更しません。'
    : '変更はありません。項目を編集すると保存できます。');
  saveButton.disabled = saving || !changed || errors.length > 0 || Boolean(warnings.length && !confirmDiff.checked);
  deleteButton.disabled = saving;
}
function showState(): void {
  if (!record) return;
  state.textContent = JSON.stringify({ ...record, pdf: { size: record.pdfSize, type: record.pdfType, loaded: false } }, null, 2);
}
function showError(message: string): void {
  appStatus.error(message);
  showInlineError(errorView, message);
}
form.addEventListener('input', event => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.name === 'kind') hideConditional(el.value);
  clearInlineError(errorView);
  confirmDiff.checked = false;
  updateUI();
});
form.addEventListener('change', event => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.name === 'workDays') {
    el.value = normalizeWorkDays(el.value);
  }
  clearInlineError(errorView);
  updateUI();
});
form.addEventListener('submit', event => event.preventDefault());
confirmDiff.addEventListener('change', () => { clearInlineError(errorView); updateUI(); });
saveButton.addEventListener('click', async () => {
  if (!record || saving || !hasUnsavedChanges()) return;
  const employerId=employerInput.value.trim()||undefined;
  if(!validEmployerId(employerId)){showError('勤務先IDの形式が不正です。');return;}
  const formValues = applicablePayrollForm(getValues());
  const checked = validatePayrollForm(formValues);
  if (checked.errors.length) { showError(checked.errors[0]); return; }
  if (checked.warnings.length && !confirmDiff.checked) return;
  saving = true;
  appStatus.loading('明細の変更を保存しています…');
  updateUI();
  try {
    const updated: SavedPayrollSummary = {
      ...record,
      fileName: storedPdfName(formValues.job, formValues.kind, formValues.paymentDate, record.originalFileName ?? record.fileName),
      form: formValues,
      employerId,
      zeroResolution: reconcilePayrollZeroResolution(record.zeroResolution,formValues),
      warningsAcknowledged: checked.warnings.length ? confirmDiff.checked : record.warningsAcknowledged,
      reviewedIssues: checked.warnings.length ? checked.warnings : record.reviewedIssues,
      reviewedAt: checked.warnings.length ? new Date().toISOString() : record.reviewedAt,
    };
    const conflicts = await inspectReplacementConflicts([updated], updated.id);
    if (conflicts.length) {
      const lines = conflicts.map(c => `・ID ${c.id} / ${c.fileName}（${c.period.replaceAll('|', ' / ')}）`).join('\n');
      if (!window.confirm(`編集後の明細が保存済みデータと重複します。\n\n【残す明細】\nID ${updated.id} / ${updated.fileName}\n\n【一覧・収入情報から除外する明細：${conflicts.length}件】\n${lines}\n\n「OK」で除外を実行します。\n除外する明細の暗号化PDF原本はOneDriveに保持されますが、一覧からは参照できなくなります。よろしいですか？`)) {
        saving = false; updateUI(); return;
      }
    }
    await updateRecordMetadata(updated, conflicts, recordSignature(record),stage=>appStatus.loading(stage));
    appStatus.success('明細の変更を保存しました');
    leavingAfterSave = true;
    window.location.assign(homeHref);
  } catch (error) {
    leavingAfterSave = false;
    saving = false;
    const detail=error instanceof Error?error.message:String(error);
    if(error instanceof PayrollPartialSuccessError){
      const heading=error.stage==='duplicate-cleanup'
        ? '編集内容は保存済みですが、重複明細の整理が途中までしか完了していません。'
        : error.stage==='year-move'
          ? '編集内容は移動先年度に保存済みですが、移動元年度の明細整理が未完了の可能性があります。'
          : '編集内容は保存済みですが、Finance連携用の収入同期が未完了です。';
      window.alert(`${heading}\n${detail}`);
      leavingAfterSave=true;window.location.assign(homeHref);return;
    }
    showError(`保存処理を完了できませんでした。再読込して最新の状態を確認してください。\n${detail}`);
    updateUI();
  }
});
deleteButton.addEventListener('click', async () => {
  if (!record || saving) return;
  const job = record.form.job === 'main' ? '本業' : '副業';
  const kind = record.form.kind === 'bonus' ? '賞与' : '給与';
  if (!window.confirm(`保存済み明細を1件削除します。\n\n${job} / ${record.form.targetMonth}分 / ${kind}\nファイル: ${record.fileName}\n\n保存済みの入力情報とFinance連携用の収入情報から除外します。\n暗号化PDF原本はOneDriveに保持されますが、明細一覧からは参照できなくなります。\n編集中の未保存内容も破棄されます。復元には削除前のバックアップなどが必要です。\n\n本当に削除しますか？`)) return;
  saving = true;
  appStatus.loading('明細を削除しています…');
  updateUI();
  try {
    await deleteRecord(record.id, recordSignature(record));
    appStatus.success('明細を削除しました');
    leavingAfterSave = true;
    window.location.assign(homeHref);
  } catch (error) {
    leavingAfterSave = false;
    saving = false;
    const detail=error instanceof Error?error.message:String(error);
    if(error instanceof PayrollPartialSuccessError && error.stage==='income-sync'){
      appStatus.clear();
      window.alert(incompleteDeleteIncomeNotice());
      leavingAfterSave=true;
      window.location.assign(homeHref);
      return;
    }
    showError(`削除処理を完了できませんでした。処理が一部確定した可能性があるため、最新の明細一覧を確認してください。\n${detail}`);
    updateUI();
  }
});
window.addEventListener('beforeunload', event => {
  if (leavingAfterSave || !hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});
appStatus.loading('保存済み明細を読み込んでいます…');
void (async () => {
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isSafeInteger(id) || id <= 0) { showError('明細IDが不正です。ホームに戻って選び直してください。'); return; }
  try {
    // Priority-only hint, not a trusted statement location. CloudVault still
    // validates the whole indexed snapshot before returning any editable record.
    const yearHint=new URLSearchParams(location.search).get('hintYear')??undefined;
    record = await getRecordSummary(id,yearHint);
    if (!record) { showError('保存済み明細が見つかりません。'); return; }
    editor.hidden = false;
    appStatus.success('明細を読み込みました');
    $('record-name').textContent = record.fileName;
    $('record-details').textContent = `ID ${record.id} / 登録日時 ${new Date(record.savedAt).toLocaleString('ja-JP')} / PDF ${record.pdfSize.toLocaleString('ja-JP')} bytes`;
    const link = $<HTMLAnchorElement>('original-pdf');
    link.href = `../view/index.html?id=${encodeURIComponent(String(record.id))}`;
    // Opens a new viewer tab synchronously; the already-unlocked editor transfers
    // only the verified PDF Blob over a one-use, lock-aware BroadcastChannel.
    const startHandoff=()=>preparePdfHandoff(link,record!.id,async()=>({
      fileName:record!.fileName,
      pdf:await getOriginalForVerifiedEdit(record!.id,recordSignature(record!)),
    }),capturePdfHandoffAuthorization());
    link.addEventListener('click',event=>{if(!event.defaultPrevented)startHandoff();});
    link.addEventListener('auxclick',event=>{if(event.button===1&&!event.defaultPrevented)startHandoff();});
    const download = $<HTMLAnchorElement>('download-pdf');
    download.href = '#'; // Real bytes are fetched and verified only after a click.
    download.addEventListener('click',async event=>{
      event.preventDefault();
      if(!record||saving||pdfDownloading)return;
      pdfDownloading=true;appStatus.loading('PDF原本を取得・照合しています…');
      try{
        const pdf=await getOriginalForVerifiedEdit(record.id,recordSignature(record));
        const objectUrl=URL.createObjectURL(pdf);
        try{
          const anchor=document.createElement('a');
          anchor.href=objectUrl;anchor.download=safePdfFileName(record.fileName);
          document.body.append(anchor);anchor.click();anchor.remove();
        }finally{window.setTimeout(()=>URL.revokeObjectURL(objectUrl),60_000);}
        appStatus.success('PDFのダウンロードを開始しました');
      }catch(error){showError(`PDF原本を取得できませんでした：${error instanceof Error?error.message:String(error)}`);}
      finally{pdfDownloading=false;}
    });
    fillForm(record.form);
    showState();
    updateUI();
  } catch (error) { showError(error instanceof Error ? error.message : '明細の読み込みに失敗しました。'); }
})();
