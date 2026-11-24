import {personalReviewRows,renderReviewConfirmation} from './ui/payrollReview';
import {confirmOperation} from './ui/operationDialog';
import {rememberNavigationNotice} from './ui/navigationNotice';
import {authEpoch} from './cloud/snapshot';
import { createAppStatus, type AppStatusKind } from "./ui/appStatus";
import {describePayrollSaveProgress,type PayrollSavePhase} from './ui/operationFeedback';
/**
 * 明細アップロード画面。
 * - PDFをブラウザ内だけで読み取り、ページ数・テキスト取得可否を検証
 * - 本業・副業の確認済み給与書式に限り、当月の金額を自動入力
 * - 確認後のPDF原本と明細を端末内で暗号化しOneDriveへ保存
 */
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { createCoordinateDiagnostic } from "./pdf/diagnostic";
import { redactCoordinateDiagnostic } from "./pdf/redactDiagnostic";
import { parsePayroll, type PdfTextCell, type PayrollParseResult } from "./pdf/payrollParser";
import { saveRecordsSkippingDuplicates, recordSignature, type SavedPayrollRecordInput } from "./storage/payrollStore";
import { cloudVault,captureOperationAuthorization,tryResumeCloudVault } from "./cloud/auth";
import { inspectUploadRecovery, requireSafeUploadRecovery, uploadRecoveryAttempt, uploadRecoveryMessage, type UploadRecoveryAttempt } from "./storage/uploadRecovery";
import { PAYROLL_FIELDS, PayrollEmployerConfirmationError, validatePayrollForm, normalizeWorkDays, applicablePayrollForm, type PayrollFieldKey } from "./storage/payrollValidation";
import {createPayrollSemantics} from './storage/payrollSemantics';
import {validEmployerId} from './storage/employerIdentity';
import {type EmployerEntry} from './storage/employerDirectory';
import {currentEmployer,renderEmployerSelect} from './ui/employerSelection';
import {emptyOptionalAmounts,prepareOptionalZeros,ZERO_OPTIONAL_AMOUNT_LABELS} from './storage/payrollZeroResolution';
import { verifyPdfBytes } from "./storage/pdfIntegrity";
import { storedPdfName } from "./storage/fileNaming";
import { duplicateOwners, pdfFailureMessage, shortFileName } from "./pdf/uploadWorkflow";
import { showInlineError, clearInlineError } from "./ui/feedback";
import {describeUploadDuplicates} from "./ui/duplicateResult";

GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;

type Status = "queued" | "reading" | "ready" | "no-text" | "duplicate" | "error";
type FieldKey = PayrollFieldKey;

type FormValues = Record<FieldKey, string>;
interface Entry {
  id: number;
  file: File;
  status: Status;
  pages: number;
  textCount: number;
  hash?: string;
  error?: string;
  cancelled?: boolean;
  task?: ReturnType<typeof getDocument>;
  currentPage?: number;
  /** PDF解析で値が自動転記された欄。手動修正時に解除する。 */
  autoFields?: Set<FieldKey>;
  form: FormValues;
  employerId?:string;
  employerChosen?:boolean;
  parsed?: PayrollParseResult;
  previewUrl?: string;
  /** このPDFに紐づく警告の確認。別PDFへの切り替えでは変えない。 */
  reviewed?: boolean;
  /** 確認時のフォーム・警告の指紋。中身が変われば確認を失効させる。 */
  reviewedFingerprint?: string;
}

const MAX_FILES = 30;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// 圧縮率の高い大量ページPDFで、ブラウザが無制限に解析を続けないようにする。
const MAX_PARSE_PAGES = 100;
const MAX_TEXT_ITEMS = 100_000;
const FIELDS: readonly FieldKey[] = PAYROLL_FIELDS;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`HTML要素が見つかりません: #${id}`);
  return element as T;
};
const dropZone = $<HTMLDivElement>("drop-zone");
const mobileFilePicker = $<HTMLButtonElement>("mobile-file-picker");
const fileInput = $<HTMLInputElement>("file-input");
const fileList = $<HTMLUListElement>("file-list");
const listEmpty = $<HTMLDivElement>("file-list-empty");
const reviewEmpty = $<HTMLDivElement>("review-empty");
const reviewContent = $<HTMLDivElement>("review-content");
const reviewForm = $<HTMLFormElement>("review-form");
const employerInput = $<HTMLSelectElement>("employer-id");
const employerLoad = $<HTMLButtonElement>("employer-load");
const employerStatus = $<HTMLElement>("employer-status");
let employerDirectory:EmployerEntry[]|undefined;
let employerLoading=false;
let employerLoadFailed=false;
function defaultEmployer(entry:Entry):void{
 if(entry.employerChosen||!employerDirectory)return;
 const next=currentEmployer(employerDirectory,entry.form.job);
 if(entry.employerId!==next){entry.employerId=next;setReviewed(entry,false);}
}
/** Explicit load or save preflight. Never write on the first load or after a directory change. */
async function refreshEmployerChoices(allowPrompt=true):Promise<boolean>{
 if(employerLoading)return false;
 employerLoading=true;updateSaveState();
 employerStatus.textContent='勤務先一覧を確認しています…';
 const authorized=captureOperationAuthorization();
 try{
  const vault=allowPrompt?await cloudVault():await tryResumeCloudVault();
  if(!vault){employerStatus.textContent='';return false;}
  const fresh=await vault.readEmployerDirectory();
  if(!authorized())return false;
  const before=entries.map(entry=>entry.employerId??null);
  employerDirectory=fresh;employerLoadFailed=false;
  for(const entry of entries){
   if(entry.employerId&&!fresh.some(x=>x.id===entry.employerId&&x.role===entry.form.job)){entry.employerId=undefined;entry.employerChosen=false;setReviewed(entry,false);}
   defaultEmployer(entry);
  }
  const unchanged=entries.length===before.length&&entries.every((entry,i)=>(entry.employerId??null)===before[i]);
  employerStatus.textContent='';
  render();
  if(allowPrompt&&!unchanged)notice('info','勤務先の選択が更新されました。確認して保存してください。');
  return unchanged;
 }catch{employerLoadFailed=true;employerStatus.textContent='勤務先一覧を確認できませんでした。もう一度読み込んでください。';if(allowPrompt)notice('error',employerStatus.textContent);return false;}
 finally{employerLoading=false;updateSaveState();}
}
const readResult = $<HTMLDivElement>("read-result");
const validationMessage = $<HTMLParagraphElement>("validation-message");
const reviewConfirmation = $<HTMLElement>("upload-review-confirmation");
const reviewConfirm = $<HTMLInputElement>("upload-review-confirm");
const clearButton = $<HTMLButtonElement>("clear-files");
const progressWrap = $<HTMLDivElement>("progress-wrap");
const progressFill = $<HTMLDivElement>("progress-fill");
const progressText = $<HTMLSpanElement>("progress-text");
const toast = $<HTMLDivElement>("toast");
const appStatus=createAppStatus(toast);
const diagnosticButton = $<HTMLButtonElement>("diagnostic-button");
const diagnosticDialog = $<HTMLDialogElement>("diagnostic-dialog");
const diagnosticClose = $<HTMLButtonElement>("diagnostic-close");
const diagnosticShared = $<HTMLTextAreaElement>("diagnostic-shared");
const diagnosticCopy = $<HTMLButtonElement>("diagnostic-copy");
const diagnosticRedact = $<HTMLButtonElement>("diagnostic-redact");
const diagnosticViewOriginal = $<HTMLButtonElement>("diagnostic-view-original");
const diagnosticCopyOriginal = $<HTMLButtonElement>("diagnostic-copy-original");
let diagnosticRawText = "";
const diagnosticState = $<HTMLParagraphElement>("diagnostic-state");
const analysisIssues = $<HTMLElement>("analysis-issues");
const analysisIssuesList = $<HTMLUListElement>("analysis-issues-list");
const analysisIssuesCount = $<HTMLElement>("analysis-issues-count");
const saveButton = $<HTMLButtonElement>("save-all");
const saveButtonLabel = $<HTMLSpanElement>("save-all-label");
const zeroApproval = $<HTMLElement>("zero-approval");
const zeroCheckbox = $<HTMLInputElement>("zero-missing-amounts");
const zeroCount = $<HTMLElement>("zero-approval-count");
const zeroList = $<HTMLUListElement>("zero-approval-list");
let zeroConsentFingerprint: string | null = null;
zeroCheckbox.checked=false; // Never restore a sensitive batch-wide approval from browser form history.
window.addEventListener('pageshow',()=>{
  zeroCheckbox.checked=false;zeroConsentFingerprint=null;updateSaveState();
});
function zeroCandidatesFingerprint(items: readonly Entry[]): string {
  return JSON.stringify(items.map(entry=>[entry.id,entry.hash??'',entry.status,
    FIELDS.map(field=>entry.form[field]),entry.employerId??null,entry.parsed?.missingFields??[]]));
}
zeroCheckbox.addEventListener('change',()=>{
  zeroConsentFingerprint=zeroCheckbox.checked?zeroCandidatesFingerprint(candidates()):null;
  updateSaveState();
});
const saveStatus = $<HTMLElement>("save-status");
const uploadGuide = $<HTMLParagraphElement>("upload-guide");
const workspace = document.querySelector<HTMLElement>(".workspace")!;
const saveBar = document.querySelector<HTMLElement>(".save-bar")!;
const saveFeedback = $<HTMLElement>("save-feedback");
const saveStage = $<HTMLElement>("save-stage");
const saveElapsed = $<HTMLElement>("save-elapsed");
const saveProgress = $<HTMLElement>("save-progress-track");
const saveProgressFill = $<HTMLElement>("save-progress-fill");
const saveGuidance = $<HTMLElement>("save-guidance");
const uploadRecovery = $<HTMLElement>("upload-save-recovery");
const uploadRecoveryStatus = $<HTMLElement>("upload-save-recovery-status");
const uploadRecoveryRecheck = $<HTMLButtonElement>("upload-save-recheck");
const uploadRecoveryReload = $<HTMLButtonElement>("upload-save-reload");
const saveDuplicates = $<HTMLElement>("save-duplicates");
const saveDuplicateList = $<HTMLUListElement>("save-duplicate-list");
const saveDuplicateTitle = $<HTMLElement>("save-duplicate-title");
const reviewPanel = document.querySelector<HTMLElement>(".review-panel");

