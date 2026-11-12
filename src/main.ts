/** 給与ダッシュボード：IndexedDBに保存したPDF原本と手入力・自動抽出値を表示する。 */
import { deleteRecord, loadRecords, recordSignature, type SavedPayrollRecord } from './storage/payrollStore';
import { amountOrMissing } from './storage/payrollValidation';
import { calculateAnnualForecast, type MonthEstimate, type AnnualForecast } from './forecast/annualForecast';
import { fiscalYearOfTargetMonth } from './forecast/payrollCalendar';

type Job = 'main' | 'side';
type SummaryKey = 'gross' | 'net' | 'incomeTax' | 'residentTax' | 'socialInsurance' | 'transportation' | 'reimbursedExpenses' | 'workDays';

function required<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`必要な画面要素が見つかりません: ${selector}`);
  return node;
}
const yearSelect = required<HTMLSelectElement>('#fiscal-year');
const periodLabel = required<HTMLElement>('#fiscal-period');
const bonusToggle = required<HTMLInputElement>('#include-bonus');
const forecastToggle = required<HTMLInputElement>('#include-forecast');
const forecastPanel = required<HTMLElement>('#forecast-panel');
const forecastStatus = required<HTMLElement>('#forecast-status');
const forecastDetails = required<HTMLElement>('#forecast-details');
const yen = (amount: number): string => `${amount.toLocaleString('ja-JP')}円`;
// 選択年度はURLで引き継ぐ。ブラウザの戻る・再読み込み・編集後の戻りにも対応する。
function fiscalYearFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get('fy');
  if (!raw || !/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1900 && year <= 2200 ? year : null;
}
const initialFiscalYear = fiscalYearFromUrl();
function currentFiscalYear(): number {
  const today = new Date();
  return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
}
let saved: SavedPayrollRecord[] = [];
let pdfUrls: string[] = [];
const deletingRecordIds = new Set<number>();

