import {openRecordDiagnostic} from './ui/recordDiagnostic';
import {personalReviewRows,renderReviewConfirmation,editedReviewRecord} from './ui/payrollReview';
import {confirmOperation,showOperationMessage} from './ui/operationDialog';
import {rememberNavigationNotice} from './ui/navigationNotice';
import {authEpoch} from './cloud/snapshot';
import { createAppStatus } from './ui/appStatus';
import { safePdfFileName } from './storage/fileNaming';
import {preparePdfHandoff} from './pdf/handoff';
import {capturePdfHandoffAuthorization,captureOperationAuthorization,cloudVault} from './cloud/auth';
/** 保存済みレコードの検査・編集。PDF原本と保存IDは保持する。 */
import {deleteRecords,getRecordSummary,getOriginalForVerifiedEdit,updateRecordMetadata,inspectReplacementConflicts,recordSignature,type SavedPayrollSummary} from './storage/payrollStore';
import {reconcilePayrollZeroResolution} from './storage/payrollZeroResolution';
import {validEmployerId} from './storage/employerIdentity';
import {employerDirectorySignature,type EmployerEntry} from './storage/employerDirectory';
import {renderEmployerSelect,employerAssignmentAllowed,employerDisplayName} from './ui/employerSelection';
import { validatePayrollForm, normalizeWorkDays, applicablePayrollForm } from './storage/payrollValidation';
import { storedPdfName } from './storage/fileNaming';
import { showInlineError, clearInlineError } from './ui/feedback';
import {PayrollPartialSuccessError} from './storage/operationError';
import {incompleteDeleteIncomeNotice,incompleteDeleteOriginalNotice} from './ui/deleteOutcome';

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
const reviewConfirmation=$<HTMLElement>('edit-review-confirmation');
let reviewApproval:string|null=null;
const diagnosticButton=$<HTMLButtonElement>('record-diagnostic-open');
const currentReview=$<HTMLElement>('edit-current-review');
const historyReview=$<HTMLElement>('edit-review-history');
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
let deletionPending=false;
let deletionConfirming=false;
let deletionNeedsReload=false;
let deletionAuthorization:(()=>boolean)|undefined;
let leavingAfterSave = false;