let entries: Entry[] = [];
let selectedId: number | null = null;
let nextId = 1;
let reading = false;
let uploadInitialized = false;
let saving = false;
let leavingAfterSave = false;
let uploadSaveRecoveryRequired=false;
let uploadSaveRecoveryChecked=false;
let uploadSaveRecoveryChecking=false;
let uploadSaveAttempt:UploadRecoveryAttempt[]=[];
let wasParsing=false;
let saveTick:ReturnType<typeof setInterval>|undefined;
let saveStartedAt=0;
let lastSaveUpdateAt=0;
let lastSaveMessage='';
let savePhase:PayrollSavePhase=0;
let savePhaseLabel='保存の準備中';
function stopSaveClock():void {if(saveTick!==undefined){clearInterval(saveTick);saveTick=undefined;}}
function updateSaveClock():void {
 if(!saveStartedAt)return;
 const seconds=Math.max(0,Math.floor((Date.now()-saveStartedAt)/1000));
 const waiting=Math.floor((Date.now()-lastSaveUpdateAt)/1000);
 const time=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
 saveElapsed.textContent=`経過 ${time}${saving&&waiting>=20?' · OneDriveの応答待ち':''}`;
 if(saving&&waiting>=20)saveGuidance.textContent='通信応答を待っています。保存中は画面を移動せず、追加アップロードもしないでください。';
}
function beginSaveFeedback():void {
 appStatus.loading('明細を保存しています…');
 saveFeedback.hidden=false;saveFeedback.classList.remove('is-failed','is-complete');
 saveDuplicates.hidden=true;saveDuplicateList.replaceChildren();
 saveStartedAt=Date.now();lastSaveUpdateAt=saveStartedAt;lastSaveMessage='';savePhase=0;savePhaseLabel='保存の準備中';
 saveStage.textContent='保存の準備中';saveStage.dataset.phase='0';saveProgress.setAttribute('aria-label','保存処理の進捗');
 saveGuidance.textContent='保存中は画面移動・追加アップロードをしないでください。重複除外があった場合は結果を表示し、通常の保存完了時はホームへ戻ります。';
 saveProgress.classList.add('is-indeterminate');saveProgressFill.style.width='28%';
 saveProgress.removeAttribute('aria-valuenow');
 stopSaveClock();updateSaveClock();saveTick=setInterval(updateSaveClock,1000);
}
function showSaveProgress(message:string):void {
 if(message!==lastSaveMessage){lastSaveUpdateAt=Date.now();lastSaveMessage=message;}
 const view=describePayrollSaveProgress(message);
 // Parallel PDFs can report in different order. Do not move the visible stage backwards.
 if(view.phase>=savePhase){savePhase=view.phase;savePhaseLabel=`${view.count}${view.title}`;}
 saveStage.textContent=savePhaseLabel;
 saveStage.dataset.phase=String(savePhase);
 appStatus.loading(savePhaseLabel);
 if(view.percent!==null&&view.phase===savePhase){
   saveProgress.classList.remove('is-indeterminate');
   saveProgressFill.style.width=`${view.percent}%`;
   saveProgress.setAttribute('aria-valuenow',String(view.percent));
   saveProgress.setAttribute('aria-label','現在のPDF送信率');
 }else{
   saveProgress.classList.add('is-indeterminate');
   saveProgressFill.style.width='28%';
   saveProgress.removeAttribute('aria-valuenow');
   saveProgress.setAttribute('aria-label','保存処理中（全体の完了率は未確定）');
 }
 saveStatus.textContent=message;
 saveGuidance.textContent='保存中は画面移動・追加アップロードをしないでください。重複除外があった場合は結果を表示し、通常の保存完了時はホームへ戻ります。';
 updateSaveClock();
}
function notice(kind:Exclude<AppStatusKind,'loading'>,message: string): void {
  appStatus.show(kind,message);
}
function makeForm(): FormValues {
  return Object.fromEntries(FIELDS.map(key => [key, ""])) as FormValues;
}
/** 勤務日数は実際のPDF値から小数点以下を切り上げて管理する。未入力・不正値はそのまま検証へ回す。 */
const ceilWorkDays = normalizeWorkDays;
function selectedEntry(): Entry | undefined {
  return entries.find(entry => entry.id === selectedId);
}
function duplicated(): Map<number, number> { return duplicateOwners(entries); }
function candidates(): Entry[] {
  const dup = duplicated();
  return entries.filter(entry => !dup.has(entry.id));
}
/** 削除されたファイルの処理を中断。保管済みのPDFには作用しない。 */
function abortEntry(entry: Entry): void {
  entry.cancelled = true;
  if (entry.task) void entry.task.destroy().catch(() => {});
}
/** 重複元を削除したら、残ったコピーを再解析して通常の保存候補へ戻す。 */
function activateOrphanDuplicates(): void {
  const dup = duplicated();
  let requeued = false;
  for (const entry of entries) {
    if (entry.status === 'duplicate' && !dup.has(entry.id)) {
      entry.status = 'queued';
      entry.parsed = undefined;
      entry.autoFields = undefined;
      entry.form = makeForm();
      entry.cancelled = false;
      requeued = true;
    }
  }
  if (requeued) void drainQueue();
}
function stillActive(entry: Entry): void {
  if (entry.cancelled || !entries.includes(entry)) throw new Error('解析が中断されました。');
}

