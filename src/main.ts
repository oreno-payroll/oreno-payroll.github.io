import { safePdfFileName } from './storage/fileNaming';
/** 給与ダッシュボード：OneDrive暗号化保管庫の解析JSONから集計する。 */
import { deleteRecord, getRecord, loadRecordSummaries, summaryCacheInfo, recordSignature, type SavedPayrollRecord, type SavedPayrollSummary } from './storage/payrollStore';
import {PayrollPartialSuccessError} from './storage/operationError';
import {mutationEpoch} from './cloud/snapshot';
import { amountOrMissing } from './storage/payrollValidation';
import { summary, withEstimates, type Summary, type SummaryKey } from './forecast/summary';
import { setMissingIndicator } from './ui/missingIndicator';
import { createSidePdfZip } from './export/sidePdfs';
import { calculateAnnualForecast, type MonthEstimate, type AnnualForecast } from './forecast/annualForecast';
import { fiscalYearOfTargetMonth } from './forecast/payrollCalendar';
import { calendarYearOfPaymentDate, calculateCalendarForecast, type CalendarForecast } from './forecast/calendarForecast';

type Job = 'main' | 'side';
type PeriodMode = 'fiscal' | 'calendar';

function required<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`必要な画面要素が見つかりません: ${selector}`);
  return node;
}
const yearSelect = required<HTMLSelectElement>('#fiscal-year');
const fiscalModeButton = required<HTMLButtonElement>('#mode-fiscal');
const calendarModeButton = required<HTMLButtonElement>('#mode-calendar');
const yearLabel = required<HTMLElement>('#year-label');
const forecastLabel = required<HTMLElement>('#forecast-toggle-label');
const periodLabel = required<HTMLElement>('#fiscal-period');
const bonusToggle = required<HTMLInputElement>('#include-bonus');
const forecastToggle = required<HTMLInputElement>('#include-forecast');
const forecastPanel = required<HTMLElement>('#forecast-panel');
const forecastStatus = required<HTMLElement>('#forecast-status');
const forecastDetails = required<HTMLElement>('#forecast-details');
const forecastHeading = required<HTMLElement>('#forecast-heading');
const yen = (amount: number): string => `${amount.toLocaleString('ja-JP')}円`;
// 編集ページと相互に引き継ぐ。旧リンク ?fy=2025 にも後方互換性を残す。
const searchParams = new URLSearchParams(window.location.search);
let periodMode: PeriodMode = searchParams.get('mode') === 'calendar' ? 'calendar' : 'fiscal';
function selectedYearFromUrl(): number | null {
  const raw = searchParams.get('year') ?? searchParams.get('fy');
  if (!raw || !/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1900 && year <= 2200 ? year : null;
}
const initialYear = selectedYearFromUrl();
function currentFiscalYear(): number {
  const today = new Date();
  return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
}
function currentPeriodYear(): number {
  return periodMode === 'fiscal' ? currentFiscalYear() : new Date().getFullYear();
}
function persistPeriodSelection(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', periodMode);
  url.searchParams.set('year', yearSelect.value);
  url.searchParams.delete('fy');
  window.history.replaceState(window.history.state, '', url);
}
function editPeriodQuery(): string {
  return `mode=${encodeURIComponent(periodMode)}&year=${encodeURIComponent(yearSelect.value)}`;
}
let saved: SavedPayrollSummary[] = [];
const visibleCounts: Record<Job, number> = { main: 50, side: 50 };
const deletingRecordIds = new Set<number>();
const sideZipButton = required<HTMLButtonElement>('#download-side-zip');
const sideZipStatus = required<HTMLElement>('#side-zip-status');
let exportingSideZip = false;
function selectedPeriodRecords(): SavedPayrollSummary[] {
  const year = Number(yearSelect.value);
  return saved.filter(item =>
    (periodMode === 'calendar' ? calendarYearOfPaymentDate(item.form.paymentDate) : fiscalYearOfTargetMonth(item.form.targetMonth)) === year &&
    (bonusToggle.checked || item.form.kind !== 'bonus'));
}
sideZipButton.addEventListener('click', async () => {
  if (exportingSideZip) return;
  const exportYear = yearSelect.value;
  const exportMode = periodMode;
  const side = selectedPeriodRecords().filter(item => item.form.job === 'side');
  if (!side.length) return;
  exportingSideZip = true;
  sideZipButton.disabled = true;
  sideZipStatus.textContent = `${side.length}件のPDFをZIPにまとめています…`;
  sideZipStatus.removeAttribute('role');
  try {
    // 表示には索引しか持たないため、ZIP作成の際にだけ対象PDF原本を取得する。
    const originals: SavedPayrollRecord[] = [];
    for (const [index, item] of side.entries()) {
      sideZipStatus.textContent = `副業PDFを取得中… ${index + 1} / ${side.length}件（${exportMode === 'calendar' ? '暦年' : '年度'} ${exportYear}）`;
      const full = await getRecord(item.id);
      if (!full || recordSignature(full) !== recordSignature(item)) {
        throw new Error('保存済み明細が変更されました。画面を更新してから再実行してください。');
      }
      originals.push(full);
    }
    const archive = await createSidePdfZip(originals);
    const url = URL.createObjectURL(archive);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-side-${exportMode}-${exportYear}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    sideZipStatus.textContent = `副業PDF ${side.length}件（${exportYear}）のZIPを作成しました。ダウンロード先を確認してください。`;
  } catch (error) {
    sideZipStatus.textContent = `副業PDFのZIP作成に失敗しました：${error instanceof Error ? error.message : String(error)}`;
    sideZipStatus.setAttribute('role', 'alert');
  } finally {
    exportingSideZip = false;
    sideZipButton.disabled = selectedPeriodRecords().every(item => item.form.job !== 'side');
  }
});

function updateYearOptions(): void {
  const currentYear = currentPeriodYear();
  const years = new Set<number>([currentYear, currentYear + 1]);
  for (const item of saved) {
    const year = periodMode === 'fiscal'
      ? fiscalYearOfTargetMonth(item.form.targetMonth)
      : calendarYearOfPaymentDate(item.form.paymentDate);
    if (year !== null) years.add(year);
  }
  const active = yearSelect.value === '' ? (initialYear ?? currentYear) : Number(yearSelect.value);
  years.add(active);
  yearSelect.replaceChildren();
  [...years].sort((a, b) => b - a).forEach(year => {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = periodMode === 'fiscal' ? `${year}年度` : `${year}年分`;
    yearSelect.append(option);
  });
  yearSelect.value = String(active);
  yearLabel.textContent = periodMode === 'fiscal' ? '対象年度' : '対象年';
  yearSelect.setAttribute('aria-label', yearLabel.textContent);
  forecastLabel.textContent = periodMode === 'fiscal' ? '3月まで見込み' : '12月まで見込み';
  forecastToggle.title = periodMode === 'fiscal'
    ? '対象月基準で3月までの未登録給与と本業賞与を概算します。'
    : '支給日基準で、最後の実績支給月の翌月から12月までを概算します。';
  forecastToggle.closest('label')?.setAttribute('title', forecastToggle.title);
  fiscalModeButton.setAttribute('aria-pressed', String(periodMode === 'fiscal'));
  calendarModeButton.setAttribute('aria-pressed', String(periodMode === 'calendar'));
}
function renderForecastExplanation(plan: AnnualForecast | CalendarForecast): void {
  forecastPanel.hidden = false;
  forecastDetails.replaceChildren();
  const salaryCount = plan.jobs.main.estimates.length + plan.jobs.side.estimates.length;
  const bonusCount = plan.jobs.main.bonusEstimates.length;
  const estimatedCount = plan.estimates.length;
  forecastStatus.textContent = estimatedCount ? `実績＋給与${salaryCount}か月分・本業賞与${bonusCount}回分の見込み` : '実績のみ（見込み対象なし）';
  const explanation = document.createElement('p');
  explanation.className = 'forecast-note';
  explanation.textContent = periodMode === 'fiscal'
    ? '通常給与は未登録対象月を直近最大3件の中央値で推計。立替経費は翌月以降に繰り越しません。本業の未登録賞与（8月・翌2月）は最新の通常給与1件から交通費・立替経費を除いて推計します。業績給は見込みに含みません。副業賞与の見込みは加算しません。'
    : '通常給与は、勤務先ごとに最後の実績支給月の翌月から12月までを直近最大3件の中央値で推計します。過去の未登録給与月は補完しません。立替経費・年末調整の還付や追徴を繰り越しません。本業の未登録賞与（2月・8月）は過去月も含め、最新の通常給与1件から交通費・立替経費を除いて推計します。業績給は見込みに含めず、副業賞与の見込みは加算しません。';
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
      detail.textContent = `${item.estimates.length}か月分の推計（${months}）｜月額総支給 ${first.values.gross === null ? '算出不可' : yen(first.values.gross)}｜${periodMode === 'fiscal' ? '年度' : '暦年'}への加算 ${yen(total)}｜参照 ${sample} の${item.sampleMonths.length}件`;
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
        bonusDetail.textContent = '8月・2月の見込み対象はありません（登録済み、または対象期間外）。';
      } else {
        const months = item.bonusEstimates.map(e => e.month.replace('-', '/')).join('、');
        const total = item.bonusEstimates.reduce((sum, e) => sum + (e.values.gross ?? 0), 0);
        const first = item.bonusEstimates[0];
        const sample = item.bonusSampleMonth ? item.bonusSampleMonth.replace('-', '/') : '不明';
        bonusDetail.textContent = `${item.bonusEstimates.length}回（${months}）｜額面合計 ${yen(total)}｜1回あたり額面 ${first.values.gross === null ? '算出不可' : yen(first.values.gross)}・手取り ${first.values.net === null ? '算出不可' : yen(first.values.net)}｜参照：最新の通常給与 ${sample}（交通費・経費除外）`;
      }
      bonusLine.append(bonusTitle, bonusDetail);
      forecastDetails.append(bonusLine);
    }
  }
  const caution = document.createElement('p');
  caution.className = 'forecast-caution';
  caution.textContent = '将来分の所得税・住民税・社会保険料は過去の控除額から推計した参考値です。年末調整や最終的な税負担は予測しません。賞与見込みの控除も通常給与を参考にした概算です。業績手当は加算しません。登録済みの副業賞与は「賞与を含む」ON時に実績として集計します。見込み加算分の※は一部算出できない項目を示します。保存データは変更しません。';
  forecastDetails.append(caution);
  const suspicious = plan.estimates.filter(estimate => {
    const gross = estimate.values.gross;
    const net = estimate.values.net;
    const travel = estimate.values.transportation ?? 0;
    const expenses = estimate.values.reimbursedExpenses ?? 0;
    return gross !== null && (gross < 0 || net !== null && net > gross || travel + expenses > gross);
  });
  if (suspicious.length) {
    const warning = document.createElement('p');
    warning.className = 'forecast-caution forecast-caution--warning';
    warning.textContent = `見込み${suspicious.length}件で手取りが総支給を上回るなどの異常値が検出されました。推計の元となった実績明細を確認してください。`;
    forecastDetails.append(warning);
  }
}
function updateSummary(prefix: 'total' | Job, result: Summary, count: number, sideSalaryCount = count): void {
  for (const key of ['gross', 'net', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses'] as const) {
    const id = `${prefix}-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
    const element = document.getElementById(id);
    if (!element) continue;
    // 金額には金額だけを表示し、欠損情報は項目名の直下へ分離する。
    element.textContent = !count || !result.observed[key] ? '--' : yen(result.sums[key]);
    setMissingIndicator(element, count && result.partial[key] ? result.missingCounts[key] : 0, count);
  }
  if (prefix === 'side') {
    const days = document.getElementById('side-days');
    if (days) {
      days.textContent = !sideSalaryCount || !result.observed.workDays
        ? '--' : `${result.sums.workDays.toLocaleString('ja-JP')}日`;
      setMissingIndicator(days, sideSalaryCount && result.partial.workDays ? result.missingCounts.workDays : 0, sideSalaryCount);
    }
  }
}
function renderList(job: Job, records: SavedPayrollSummary[]): void {
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
  const ordered = [...records].sort((a, b) => b.form.paymentDate.localeCompare(a.form.paymentDate));
  for (const record of ordered.slice(0, visibleCounts[job])) {
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
    // 閲覧専用ページがクリック時にIDBから原本1件だけ取得する。
    link.href = `./view/index.html?id=${encodeURIComponent(String(record.id))}`;
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
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'btn btn--icon';
    download.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-download"></use></svg>';
    download.setAttribute('aria-label', `${record.fileName} をダウンロード`);
    download.title = '原本PDFをダウンロード';
    download.addEventListener('click', async () => {
      if (download.disabled) return;
      download.disabled = true;
      try {
        const full = await getRecord(record.id);
        if (!full || recordSignature(full) !== recordSignature(record)) {
          throw new Error('この明細は別タブで更新されています。画面を再読み込みしてください。');
        }
        const url = URL.createObjectURL(full.pdf);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = safePdfFileName(full.fileName);
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) {
        window.alert(`PDFのダウンロードに失敗しました。\n${error instanceof Error ? error.message : String(error)}`);
      } finally { download.disabled = false; }
    });
    const edit = document.createElement('a');
    edit.className = 'btn btn--icon';
    edit.href = `./edit/index.html?id=${encodeURIComponent(String(record.id))}&${editPeriodQuery()}`;
    edit.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-edit"></use></svg>';
    edit.setAttribute('aria-label', `${record.fileName} の保存情報を編集`);
    edit.title = '保存情報を確認・編集';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--icon btn--delete';
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>';
    remove.setAttribute('aria-label', `${record.fileName} を削除`);
    remove.title = '保存済みの明細を削除（暗号化PDF原本はOneDriveに保持）';
    remove.disabled = deletingRecordIds.has(record.id);
    remove.addEventListener('click', async () => {
      if (deletingRecordIds.has(record.id)) return;
      const label = record.form.job === 'main' ? '本業' : '副業';
      const kind = record.form.kind === 'bonus' ? '賞与' : '給与';
      const message = `保存済みの明細を1件削除します。\n\n${label} / ${record.form.targetMonth}分 / ${kind}\nファイル: ${record.fileName}\n\n解析・入力情報とFinance連携用の収入情報からこの明細を除外します。\n暗号化PDF原本はOneDriveに残りますが、アプリの明細一覧からは参照できなくなります。\n復元には削除前のバックアップなどが必要です。\n\n本当に削除しますか？`;
      if (!window.confirm(message)) return;
      deletingRecordIds.add(record.id);
      remove.disabled = true;
      try {
        await deleteRecord(record.id, recordSignature(record));
      } catch (error) {
        if(error instanceof PayrollPartialSuccessError && error.stage==='income-sync')
          window.alert(`明細の削除は完了していますが、Finance連携の収入同期が未完了です。\n${error.message}`);
        else window.alert(`削除処理を完了できませんでした。\n${error instanceof Error ? error.message : String(error)}`);
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
  // 50件ずつ描画する。年度内の全件を副業ZIPに保存する機能には影響しない。
  if (ordered.length > visibleCounts[job]) {
    const rest = ordered.length - visibleCounts[job];
    const moreItem = document.createElement('li');
    moreItem.className = 'statement-item';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn--secondary';
    more.textContent = `さらに${Math.min(50, rest)}件表示（残り${rest}件）`;
    more.addEventListener('click', () => { visibleCounts[job] += 50; render(); });
    moreItem.append(more);
    list.append(moreItem);
  }
}
function render(): void {
  const year = Number(yearSelect.value);
  const isCalendar = periodMode === 'calendar';
  periodLabel.textContent = isCalendar
    ? `${year}年1月〜12月 ・ 支給日基準`
    : `${year}年4月〜${year + 1}年3月 ・ 給与対象年月基準`;
  const yearRecords = selectedPeriodRecords();
  const main = yearRecords.filter(item => item.form.job === 'main');
  const side = yearRecords.filter(item => item.form.job === 'side');
  sideZipButton.disabled = exportingSideZip || side.length === 0;
  sideZipButton.title = side.length ? `表示中の副業明細${side.length}件の原本PDFをZIPで保存` : '表示中の副業PDFはありません';
  if (!exportingSideZip) sideZipStatus.textContent = '';
  const forecast = forecastToggle.checked
    ? isCalendar ? calculateCalendarForecast(saved, year, new Date(), bonusToggle.checked)
      : calculateAnnualForecast(saved, year, new Date(), bonusToggle.checked)
    : null;
  const projected = forecast?.estimates ?? [];
  periodLabel.textContent += forecastToggle.checked ? ' / 見込みは画面表示のみ' : '';
  forecastPanel.hidden = !forecast;
  forecastStatus.hidden = !forecast;
  forecastHeading.textContent = isCalendar ? '12月までの見込み計算根拠' : '3月までの見込み計算根拠';
  if (forecast) renderForecastExplanation(forecast);
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-amount-period]'))) {
    element.textContent = isCalendar ? '年間総支給額' : '年度総支給額';
  }
  const daysLabel = document.getElementById('side-days-label');
  if (daysLabel) daysLabel.textContent = isCalendar ? '出勤日数（暦年累計）' : '出勤日数（年度累計）';
  updateSummary('total', withEstimates(summary(yearRecords), projected), yearRecords.length + projected.length);
  const mainProjected = projected.filter(item => item.job === 'main');
  const sideProjected = projected.filter(item => item.job === 'side');
  updateSummary('main', withEstimates(summary(main), mainProjected), main.length + mainProjected.length);
  updateSummary('side', withEstimates(summary(side), sideProjected), side.length + sideProjected.length,
    side.filter(item => item.form.kind === 'salary').length + sideProjected.filter(item => item.kind === 'salary').length);
  renderList('main', main);
  renderList('side', side);
}
function changeMode(mode: PeriodMode): void {
  if (periodMode === mode) return;
  periodMode = mode;
  visibleCounts.main = 50; visibleCounts.side = 50;
  updateYearOptions();
  persistPeriodSelection();
  render();
}
fiscalModeButton.addEventListener('click', () => changeMode('fiscal'));
calendarModeButton.addEventListener('click', () => changeMode('calendar'));
yearSelect.addEventListener('change', () => { visibleCounts.main = 50; visibleCounts.side = 50; persistPeriodSelection(); render(); });
bonusToggle.addEventListener('change', () => { visibleCounts.main = 50; visibleCounts.side = 50; render(); });
forecastToggle.addEventListener('change', render);
let dashboardValidUntil=0;
let dashboardMutationEpoch='';
let dashboardLoading=false;
async function refreshDashboard(forceFresh=false): Promise<void> {
  if(dashboardLoading)return;
  dashboardLoading=true;
  const refreshButton=document.querySelector<HTMLButtonElement>('#payroll-refresh-data');
  if(refreshButton)refreshButton.disabled=true;
  const preferred=initialYear??currentPeriodYear();
  periodLabel.setAttribute('aria-busy','true');
  yearSelect.disabled=true;
  bonusToggle.disabled=true;
  forecastToggle.disabled=true;
  sideZipButton.disabled=true;
  try {
    saved = await loadRecordSummaries({
      forceFresh,
      priorityYears:[String(preferred),String(preferred-1)],
      onProgress:message=>{periodLabel.textContent=message;},
    });
    yearSelect.disabled = false;
    bonusToggle.disabled = false;
    forecastToggle.disabled = false;
    periodLabel.removeAttribute('role');
    periodLabel.style.removeProperty('color');
    updateYearOptions();
    render();
    dashboardMutationEpoch=mutationEpoch();
    const cache=await summaryCacheInfo();dashboardValidUntil=cache.deadline;
    const indicator=document.getElementById('payroll-data-freshness');
    if(indicator)indicator.textContent=cache.cached?'短時間の暗号化キャッシュを表示中':'OneDrive確認済み';
  } catch (error) {
    console.error('保存済み明細を読み込めませんでした。', error);
    periodLabel.textContent = `保存済み明細の読み込みに失敗しました。OneDriveへの接続と暗号化保管庫をご確認ください。${error instanceof Error ? ` (${error.message})` : ''}`;
    periodLabel.setAttribute('role', 'alert');
    periodLabel.style.color = 'var(--color-danger)';
    yearSelect.disabled = true;
    bonusToggle.disabled = true;
    forecastToggle.disabled = true;
    sideZipButton.disabled = true;
    // エラー文を通常renderで上書きしない。既存レコードが消えたわけではない。
  } finally {
    periodLabel.removeAttribute('aria-busy');
    dashboardLoading=false;
    if(refreshButton)refreshButton.disabled=false;
  }
}
// Back/forward cache does not imply a changed dataset. Only mutations or TTL expiry force a reload.
window.addEventListener('pageshow', event => {
 if(event.persisted && (dashboardMutationEpoch!==mutationEpoch()||Date.now()>=dashboardValidUntil))
  void refreshDashboard(true);
});
// フッターの操作領域へだけ追加し、説明文と動的ボタンを均等配置しない。
const footerActions=document.querySelector<HTMLElement>('.site-footer__actions');
if(footerActions&&!footerActions.querySelector('#payroll-refresh-data')) {
 const control=document.createElement('span');control.className='payroll-data-sync';
 const state=document.createElement('span');state.id='payroll-data-freshness';state.textContent='確認中…';
 state.setAttribute('role','status');state.setAttribute('aria-live','polite');
 const refresh=document.createElement('button');refresh.id='payroll-refresh-data';refresh.type='button';refresh.className='site-footer__button';refresh.textContent='最新を確認';
 refresh.addEventListener('click',()=>{void refreshDashboard(true);});
 control.append(state,refresh);footerActions.append(control);
}
void refreshDashboard();
