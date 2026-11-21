import { createAppStatus } from "./ui/appStatus";
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
import { saveRecordsSkippingDuplicates, type SavedPayrollRecordInput } from "./storage/payrollStore";
import { PAYROLL_FIELDS, validatePayrollForm, normalizeWorkDays, applicablePayrollForm, type PayrollFieldKey } from "./storage/payrollValidation";
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
  parsed?: PayrollParseResult;
  previewUrl?: string;
  /** このPDFに紐づく警告の確認。別PDFへの切り替えでは変えない。 */
  reviewed?: boolean;
  /** 確認時のフォーム・警告の指紋。中身が変われば確認を失効させる。 */
  reviewedFingerprint?: string;
  /** 入力内容チェックの結果。別PDFへ移っても表示を保持する。 */
  validationFeedback?: { message: string; isError: boolean };
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
const readResult = $<HTMLDivElement>("read-result");
const validationMessage = $<HTMLParagraphElement>("validation-message");
const validateButton = $<HTMLButtonElement>("validate-button");
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
const saveStatus = $<HTMLElement>("save-status");
const saveFeedback = $<HTMLElement>("save-feedback");
const saveStage = $<HTMLElement>("save-stage");
const saveElapsed = $<HTMLElement>("save-elapsed");
const saveProgress = $<HTMLElement>("save-progress-track");
const saveProgressFill = $<HTMLElement>("save-progress-fill");
const saveGuidance = $<HTMLElement>("save-guidance");
const saveDuplicates = $<HTMLElement>("save-duplicates");
const saveDuplicateList = $<HTMLUListElement>("save-duplicate-list");
const saveDuplicateTitle = $<HTMLElement>("save-duplicate-title");
const reviewPanel = document.querySelector<HTMLElement>(".review-panel");