function updateYearOptions(): void {
  const currentYear = currentFiscalYear();
  const years = new Set<number>([currentYear, currentYear + 1]);
  for (const item of saved) {
    const year = fiscalYearOfTargetMonth(item.form.targetMonth);
    if (year !== null) years.add(year);
  }
  const active = yearSelect.value === '' ? (initialFiscalYear ?? currentYear) : Number(yearSelect.value);
  // 編集後にその年度の最後の明細が移動しても、選択中の年度を勝手に変えない。
  years.add(active);
  yearSelect.replaceChildren();
  [...years].sort((a, b) => b - a).forEach(year => {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = `${year}年度`;
    yearSelect.append(option);
  });
  yearSelect.value = String(years.has(active) ? active : currentYear);
}
interface Summary {
  sums: Record<SummaryKey, number>;
  observed: Record<SummaryKey, boolean>;
  partial: Record<SummaryKey, boolean>;
}
function summary(records: SavedPayrollRecord[]): Summary {
  const zero = (): Record<SummaryKey, number> => ({
    gross: 0, net: 0, incomeTax: 0, residentTax: 0, socialInsurance: 0, transportation: 0, reimbursedExpenses: 0, workDays: 0,
  });
  const sums = zero();
  const observed = Object.fromEntries(Object.keys(sums).map(k => [k, false])) as Record<SummaryKey, boolean>;
  const partial = Object.fromEntries(Object.keys(sums).map(k => [k, false])) as Record<SummaryKey, boolean>;
  function add(key: SummaryKey, value: string | undefined): void {
    const numeric = amountOrMissing(value);
    if (numeric === null) { partial[key] = true; return; }
    observed[key] = true;
    sums[key] += numeric;
  }
  for (const { form } of records) {
    // 0円の賞与は内訳欄が存在しない正常明細。月次の「未入力」扱いで
    // 所得税・社会保険料の年間集計に ※ を付けない。
    const zeroBonus = form.kind === 'bonus' && amountOrMissing(form.gross) === 0 && amountOrMissing(form.net) === 0;
    const valueFor = (key: string): string | undefined =>
      zeroBonus && amountOrMissing(form[key]) === null ? '0' : form[key];
    for (const key of ['gross', 'net', 'residentTax', 'transportation', 'reimbursedExpenses'] as const) add(key, valueFor(key));
    // 実績の所得税は年調還付を反映した実際の控除（所得税＋年調過不足）を表示する。
    // 月給を使った将来予測にはこの一時的な年調額を混ぜない。
    add('incomeTax', valueFor('incomeTax'));
    const yearEnd = amountOrMissing(form.yearEndAdjustment);
    if (yearEnd !== null) {
      sums.incomeTax += yearEnd;
      observed.incomeTax = true;
      if (amountOrMissing(form.incomeTax) === null && !zeroBonus) partial.incomeTax = true;
    }
    if (form.kind === 'salary') add('workDays', form.workDays);
    for (const key of ['healthInsurance', 'careInsurance', 'childcareSupport', 'pension', 'employmentInsurance']) {
      add('socialInsurance', valueFor(key));
    }
  }
  return { sums, observed, partial };
}
/** 見込みを表示専用の集計に加算する。保存済みレコードや元の集計結果は変更しない。 */
function withEstimates(actual: Summary, estimates: readonly MonthEstimate[]): Summary {
  const sums = { ...actual.sums };
  const observed = { ...actual.observed };
  const partial = { ...actual.partial };
  for (const estimate of estimates) {
    for (const key of ['gross', 'net', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses', 'workDays'] as const) {
      const value = estimate.values[key];
      if (value === null) { partial[key] = true; continue; }
      sums[key] += value;
      observed[key] = true;
      if (estimate.incomplete[key]) partial[key] = true;
    }
  }
  return { sums, observed, partial };
}
function renderForecastExplanation(plan: AnnualForecast): void {
  forecastPanel.hidden = false;
  forecastDetails.replaceChildren();
  const salaryCount = plan.jobs.main.estimates.length + plan.jobs.side.estimates.length;
  const bonusCount = plan.jobs.main.bonusEstimates.length;
  const estimatedCount = plan.estimates.length;
  forecastStatus.textContent = estimatedCount ? `実績＋給与${salaryCount}か月分・本業賞与${bonusCount}回分の見込み` : '実績のみ（見込み対象なし）';
  const explanation = document.createElement('p');
  explanation.className = 'forecast-note';
  explanation.textContent = '月給は当月以降の未登録月を、直近最大3件の中央値で推計。立替経費は翌月以降に繰り越しません。本業賞与は8月・翌2月の未登録分のみ、月給から交通費と経費を除いた額を参考に加算します。副業賞与の見込みは加算しません。';
  forecastDetails.append(explanation);
  if (estimatedCount) {
    const deltaLine = document.createElement('p');
    deltaLine.className = 'forecast-delta';
    const fields: Array<[SummaryKey, string]> = [
      ['gross', '総支給'], ['net', '手取り'], ['incomeTax', '所得税'],
      ['residentTax', '住民税'], ['socialInsurance', '社会保険料'], ['transportation', '交通費'], ['reimbursedExpenses', '立替経費'],
    ];
    const additions = fields.map(([key, label]) => {
      const known = plan.estimates.map(estimate => estimate.values[key]).filter((value): value is number => value !== null);
      return `${label} +${known.length ? yen(known.reduce((sum, value) => sum + value, 0)) : '算出不可'}${known.length < estimatedCount ? ' ※' : ''}`;
    });
    deltaLine.textContent = `見込み加算分：${additions.join(' ／ ')}`;
    forecastDetails.append(deltaLine);
  }
  for (const job of ['main', 'side'] as const) {
    const item = plan.jobs[job];
    const line = document.createElement('div');
    line.className = 'forecast-job-row';
    const title = document.createElement('strong');
    title.textContent = job === 'main' ? '本業' : '副業';
    const detail = document.createElement('span');
    if (item.reason) {
      detail.textContent = item.reason;
    } else {
      const first = item.estimates[0];
      const total = item.estimates.reduce((sum, e) => sum + (e.values.gross ?? 0), 0);
      const sample = item.sampleMonths.map(month => month.replace('-', '/')).join('・');
      const months = item.pendingMonths.map(month => month.replace('-', '/')).join('、');
      detail.textContent = `${item.estimates.length}か月分の推計（${months}）｜月額総支給 ${first.values.gross === null ? '算出不可' : yen(first.values.gross)}｜年度への加算 ${yen(total)}｜参照 ${sample} の${item.sampleMonths.length}件`;
    }
    line.append(title, detail);
    forecastDetails.append(line);
    if (job === 'main' && bonusToggle.checked) {
      const bonusLine = document.createElement('div');
      bonusLine.className = 'forecast-job-row';
      const bonusTitle = document.createElement('strong');
      bonusTitle.textContent = '本業賞与';
      const bonusDetail = document.createElement('span');
      if (item.bonusReason) {
        bonusDetail.textContent = item.bonusReason;
      } else if (!item.bonusEstimates.length) {
        bonusDetail.textContent = '8月・2月とも登録済み、または対象外です。';
      } else {
        const months = item.bonusEstimates.map(e => e.month.replace('-', '/')).join('、');
        const total = item.bonusEstimates.reduce((sum, e) => sum + (e.values.gross ?? 0), 0);
        bonusDetail.textContent = `${item.bonusEstimates.length}回（${months}）｜賞与額面の見込み ${yen(total)}｜交通費を除いた月給を参考`;
      }
      bonusLine.append(bonusTitle, bonusDetail);
      forecastDetails.append(bonusLine);
    }
  }
  const caution = document.createElement('p');
  caution.className = 'forecast-caution';
  caution.textContent = '賞与見込みの手取り・所得税・社会保険料は直近の月給を使った概算で、実際の賞与明細と異なる場合があります。業績手当は将来分に加算しません。登録済みの副業賞与は「賞与を含む」ON時に実績として集計します。※は未入力のある部分集計。PDFとIndexedDBは変更しません。';
  forecastDetails.append(caution);
}
function updateSummary(prefix: 'total' | Job, result: Summary, count: number): void {
  for (const key of ['gross', 'net', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses'] as const) {
    const id = `${prefix}-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
    const element = document.getElementById(id);
    if (!element) continue;
    element.textContent = !count || !result.observed[key] ? '--' : `${yen(result.sums[key])}${result.partial[key] ? ' ※' : ''}`;
    if (count && result.partial[key]) {
      element.title = '未入力の項目があります。表示額は入力済みの合計であり、0円として確定していません。';
      element.setAttribute('aria-label', `${element.textContent} 未入力項目あり`);
    } else {
      element.removeAttribute('title'); element.removeAttribute('aria-label');
    }
  }
  if (prefix === 'side') {
    const days = document.getElementById('side-days');
    if (days) {
      days.textContent = !count || !result.observed.workDays ? '--' : `${result.sums.workDays.toLocaleString('ja-JP')}日${result.partial.workDays ? ' ※' : ''}`;
      days.title = result.partial.workDays ? '出勤日数が未入力の明細があります。' : '';
    }
  }
}
function revokePdfUrls(): void {
  for (const url of pdfUrls) URL.revokeObjectURL(url);
  pdfUrls = [];
}
function renderList(job: Job, records: SavedPayrollRecord[]): void {
  const list = required<HTMLUListElement>(`#${job}-records`);
  required<HTMLElement>(`#${job}-count`).textContent = `${records.length}件`;
  list.replaceChildren();
  if (!records.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    const strong = document.createElement('strong');
    strong.textContent = '登録済みの明細はありません';
    const hint = document.createElement('span');
    hint.textContent = '明細を保存すると、ここに表示されます。';
    li.append(strong, hint);
    list.append(li);
    return;
  }
  for (const record of records.sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate))) {
    const item = document.createElement('li');
    item.className = 'statement-item';
    const left = document.createElement('div');
    left.className = 'statement-item__left';
    const detail = document.createElement('div');
    detail.className = 'statement-item__text';
    const link = document.createElement('a');
    link.className = 'statement-link';
    link.textContent = record.fileName;
    link.title = '原本PDFを別タブで開く';
    const url = URL.createObjectURL(record.pdf);
    pdfUrls.push(url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const caption = document.createElement('span');
    caption.className = 'statement-item__meta';
    const gross = amountOrMissing(record.form.gross);
    const net = amountOrMissing(record.form.net);
    caption.textContent = `${record.form.targetMonth}分 / ${record.form.paymentDate} 支給 / ${record.form.kind === 'bonus' ? '賞与' : '給与'} / 総支給 ${gross === null ? '--' : yen(gross)} / 手取り ${net === null ? '--' : yen(net)}`;
    detail.append(link, caption);
    left.append(detail);
    const actions = document.createElement('div');
    actions.className = 'statement-item__actions';
    const download = document.createElement('a');
    download.className = 'btn btn--icon';
    download.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-download"></use></svg>';
    download.setAttribute('aria-label', `${record.fileName} をダウンロード`);
    download.href = url;
    download.download = record.fileName;
    download.title = '原本PDFをダウンロード';
    const edit = document.createElement('a');
    edit.className = 'btn btn--icon';
    edit.href = `./edit/index.html?id=${encodeURIComponent(String(record.id))}&fy=${encodeURIComponent(yearSelect.value)}`;
    edit.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-edit"></use></svg>';
    edit.setAttribute('aria-label', `${record.fileName} の保存情報を編集`);
    edit.title = '保存情報を確認・編集';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--icon btn--delete';
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>';
    remove.setAttribute('aria-label', `${record.fileName} を削除`);
    remove.title = '保存済みの明細とPDF原本を削除';
    remove.disabled = deletingRecordIds.has(record.id);
    remove.addEventListener('click', async () => {
      if (deletingRecordIds.has(record.id)) return;
      const label = record.form.job === 'main' ? '本業' : '副業';
      const kind = record.form.kind === 'bonus' ? '賞与' : '給与';
      const message = `保存済みの明細を1件削除します。\n\n${label} / ${record.form.targetMonth}分 / ${kind}\nファイル: ${record.fileName}\n\n入力情報とPDF原本を両方削除します。元に戻すには削除前のバックアップが必要です。\n\n本当に削除しますか？`;
      if (!window.confirm(message)) return;
      deletingRecordIds.add(record.id);
      remove.disabled = true;
      try {
        await deleteRecord(record.id, recordSignature(record));
      } catch (error) {
        window.alert(`削除処理を完了できませんでした。\n${error instanceof Error ? error.message : String(error)}`);
      } finally {
        deletingRecordIds.delete(record.id);
        remove.disabled = false;
        await refreshDashboard();
      }
    });
    actions.append(edit, download, remove);
    item.append(left, actions);
    list.append(item);
  }
}
function render(): void {
  const year = Number(yearSelect.value);
  periodLabel.textContent = `${year}年4月〜${year + 1}年3月 ・ 給与対象年月基準 / ※は未入力のある部分集計`;
  const yearRecords = saved.filter(item => fiscalYearOfTargetMonth(item.form.targetMonth) === year &&
    (bonusToggle.checked || item.form.kind !== 'bonus'));
  const main = yearRecords.filter(item => item.form.job === 'main');
  const side = yearRecords.filter(item => item.form.job === 'side');
  const forecast = forecastToggle.checked ? calculateAnnualForecast(saved, year, new Date(), bonusToggle.checked) : null;
  const projected = forecast?.estimates ?? [];
  periodLabel.textContent += forecastToggle.checked ? ' / 見込みは画面表示のみ' : '';
  forecastPanel.hidden = !forecast;
  forecastStatus.hidden = !forecast;
  if (forecast) renderForecastExplanation(forecast);
  updateSummary('total', withEstimates(summary(yearRecords), projected), yearRecords.length + projected.length);
  const mainProjected = projected.filter(item => item.job === 'main');
  const sideProjected = projected.filter(item => item.job === 'side');
  updateSummary('main', withEstimates(summary(main), mainProjected), main.length + mainProjected.length);
  updateSummary('side', withEstimates(summary(side), sideProjected), side.length + sideProjected.length);
  revokePdfUrls();
  renderList('main', main);
  renderList('side', side);
}
yearSelect.addEventListener('change', () => {
  // 画面内で選択した年度をURLに残し、別ページから戻った際も復元可能にする。
  const url = new URL(window.location.href);
  url.searchParams.set('fy', yearSelect.value);
  window.history.replaceState(window.history.state, '', url);
  render();
});
bonusToggle.addEventListener('change', render);
forecastToggle.addEventListener('change', render);
window.addEventListener('pagehide', revokePdfUrls);
async function refreshDashboard(): Promise<void> {
  try {
    saved = await loadRecords();
    yearSelect.disabled = false;
    bonusToggle.disabled = false;
    forecastToggle.disabled = false;
    periodLabel.removeAttribute('role');
    periodLabel.style.removeProperty('color');
    updateYearOptions();
    render();
  } catch (error) {
    console.error('保存済み明細を読み込めませんでした。', error);
    periodLabel.textContent = `保存済み明細の読み込みに失敗しました。ブラウザの保存設定をご確認ください。${error instanceof Error ? ` (${error.message})` : ''}`;
    periodLabel.setAttribute('role', 'alert');
    periodLabel.style.color = 'var(--color-danger)';
    yearSelect.disabled = true;
    bonusToggle.disabled = true;
    forecastToggle.disabled = true;
    // エラー文を通常renderで上書きしない。既存レコードが消えたわけではない。
  }
}
// ブラウザの「戻る」でbfcacheから復帰すると古い一覧と無効化されたBlob URLが残るため、再取得する。
window.addEventListener('pageshow', event => { if (event.persisted) void refreshDashboard(); });
void refreshDashboard();