const employerInput=$<HTMLSelectElement>('employer-id');
const employerStatus=$<HTMLElement>('employer-status');
let employerDirectory:EmployerEntry[]=[];
let employerRoleSelectionRequired=false;
function refreshEmployerSelect(selected?:string):void{
 renderEmployerSelect(employerInput,employerDirectory,getValues().job,selected);
}
employerInput.addEventListener('change',()=>{employerRoleSelectionRequired=false;reviewApproval=null;clearInlineError(errorView);updateUI();});
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
  refreshEmployerSelect(record?.employerId);
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
function approvalFingerprint():string{return JSON.stringify([getValues(),employerInput.value.trim()]);}
function hasApproval():boolean{return reviewApproval!==null&&reviewApproval===approvalFingerprint();}
function updateUI(): void {
  if (!record) return;
  const values = getValues();
  const { errors, warnings } = validatePayrollForm(values);
  const selected=employerInput.value||undefined;
  if(employerRoleSelectionRequired||!validEmployerId(selected)||!employerAssignmentAllowed(employerDirectory,values.job,selected,record))errors.unshift('勤務区分に対応する勤務先（または未設定）を選び直してください。');
  const changed = hasUnsavedChanges();
  form.inert=deletionPending||deletionNeedsReload;
  deleteButton.textContent=deletionPending?'元に戻す':'削除';
  deleteButton.setAttribute('aria-label',deletionPending?'明細の削除を取り消す':'明細を削除待ちにする');
  saveButton.textContent=deletionPending?'削除を確定':'変更を保存';
  renderReviewConfirmation(reviewConfirmation,confirmDiff,{required:changed&&warnings.length>0,approved:hasApproval(),disabled:saving||errors.length>0,warnings,rows:personalReviewRows(values)});
  currentReview.textContent=errors.length?'現在の入力内容にエラーがあります。':warnings.length?`現在の検算警告：${warnings.length}件${changed?'（保存前の入力内容）':'（保存済みの入力内容）'}`:'検算警告なし（未入力項目を除く）';
  // Show the same calculated rows for saved warnings, without asking for a new approval until edited.
  if(!changed&&warnings.length){
    renderReviewConfirmation(reviewConfirmation,confirmDiff,{required:true,approved:false,disabled:true,warnings,rows:personalReviewRows(values)});
  }
  reviewConfirmation.querySelector('h3')!.textContent=changed?'原本との照合が必要です':'現在の検算警告';
  confirmDiff.closest('label')!.hidden=!changed;
  status.textContent = errors[0] ?? (changed&&warnings.length&&!hasApproval() ? '確認事項を原本と照合してください。' : changed
    ? '未保存の変更があります。'
    : '');
  saveButton.disabled = saving || !changed || errors.length > 0 || Boolean(warnings.length && !hasApproval());
  employerInput.disabled=saving||deletionPending||deletionNeedsReload;
  if(deletionPending||deletionNeedsReload){
    reviewConfirmation.hidden=true;currentReview.hidden=true;
    status.textContent=deletionNeedsReload?'最新データを確認するため画面を開き直してください。':'削除待ち。確定するまで保存済みの明細は変更しません。';
    saveButton.disabled=saving||deletionConfirming||deletionNeedsReload||!deletionAuthorization?.();
  }
  currentReview.hidden=deletionPending||deletionNeedsReload;
  deleteButton.disabled=saving||deletionConfirming||deletionNeedsReload;
  diagnosticButton.disabled=saving||deletionPending||deletionConfirming||deletionNeedsReload;
}
diagnosticButton.addEventListener('click',()=>{
  if(!record||diagnosticButton.disabled)return;
  const target=record,session=captureOperationAuthorization(),unlocked=capturePdfHandoffAuthorization();
  openRecordDiagnostic(()=>JSON.stringify({...target,pdf:{size:target.pdfSize,type:target.pdfType,loaded:false}},null,2),()=>session()&&unlocked()&&record===target&&!diagnosticButton.disabled);
});
function showError(message: string): void {
  appStatus.error(message);
  showInlineError(errorView, message);
}
form.addEventListener('input', event => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.name === 'kind') hideConditional(el.value);
  if (el instanceof HTMLInputElement && el.name === 'job') {
    const selected=employerInput.value||undefined;
    // Preserve unchanged legacy IDs; on a role change require an explicit choice.
    if(selected&&!employerAssignmentAllowed(employerDirectory,el.value,selected,record)){
      refreshEmployerSelect();
      const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='勤務先を選択してください';placeholder.disabled=true;
      employerInput.prepend(placeholder);employerInput.selectedIndex=0;employerRoleSelectionRequired=true;
    }else if(employerRoleSelectionRequired){
      refreshEmployerSelect();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='勤務先を選択してください';placeholder.disabled=true;employerInput.prepend(placeholder);employerInput.selectedIndex=0;
    }else refreshEmployerSelect(selected);
  }
  clearInlineError(errorView);
  reviewApproval=null;
  updateUI();
});
form.addEventListener('change', event => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.name === 'workDays') {
    const next=normalizeWorkDays(el.value);if(next!==el.value)reviewApproval=null;el.value=next;
  }
  clearInlineError(errorView);
  updateUI();
});
form.addEventListener('submit', event => event.preventDefault());
confirmDiff.addEventListener('change', () => { reviewApproval=confirmDiff.checked&&!confirmDiff.disabled?approvalFingerprint():null;clearInlineError(errorView); updateUI(); });
saveButton.addEventListener('click', async () => {
  if(deletionPending){await commitPendingDeletion();return;}
  if (!record || saving || deletionNeedsReload || !hasUnsavedChanges()) return;
  const employerId=employerInput.value.trim()||undefined;
  const formValues = applicablePayrollForm(getValues());
  if(employerRoleSelectionRequired||!validEmployerId(employerId)||!employerAssignmentAllowed(employerDirectory,formValues.job,employerId,record)){showError('勤務区分に対応する勤務先（または未設定）を選び直してください。');return;}
  const checked = validatePayrollForm(formValues);
  if (checked.errors.length) { showError(checked.errors[0]); return; }
  if (checked.warnings.length && !hasApproval()) return;
  const operationEpoch=authEpoch(),authorized=captureOperationAuthorization();
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
      ...editedReviewRecord(record,checked.warnings,hasApproval(),new Date().toISOString()),
    };
    const freshDirectory=await (await cloudVault()).readEmployerDirectory();
    if(!authorized()){saving=false;updateUI();return;}
    if(employerDirectorySignature(freshDirectory)!==employerDirectorySignature(employerDirectory)){
      employerDirectory=freshDirectory;refreshEmployerSelect(employerId);reviewApproval=null;saving=false;appStatus.warning('勤務先一覧が更新されました。選択内容を確認してください。',true);updateUI();return;
    }
    const conflicts = await inspectReplacementConflicts([updated], updated.id);
    if (conflicts.length) {
      const lines = conflicts.map(c => `・${employerDisplayName(employerDirectory,c.employerId,c.period.split('|')[0])} / ${c.fileName}（${c.period.split('|').slice(0,3).join(' / ')}）`).join('\n');
      if(!await confirmOperation({title:'重複する明細を整理',subject:`残す明細：${employerDisplayName(employerDirectory,updated.employerId,updated.form.job)} / ${updated.fileName}`,tone:'danger',acceptLabel:'保存して重複明細を除外',details:[
        `一覧・収入情報から除外する明細：${conflicts.length}件\n${lines}`,
        '明細とFinance連携の確認後、除外対象の未参照PDF原本をごみ箱へ移動します。共有原本は保持します。旧暗号世代の原本は別途確認した整理操作の対象になります。',
      ]},authorized)||!authorized()) {
        saving=false;appStatus.clear();updateUI();return;
      }
    }
    if(!authorized()){saving=false;appStatus.clear();updateUI();return;}
    // Modal confirmation is asynchronous: do not save a draft changed during confirmation.
    if(employerRoleSelectionRequired||JSON.stringify(applicablePayrollForm(getValues()))!==JSON.stringify(formValues)||(employerInput.value.trim()||undefined)!==employerId||(checked.warnings.length&&!hasApproval())){
      saving=false;appStatus.warning('入力内容が変わりました。もう一度確認してください。');updateUI();return;
    }
    await updateRecordMetadata(updated, conflicts, recordSignature(record),stage=>appStatus.loading(stage),employerDirectorySignature(employerDirectory));
    if(!authorized()){saving=false;updateUI();return;}
    if(operationEpoch===authEpoch())rememberNavigationNotice({operation:'edit-saved'},operationEpoch);
    leavingAfterSave = true;
    window.location.assign(homeHref);
  } catch (error) {
    leavingAfterSave = false;
    saving = false;
    const detail=error instanceof Error?error.message:String(error);
    if(error instanceof PayrollPartialSuccessError){
      const heading=error.stage==='duplicate-cleanup'
        ? '編集内容は保存済みですが、重複明細・PDF原本の整理は一部未確認です。'
        : error.stage==='year-move'
          ? '編集内容は移動先年度に保存済みですが、移動元年度の明細整理が未完了の可能性があります。'
          : '編集内容は保存済みですが、Finance連携用の収入同期が未完了です。';
      appStatus.partial(heading);
      saving=true;updateUI();
      await showOperationMessage({title:'明細編集・一部完了',details:[heading,detail],tone:'warning',acceptLabel:'閉じる'},authorized);
      if(!authorized()){saving=false;updateUI();return;}
      if(operationEpoch===authEpoch())rememberNavigationNotice({operation:error.stage==='duplicate-cleanup'?'edit-cleanup-partial':error.stage==='year-move'?'edit-year-partial':'edit-income-partial'},operationEpoch);
      leavingAfterSave=true;window.location.assign(homeHref);return;
    }
    showError(`保存処理を完了できませんでした。再読込して最新の状態を確認してください。\n${detail}`);
    updateUI();
  }
});
deleteButton.addEventListener('click',()=>{
  if(!record||saving||deletionConfirming||deletionNeedsReload)return;
  if(!deletionPending)deletionAuthorization=captureOperationAuthorization();
  if(!deletionAuthorization?.())return;
  deletionPending=!deletionPending;updateUI();
});
async function commitPendingDeletion():Promise<void>{
  if (!record || saving || deletionConfirming || deletionNeedsReload || !deletionPending || !deletionAuthorization?.()) return;
  const job = record.form.job === 'main' ? '本業' : '副業';
  const kind = record.form.kind === 'bonus' ? '賞与' : '給与';
  const target=record,signature=recordSignature(record),operationEpoch=authEpoch(),authorized=deletionAuthorization;
  deletionConfirming=true;updateUI();
  const approved=await confirmOperation({title:'給与明細を削除',subject:`${job} / ${employerDisplayName(employerDirectory,target.employerId,target.form.job)} / ${target.form.targetMonth}分 / ${kind}\n${target.fileName}`,tone:'danger',acceptLabel:'明細を削除',details:[
    '保存済みの入力情報とFinance連携用の収入情報から除外します。',
    '明細とFinance連携の確認後、未参照になった暗号化PDF原本をごみ箱へ移動します。別の明細が参照している原本は保持します。他の端末・タブで保存中でないことを確認してください。',
    '編集中の未保存内容も破棄されます。復元には削除前のバックアップなどが必要です。',
  ]},()=>authorized()&&deletionPending&&record===target);
  deletionConfirming=false;
  if(!approved||!authorized()||saving||record!==target||!deletionPending){updateUI();return;}
  saving = true;
  appStatus.loading('明細を削除しています…');
  updateUI();
  try {
    await deleteRecords([{id:target.id,signature}]);
    if(!authorized()){saving=false;updateUI();return;}
    if(operationEpoch===authEpoch())rememberNavigationNotice({operation:'delete-saved'},operationEpoch);
    leavingAfterSave = true;
    window.location.assign(homeHref);
  } catch (error) {
    leavingAfterSave = false;
    saving = false;
    const detail=error instanceof Error?error.message:String(error);
    if(error instanceof PayrollPartialSuccessError && error.stage==='income-sync'){
      appStatus.partial(incompleteDeleteIncomeNotice());
      saving=true;updateUI();
      await showOperationMessage({title:'明細削除・一部完了',details:[incompleteDeleteIncomeNotice()],tone:'warning',acceptLabel:'閉じる'},authorized);
      if(!authorized()){saving=false;updateUI();return;}
      if(operationEpoch===authEpoch())rememberNavigationNotice({operation:'delete-income-partial'},operationEpoch);
      leavingAfterSave=true;
      window.location.assign(homeHref);
      return;
    }
    if(error instanceof PayrollPartialSuccessError&&error.stage==='original-trash'){
      appStatus.partial(incompleteDeleteOriginalNotice());
      saving=true;updateUI();
      await showOperationMessage({title:'PDF原本の整理・一部完了',details:[incompleteDeleteOriginalNotice()],tone:'warning',acceptLabel:'閉じる'},authorized);
      if(!authorized()){saving=false;updateUI();return;}
      if(operationEpoch===authEpoch())rememberNavigationNotice({operation:'delete-original-partial'},operationEpoch);
      leavingAfterSave=true;window.location.assign(homeHref);return;
    }
    deletionNeedsReload=true;
    showError(`削除処理を完了できませんでした。処理が一部確定した可能性があるため、最新の明細一覧を確認し、設定からFinance連携を再生成してください。\n${detail}`);
    updateUI();
  }
}
window.addEventListener('beforeunload', event => {
  if (leavingAfterSave || (!hasUnsavedChanges()&&!deletionPending&&!saving)) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('pagehide',()=>{if(!saving){deletionPending=false;deletionAuthorization=undefined;}});
window.addEventListener('pageshow',event=>{if(event.persisted)updateUI();});
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
    employerDirectory=await (await cloudVault()).readEmployerDirectory();
    employerStatus.textContent='';
    editor.hidden = false;
    appStatus.success('明細を読み込みました');
    $('record-name').textContent = record.fileName;
    $('record-details').textContent = `PDF ${record.pdfSize < 1024 * 1024 ? `${Math.max(1, Math.round(record.pdfSize / 1024))} KB` : `${(record.pdfSize / 1024 / 1024).toFixed(1)} MB`}`;
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
    const issues=record.reviewedIssues??[];
    historyReview.hidden=!issues.length&&!record.reviewedAt;
    if(!historyReview.hidden){
      const date=historyReview.querySelector<HTMLElement>('[data-review-history-date]')!;
      date.textContent=record.reviewedAt?`確認日時：${new Date(record.reviewedAt).toLocaleString('ja-JP')}`:'確認日時：未記録';
      const list=historyReview.querySelector<HTMLElement>('ul')!;
      for(const issue of issues){const li=document.createElement('li');li.textContent=issue;list.append(li);}
    }
    updateUI();
  } catch (error) { showError(error instanceof Error ? error.message : '明細の読み込みに失敗しました。'); }
})();