/** 確認済みの対象を明細ごとに固定する。フォーム・警告が変わったら失効。 */
function reviewFingerprint(entry: Entry): string {
  return JSON.stringify([
    entry.status,
    FIELDS.map(key => entry.form[key]),
    entry.employerId??null,
    entry.parsed?.profile ?? null,
    entry.parsed?.warnings ?? [],
    entry.parsed?.missingFields ?? [],
  ]);
}
function isReviewed(entry: Entry): boolean {
  return entry.reviewed === true && entry.reviewedFingerprint === reviewFingerprint(entry);
}
function setReviewed(entry: Entry, value: boolean): void {
  entry.reviewed = value;
  entry.reviewedFingerprint = value ? reviewFingerprint(entry) : undefined;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}
function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function statusLabel(entry: Entry): { label: string; variant: string } {
  if (duplicated().has(entry.id)) return { label: "同一PDF（保存対象外）", variant: "warning" };
  switch (entry.status) {
    case "queued": return { label: "読み取り待ち", variant: "pending" };
    case "reading": return { label: "読み取り中", variant: "pending" };
    case "ready": {
      if (validatePayrollForm(entry.form).errors.length || hasReviewIssue(entry)) {
        return isReviewed(entry) && !validatePayrollForm(entry.form).errors.length
          ? { label: "確認済み", variant: "confirmed" }
          : { label: "要確認", variant: "warning" };
      }
      return { label: "自動入力済み", variant: "ready" };
    }
    case "no-text": return isReviewed(entry)
      ? { label: "確認済み", variant: "confirmed" }
      : { label: "要確認", variant: "warning" };
    case "duplicate": return { label: "要確認", variant: "warning" };
    // 解析不能で保存不可。入力の手動確認で解消できる「要確認」と分ける。
    case "error": return { label: "読み取り失敗", variant: "error" };
  }
}
function renderFileList(): void {
  const hasFiles = entries.length > 0;
  listEmpty.hidden = hasFiles;
  fileList.hidden = !hasFiles;
  clearButton.hidden = !hasFiles;
  $("file-count").textContent = `${entries.length}件`;
  const completed = entries.filter(entry => entry.status !== "queued" && entry.status !== "reading").length;
  const active = entries.some(entry => entry.status === "queued" || entry.status === "reading");
  if(active&&!wasParsing)appStatus.loading('PDFを解析しています…');
  if(!active&&wasParsing)appStatus.success('PDFの解析が完了しました');
  wasParsing=active;
  $("file-summary").textContent = !hasFiles ? "PDF追加待ち" : active ? `${completed} / ${entries.length} 件のPDF解析が完了` : `${entries.length}件の確認が可能です（未保存）`;
  progressWrap.hidden = !active;
  const parsing = entries.find(entry => entry.status === "reading");
  progressText.textContent = parsing
    ? `${completed} / ${entries.length} · ${shortFileName(parsing.file.name, 26)}${parsing.pages ? `（${parsing.currentPage ?? 0}/${parsing.pages}ページ）` : ""}`
    : `${completed} / ${entries.length}`;
  progressFill.style.width = `${hasFiles ? completed * 100 / entries.length : 0}%`;
  fileList.replaceChildren();

  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = `file-list__item${entry.id === selectedId ? " is-selected" : ""}`;
    // 明細カード全体をボタンにする。削除ボタンのみ独立した操作として残す。
    // ボタンの入れ子を避けるため、選択操作と削除操作は兄弟要素にする。
    const select = document.createElement("button");
    select.type = "button";
    select.className = "file-list__select";
    select.setAttribute("aria-label", `${entry.file.name} の内容を確認`);
    select.setAttribute("aria-pressed", String(entry.id === selectedId));
    select.addEventListener("click", () => selectFile(entry.id));

    const iconBox = document.createElement("span");
    iconBox.className = "file-list__icon";
    iconBox.append(icon("file"));
    const label = document.createElement("span");
    label.className = "file-list__text";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = entry.file.name;
    name.title = entry.file.name;
    const size = document.createElement("span");
    size.className = "file-caption";
    const employer=employerDirectory?.find(x=>x.id===entry.employerId);
    size.textContent = `${formatBytes(entry.file.size)}${entry.pages ? ` · ${entry.pages}ページ` : ""}${employer?` · ${employer.name}`:""}`;
    const status = document.createElement("span");
    const state = statusLabel(entry);
    status.className = `file-status file-status--${state.variant}`;
    status.textContent = state.label;
    label.append(name, size, status);
    select.append(iconBox, label);

    // 「表示中」は選択状態の目印であり、切り替え専用のボタンではない。
    if (entry.id === selectedId) {
      const current = document.createElement("span");
      current.className = "file-list__current";
      current.textContent = "表示中";
      current.title = "右側に表示している明細";
      select.append(current);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-list__remove";
    remove.setAttribute("aria-label", `${entry.file.name} を一覧から削除`);
    remove.title = "一覧から削除";
    remove.append(icon("close"));
    remove.addEventListener("click", () => removeFile(entry.id));

    item.append(select, remove);
    fileList.append(item);
  }
}
/** 複数PDFを操作するため、リストと確認フォームの選択を必ず同期する。 */
function selectFile(id: number): void {
  if (saving) return;
  if (!entries.some(entry => entry.id === id)) return;
  selectedId = id;
  render();
  reviewPanel?.scrollTo({ top: 0 });
}
/** 不足欄や異常の理由を見せる。未検出をゼロとして補完しない。 */
function renderIssues(entry: Entry): void {
  analysisIssuesList.replaceChildren();
  const items: { text: string; severity: "warning" | "error" }[] = [];
  if (entry.status === "error") {
    items.push({ text: `${entry.error ?? "PDFを読み取れませんでした。"} このPDFは保存できません。`, severity: "error" });
  } else if (entry.status === "no-text") {
    items.push({ text: "文字を取得できません。画像形式などの可能性があります。", severity: "warning" });
  } else if (duplicated().has(entry.id)) {
    const original = entries.find(item => item.id === duplicated().get(entry.id));
    items.push({ text: `同じPDFが一覧にあります。「${original?.file.name ?? "先に追加したPDF"}」を優先し、このファイルは保存しません。`, severity: "warning" });
  }
  for (const missing of entry.parsed?.missingFields ?? []) {
    const manuallyEntered = missing.field ? entry.form[missing.field].trim() !== "" : false;
    const description = missing.reason === "absent"
      ? `想定した「${missing.label}」欄がPDF内に見つかりませんでした。`
      : `「${missing.label}」欄はありますが、値を取得できませんでした。`;
    items.push({ text: description + (manuallyEntered ? "（入力欄は手動入力済み）" : " 原本をご確認ください。"), severity: "warning" });
  }
  for (const warning of entry.parsed?.warnings ?? []) {
    items.push({ text: warning, severity: "warning" });
  }
  analysisIssues.hidden = items.length === 0;
  analysisIssuesCount.textContent = `${items.length}件`;
  for (const { text, severity } of items) {
    const li = document.createElement("li");
    li.className = `analysis-issues__item analysis-issues__item--${severity}`;
    li.textContent = text;
    analysisIssuesList.append(li);
  }
  for (const field of Array.from(reviewForm.querySelectorAll<HTMLElement>(".field"))) {
    const control = field.querySelector<HTMLInputElement>("input[name], select[name]");
    if (!control) continue;
    const missing = entry.parsed?.missingFields.some(item => item.field === control.name && entry.form[control.name as FieldKey] === "") ?? false;
    field.classList.toggle("field--missing", missing);
    const automatic = entry.autoFields?.has(control.name as FieldKey) ?? false;
    field.classList.toggle("field--auto", automatic && entry.form[control.name as FieldKey] !== "");
    field.classList.toggle("field--manual", !automatic && entry.form[control.name as FieldKey] !== "");
    const source = entry.parsed?.fieldSources?.[control.name as FieldKey];
    if (automatic && source) {
      control.title = `PDF自動抽出: ${source.page}ページ「${source.label}」 x=${source.valueX.toFixed(1)} y=${source.valueY.toFixed(1)}`;
    } else if (automatic) control.title = 'PDFから自動入力しました。原本をご確認ください。';
    else if (entry.form[control.name as FieldKey] !== '') control.title = '手動入力値です。';
    else control.removeAttribute('title');
  }
}