let entries: Entry[] = [];
let selectedId: number | null = null;
let nextId = 1;
let reading = false;
let saving = false;
let leavingAfterSave = false;
let wasParsing=false;
let saveTick:ReturnType<typeof setInterval>|undefined;
let saveStartedAt=0;
let lastSaveUpdateAt=0;
let lastSaveMessage='';
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
 saveStartedAt=Date.now();lastSaveUpdateAt=saveStartedAt;lastSaveMessage='';
 saveStage.textContent='保存の準備中';
 saveGuidance.textContent='保存中は画面移動・追加アップロードをしないでください。重複除外があった場合は結果を表示し、通常の保存完了時はホームへ戻ります。';
 saveProgress.classList.add('is-indeterminate');saveProgressFill.style.width='28%';
 saveProgress.removeAttribute('aria-valuenow');
 stopSaveClock();updateSaveClock();saveTick=setInterval(updateSaveClock,1000);
}
function showSaveProgress(message:string):void {
 if(message!==lastSaveMessage){lastSaveUpdateAt=Date.now();lastSaveMessage=message;}
 const match=/^(\d+)\/(\d+)件[：を]/.exec(message);
 const pct=/暗号化PDFの送信 (\d+)%/.exec(message);
 const phase=pct?'PDFを送信中':message.includes('重複')?'重複を確認中':
  message.includes('暗号化PDFをOneDriveへ送信')?'PDFの送信を開始':
  message.includes('原本PDFを暗号化')?'PDFを暗号化中':
  message.includes('読み戻して照合')?'PDF原本を検証中':
  message.includes('解析済み給与データ')?'明細データを保存中':
  message.includes('収入データを同期')?'収入データを同期中':
  message.includes('クラウドへ保存しました')?'明細の保存完了':
  message.includes('接続')?'OneDriveへ接続中':'保存結果を確認中';
 saveStage.textContent=`${match?`${match[1]} / ${match[2]}件 · `:''}${phase}`;
 appStatus.loading(saveStage.textContent);
 if(pct){
  const n=Math.min(100,Math.max(0,Number(pct[1])));
  saveProgress.classList.remove('is-indeterminate');saveProgressFill.style.width=`${n}%`;
  saveProgress.setAttribute('aria-valuenow',String(n));
 }else{
  saveProgress.classList.add('is-indeterminate');saveProgressFill.style.width='28%';
  saveProgress.removeAttribute('aria-valuenow');
 }
 saveStatus.textContent=message;
 saveGuidance.textContent='保存中は画面移動・追加アップロードをしないでください。重複除外があった場合は結果を表示し、通常の保存完了時はホームへ戻ります。';
 updateSaveClock();
}
function notice(message: string): void {
  if (/失敗|できません|エラー|要確認|確認してください|追加できません/.test(message)) appStatus.error(message);
  else appStatus.success(message);
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
function setValidationFeedback(entry: Entry, message: string, isError = false): void {
  entry.validationFeedback = { message, isError };
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
    // 読み取り不能PDFは「要確認」と表示するが、保存自体は許可しない。
    case "error": return { label: "要確認", variant: "warning" };
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
  $("file-summary").textContent = !hasFiles ? "取り込み待ち" : active ? `${completed} / ${entries.length} 件の読み取りが完了` : `${entries.length}件の確認が可能です（未保存）`;
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
    size.textContent = `${formatBytes(entry.file.size)}${entry.pages ? ` · ${entry.pages}ページ` : ""}`;
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
  for (const warning of validatePayrollForm(entry.form).warnings) {
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
    readResult.textContent = `PDFの文字情報を読み取っています。${entry.pages ? ` ${entry.currentPage ?? 0}/${entry.pages}ページ` : ""}`;
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
  updateConditionalFields(entry.form.kind);
  // 解析中に入力しても後からPDFの結果で上書きされないよう、完了まで編集不可。
  const isReading = entry.status === "queued" || entry.status === "reading" || duplicated().has(entry.id);
  for (const control of Array.from(reviewForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name],select[name]"))) control.disabled = isReading;
  renderIssues(entry);
  validationMessage.hidden = !entry.validationFeedback;
  validationMessage.classList.toggle("is-error", Boolean(entry.validationFeedback?.isError));
  validationMessage.textContent = entry.validationFeedback?.message ?? "";
}
function render(): void {
  renderFileList();
  renderReview();
  updateSaveState();
}
function removeFile(id: number): void {
  if (saving) return;
  const entry = entries.find(item => item.id === id);
  if (entry) abortEntry(entry);
  if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entries = entries.filter(item => item.id !== id);
  if (selectedId === id) selectedId = entries[0]?.id ?? null;
  activateOrphanDuplicates();
  render();
}
function addFiles(files: File[]): void {
  if (saving) { notice("保存処理中はPDFを追加できません。"); return; }
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
  if (rejected) notice(`${rejected}件を追加できませんでした。PDF形式・25MB以下・最大30件をご確認ください。`);
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
  if (dragDepth || Date.now() < suppressPickerUntil) return;
  fileInput.click();
});
dropZone.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  if (dragDepth || Date.now() < suppressPickerUntil) return;
  fileInput.click();
});
fileInput.addEventListener("change", () => {
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
    notice("PDFは上の点線エリアにドロップしてください。");
  }
});
clearButton.addEventListener("click", () => {
  // ページで選択した未保存データだけを削除。保存済みDBには影響しない。
  for (const entry of entries) {
    abortEntry(entry);
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  }
  entries = [];
  selectedId = null;
  render();
  notice("選択中のPDFを一覧から削除しました。保存済みデータは削除されません。");
});
reviewForm.addEventListener("input", event => {
  const target = event.target;
  const entry = selectedEntry();
  if (!entry || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const key = target.name as FieldKey;
  if (!FIELDS.includes(key) || entry.form[key] === target.value) return;
  entry.form[key] = target.value;
  entry.autoFields?.delete(key);
  if (key === "kind") updateConditionalFields(target.value);
  // 値が本当に変更された明細だけ確認を解除する。
  setReviewed(entry, false);
  entry.validationFeedback = undefined;
  renderIssues(entry);
  validationMessage.hidden = true;
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
    entry.validationFeedback = undefined;
  }
  renderIssues(entry);
  renderFileList();
  updateSaveState();
});
reviewForm.addEventListener("submit", event => event.preventDefault());
$("open-pdf").addEventListener("click", () => {
  const entry = selectedEntry();
  if (!entry) return;
  if (!entry.previewUrl) entry.previewUrl = URL.createObjectURL(entry.file);
  const a = document.createElement("a");
  a.href = entry.previewUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
});
validateButton.addEventListener("click", () => {
  const entry = selectedEntry();
  if (!entry || duplicated().has(entry.id)) return;
  if (entry.status === "queued" || entry.status === "reading") return;
  const checked = validatePayrollForm(entry.form);
  if (!reviewForm.reportValidity() || checked.errors.length || entry.status === "error") {
    setReviewed(entry, false);
    setValidationFeedback(entry, checked.errors[0] ?? "入力形式またはPDFの状態を確認してください。", true);
  } else if (hasReviewIssue(entry)) {
    // 警告・不足項目を原本と照合したことを明示的なボタン操作で承認する。
    // 同じ操作を別のPDFに移動しても再度求めない。
    setReviewed(entry, true);
    setValidationFeedback(entry, "この明細の確認事項を確認済みにしました。入力を変更した場合だけ再確認が必要です。");
  } else {
    setValidationFeedback(entry, "入力内容を検証しました。保存できます。");
  }
  render();
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
function updateSaveState(): void {
  const locked = saving || selectedEntry()?.status === "reading" || selectedEntry()?.status === "queued" || (selectedId !== null && duplicated().has(selectedId));
  for (const control of Array.from(reviewForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name],select[name]"))) control.disabled = locked;
  fileInput.disabled = saving;
  mobileFilePicker.disabled = saving;
  dropZone.setAttribute("aria-disabled",saving?"true":"false");
  clearButton.disabled = saving;
  for (const button of Array.from(fileList.querySelectorAll<HTMLButtonElement>("button"))) button.disabled = saving;
  const pending = entries.some(entry => entry.status === "queued" || entry.status === "reading");
  const uploadable = candidates();
  const issueEntries = uploadable.filter(hasReviewIssue);
  const invalidEntry = uploadable.find(entry => formError(entry) !== null);
  const badPdf = uploadable.find(entry => entry.status === "error");
  const unreviewed = issueEntries.filter(entry => !isReviewed(entry));
  validateButton.disabled = locked;
  // 確認の入口を右側のボタンに一本化する。状態は選択中PDFごとに保持。
  // ボタン名を切り替えず、確認済みは左側のステータスと直下のメッセージで示す。
  saveButton.disabled = saving || entries.length === 0 || pending || Boolean(badPdf) || Boolean(invalidEntry) || unreviewed.length > 0;
  saveButtonLabel.textContent = saving ? "保存中…" : "すべて保存";
  if (saving) {
    saveStatus.textContent = `${entries.length}件のPDFと明細を保存しています…`;
  } else if (!entries.length) {
    saveStatus.textContent = "PDFを追加すると、ここからまとめて保存できます。";
  } else if (pending) {
    saveStatus.textContent = `PDFの解析完了後に保存できます（全${entries.length}件）。`;
  } else if (badPdf) {
    saveStatus.textContent = `「${badPdf.file.name}」はPDFとして正常に読めないため保存できません。削除して再追加してください。`;
  } else if (invalidEntry) {
    saveStatus.textContent = `「${invalidEntry.file.name}」：${formError(invalidEntry)}`;
  } else if (unreviewed.length) {
    saveStatus.textContent = `${unreviewed.length}件が未確認です。左の「要確認」を選び、右側の「入力内容をチェック」を押してください。`;
  } else {
    const duplicateCount = entries.length - uploadable.length;
    saveStatus.textContent = `${uploadable.length}件を保存できます。${duplicateCount ? `一覧内の同一PDF ${duplicateCount}件は対象外。` : ""}既存データとの重複はスキップします。`;
  }
}
saveButton.addEventListener("click", async () => {
  if (saving || saveButton.disabled) return;
  const uploadable = candidates();
  const errorEntry = uploadable.find(entry => formError(entry));
  if (errorEntry) {
    selectFile(errorEntry.id);
    notice(`「${errorEntry.file.name}」の入力内容を確認してください。`);
    return;
  }
  if (uploadable.some(entry => entry.status === "error")) {
    notice("読み取りに失敗したPDFがあります。先に一覧から削除してください。");
    return;
  }
  if (uploadable.some(entry => hasReviewIssue(entry) && !isReviewed(entry))) {
    notice("未確認の明細があります。右側の「入力内容をチェック」で確認してください。");
    return;
  }
  saving = true;
  clearInlineError(saveStatus);
  updateSaveState();
  beginSaveFeedback();
  try {
    saveStatus.textContent = '保存前のPDFを検証しています…';
    // 保存前に形式とSHA-256を再確認する。ハッシュがないまま重複検査を素通りさせない。
    for (const entry of uploadable) {
      verifyPdfBytes(new Uint8Array(await entry.file.arrayBuffer()));
      if (!entry.hash) throw new Error("PDFのSHA-256を確認できません。localhost/HTTPSで開いて再読み込みしてください。");
    }
    // OneDriveの複数ファイル書込みは一括トランザクションではない。
    // 1件ずつ保存確認し、途中で失敗すれば件数と不完全保存の可能性を通知する。
    const records: SavedPayrollRecordInput[] = uploadable.map(entry => ({
      fileName: storedPdfName(entry.form.job, entry.form.kind, entry.form.paymentDate, entry.file.name),
      originalFileName: entry.file.name,
      pdf: entry.file,
      fileHash: entry.hash,
      form: applicablePayrollForm({ ...entry.form, workDays: ceilWorkDays(entry.form.workDays) }),
      pages: entry.pages,
      warningsAcknowledged: hasReviewIssue(entry) && isReviewed(entry),
      ...(hasReviewIssue(entry) ? { reviewedIssues: [
        ...(entry.parsed?.warnings ?? []),
        ...(entry.parsed?.missingFields.map(m => `${m.label}: ${m.reason}`) ?? []),
        ...validatePayrollForm(entry.form).warnings,
      ], reviewedAt: new Date().toISOString() } : {}),
    }));
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
      appStatus.success('重複を確認しました');
    }
    // 重複がなければ従来どおり自動帰還。重複があればファイル名と理由を画面に残す。
    leavingAfterSave = true;
    if(!skipped) window.setTimeout(() => window.location.assign('../index.html'), 1500);
  } catch (error) {
    leavingAfterSave = false;
    stopSaveClock();saveFeedback.classList.add('is-failed');
    saveStage.textContent='保存を完了できませんでした';
    saveProgress.classList.remove('is-indeterminate');saveProgressFill.style.width='0%';
    saveGuidance.textContent='OneDriveの保存済み一覧を確認してから再試行してください。途中まで保存されたファイルが残っている可能性があります。';
    console.error("明細保存に失敗", error);
    saving = false;
    updateSaveState();
    showInlineError(saveStatus, `保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    appStatus.error(`保存できませんでした：${error instanceof Error?error.message:String(error)}`);
  }
});

// PDFの元テキストと座標を抽出し、利用者が伏せ字に編集してからコピーする。
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
  try {
    const diagnostic = await createCoordinateDiagnostic(entry.file);
    diagnosticRawText = diagnostic.raw;
    diagnosticShared.value = redactCoordinateDiagnostic(diagnostic.raw);
    diagnosticState.textContent = `${diagnostic.pageCount}ページのPDFから、${diagnostic.itemCount}件を抽出。共有用の原文はすべてマスク済みです。`;
    diagnosticCopy.disabled = false;
    diagnosticRedact.disabled = true;
    diagnosticViewOriginal.disabled = false;
    diagnosticCopyOriginal.disabled = false;
  } catch {
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
diagnosticViewOriginal.addEventListener("click", () => {
  if (!diagnosticRawText || !window.confirm("原文には氏名・勤務先・給与額・口座情報などが含まれます。この端末の画面に表示しますか？")) return;
  diagnosticShared.value = diagnosticRawText;
  diagnosticRedact.disabled = false;
  diagnosticState.textContent = "原文をローカル表示中です。共有用コピーは引き続き自動マスクします。";
});
diagnosticCopyOriginal.addEventListener("click", async () => {
  if (!diagnosticRawText || !window.confirm("個人情報を含むPDF診断の原文をコピーします。原文のコピーには明示的な確認が必要です。貼り付け先に注意してください。続けますか？")) return;
  try {
    await navigator.clipboard.writeText(diagnosticRawText);
    diagnosticState.textContent = "確認済みの原文をコピーしました。共有先を再確認してください。";
  } catch {
    diagnosticState.textContent = "原文の自動コピーに失敗しました。安全のため、原文の自動選択は行いません。";
  }
});
diagnosticClose.addEventListener("click", () => diagnosticDialog.close());
diagnosticDialog.addEventListener("close", () => {
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
 event.preventDefault();notice('OneDriveへ保存中です。完了後に移動してください。');
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
