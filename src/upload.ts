/**
 * 明細アップロード画面。
 * - PDFをブラウザ内だけで読み取り、ページ数・テキスト取得可否を検証
 * - 本業・副業の確認済み給与書式に限り、当月の金額を自動入力
 * - 確認後のPDF原本と明細をIndexedDBへまとめて保存（ネットワーク送信なし）
 */
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { createCoordinateDiagnostic } from "./pdf/diagnostic";
import { parsePayroll, type PdfTextCell, type PayrollParseResult } from "./pdf/payrollParser";
import { saveRecordsSkippingDuplicates, type SavedPayrollRecordInput } from "./storage/payrollStore";
import { PAYROLL_FIELDS, validatePayrollForm, normalizeWorkDays, type PayrollFieldKey } from "./storage/payrollValidation";
import { verifyPdfBytes } from "./storage/pdfIntegrity";
import { storedPdfName } from "./storage/fileNaming";

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
const FIELDS: readonly FieldKey[] = PAYROLL_FIELDS;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`HTML要素が見つかりません: #${id}`);
  return element as T;
};
const dropZone = $<HTMLDivElement>("drop-zone");
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
const diagnosticButton = $<HTMLButtonElement>("diagnostic-button");
const diagnosticDialog = $<HTMLDialogElement>("diagnostic-dialog");
const diagnosticClose = $<HTMLButtonElement>("diagnostic-close");
const diagnosticShared = $<HTMLTextAreaElement>("diagnostic-shared");
const diagnosticCopy = $<HTMLButtonElement>("diagnostic-copy");
const diagnosticState = $<HTMLParagraphElement>("diagnostic-state");
const analysisIssues = $<HTMLElement>("analysis-issues");
const analysisIssuesList = $<HTMLUListElement>("analysis-issues-list");
const analysisIssuesCount = $<HTMLElement>("analysis-issues-count");
const saveButton = $<HTMLButtonElement>("save-all");
const saveStatus = $<HTMLElement>("save-status");
const reviewPanel = document.querySelector<HTMLElement>(".review-panel");

let entries: Entry[] = [];
let selectedId: number | null = null;
let nextId = 1;
let reading = false;
let saving = false;
let toastTimeout: ReturnType<typeof setTimeout> | undefined;