function updateConditionalFields(kind: string): void {
  for (const field of Array.from(reviewForm.querySelectorAll<HTMLElement>("[data-bonus-only]"))) {
    field.hidden = kind !== "bonus";
  }
  for (const field of Array.from(reviewForm.querySelectorAll<HTMLElement>("[data-salary-only]"))) {
    field.hidden = kind === "bonus";
  }
}
function renderReview(): void {
  const entry = selectedEntry();
  reviewEmpty.hidden = Boolean(entry);
  reviewContent.hidden = !entry;
  if (!entry) return;
  $("selected-name").textContent = entry.file.name;
  $("selected-meta").textContent = `${formatBytes(entry.file.size)}${entry.pages ? ` · ${entry.pages}ページ` : ""} · 原本ファイル`;
  readResult.className = "read-result";
  if (duplicated().has(entry.id)) {
    readResult.textContent = "同一内容のPDFは一覧内で最初の1件だけ保存します。このファイルは保存対象外です。";
    readResult.classList.add("read-result--warning");
  } else if (entry.status === "queued" || entry.status === "reading") {
    readResult.textContent = `PDFを解析しています。${entry.pages ? ` ${entry.currentPage ?? 0}/${entry.pages}ページ` : ""}`;
  } else if (entry.status === "ready") {
    const parsed = entry.parsed;
    if (parsed?.profile) {
      if (parsed.layout?.status === "suspect") {
        readResult.textContent = `PDFの書式変更が疑われるため、自動入力を停止しました。原本を確認し、各欄を手動入力してください。${parsed.warnings.join(" / ")}`;
        readResult.classList.add("read-result--warning");
      } else {
        const source = parsed.profile === "main" ? "本業" : "副業";
        const count = Object.keys(parsed.fields).filter(key => parsed.fields[key as FieldKey] !== undefined).length;
        readResult.textContent = `${source}の${parsed.fields.kind === "bonus" ? "賞与" : "給与"}明細と判定し、${count}項目を自動入力しました。${parsed.sourcePage ? `取得元は${parsed.sourcePage}ページ目です。` : ''}原本と照合してから確認してください。`;
        if (parsed.warnings.length) {
          readResult.classList.add("read-result--warning");
          readResult.textContent += ` ${isReviewed(entry) ? "確認済み" : "要確認"}：${parsed.warnings.join(" / ")}`;
        }
      }
    } else {
      readResult.textContent = `${entry.pages}ページ / ${entry.textCount}件の文字を取得しました。${parsed?.warnings.join(" / ") ?? "項目を手動で確認してください。"}`;
      readResult.classList.add("read-result--warning");
    }
  } else if (entry.status === "no-text") {
    readResult.classList.add("read-result--warning");
    readResult.textContent = "PDFを開けましたが文字情報を取得できませんでした。画像PDFなどの可能性があります。OCRは未対応です。";
  } else if (entry.status === "duplicate") {
    readResult.classList.add("read-result--warning");
    readResult.textContent = "この選択内に内容が同じPDFがすでにあります。二重登録を防ぐため、後の登録処理では確認が必要です。";
  } else {
    readResult.classList.add("read-result--error");
    readResult.textContent = `PDFを読み取れませんでした。${entry.error ?? "ファイル形式をご確認ください。"}`;
  }
  for (const key of FIELDS) {
    if (key === "job" || key === "kind") {
      // 同じnameに複数あるradioはRadioNodeListになるので個別にcheckedを同期。
      for (const radio of Array.from(reviewForm.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${key}"]`))) {
        radio.checked = radio.value === entry.form[key];
      }
    } else {
      const element = reviewForm.elements.namedItem(key);
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        element.value = entry.form[key];
      }
    }
  }
  renderEmployerSelect(employerInput,employerDirectory??[],entry.form.job,entry.employerId);
  employerInput.disabled=saving||employerLoading||!employerDirectory||entry.status==='queued'||entry.status==='reading'||duplicated().has(entry.id)||!['main','side'].includes(entry.form.job);
  updateConditionalFields(entry.form.kind);
  // 解析中に入力しても後からPDFの結果で上書きされないよう、完了まで編集不可。
  const isReading = entry.status === "queued" || entry.status === "reading" || duplicated().has(entry.id);
  for (const control of Array.from(reviewForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name],select[name]"))) control.disabled = isReading;
  renderIssues(entry);
}
function render(): void {
  renderFileList();
  renderReview();
  updateSaveState();
}
function removeFile(id: number): void {
  if (saving || uploadSaveRecoveryChecking) return;
  const entry = entries.find(item => item.id === id);
  if (entry) abortEntry(entry);
  if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entries = entries.filter(item => item.id !== id);
  if (selectedId === id) selectedId = entries[0]?.id ?? null;
  activateOrphanDuplicates();
  render();
}
function addFiles(files: File[]): void {
  if (saving || uploadSaveRecoveryChecking) { notice("info","保存処理中はPDFを追加できません。"); return; }
  if (!files.length) return;
  saveFeedback.hidden=true;
  let rejected = 0;
  let added = 0;
  for (const file of files) {
    if (entries.length >= MAX_FILES) { rejected++; continue; }
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { rejected++; continue; }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) { rejected++; continue; }
    const entry: Entry = { id: nextId++, file, status: "queued", pages: 0, textCount: 0, form: makeForm() };
    entries.push(entry);
    if (selectedId === null) selectedId = entry.id;
    added++;
  }
  render();
  if (rejected) notice("warning",`${rejected}件を追加できませんでした。PDF形式・25MB以下・最大30件をご確認ください。`);
  if (added) void drainQueue();
}
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function inspect(entry: Entry): Promise<void> {
  stillActive(entry);
  entry.status = "reading";
  renderFileList();
  if (selectedId === entry.id) renderReview();
  try {
    const bytes = await entry.file.arrayBuffer();
    stillActive(entry);
    verifyPdfBytes(new Uint8Array(bytes));
    // HTTPSまたはlocalhostならWeb Cryptoで完全一致の重複を検知できる。
    if (typeof crypto !== "undefined" && crypto.subtle) {
      try {
        const digest = await crypto.subtle.digest("SHA-256", bytes.slice(0));
        stillActive(entry);
        entry.hash = toHex(digest);
        // 一覧内の同一PDFは先に追加したものを優先し、保存対象から外す。
        if (duplicated().has(entry.id)) {
          entry.status = "duplicate";
          return;
        }
      } catch {
        // ハッシュが使えなくてもPDFの文字抽出は継続する。
      }
    }
    const task = getDocument({
      data: new Uint8Array(bytes),
        cMapUrl: new URL("./cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./standard_fonts/", import.meta.url).href,
      wasmUrl: new URL("./wasm/", import.meta.url).href,
      iccUrl: new URL("./iccs/", import.meta.url).href,
    });
    entry.task = task;
    try {
      const pdf = await task.promise;
      stillActive(entry);
      entry.pages = pdf.numPages;
      renderFileList();
      if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PARSE_PAGES) {
        throw new Error(`PDFのページ数が上限（${MAX_PARSE_PAGES}ページ）を超えています。`);
      }
      let count = 0;
      const coordinateItems: PdfTextCell[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        stillActive(entry);
        entry.currentPage = pageNumber;
        renderFileList();
        if (selectedId === entry.id) renderReview();
        const page = await pdf.getPage(pageNumber);
        stillActive(entry);
        const content = await page.getTextContent();
        stillActive(entry);
        for (const item of content.items) {
          if (!( "str" in item) || !item.str.trim()) continue;
          count++;
          if (count > MAX_TEXT_ITEMS) throw new Error('PDFの文字情報が上限を超えています。');
          // 全ページの座標を保持し、後続ページにある明細も解析する。
          {
            coordinateItems.push({
              page: pageNumber,
              text: item.str,
              x: item.transform[4],
              y: item.transform[5],
              width: item.width,
              height: item.height,
            });
          }
        }
      }
      entry.textCount = count;
      if (count) {
        entry.parsed = parsePayroll(coordinateItems);
        entry.autoFields = new Set();
        // 自動検出できた項目だけ反映し、不明な項目は空欄のまま残す。
        for (const [key, value] of Object.entries(entry.parsed.layout?.status === "suspect" ? {} : entry.parsed.fields)) {
          if (value !== undefined && FIELDS.includes(key as FieldKey)) {
            entry.form[key as FieldKey] = key === "workDays" ? ceilWorkDays(value) : value;
            entry.autoFields.add(key as FieldKey);
          }
        }
      }
      entry.status = count ? "ready" : "no-text";
      defaultEmployer(entry);
    } finally {
      entry.task = undefined;
      await task.destroy();
    }
  } catch (error) {
    if (!entry.cancelled) {
      entry.status = "error";
      entry.error = pdfFailureMessage(error);
    }
  } finally {
    // 読み取り結果が確定した時点でだけ、このPDFの確認状態を初期化する。
    setReviewed(entry, false);
    // 途中で一覧から削除されても、非同期完了で再追加しない。
    if (entries.includes(entry)) {
      renderFileList();
      if (selectedId === entry.id) renderReview();
      updateSaveState();
    }
  }
}
async function drainQueue(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    while (true) {
      const next = entries.find(entry => entry.status === "queued");
      if (!next) break;
      await inspect(next);
    }
  } finally {
    reading = false;
    renderFileList();
    updateSaveState();
  }
}

// クリックで選択。ドロップ後に意図せず選択ダイアログが出ないよう抑止する。
let suppressPickerUntil = 0;
mobileFilePicker.addEventListener("click", () => { if (!fileInput.disabled) fileInput.click(); });
dropZone.addEventListener("click", () => {
  if (fileInput.disabled || dragDepth || Date.now() < suppressPickerUntil) return;
  fileInput.click();
});
dropZone.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  if (fileInput.disabled || dragDepth || Date.now() < suppressPickerUntil) return;
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  if (fileInput.disabled) { fileInput.value = ""; return; }
  addFiles(Array.from(fileInput.files ?? []));
  fileInput.value = "";
});
let dragDepth = 0;
dropZone.addEventListener("dragenter", event => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth++;
  dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragover", event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
dropZone.addEventListener("dragleave", event => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropZone.classList.remove("is-dragging");
  suppressPickerUntil = Date.now() + 500;
});
dropZone.addEventListener("drop", event => {
  event.preventDefault();
  dragDepth = 0;
  suppressPickerUntil = Date.now() + 600;
  dropZone.classList.remove("is-dragging");
  if (fileInput.disabled) return;
  addFiles(Array.from(event.dataTransfer?.files ?? []));
});
// ドロップエリア以外へPDFを落としても、ブラウザがPDFへ遷移しないようにする。
document.addEventListener("dragover", event => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
document.addEventListener("drop", event => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  const target = event.target;
  if (target instanceof Node && !dropZone.contains(target)) {
    notice("info","PDFは上の点線エリアにドロップしてください。");
  }
});
clearButton.addEventListener("click", () => {
  if(saving||uploadSaveRecoveryChecking)return;
  // ページで選択した未保存データだけを削除。保存済みDBには影響しない。
  for (const entry of entries) {
    abortEntry(entry);
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  }
  entries = [];
  selectedId = null;
  render();
  notice("info","選択中のPDFを一覧から削除しました。保存済みデータは削除されません。");
});
employerInput.addEventListener('change',()=>{
 const entry=selectedEntry();if(!entry||employerInput.disabled||!employerDirectory)return;
 const next=employerInput.value||undefined;
 if(next&&!employerDirectory.some(x=>x.id===next&&x.role===entry.form.job))return;
 entry.employerChosen=true;
 if(entry.employerId===next)return;
 entry.employerId=next;setReviewed(entry,false);renderFileList();updateSaveState();
});
employerLoad.addEventListener('click',()=>{if(!saving&&!employerLoading&&!uploadSaveRecoveryChecking)void refreshEmployerChoices();});
reviewForm.addEventListener("input", event => {
  const target = event.target;
  const entry = selectedEntry();
  if (!entry || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const key = target.name as FieldKey;
  if (!FIELDS.includes(key) || entry.form[key] === target.value) return;
  entry.form[key] = target.value;
  if(key==="job"){entry.employerChosen=false;entry.employerId=undefined;defaultEmployer(entry);renderEmployerSelect(employerInput,employerDirectory??[],entry.form.job,entry.employerId);}
  entry.autoFields?.delete(key);
  if (key === "kind") updateConditionalFields(target.value);
  // 値が本当に変更された明細だけ確認を解除する。
  setReviewed(entry, false);
  renderIssues(entry);
  renderFileList();
  updateSaveState();
});
// 手入力時は編集中の小数入力を邪魔せず、確定時に切り上げる。
reviewForm.addEventListener("change", event => {
  const input = event.target;
  const entry = selectedEntry();
  if (!(input instanceof HTMLInputElement) || input.name !== "workDays" || !entry) return;
  const rounded = ceilWorkDays(input.value);
  input.value = rounded;
  if (entry.form.workDays !== rounded) {
    entry.form.workDays = rounded;
    entry.autoFields?.delete("workDays");
    setReviewed(entry, false);
  }
  renderIssues(entry);
  renderFileList();
  updateSaveState();
});
reviewForm.addEventListener("submit", event => event.preventDefault());
$("open-pdf").addEventListener("click", () => {
  const entry = selectedEntry();
  if (!entry) return;
  if (!entry.previewUrl) {
    // File.type はアップロード元が指定できるため、PDFプレビュー時はMIMEを固定する。
    // 「.pdf」なのに text/html のFileでも、HTMLとして開かないようにする。
    entry.previewUrl = URL.createObjectURL(new Blob([entry.file], { type: "application/pdf" }));
  }
  const a = document.createElement("a");
  a.href = entry.previewUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
});
reviewConfirm.addEventListener("change", () => {
  const entry=selectedEntry();
  if(!entry||reviewConfirm.disabled||duplicated().has(entry.id))return;
  const approved=reviewConfirm.checked&&hasReviewIssue(entry)&&reviewForm.reportValidity()&&validEmployerId(entry.employerId)&&!formError(entry)&&entry.status!=="error";
  setReviewed(entry,approved);
  renderFileList();updateSaveState();
});
/** 検算差異もチェック対象。破損PDFは確認に関係なく保存不可。 */
function hasReviewIssue(entry: Entry): boolean {
  return entry.status === "no-text" || (entry.status === "ready" && (!entry.parsed?.profile
    || Boolean(entry.parsed.warnings.length || entry.parsed.missingFields.length)))
    || validatePayrollForm(entry.form).warnings.length > 0;
}
function formError(entry: Entry): string | null {
  return validatePayrollForm(entry.form).errors[0] ?? null;
}
/** A missing-to-zero opt-in is not permission to ignore NEW arithmetic warnings. */
function zeroIntroducedWarnings(entry: Entry): string[] {
  const before=new Set(validatePayrollForm(entry.form).warnings);
  const prepared=prepareOptionalZeros(entry.form,{},true);
  return validatePayrollForm(prepared.form).warnings.filter(warning=>!before.has(warning));
}
/** The HTML starts disabled. Only enable the picker after all listeners and the
 * first render have completed; a static DOM is not an initialized upload page. */
function updateFilePickerState(): void {
  if (!uploadInitialized) return;
  fileInput.disabled = saving || uploadSaveRecoveryChecking;
  mobileFilePicker.disabled = saving || uploadSaveRecoveryChecking;
  dropZone.setAttribute("aria-disabled",saving||uploadSaveRecoveryChecking?"true":"false");
  dropZone.tabIndex = fileInput.disabled ? -1 : 0;
}
function updateSaveState(): void {
  const locked = saving || uploadSaveRecoveryChecking || selectedEntry()?.status === "reading" || selectedEntry()?.status === "queued" || (selectedId !== null && duplicated().has(selectedId));
  for (const control of Array.from(reviewForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name],select[name]"))) control.disabled = locked;
  employerInput.disabled=locked||employerLoading||!employerDirectory||!selectedEntry()||!['main','side'].includes(selectedEntry()?.form.job??'');
  employerLoad.hidden=(employerDirectory!==undefined&&!employerLoadFailed)||employerLoading;
  employerLoad.textContent=employerLoadFailed?'再読み込み':'勤務先を選択する';
  employerLoad.disabled=locked||employerLoading||!selectedEntry();
  updateFilePickerState();
  clearButton.disabled = saving || uploadSaveRecoveryChecking;
  for (const button of Array.from(fileList.querySelectorAll<HTMLButtonElement>("button"))) button.disabled = saving || uploadSaveRecoveryChecking;
  uploadRecoveryRecheck.disabled = saving || uploadSaveRecoveryChecking || !uploadSaveRecoveryRequired;
  uploadRecoveryReload.disabled = saving || uploadSaveRecoveryChecking || !uploadSaveRecoveryRequired || !uploadSaveRecoveryChecked;
  const pending = entries.some(entry => entry.status === "queued" || entry.status === "reading");
  const uploadable = candidates();
  const issueEntries = uploadable.filter(hasReviewIssue);
  const invalidEntry = uploadable.find(entry => formError(entry)||!validEmployerId(entry.employerId));
  const badPdf = uploadable.find(entry => entry.status === "error");
  const unreviewed = issueEntries.filter(entry => !isReviewed(entry));
  const current=selectedEntry();
  const editable=Boolean(current&&!locked&&current.status!=="error");
  const formIssue=current&&editable?(!validEmployerId(current.employerId)?"勤務先の選択が不正です。":formError(current)):null;
  validationMessage.hidden=!formIssue;
  validationMessage.textContent=formIssue??"";
  validationMessage.classList.toggle("is-error",Boolean(formIssue));
  renderReviewConfirmation(reviewConfirmation,reviewConfirm,{
    required:Boolean(current&&(current.status==="ready"||current.status==="no-text")&&!duplicated().has(current.id)&&hasReviewIssue(current)),
    approved:Boolean(current&&isReviewed(current)),disabled:!editable||Boolean(formIssue),
    warnings:current?[...validatePayrollForm(current.form).warnings,...(current.status==="no-text"||!current.parsed?.profile||current.parsed.warnings.length||current.parsed.missingFields.length?["PDF解析時の確認事項も原本と照合してください。"]:[])]:[],rows:current?personalReviewRows(current.form):[],
  });
  // Consent is only valid for the exact current batch and field values. Changing
  // any PDF/form/status after checking resets it, never silently extends consent.
  const fingerprint=zeroCandidatesFingerprint(uploadable);
  if(zeroCheckbox.checked&&(zeroConsentFingerprint!==fingerprint||unreviewed.length>0||Boolean(invalidEntry)||Boolean(badPdf)||pending)){
    zeroCheckbox.checked=false;zeroConsentFingerprint=null;
  }
  const zeroRows=uploadable.map(entry=>({entry,fields:emptyOptionalAmounts(entry.form)}))
    .filter(row=>row.fields.length>0);
  const blankCount=zeroRows.reduce((sum,row)=>sum+row.fields.length,0);
  zeroApproval.hidden=blankCount===0||saving;
  zeroCheckbox.disabled=saving||pending||Boolean(badPdf)||Boolean(invalidEntry)||unreviewed.length>0;
  const zeroContradictions=zeroCheckbox.checked?uploadable.filter(entry=>zeroIntroducedWarnings(entry).length>0):[];
  zeroCount.textContent=zeroContradictions.length
    ? `${zeroContradictions.length}件で0円補完による検算不一致。該当欄を手動確認するかチェックを外してください。`
    : `${zeroRows.length}件のPDF・${blankCount}項目。OFFなら従来どおり空欄で保存します。`;
  zeroList.replaceChildren(...zeroRows.map(({entry,fields})=>{
    const item=document.createElement('li');
    item.textContent=`${entry.file.name}：${fields.map(field=>ZERO_OPTIONAL_AMOUNT_LABELS[field]).join('・')}`;
    return item;
  }));
  saveButton.disabled = saving || uploadSaveRecoveryRequired || uploadSaveRecoveryChecking || employerLoading || entries.length === 0 || pending || Boolean(badPdf) || Boolean(invalidEntry) || unreviewed.length > 0 || zeroContradictions.length > 0;
  saveButtonLabel.textContent = saving ? "保存中…" : "すべて保存";
  const isEmpty=entries.length===0;
  workspace.classList.toggle('is-empty',isEmpty);
  saveBar.classList.toggle('is-empty',isEmpty&&!saving&&!uploadSaveRecoveryRequired);
  saveStatus.hidden=isEmpty&&!saving;
  uploadGuide.textContent=uploadSaveRecoveryRequired?'前回の保存結果が未確認です。OneDriveを再照合してください。':isEmpty?'PDFを追加してください。':saving?'OneDriveへ保存しています…':pending?'PDFを読み取っています…':badPdf?'読み取り失敗のPDFを一覧から外してください。':invalidEntry||unreviewed.length?'明細の内容を確認してください。':'確認完了。すべて保存できます。';
  if (saving) {
    saveStatus.textContent = `${entries.length}件のPDFと明細を保存しています…`;
  } else if (!entries.length) {
    saveStatus.textContent = "";
  } else if (uploadSaveRecoveryRequired) {
    saveStatus.textContent = "保存結果の確認が必要です。OneDriveの照合が完了するまで再保存できません。";
  } else if (pending) {
    saveStatus.textContent = `PDFの解析完了後に保存できます（全${entries.length}件）。`;
  } else if (badPdf) {
    saveStatus.textContent = `「${badPdf.file.name}」はPDFとして正常に読めないため保存できません。削除して再追加してください。`;
  } else if (invalidEntry) {
    saveStatus.textContent = `「${invalidEntry.file.name}」：${!validEmployerId(invalidEntry.employerId)?'勤務先の選択が不正です。':formError(invalidEntry)}`;
  } else if (unreviewed.length) {
    saveStatus.textContent = `${unreviewed.length}件が未確認です。左の「要確認」を選び、右側の確認チェックを入れてください。`;
  } else if (zeroContradictions.length) {
    saveStatus.textContent = `未取得金額を0円にすると${zeroContradictions.length}件で検算不一致になります。確認して手動入力するか、チェックを外してください。`;
  } else {
    const duplicateCount = entries.length - uploadable.length;
    saveStatus.textContent = `${uploadable.length}件を保存できます。${duplicateCount ? `一覧内の同一PDF ${duplicateCount}件は対象外。` : ""}既存データとの重複はスキップします。`;
  }
}
uploadRecoveryRecheck.addEventListener('click',()=>{void(async()=>{
  if(saving||uploadSaveRecoveryChecking||!uploadSaveRecoveryRequired)return;
  uploadSaveRecoveryChecking=true;uploadSaveRecoveryChecked=false;updateSaveState();
  uploadRecoveryStatus.textContent='OneDriveの年度別明細と暗号化PDF原本を照合しています…';
  try{
    const report=await inspectUploadRecovery(await cloudVault(),uploadSaveAttempt,recordSignature);
    uploadRecoveryStatus.textContent=uploadRecoveryMessage(report);
    try{requireSafeUploadRecovery(report);uploadSaveRecoveryChecked=true;uploadRecoveryStatus.textContent+=' 再開前に「保存済みデータを読み直す」を押してください。';}
    catch(error){uploadRecoveryStatus.textContent+=' '+(error instanceof Error?error.message:'設定画面で復旧してください。');}
  }catch(error){
    uploadRecoveryStatus.textContent=`安全な再保存を確認できませんでした：${error instanceof Error?error.message:'通信エラー'}。この画面で再保存しないでください。`;
  }finally{uploadSaveRecoveryChecking=false;updateSaveState();}
 })()});
uploadRecoveryReload.addEventListener('click',()=>{void(async()=>{
  if(saving||uploadSaveRecoveryChecking||!uploadSaveRecoveryRequired||!uploadSaveRecoveryChecked)return;
  const authorized=captureOperationAuthorization(),attempt=uploadSaveAttempt;
  if(!await confirmOperation({title:'最新データを確認',details:['選択中のPDFと未保存の入力内容を破棄して、最新のOneDrive保存状態を読み直します。','必要なPDFは再度選択してください。'],tone:'warning',acceptLabel:'破棄して読み直す'},authorized)||!authorized())return;
  if(saving||uploadSaveRecoveryChecking||!uploadSaveRecoveryRequired||!uploadSaveRecoveryChecked||attempt!==uploadSaveAttempt)return;
  uploadSaveRecoveryChecking=true;uploadSaveRecoveryChecked=false;updateSaveState();
  uploadRecoveryStatus.textContent='画面を戻す直前にOneDriveを再照合しています…';
  try{
    requireSafeUploadRecovery(await inspectUploadRecovery(await cloudVault(),uploadSaveAttempt,recordSignature));
    if(!authorized())return;
    leavingAfterSave=true; // The user confirmed discarding drafts; bypass only the local beforeunload prompt.
    window.location.reload();
  }catch(error){
    uploadRecoveryStatus.textContent=`再確認に失敗しました：${error instanceof Error?error.message:'通信エラー'}。再保存しないでください。`;
  }finally{uploadSaveRecoveryChecking=false;updateSaveState();}
 })()});
saveButton.addEventListener("click", async () => {
  if (saving || uploadSaveRecoveryRequired || saveButton.disabled) return;
  const authorized=captureOperationAuthorization();
  const before=zeroCandidatesFingerprint(candidates());
  const unchanged=await refreshEmployerChoices();
  if(!unchanged||!authorized())return;
  if(saving||uploadSaveRecoveryRequired||saveButton.disabled||before!==zeroCandidatesFingerprint(candidates()))return;
  const uploadable = candidates();
  const attempt:UploadRecoveryAttempt[]=uploadable.map(entry=>uploadRecoveryAttempt({form:entry.form,fileHash:entry.hash,employerId:entry.employerId}));
  const errorEntry = uploadable.find(entry => formError(entry)||!validEmployerId(entry.employerId));
  if (errorEntry) {
    selectFile(errorEntry.id);
    notice("warning",`「${errorEntry.file.name}」の勤務先または入力内容を確認してください。`);
    return;
  }
  if (uploadable.some(entry => entry.status === "error")) {
    notice("error","読み取りに失敗したPDFがあります。先に一覧から削除してください。");
    return;
  }
  if (uploadable.some(entry => hasReviewIssue(entry) && !isReviewed(entry))) {
    notice("warning","未確認の明細があります。右側の確認チェックを入れてください。");
    return;
  }
  // Capture the opt-in BEFORE disabling the controls. It is never inferred from
  // a previously saved statement or from a rendered summary's zero policy.
  const operationEpoch=authEpoch();
  const approveZero=zeroCheckbox.checked&&zeroConsentFingerprint===zeroCandidatesFingerprint(uploadable);
  saving = true;
  clearInlineError(saveStatus);
  updateSaveState();
  beginSaveFeedback();
  try {
    showSaveProgress('保存前のPDFを検証しています…');
    // 保存前に形式とSHA-256を再確認する。ハッシュがないまま重複検査を素通りさせない。
    for (const entry of uploadable) {
      verifyPdfBytes(new Uint8Array(await entry.file.arrayBuffer()));
      if (!entry.hash) throw new Error("PDFのSHA-256を確認できません。localhost/HTTPSで開いて再読み込みしてください。");
    }
    // OneDriveの複数ファイル書込みは一括トランザクションではない。
    // 1件ずつ保存確認し、途中で失敗すれば件数と不完全保存の可能性を通知する。
    const approvedAt=new Date().toISOString();
    const records: SavedPayrollRecordInput[] = uploadable.map(entry => {
      if(approveZero&&zeroIntroducedWarnings(entry).length)
        throw new Error('未取得金額を0円にすると検算不一致が生じます。元のPDFと金額を確認してください。');
      const prepared=prepareOptionalZeros(
        {...entry.form,workDays:ceilWorkDays(entry.form.workDays)},
        {missingFields:entry.parsed?.missingFields,fields:entry.parsed?.fields,
         fieldSources:entry.parsed?.fieldSources,automaticFields:entry.autoFields},
        approveZero,approvedAt,
      );
      return {
      fileName: storedPdfName(entry.form.job, entry.form.kind, entry.form.paymentDate, entry.file.name),
      originalFileName: entry.file.name,
      pdf: entry.file,
      fileHash: entry.hash,
      form: prepared.form,
      zeroResolution: prepared.zeroResolution,
      ...(entry.employerId?{employerId:entry.employerId}:{}),
      semantics: createPayrollSemantics(entry.form,entry.parsed),
      pages: entry.pages,
      warningsAcknowledged: hasReviewIssue(entry) && isReviewed(entry),
      ...(hasReviewIssue(entry) ? { reviewedIssues: [
        ...(entry.parsed?.warnings ?? []),
        ...(entry.parsed?.missingFields.map(m => `${m.label}: ${m.reason}`) ?? []),
        ...validatePayrollForm(entry.form).warnings,
      ], reviewedAt: new Date().toISOString() } : {}),
      };
    });
    const result = await saveRecordsSkippingDuplicates(records, message => {
      showSaveProgress(message);
      saveButtonLabel.textContent = '保存中…';
    });
    const duplicateOwnersAtSave=duplicated();
    const skippedDetails=describeUploadDuplicates(result.skipped,[...duplicateOwnersAtSave].map(([duplicateId,firstId])=>({
      fileName:entries.find(entry=>entry.id===duplicateId)?.file.name??'名前不明',
      firstFileName:entries.find(entry=>entry.id===firstId)?.file.name??'名前不明',
    })));
    const skipped=skippedDetails.length;
    if(skipped){
      saveDuplicateTitle.textContent=`保存対象外となったPDF：${skipped}件`;
      saveDuplicateList.replaceChildren(...skippedDetails.map(item=>{
        const row=document.createElement('li');
        const name=document.createElement('strong');name.textContent=item.fileName;
        const reason=document.createElement('span');reason.textContent=item.reason;
        row.append(name,reason);return row;
      }));
      saveDuplicates.hidden=false;
    }
    if (result.saved) {
      stopSaveClock();
      saveFeedback.classList.add('is-complete');saveFeedback.classList.remove('is-failed');
      saveStage.textContent='OneDriveへの保存完了';
      saveProgress.classList.remove('is-indeterminate');saveProgressFill.style.width='100%';
      saveProgress.setAttribute('aria-valuenow','100');
      saveStatus.textContent = `${result.saved}件をOneDriveへ保存・検証しました。${skipped?`重複${skipped}件は保存していません。`:''}`;
      saveGuidance.textContent=skipped?'重複として除外したファイルを下で確認してください。':'保存完了を確認しました。ホームへ戻ります。';
      saveButtonLabel.textContent = '保存完了';
      appStatus.success(`${result.saved}件の明細を保存しました`);
    } else {
      stopSaveClock();
      saveFeedback.classList.add('is-complete');
      saveStage.textContent='新しく保存する明細はありません';
      saveProgress.classList.remove('is-indeterminate');saveProgressFill.style.width='100%';
      saveProgress.setAttribute('aria-valuenow','100');
      saveStatus.textContent=`重複${skipped}件を除外しました。新しい保存は行っていません。`;
      saveGuidance.textContent=skipped?'重複として除外したファイルを下で確認してください。':'新しい保存対象はありません。ホームへ戻ります。';
      saveButtonLabel.textContent='重複確認済み';
      appStatus.info('重複しているため、新しい明細はありません。');
    }
    // 重複がなければ従来どおり自動帰還。重複があればファイル名と理由を画面に残す。
    leavingAfterSave = true;
    if(!skipped) {
      if(result.saved&&operationEpoch===authEpoch())rememberNavigationNotice({operation:'upload-saved',count:result.saved},operationEpoch);
      window.location.assign('../index.html');
    }
  } catch (error) {
    leavingAfterSave = false;
    // An employer ambiguity is detected before any writes and can be corrected
    // in the current form. All uncertain cloud failures still require inspection.
    if(!(error instanceof PayrollEmployerConfirmationError)){
      uploadSaveRecoveryRequired=true;uploadSaveRecoveryChecked=false;uploadSaveAttempt=attempt;
      uploadRecovery.hidden=false;uploadRecoveryStatus.textContent='OneDriveへの保存結果を確認できません。確認が終わるまで再保存しないでください。';
    }
    stopSaveClock();saveFeedback.classList.add('is-failed');
    saveStage.textContent='保存を完了できませんでした';
    saveProgress.classList.remove('is-indeterminate');saveProgressFill.style.width='0%';
    saveGuidance.textContent='OneDriveの保存済み一覧を確認してから再試行してください。途中まで保存されたファイルが残っている可能性があります。';
    // Do not log cloud exceptions which may contain private diagnostic data.
    saving = false;
    updateSaveState();
    showInlineError(saveStatus, `保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    appStatus.error(`保存できませんでした：${error instanceof Error?error.message:String(error)}`);
  }
});

// PDFの元テキストと座標を抽出し、利用者が伏せ字に編集してからコピーする。
let diagnosticGeneration=0;
diagnosticButton.addEventListener("click", async () => {
  const entry = selectedEntry();
  if (!entry) return;
  diagnosticRawText = "";
  diagnosticShared.value = "";
  diagnosticState.textContent = "PDFの文字と座標を解析しています…";
  diagnosticCopy.disabled = true;
  diagnosticRedact.disabled = true;
  diagnosticViewOriginal.disabled = true;
  diagnosticCopyOriginal.disabled = true;
  diagnosticButton.disabled = true;
  diagnosticDialog.showModal();
  const generation=++diagnosticGeneration,authorized=captureOperationAuthorization();
  try {
    const diagnostic = await createCoordinateDiagnostic(entry.file);
    if(!diagnosticDialog.open||generation!==diagnosticGeneration||!authorized())return;
    diagnosticRawText = diagnostic.raw;
    diagnosticShared.value = redactCoordinateDiagnostic(diagnostic.raw);
    diagnosticState.textContent = `${diagnostic.pageCount}ページのPDFから、${diagnostic.itemCount}件を抽出。共有用の原文はすべてマスク済みです。`;
    diagnosticCopy.disabled = false;
    diagnosticRedact.disabled = true;
    diagnosticViewOriginal.disabled = false;
    diagnosticCopyOriginal.disabled = false;
  } catch {
    if(!diagnosticDialog.open||generation!==diagnosticGeneration||!authorized())return;
    diagnosticState.textContent = "座標診断に失敗しました。画像だけのPDFや保護されたPDFは解析できない場合があります。";
  } finally {
    diagnosticButton.disabled = false;
  }
});
diagnosticRedact.addEventListener("click", () => {
  if (diagnosticRedact.disabled) return;
  diagnosticShared.value = redactCoordinateDiagnostic(diagnosticRawText);
  diagnosticRedact.disabled = true;
  diagnosticState.textContent = "座標と文字番号を残し、すべての文字を伏せました。内容を確認してからコピーしてください。原文は診断を開き直すと再取得できます。";
});

diagnosticCopy.addEventListener("click", async () => {
  if (!diagnosticRawText) return;
  // A user can edit/reveal the textbox. The SHARE action never trusts that content.
  const safe = redactCoordinateDiagnostic(diagnosticRawText);
  try {
    await navigator.clipboard.writeText(safe);
    diagnosticState.textContent = "共有用に全文マスク済みの座標診断だけをコピーしました。";
  } catch {
    diagnosticShared.value = safe;
    diagnosticShared.focus();
    diagnosticShared.select();
    diagnosticRedact.disabled = true;
    diagnosticState.textContent = "自動コピーできませんでした。マスク済みテキストを選択しました。";
  }
});
diagnosticViewOriginal.addEventListener("click", async () => {
  if(!diagnosticRawText||!diagnosticDialog.open)return;
  const authorized=captureOperationAuthorization(),generation=diagnosticGeneration;
  const current=()=>authorized()&&diagnosticDialog.open&&generation===diagnosticGeneration&&Boolean(diagnosticRawText);
  if(!await confirmOperation({title:'PDF診断の原文を表示',details:['原文には氏名・勤務先・給与額・口座情報などが含まれます。','この端末の画面にのみ表示します。共有用コピーは引き続き全マスクです。'],tone:'warning',acceptLabel:'原文を表示'},current)||!current())return;
  diagnosticShared.value = diagnosticRawText;
  diagnosticRedact.disabled = false;
  diagnosticState.textContent = "原文をローカル表示中です。共有用コピーは引き続き自動マスクします。";
});
diagnosticCopyOriginal.addEventListener("click", async () => {
  if(!diagnosticRawText||!diagnosticDialog.open)return;
  const authorized=captureOperationAuthorization(),generation=diagnosticGeneration;
  const current=()=>authorized()&&diagnosticDialog.open&&generation===diagnosticGeneration&&Boolean(diagnosticRawText);
  if(!await confirmOperation({title:'PDF診断の原文をコピー',details:['個人情報を含むPDF診断の原文をクリップボードにコピーします。','貼り付け先に注意してください。共有用にする場合は全マスクのコピーを使用してください。'],tone:'warning',acceptLabel:'原文をコピー'},current)||!current())return;
  try {
    await navigator.clipboard.writeText(diagnosticRawText);
    diagnosticState.textContent = "確認済みの原文をコピーしました。共有先を再確認してください。";
  } catch {
    diagnosticState.textContent = "原文の自動コピーに失敗しました。安全のため、原文の自動選択は行いません。";
  }
});
diagnosticClose.addEventListener("click", () => diagnosticDialog.close());
diagnosticDialog.addEventListener("close", () => {
  diagnosticGeneration++;
  diagnosticRawText = "";
  diagnosticShared.value = "";
  diagnosticCopy.disabled = true;
  diagnosticViewOriginal.disabled = true;
  diagnosticCopyOriginal.disabled = true;
  diagnosticRedact.disabled = true;
});
diagnosticDialog.addEventListener("click", event => {
  if (event.target === diagnosticDialog) diagnosticDialog.close();
});
// 一覧にあるPDFは保存前。保存成功時のみ離脱確認を抑止する。
// beforeunloadの文言はブラウザ標準（任意の文面は表示されない）。
// 保存中のアプリ内移動は抑止。ページを閉じる操作にもbeforeunloadで警告する。
document.addEventListener('click',event=>{
 if(!saving || (leavingAfterSave && saveFeedback.classList.contains('is-complete')))return;
 const target=event.target;
 if(!(target instanceof Element))return;
 const link=target.closest<HTMLAnchorElement>('a[href]');
 if(!link)return;
 event.preventDefault();notice('info','OneDriveへ保存中です。完了後に移動してください。');
},true);
window.addEventListener("beforeunload", event => {
  if ((!saving && entries.length === 0) || leavingAfterSave) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pagehide", () => {
  for (const entry of entries) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
});
render();
uploadInitialized = true;
updateFilePickerState();

// Read the directory automatically only when an existing authorized session can resume.
void refreshEmployerChoices(false);