function notice(message: string): void {
  if (toastTimeout) clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.hidden = false;
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 4500);
}
function makeForm(): FormValues {
  return Object.fromEntries(FIELDS.map(key => [key, ""])) as FormValues;
}
/** 勤務日数は実際のPDF値から小数点以下を切り上げて管理する。未入力・不正値はそのまま検証へ回す。 */
const ceilWorkDays = normalizeWorkDays;
function selectedEntry(): Entry | undefined {
  return entries.find(entry => entry.id === selectedId);
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
  $("file-summary").textContent = !hasFiles ? "取り込み待ち" : active ? `${completed} / ${entries.length} 件の読み取りが完了` : `${entries.length}件の確認が可能です（未保存）`;
  progressWrap.hidden = !active;
  progressText.textContent = `${completed} / ${entries.length}`;
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
  } else if (entry.status === "duplicate") {
    items.push({ text: "内容が同じPDFが一覧にあります。二重登録にご注意ください。", severity: "warning" });
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
  if (entry.status === "queued" || entry.status === "reading") {
    readResult.textContent = "PDFの文字情報を読み取っています。";
  } else if (entry.status === "ready") {
    const parsed = entry.parsed;
    if (parsed?.profile) {
      const source = parsed.profile === "main" ? "本業" : "副業";
      const count = Object.keys(parsed.fields).filter(key => parsed.fields[key as FieldKey] !== undefined).length;
      readResult.textContent = `${source}の${parsed.fields.kind === "bonus" ? "賞与" : "給与"}明細と判定し、${count}項目を自動入力しました。原本と照合してから確認してください。`;
      if (parsed.warnings.length) {
        readResult.classList.add("read-result--warning");
        readResult.textContent += ` ${isReviewed(entry) ? "確認済み" : "要確認"}：${parsed.warnings.join(" / ")}`;
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
  const isReading = entry.status === "queued" || entry.status === "reading";
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
  if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entries = entries.filter(item => item.id !== id);
  if (selectedId === id) selectedId = entries[0]?.id ?? null;
  render();
}
function addFiles(files: File[]): void {
  if (saving) { notice("保存処理中はPDFを追加できません。"); return; }
  if (!files.length) return;
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
  entry.status = "reading";
  renderFileList();
  if (selectedId === entry.id) renderReview();
  try {
    const bytes = await entry.file.arrayBuffer();
    verifyPdfBytes(new Uint8Array(bytes));
    // HTTPSまたはlocalhostならWeb Cryptoで完全一致の重複を検知できる。
    if (typeof crypto !== "undefined" && crypto.subtle) {
      try {
        const digest = await crypto.subtle.digest("SHA-256", bytes.slice(0));
        entry.hash = toHex(digest);
        // 一覧内で同じPDFがあっても解析は続け、どの明細を残すか保存前に選べるようにする。
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
    try {
      const pdf = await task.promise;
      entry.pages = pdf.numPages;
      let count = 0;
      const coordinateItems: PdfTextCell[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!( "str" in item) || !item.str.trim()) continue;
          count++;
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
        // 自動検出できた項目だけ反映し、不明な項目は空欄のまま残す。
        for (const [key, value] of Object.entries(entry.parsed.fields)) {
          if (value !== undefined && FIELDS.includes(key as FieldKey)) {
            entry.form[key as FieldKey] = key === "workDays" ? ceilWorkDays(value) : value;
          }
        }
      }
      entry.status = count ? "ready" : "no-text";
    } finally {
      await task.destroy();
    }
  } catch (error) {
    entry.status = "error";
    const message = error instanceof Error ? error.message : String(error);
    entry.error = /password/i.test(message) ? "パスワード付きPDFは現在未対応です。" : "破損・保護・非対応形式などの可能性があります。";
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
  for (const entry of entries) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
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
  if (!entry) return;
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
  const locked = saving || selectedEntry()?.status === "reading" || selectedEntry()?.status === "queued";
  for (const control of Array.from(reviewForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name],select[name]"))) control.disabled = locked;
  fileInput.disabled = saving;
  clearButton.disabled = saving;
  for (const button of Array.from(fileList.querySelectorAll<HTMLButtonElement>("button"))) button.disabled = saving;
  const pending = entries.some(entry => entry.status === "queued" || entry.status === "reading");
  const issueEntries = entries.filter(hasReviewIssue);
  const invalidEntry = entries.find(entry => formError(entry) !== null);
  const badPdf = entries.find(entry => entry.status === "error");
  const unreviewed = issueEntries.filter(entry => !isReviewed(entry));
  validateButton.disabled = locked;
  // 確認の入口を右側のボタンに一本化する。状態は選択中PDFごとに保持。
  // ボタン名を切り替えず、確認済みは左側のステータスと直下のメッセージで示す。
  saveButton.disabled = saving || entries.length === 0 || pending || Boolean(badPdf) || Boolean(invalidEntry) || unreviewed.length > 0;
  if (saving) {
    saveStatus.textContent = `${entries.length}件のPDFと明細を保存しています…`;
    saveButton.textContent = "保存中…";
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
    saveStatus.textContent = `${entries.length}件を保存できます。既存データとの重複があればその分だけスキップします。`;
  }
}
saveButton.addEventListener("click", async () => {
  if (saving || saveButton.disabled) return;
  const errorEntry = entries.find(entry => formError(entry));
  if (errorEntry) {
    selectFile(errorEntry.id);
    notice(`「${errorEntry.file.name}」の入力内容を確認してください。`);
    return;
  }
  if (entries.some(entry => entry.status === "error")) {
    notice("読み取りに失敗したPDFがあります。先に一覧から削除してください。");
    return;
  }
  if (entries.some(entry => hasReviewIssue(entry) && !isReviewed(entry))) {
    notice("未確認の明細があります。右側の「入力内容をチェック」で確認してください。");
    return;
  }
  saving = true;
  updateSaveState();
  try {
    // 保存前に形式とSHA-256を再確認する。ハッシュがないまま重複検査を素通りさせない。
    for (const entry of entries) {
      verifyPdfBytes(new Uint8Array(await entry.file.arrayBuffer()));
      if (!entry.hash) throw new Error("PDFのSHA-256を確認できません。localhost/HTTPSで開いて再読み込みしてください。");
    }
    // 同一トランザクションで全件を登録。途中失敗なら一件も登録しない。
    const records: SavedPayrollRecordInput[] = entries.map(entry => ({
      fileName: storedPdfName(entry.form.job, entry.form.kind, entry.form.paymentDate, entry.file.name),
      originalFileName: entry.file.name,
      pdf: entry.file,
      fileHash: entry.hash,
      form: { ...entry.form, workDays: ceilWorkDays(entry.form.workDays) },
      pages: entry.pages,
      warningsAcknowledged: hasReviewIssue(entry) && isReviewed(entry),
      ...(hasReviewIssue(entry) ? { reviewedIssues: [
        ...(entry.parsed?.warnings ?? []),
        ...(entry.parsed?.missingFields.map(m => `${m.label}: ${m.reason}`) ?? []),
        ...validatePayrollForm(entry.form).warnings,
      ], reviewedAt: new Date().toISOString() } : {}),
    }));
    const result = await saveRecordsSkippingDuplicates(records);
    if (result.skipped.length) {
      const detail = result.skipped.map(item => `・${item.fileName}：${item.reason.includes('pdf') ? 'PDFが重複' : '勤務先・種類・年月が重複'}`).join('\n');
      window.alert(`${result.saved}件を保存し、重複${result.skipped.length}件は既存優先でスキップしました。\n既存の明細・手動修正・PDF原本は変更していません。\n\n${detail}`);
    }
    if (result.saved) window.location.assign("../index.html");
    else {
      notice('すべて既存の明細と重複しているため、新しい保存は行いませんでした。');
      saving = false;
      updateSaveState();
    }
  } catch (error) {
    console.error("明細保存に失敗", error);
    notice(`保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    saving = false;
    updateSaveState();
  }
});

// PDFの元テキストと座標を抽出し、利用者が伏せ字に編集してからコピーする。
diagnosticButton.addEventListener("click", async () => {
  const entry = selectedEntry();
  if (!entry) return;
  diagnosticShared.value = "";
  diagnosticState.textContent = "PDFの文字と座標を解析しています…";
  diagnosticCopy.disabled = true;
  diagnosticButton.disabled = true;
  diagnosticDialog.showModal();
  try {
    const diagnostic = await createCoordinateDiagnostic(entry.file);
    diagnosticShared.value = diagnostic.raw;
    diagnosticState.textContent = `${diagnostic.pageCount}ページのPDFから、${diagnostic.itemCount}件の座標付き文字を抽出しました。チャットに貼る前に氏名・会社名・金額などを手動で伏せてください。`;
    diagnosticCopy.disabled = false;
  } catch {
    diagnosticState.textContent = "座標診断に失敗しました。画像だけのPDFや保護されたPDFは解析できない場合があります。";
  } finally {
    diagnosticButton.disabled = false;
  }
});
diagnosticCopy.addEventListener("click", async () => {
  const text = diagnosticShared.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    diagnosticState.textContent = "テキストをコピーしました。チャットへ貼る前に個人情報や実際の金額を伏せたか確認してください。";
  } catch {
    diagnosticShared.focus();
    diagnosticShared.select();
    diagnosticState.textContent = "自動コピーできませんでした。選択状態にしたので、Command + C でコピーしてください。";
  }
});
diagnosticClose.addEventListener("click", () => diagnosticDialog.close());
diagnosticDialog.addEventListener("click", event => {
  if (event.target === diagnosticDialog) diagnosticDialog.close();
});
window.addEventListener("pagehide", () => {
  for (const entry of entries) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
});
render();
