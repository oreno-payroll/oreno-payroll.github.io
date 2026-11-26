import {recordNotification} from './ui/notificationHistory';
import {confirmOperation,showOperationMessage} from './ui/operationDialog';
import {takeNavigationNotice,navigationFeedback} from './ui/navigationNotice';
import { createAppStatus, type AppStatusKind } from './ui/appStatus';
import {dashboardFreshnessLabel} from './ui/operationFeedback';
import { safePdfFileName } from './storage/fileNaming';
import { preparePdfHandoff } from './pdf/handoff';
import {readNavigationParams,replaceNavigationParams,migrateLegacyNavigation} from './ui/navigationParams';
import { capturePdfHandoffAuthorization,captureOperationAuthorization } from './cloud/auth';
/** 給与ダッシュボード：OneDrive暗号化保管庫の解析JSONから集計する。 */
import { deleteRecords, getOriginalForVerifiedEdit, getOriginalForBatchExport, loadRecordSummaries, summaryCacheInfo, recordSignature, type SavedPayrollRecord, type SavedPayrollSummary } from './storage/payrollStore';
import {PayrollPartialSuccessError} from './storage/operationError';
import {incompleteDeleteIncomeNotice,incompleteDeleteOriginalNotice} from './ui/deleteOutcome';
import {PendingDeletion} from './ui/pendingDeletion';
import {mutationEpoch,authEpoch,NAVIGATION_MUTATION_KEY} from './cloud/snapshot';
import { amountOrMissing } from './storage/payrollValidation';
import { summary, withEstimates, type Summary, type SummaryKey } from './forecast/summary';
import { setMissingIndicator } from './ui/missingIndicator';
import { createSidePdfZip } from './export/sidePdfs';
import { calculateAnnualForecast, type MonthEstimate, type AnnualForecast } from './forecast/annualForecast';
import { selectDashboardPeriod, selectDashboardIncome, selectDashboardStatements, type StatementKindFilter } from './forecast/dashboardSelection';
import { fiscalYearOfTargetMonth } from './forecast/payrollCalendar';
import { calendarYearOfPaymentDate, calculateCalendarForecast, type CalendarForecast } from './forecast/calendarForecast';
import { monthlySalaryRegistration } from './forecast/monthlyRegistration';
import {employerDisplayName,legacyEmployers,type LegacyEmployer} from './ui/employerSelection';
import type {EmployerEntry} from './storage/employerDirectory';
import {SALARY_FORECAST_LABELS} from './storage/employerForecast';

type Job = 'main' | 'side';
type PeriodMode = 'fiscal' | 'calendar';

function required<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`必要な画面要素が見つかりません: ${selector}`);
  return node;
}
const appStatus=createAppStatus(undefined,'home');
const yearSelect = required<HTMLSelectElement>('#fiscal-year');
const fiscalModeButton = required<HTMLButtonElement>('#mode-fiscal');
const calendarModeButton = required<HTMLButtonElement>('#mode-calendar');
const yearLabel = required<HTMLElement>('#year-label');
const forecastLabel = required<HTMLElement>('#forecast-toggle-label');
const periodLabel = required<HTMLElement>('#fiscal-period');
const bonusToggle = required<HTMLInputElement>('#include-bonus');
const forecastToggle = required<HTMLInputElement>('#include-forecast');
const forecastPanel = required<HTMLDetailsElement>('#forecast-panel');
const forecastStatus = required<HTMLElement>('#forecast-status');
const forecastDetails = required<HTMLElement>('#forecast-details');
const forecastHeading = required<HTMLElement>('#forecast-heading');
const registrationPanel = required<HTMLElement>('#monthly-registration');
const registrationGrid = required<HTMLElement>('#registration-grid');
const registrationPeriod = required<HTMLElement>('#registration-period');
const yen = (amount: number): string => `${amount.toLocaleString('ja-JP')}円`;
// 編集ページと相互に引き継ぐ。旧リンク ?fy=2025 にも後方互換性を残す。
const periodKeys=['mode','year','fy'] as const;
const searchParams = readNavigationParams(window.location,periodKeys);
migrateLegacyNavigation(searchParams,periodKeys);
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
  replaceNavigationParams(new URLSearchParams({mode:periodMode,year:yearSelect.value}),periodKeys);
}
function editPeriodQuery(): string {
  return `mode=${encodeURIComponent(periodMode)}&year=${encodeURIComponent(yearSelect.value)}`;
}
let saved: SavedPayrollSummary[] = [];
let employerDirectory:EmployerEntry[]=[];
let legacyDirectory:LegacyEmployer[]=[];
function employerName(record:SavedPayrollSummary):string{return employerDisplayName(employerDirectory,record.employerId,record.form.job,legacyDirectory);}
const visibleCounts: Record<Job, number> = { main: 50, side: 50 };
const deletingRecordIds = new Set<number>();
const pendingDeletion=new PendingDeletion();
const deletionPanel=required<HTMLDetailsElement>('#pending-deletion');
const deletionList=required<HTMLUListElement>('#pending-deletion-list');
const deletionStatus=required<HTMLElement>('#pending-deletion-status');
const deletionSave=required<HTMLButtonElement>('#pending-deletion-save');
const deletionUndo=required<HTMLButtonElement>('#pending-deletion-undo');
let deletionAuthorization:(()=>boolean)|undefined;
let confirmingDeletion=false;
const deletionBusy=()=>confirmingDeletion||deletingRecordIds.size>0;
function deletionMatches():boolean{return pendingDeletion.matches(saved.map(r=>({id:r.id,signature:recordSignature(r)})));}
function deletionLabel(record:SavedPayrollSummary):string{return `${record.form.targetMonth} / ${record.form.job==='main'?'本業':'副業'} / ${employerName(record)} / ${record.fileName}`;}
function renderPendingDeletion():void{
 if(deletionPanel.hidden&&pendingDeletion.size)deletionPanel.open=true;
 deletionPanel.hidden=pendingDeletion.size===0;
 deletionList.replaceChildren();
 const blocked=deletionBusy()||exportingSideZip||dashboardLoading||dashboardStale;
 const current=!pendingDeletion.size||deletionMatches();
 deletionStatus.textContent=`削除待ち ${pendingDeletion.size}件（すべての期間・絞り込みを含む）`+(current?'':'。対象が更新されました。取り消して選び直してください。');
 for(const target of pendingDeletion.snapshot()){
  const li=document.createElement('li'),name=document.createElement('span'),undo=document.createElement('button');
  name.textContent=saved.find(r=>r.id===target.id)?deletionLabel(saved.find(r=>r.id===target.id)!):target.label;undo.type='button';undo.className='btn btn--secondary';undo.textContent='元に戻す';undo.disabled=deletionBusy();
  undo.addEventListener('click',()=>{if(!deletionBusy()){pendingDeletion.remove(target.id);render();}});li.append(name,undo);deletionList.append(li);
 }
 deletionUndo.disabled=deletionBusy();
 deletionSave.disabled=blocked||!current||!pendingDeletion.size||!deletionAuthorization?.();
}
deletionUndo.addEventListener('click',()=>{if(!deletionBusy()){pendingDeletion.clear();deletionAuthorization=undefined;render();}});
window.addEventListener('beforeunload',event=>{if(pendingDeletion.size||deletingRecordIds.size){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{pendingDeletion.clear();deletionAuthorization=undefined;});
deletionSave.addEventListener('click',async()=>{
 if(deletionBusy()||exportingSideZip||dashboardLoading||dashboardStale||!pendingDeletion.size||!deletionMatches()||!deletionAuthorization?.())return;
 const targets=pendingDeletion.snapshot(),authorized=deletionAuthorization;
 const guard=()=>authorized()&&!exportingSideZip&&!dashboardLoading&&!dashboardStale&&deletionMatches()&&JSON.stringify(targets)===JSON.stringify(pendingDeletion.snapshot());
 confirmingDeletion=true;renderPendingDeletion();
 const approved=await confirmOperation({title:'削除待ちの明細を確定',subject:`給与明細 ${targets.length}件`,tone:'danger',acceptLabel:'明細を削除',details:[
  ...targets.map(t=>{const record=saved.find(r=>r.id===t.id);return record?deletionLabel(record):t.label;}),
  '明細情報とFinance連携用の収入情報から選択した明細を除外します。',
  '明細とFinance連携を更新し、暗号化PDF原本は保全します。不要な原本は設定の未参照PDF原本の管理から別途整理できます。',
  '復元には削除前のバックアップなどが必要です。',
 ]},guard);
 confirmingDeletion=false;
 if(!approved||!guard()){renderPendingDeletion();return;}
 for(const target of targets)deletingRecordIds.add(target.id);
 render();
 appStatus.loading(`明細 ${targets.length}件を削除しています…`);
 let completion:{kind:AppStatusKind;message:string};
 try{
  await deleteRecords(targets);
  completion={kind:'success',message:`明細 ${targets.length}件を削除しました。Finance連携を確認しました。暗号化PDF原本は保全しています。`};
 }catch(error){
  if(error instanceof PayrollPartialSuccessError&&error.stage==='income-sync'){
   completion={kind:'partial',message:incompleteDeleteIncomeNotice()};
   if(authorized())appStatus.show('partial',completion.message,false,{code:'delete-income-partial'});
   await showOperationMessage({title:'明細削除・一部完了',details:[incompleteDeleteIncomeNotice()],tone:'warning',acceptLabel:'閉じる'},authorized);
  }else if(error instanceof PayrollPartialSuccessError&&error.stage==='original-trash'){
   completion={kind:'partial',message:incompleteDeleteOriginalNotice()};
   if(authorized())appStatus.show('partial',completion.message,false,{code:'delete-original-partial'});
   await showOperationMessage({title:'PDF原本の整理・一部完了',details:[completion.message],tone:'warning',acceptLabel:'閉じる'},authorized);
  }else{
   completion={kind:'error',message:'削除結果を確認できません。年度ごとに一部確定した可能性があります。最新データを確認し、設定からFinance連携を再生成してください。'};
   if(authorized())appStatus.show('error',completion.message,false,{code:'delete-saved'});
   await showOperationMessage({title:'削除結果を確認してください',details:[completion.message],tone:'danger',acceptLabel:'閉じる'},authorized);
  }
 }finally{
  pendingDeletion.clear();deletionAuthorization=undefined;deletingRecordIds.clear();
 }
 if(authorized()){
  if(completion.kind==='success')recordNotification('delete-saved','success');
  await refreshDashboard(true,completion);
 }
});
const sideZipButton = required<HTMLButtonElement>('#download-side-zip');
let exportingSideZip = false;
let statementKind: StatementKindFilter = 'all';
function selectedPeriodRecords(): SavedPayrollSummary[] {
  return selectDashboardPeriod(saved, Number(yearSelect.value), periodMode);
}
sideZipButton.addEventListener('click', async () => {
  if (exportingSideZip || dashboardLoading || dashboardStale || deletionBusy()) return;
  const exportYear = yearSelect.value;
  const exportMode = periodMode;
  const side = selectedPeriodRecords().filter(item => item.form.job === 'side');
  if (!side.length) return;
  exportingSideZip = true;
  renderPendingDeletion();
  const noticeScope=appStatus.begin('pdf-zip'),authorized=captureOperationAuthorization();
  appStatus.show('loading','副業PDFをまとめています…',false,{scope:noticeScope});
  sideZipButton.disabled = true;
  try {
    // 表示には索引しか持たないため、ZIP作成の際にだけ対象PDF原本を取得する。
    const before=await loadRecordSummaries();
    if(side.some(item=>!before.some(rec=>rec.id===item.id&&recordSignature(rec)===recordSignature(item))))
      throw new Error('保存済み明細が変更されました。画面を更新してから再実行してください。');
    // Two bounded workers mirror the backup reader. Never publish a partial ZIP;
    // preserve the selected order regardless of individual download completion.
    const originals = new Array<SavedPayrollRecord>(side.length);
    let next=0,completed=0,firstFailure:unknown=null;
    const worker=async():Promise<void>=>{
      while(firstFailure===null){
        const index=next++;
        if(index>=side.length)return;
        const item=side[index];
        try{
          const pdf=await getOriginalForBatchExport(item.id,recordSignature(item));
          originals[index]={...item,pdf};
          completed++;
          if(authorized())appStatus.show('loading',`PDF原本を取得中 ${completed}/${side.length}件`,false,{scope:noticeScope});
        }catch(error){if(firstFailure===null)firstFailure=error;}
      }
    };
    await Promise.all(Array.from({length:Math.min(2,side.length)},()=>worker()));
    if(firstFailure!==null)throw firstFailure;
    const after=await loadRecordSummaries();
    if(side.some(item=>!after.some(rec=>rec.id===item.id&&recordSignature(rec)===recordSignature(item))))
      throw new Error('PDF取得中に保存済み明細が更新されました。再読み込みしてください。');
    const archive = await createSidePdfZip(originals);
    const url = URL.createObjectURL(archive);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-side-${exportMode}-${exportYear}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if(authorized())appStatus.show('success',`副業PDF ${side.length}件のZIPを作成しました`,false,{scope:noticeScope});
  } catch (error) {
    if(authorized())appStatus.show('error',`副業PDFのZIP作成に失敗しました：${error instanceof Error ? error.message : String(error)}`,false,{scope:noticeScope});
  } finally {
    exportingSideZip = false;
    renderPendingDeletion();
    sideZipButton.disabled = dashboardLoading || dashboardStale || selectedPeriodRecords().every(item => item.form.job !== 'side');
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
    ? '対象月基準で3月までの未登録給与と設定された賞与を概算します。'
    : '支給日基準で、最後の実績支給月の翌月と当月の遅い方から12月まで概算します。過去月の未登録給与は補完しません。';
  forecastToggle.closest('label')?.setAttribute('title', forecastToggle.title);
  fiscalModeButton.setAttribute('aria-pressed', String(periodMode === 'fiscal'));
  calendarModeButton.setAttribute('aria-pressed', String(periodMode === 'calendar'));
}
function renderForecastExplanation(plan: AnnualForecast | CalendarForecast): void {
  forecastPanel.hidden = false;
  forecastDetails.replaceChildren();
  const salaryCount = plan.jobs.main.estimates.length + plan.jobs.side.estimates.length;
  const bonusCount = plan.jobs.main.bonusEstimates.length + plan.jobs.side.bonusEstimates.length;
  const estimatedCount = plan.estimates.length;
  forecastStatus.textContent = estimatedCount ? `実績＋給与${salaryCount}か月分・賞与${bonusCount}回分の見込み` : '実績のみ（見込み対象なし）';
  const explanation = document.createElement('p');
  explanation.className = 'forecast-note';
  explanation.textContent = periodMode === 'fiscal'
    ? '通常給与は支給時期を考慮した未登録対象月を、勤務先ごとに設定した方法で推計します。直近6か月の支給済み通常給与を参照し、立替経費は繰り返し計上しません。賞与は年度内の実績と予定月を照合します。対象年月を優先し、一致しない場合は支給年月も確認して、未登録の予定月に最新の通常給与1件から交通費・立替経費を除いた参考額を加算します。業績給は含めません。'
    : '通常給与は最後の実績支給月の翌月と現在月の遅い方から12月まで、勤務先ごとに設定した方法で推計します。現在月より前の未登録給与月は補完しません。立替経費は繰り返し計上しません。賞与は支給予定月が未登録の場合に、最新の通常給与1件から交通費・立替経費を除いた参考額を加算します。業績給は含めません。';
  const methodology = document.createElement('details');
  methodology.className = 'forecast-methodology';
  const methodologyTitle = document.createElement('summary');
  methodologyTitle.textContent = '計算方法・注意事項';
  methodology.append(methodologyTitle, explanation);
  const scopeNote=document.createElement('p');scopeNote.className='forecast-note';scopeNote.textContent='現在の勤務先が設定されている場合はその勤務先の給与を参照し、過去の賞与は補完しません。勤務先未設定の実績月は重複見込みを避けます。勤務先情報が未登録の勤務区分では、直近の勤務先の給与実績を参照します。すべて過去の勤務先の場合は見込みを算出しません。実績集計は全勤務先を含みます。';methodology.append(scopeNote);
  if (estimatedCount) {
    const deltaLine = document.createElement('p');
    deltaLine.className = 'forecast-delta';
    const fields: Array<[SummaryKey, string]> = [
      ['gross', '総支給額'], ['net', '手取り'], ['taxable', '課税支給額'], ['nonTaxable', '非課税支給額'], ['incomeTax', '所得税'],
      ['residentTax', '住民税'], ['socialInsurance', '社会保険料'], ['transportation', '交通費'], ['reimbursedExpenses', '立替経費'],
    ];
    const additions = fields.map(([key, label]) => {
      const known = plan.estimates.map(estimate => estimate.values[key]).filter((value): value is number => value !== null);
      return `${label} +${known.length ? yen(known.reduce((sum, value) => sum + value, 0)) : '算出不可'}${known.length < estimatedCount || plan.estimates.some(estimate=>estimate.incomplete[key]) ? ' ※' : ''}`;
    });
    deltaLine.textContent = `見込み加算分：${additions.join(' ／ ')}`;
    forecastDetails.append(deltaLine);
  }
  const formatGrossAddition = (estimates: readonly MonthEstimate[]): string => {
    const known = estimates.map(estimate => estimate.values.gross).filter((value): value is number => value !== null);
    if (!known.length) return '算出不可';
    const partial = known.length < estimates.length || estimates.some(estimate => estimate.incomplete.gross);
    return `${yen(known.reduce((sum, value) => sum + value, 0))}${partial ? ' ※' : ''}`;
  };
  for (const job of ['main', 'side'] as const) {
    const item = plan.jobs[job];
    const line = document.createElement('div');
    line.className = 'forecast-job-row';
    const title = document.createElement('strong');
    title.textContent = `${job === 'main' ? '本業' : '副業'}${item.employerName?`（${item.employerName}）`:''}`;
    const detail = document.createElement('span');
    if (item.reason) {
      detail.textContent = `${SALARY_FORECAST_LABELS[item.salaryMethod]}｜${item.reason}`;
    } else {
      const first = item.estimates[0];
      const total = formatGrossAddition(item.estimates);
      const sample = item.sampleMonths.map(month => month.replace('-', '/')).join('・');
      const months = item.pendingMonths.map(month => month.replace('-', '/')).join('、');
      detail.textContent = `${SALARY_FORECAST_LABELS[item.salaryMethod]}｜${item.estimates.length}か月分の推計（${months}）｜月額総支給額 ${first.values.gross === null ? '算出不可' : yen(first.values.gross)}｜${periodMode === 'fiscal' ? '年度' : '暦年'}への加算 ${total}｜参照 ${sample} の${item.sampleMonths.length}件`;
    }
    line.append(title, detail);
    forecastDetails.append(line);
    if (bonusToggle.checked) {
      const bonusLine = document.createElement('div');
      bonusLine.className = 'forecast-job-row';
      const bonusTitle = document.createElement('strong');
      bonusTitle.textContent = `${job==='main'?'本業':'副業'}賞与`;
      const bonusDetail = document.createElement('span');
      if (item.bonusReason) {
        bonusDetail.textContent = item.bonusReason;
      } else if (!item.bonusEstimates.length) {
        bonusDetail.textContent = '見込み対象はありません（登録済み、または対象期間外）。';
      } else {
        const months = item.bonusEstimates.map(e => e.month.replace('-', '/')).join('、');
        const total = formatGrossAddition(item.bonusEstimates);
        const first = item.bonusEstimates[0];
        const sample = item.bonusSampleMonth ? item.bonusSampleMonth.replace('-', '/') : '不明';
        bonusDetail.textContent = `${item.bonusEstimates.length}回（${months}）｜額面合計 ${total}｜1回あたり額面 ${first.values.gross === null ? '算出不可' : yen(first.values.gross)}・手取り ${first.values.net === null ? '算出不可' : yen(first.values.net)}｜参照：最新の通常給与 ${sample}（交通費・経費除外）`;
      }
      if(item.bonusMonths.length)bonusDetail.textContent=`予定：${item.bonusMonths.map(m=>`${m}月`).join('・')}｜${bonusDetail.textContent}`;
      bonusLine.append(bonusTitle, bonusDetail);
      forecastDetails.append(bonusLine);
    }
  }
  const caution = document.createElement('p');
  caution.className = 'forecast-caution';
  caution.textContent = '将来分の所得税・住民税・社会保険料は過去の控除額から推計した参考値です。年末調整や最終的な税負担は予測しません。賞与見込みの控除も通常給与を参考にした概算です。業績手当は加算しません。課税・非課税の見込みは取得済みの内訳から推計します。項目ごとの中央値を使用するため、総支給額と一致しない場合があります。根拠がない内訳は算出しません。見込み金額の※は一部算出できない項目を示します。';
  methodology.append(caution);
  forecastDetails.append(methodology);
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
    warning.textContent = `見込み${suspicious.length}件で手取りが総支給額を上回るなどの異常値が検出されました。推計の元となった実績明細を確認してください。`;
    forecastDetails.append(warning);
  }
}
/** Reuse the actual aggregation rules, including explicit zero and optional fields. */
function showMissingRecords(prefix:'total'|Job,key:SummaryKey,records:readonly SavedPayrollSummary[],estimates:readonly MonthEstimate[],trigger:HTMLButtonElement):void {
  const authorized=captureOperationAuthorization();
  const guard=()=>authorized()&&trigger.isConnected&&!dashboardLoading&&!dashboardStale&&!deletionBusy();
  if(!guard())return;
  const labels:Record<SummaryKey,string>={gross:'総支給額',net:'手取り',taxable:'課税支給額',nonTaxable:'非課税支給額',incomeTax:'所得税（年調含む）',residentTax:'住民税',socialInsurance:'社会保険料',transportation:'交通費',reimbursedExpenses:'立替経費',workDays:'出勤日数'};
  const actual=records.filter(record=>summary([record]).partial[key]);
  const empty=summary([]);
  const projected=estimates.filter(estimate=>withEstimates(empty,[estimate]).partial[key]);
  const role=(job:string)=>job==='main'?'本業':'副業';
  const kind=(value:string)=>value==='bonus'?'賞与':'給与';
  const details=[actual.length?`未入力の明細：${actual.length}件`:'登録済み明細に未入力はありません。'];
  const afterLinks:string[]=[];
  if(projected.length)afterLinks.push(`見込みの算出不足：${projected.length}件（編集対象の明細ではありません）。\n${projected.map(e=>`${e.month} / ${role(e.job)} / ${kind(e.kind)}`).join('\n')}`);
  const links=[...actual].sort((a,b)=>b.form.targetMonth.localeCompare(a.form.targetMonth)||b.form.paymentDate.localeCompare(a.form.paymentDate)).map(record=>({
    label:record.fileName,
    description:`${record.form.targetMonth.replace(/^(\d{4})-(\d{2})$/,(_,year,month)=>`${year}年${Number(month)}月`)} · ${role(record.form.job)} · ${employerName(record)} · ${kind(record.form.kind)}${pendingDeletion.has(record.id)?' · 削除待ち':''}`,
    href:editRecordHref(record),
  }));
  void showOperationMessage({title:`${prefix==='total'?'総収入':role(prefix)}：${labels[key]}の未入力`,details,links,afterLinks,acceptLabel:'閉じる'},guard);
}
function editRecordHref(record:SavedPayrollSummary):string {
  const hintedYear=fiscalYearOfTargetMonth(record.form.targetMonth);
  return `./edit/index.html#id=${encodeURIComponent(String(record.id))}&${editPeriodQuery()}${hintedYear!==null?`&hintYear=${encodeURIComponent(String(hintedYear))}`:''}`;
}
function updateSummary(prefix: 'total' | Job, result: Summary, count: number, records:readonly SavedPayrollSummary[], estimates:readonly MonthEstimate[], sideSalaryCount = count): void {
  const estimatedMissing=withEstimates(summary([]),estimates).missingCounts;
  for (const key of ['gross', 'net', 'taxable', 'nonTaxable', 'incomeTax', 'residentTax', 'socialInsurance', 'transportation', 'reimbursedExpenses'] as const) {
    const id = `${prefix}-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
    const element = document.getElementById(id);
    if (!element) continue;
    // 金額には金額だけを表示し、欠損情報は項目名の直下へ分離する。
    element.textContent = !count || !result.observed[key] ? '--' : yen(result.sums[key]);
    setMissingIndicator(element, count && result.partial[key] ? result.missingCounts[key] : 0, count, trigger=>showMissingRecords(prefix,key,records,estimates,trigger), estimatedMissing[key]);
  }
  if (prefix === 'total') {
    const complete = count > 0 && result.observed.gross && result.observed.net && !result.partial.gross && !result.partial.net;
    required<HTMLElement>('#total-deductions').textContent = complete ? yen(result.sums.gross - result.sums.net) : '--';
  }
  if (prefix === 'side') {
    const days = document.getElementById('side-days');
    if (days) {
      days.textContent = !sideSalaryCount || !result.observed.workDays
        ? '--' : `${result.sums.workDays.toLocaleString('ja-JP')}日`;
      setMissingIndicator(days, sideSalaryCount && result.partial.workDays ? result.missingCounts.workDays : 0, sideSalaryCount, trigger=>showMissingRecords(prefix,'workDays',records,estimates,trigger), estimatedMissing.workDays);
    }
  }
}
function renderList(job: Job, records: SavedPayrollSummary[], emptyMessage?:string): void {
  const list = required<HTMLUListElement>(`#${job}-records`);
  const pendingCount=records.filter(record=>pendingDeletion.has(record.id)).length;
  records=records.filter(record=>!pendingDeletion.has(record.id));
  required<HTMLElement>(`#${job}-count`).textContent = `${records.length}件`;
  list.replaceChildren();
  if (!records.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    const strong = document.createElement('strong');
    strong.textContent = pendingCount?"削除待ちの明細は上の一覧で確認できます":emptyMessage??(saved.some(item=>item.form.job===job)?(selectedPeriodRecords().some(item=>item.form.job===job)?'条件に一致する明細はありません':'この期間の明細はありません'):'明細が登録されていません');
    li.append(strong);
    list.append(li);
    return;
  }
  // Keep slips in month order without adding redundant month headings.
  const monthKey = (record: SavedPayrollSummary):string =>
    periodMode==='calendar' ? record.form.paymentDate.slice(0,7) : record.form.targetMonth;
  const ordered = [...records].sort((a, b) =>
    monthKey(b).localeCompare(monthKey(a)) || b.form.paymentDate.localeCompare(a.form.paymentDate));
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
    link.title = record.fileName;
    // 元タブの認証済み保管庫で原本を取得し、閲覧タブへPDF Blobだけ渡す。
    // 右クリックでURLを開いた場合などは、従来の閲覧ページへフォールバック。
    link.href = `./view/index.html#id=${encodeURIComponent(String(record.id))}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const handoffPdf = () => preparePdfHandoff(link, record.id, async () => ({
      fileName: record.fileName,
      pdf: await getOriginalForVerifiedEdit(record.id, recordSignature(record)),
    }), capturePdfHandoffAuthorization());
    link.addEventListener('click', event => { if (!event.defaultPrevented) handoffPdf(); });
    link.addEventListener('auxclick', event => { if (event.button === 1 && !event.defaultPrevented) handoffPdf(); });
    // The PDF name already conveys its period/type. Keep only useful figures below it.
    const amounts = document.createElement('span');
    amounts.className = 'statement-item__amounts';
    for (const [label, value] of [
      ['総支給額', record.form.gross],
      ['手取り', record.form.net],
    ] as const) {
      const amount = document.createElement('span');
      const figure = amountOrMissing(value);
      amount.textContent = `${label} ${figure === null ? '--' : yen(figure)}`;
      amounts.append(amount);
    }
    const employer=document.createElement('span');employer.className='statement-item__employer';employer.textContent=employerName(record);
    detail.append(link, employer, amounts);
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
      const noticeScope=appStatus.begin('pdf-download',record),authorized=captureOperationAuthorization();
      appStatus.show('loading','PDF原本を取得しています…',false,{scope:noticeScope});
      try {
        // Revalidate the complete annual inventory and the displayed signature
        // both before and after fetching the hash-verified original PDF.
        const pdf = await getOriginalForVerifiedEdit(record.id, recordSignature(record));
        const url = URL.createObjectURL(pdf);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = safePdfFileName(record.fileName);
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        if(authorized())appStatus.show('success','PDFのダウンロードを開始しました',false,{scope:noticeScope});
      } catch (error) {
        if(authorized())appStatus.show('error',`PDFのダウンロードに失敗しました：${error instanceof Error ? error.message : String(error)}`,false,{scope:noticeScope});
      } finally { download.disabled = false; }
    });
    const edit = document.createElement('a');
    edit.className = 'btn btn--icon';
    // A verified source record supplies an untrusted *priority* hint for the
    // edit page. It is never used as an authority for writes or PDF locations.
    edit.href = editRecordHref(record);
    edit.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-edit"></use></svg>';
    edit.setAttribute('aria-label', `${record.fileName} の保存情報を編集`);
    edit.title = '保存情報を確認・編集';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--icon btn--delete';
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>';
    remove.setAttribute('aria-label', `${record.fileName} を削除待ちにする`);
    remove.title = '削除待ちにする（確定までは暗号化PDF原本はOneDriveに保持）';
    remove.dataset.recordId=String(record.id);
    remove.disabled = deletionBusy() || dashboardLoading || dashboardStale;
    remove.addEventListener('click', () => {
      if (deletionBusy()||dashboardLoading||dashboardStale||!saved.some(r=>r.id===record.id&&recordSignature(r)===recordSignature(record)))return;
      if(!pendingDeletion.size)deletionAuthorization=captureOperationAuthorization();
      if(!deletionAuthorization?.())return;
      pendingDeletion.toggle({id:record.id,signature:recordSignature(record),label:deletionLabel(record)});
      render();
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
/** 登録状況は保存済みの通常給与だけで判定し、見込みや賞与を混ぜない。 */
function renderMonthlyRegistration(year: number, isCalendar: boolean): void {
  const months = monthlySalaryRegistration(saved, year, isCalendar ? 'calendar' : 'fiscal');
  registrationPeriod.textContent = isCalendar
    ? `${year}年1月〜12月・支給日基準`
    : `${year}年4月〜${year + 1}年3月・給与対象年月基準`;
  const cards: HTMLElement[] = [];
  for (const month of months) {
    const card = document.createElement('div');
    card.className = 'registration-month';
    const heading = document.createElement('strong');
    heading.className = 'registration-month__heading';
    heading.textContent = `${month.month}月`;
    card.append(heading);
    for (const [job, label] of [['main', '本業'], ['side', '副業']] as const) {
      const exists = month[job];
      const status = document.createElement('span');
      status.className = `registration-month__status ${exists ? 'is-registered' : 'is-missing'}`;
      status.textContent = `${label}：${exists ? '登録済み' : '未登録'}`;
      card.append(status);
    }
    cards.push(card);
  }
  registrationGrid.replaceChildren(...cards);
  registrationPanel.hidden = false;
}

function render(): void {
  const year = Number(yearSelect.value);
  const isCalendar = periodMode === 'calendar';
  periodLabel.textContent = isCalendar
    ? `${year}年1月〜12月 ・ 支給日基準`
    : `${year}年4月〜${year + 1}年3月 ・ 給与対象年月基準`;
  const periodRecords = selectedPeriodRecords();
  const yearRecords = selectDashboardIncome(periodRecords, bonusToggle.checked);
  const listRecords = selectDashboardStatements(periodRecords, statementKind);
  renderMonthlyRegistration(year, isCalendar);
  const main = yearRecords.filter(item => item.form.job === 'main');
  const side = yearRecords.filter(item => item.form.job === 'side');
  const exportCount = periodRecords.filter(item => item.form.job === 'side').length;
  sideZipButton.disabled = exportingSideZip || exportCount === 0 || dashboardLoading || dashboardStale;
  sideZipButton.title = exportCount ? `選択期間の副業PDF全${exportCount}件をZIP保存（賞与を含む）` : '選択期間の副業PDFはありません';
  const forecast = forecastToggle.checked
    ? isCalendar ? calculateCalendarForecast(saved, year, new Date(), bonusToggle.checked,employerDirectory)
      : calculateAnnualForecast(saved, year, new Date(), bonusToggle.checked,employerDirectory)
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
  updateSummary('total', withEstimates(summary(yearRecords), projected), yearRecords.length + projected.length, yearRecords, projected);
  const mainProjected = projected.filter(item => item.job === 'main');
  const sideProjected = projected.filter(item => item.job === 'side');
  updateSummary('main', withEstimates(summary(main), mainProjected), main.length + mainProjected.length, main, mainProjected);
  updateSummary('side', withEstimates(summary(side), sideProjected), side.length + sideProjected.length, side, sideProjected,
    side.filter(item => item.form.kind === 'salary').length + sideProjected.filter(item => item.kind === 'salary').length);
  renderList('main', listRecords.filter(item => item.form.job === 'main'));
  renderList('side', listRecords.filter(item => item.form.job === 'side'));
  renderPendingDeletion();
}
function changeMode(mode: PeriodMode): void {
  if (!dashboardHasView || periodMode === mode) return;
  periodMode = mode;
  visibleCounts.main = 50; visibleCounts.side = 50;
  updateYearOptions();
  persistPeriodSelection();
  render();
}
fiscalModeButton.addEventListener('click', () => changeMode('fiscal'));
calendarModeButton.addEventListener('click', () => changeMode('calendar'));
yearSelect.addEventListener('change', () => { if(!dashboardHasView)return; visibleCounts.main = 50; visibleCounts.side = 50; persistPeriodSelection(); render(); });
bonusToggle.addEventListener('change', () => {if(dashboardHasView)render();});
for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="statement-kind"]'))) {
  input.addEventListener('change', () => {
    if (!input.checked || !['all','salary','bonus'].includes(input.value)) return;
    statementKind = input.value as StatementKindFilter;
    visibleCounts.main = 50; visibleCounts.side = 50;
    if (dashboardHasView) render();
  });
}
forecastToggle.addEventListener('change', () => { forecastPanel.open=false; if(dashboardHasView)render(); });
let dashboardValidUntil=0;
let dashboardMutationEpoch='';
let dashboardLoading=false;
let dashboardHasView=false;
let dashboardStale=false;
function updatePeriodControls():void{
 const disabled=!dashboardHasView;
 for(const control of [yearSelect,fiscalModeButton,calendarModeButton,bonusToggle,forecastToggle,...Array.from(document.querySelectorAll<HTMLInputElement>('input[name="statement-kind"]'))])control.disabled=disabled;
}
async function refreshDashboard(forceFresh=false,completion?:{kind:AppStatusKind;message:string}): Promise<void> {
  if(dashboardLoading||deletionBusy())return;
  const hadView=dashboardHasView;
  dashboardLoading=true;
  if(!hadView){registrationPanel.hidden = true;renderList('main',[],'読み込み中…');renderList('side',[],'読み込み中…');}
  // Routine reads must not erase an unresolved partial operation notice.
  appStatus.clear();
  const indicator=document.getElementById('payroll-data-freshness');
  const freshness=hadView?'rechecking':'checking';
  if(indicator){indicator.textContent=dashboardFreshnessLabel(freshness);indicator.dataset.freshness=freshness;}
  const refreshButton=document.querySelector<HTMLButtonElement>('#payroll-refresh-data');
  if(refreshButton)refreshButton.disabled=true;
  // Keep last complete data visible while rechecking. Block cloud mutations, not local filters.
  document.querySelectorAll<HTMLButtonElement>('.statement-item__actions [data-record-id]').forEach(button=>{button.disabled=true;});
  renderPendingDeletion();
  const preferred=initialYear??currentPeriodYear();
  periodLabel.setAttribute('aria-busy','true');
  updatePeriodControls();
  sideZipButton.disabled=true;
  try {
    let nextDirectory:EmployerEntry[]=[];
    const nextSaved = await loadRecordSummaries({
      onEmployerDirectory:directory=>{nextDirectory=directory;},
      forceFresh,
      priorityYears:[String(preferred),String(preferred-1)],
      onProgress:message=>{if(!hadView)periodLabel.textContent=message;},
    });
    saved=nextSaved;employerDirectory=nextDirectory;legacyDirectory=legacyEmployers(saved,employerDirectory);
    yearSelect.disabled = false;
    bonusToggle.disabled = false;
    forecastToggle.disabled = false;
    periodLabel.removeAttribute('role');
    periodLabel.style.removeProperty('color');
    dashboardStale=false;
    updateYearOptions();
    render();
    dashboardHasView=true;updatePeriodControls();
    dashboardMutationEpoch=mutationEpoch();
    const cache=await summaryCacheInfo();dashboardValidUntil=cache.deadline;
    if(dashboardMutationEpoch!==mutationEpoch())throw new Error('明細の読み込み中にデータが更新されました。最新データを確認してください。');
    const freshState=cache.cached?'snapshot':'verified';
    if(indicator){indicator.textContent=dashboardFreshnessLabel(freshState);indicator.dataset.freshness=freshState;}
    const notice=takeNavigationNotice(authEpoch());
    const outcome=notice?navigationFeedback(notice):null;
    if(outcome)appStatus.show(outcome.kind,outcome.message,false,{record:false});
    else if(completion?.kind==='success')appStatus.show(completion.kind,completion.message,false,{record:false});
  } catch (error) {
    console.error('保存済み明細を読み込めませんでした。');
    appStatus.error(`${completion?completion.message+'\n':''}明細を読み込めませんでした：${error instanceof Error?error.message:String(error)}`);
    dashboardStale=dashboardHasView;
    const failedState=dashboardHasView?'stale':'unavailable';
    if(indicator){indicator.textContent=dashboardFreshnessLabel(failedState);indicator.dataset.freshness=failedState;}
    if(dashboardHasView){
      // Existing figures are for reference only. Never imply the refresh succeeded.
      yearSelect.disabled=false;bonusToggle.disabled=false;forecastToggle.disabled=false;
      render();
      sideZipButton.disabled=true;
    }else{
      periodLabel.textContent = `保存済み明細の読み込みに失敗しました。OneDriveへの接続と暗号化保管庫をご確認ください。${error instanceof Error ? ` (${error.message})` : ''}`;
      periodLabel.setAttribute('role', 'alert');
      periodLabel.style.color = 'var(--color-danger)';
      renderList('main',[],'明細を取得できませんでした');renderList('side',[],'明細を取得できませんでした');
      yearSelect.disabled = true;bonusToggle.disabled = true;forecastToggle.disabled = true;
      sideZipButton.disabled = true;
    }
    // The last verified screen is preserved for read-only use; saving is blocked.
  } finally {
    periodLabel.removeAttribute('aria-busy');
    dashboardLoading=false;updatePeriodControls();
    if(refreshButton)refreshButton.disabled=false;
    document.querySelectorAll<HTMLButtonElement>('.statement-item__actions [data-record-id]').forEach(button=>{
      button.disabled=dashboardStale||deletionBusy();
    });
    renderPendingDeletion();
    if(dashboardHasView&&!dashboardStale)
      sideZipButton.disabled=exportingSideZip||selectedPeriodRecords().every(item=>item.form.job!=='side');
  }
}
// Back/forward cache does not imply a changed dataset. Only mutations or TTL expiry force a reload.
window.addEventListener('pageshow', event => {
 if(event.persisted){
  if(dashboardHasView)render();
  if(!dashboardHasView||dashboardStale||dashboardMutationEpoch!==mutationEpoch()||Date.now()>=dashboardValidUntil)void refreshDashboard(true);
 }
});
// Remote changes invalidate the view without forcing a load while another tab is writing.
window.addEventListener('storage',event=>{
 if((event.key===NAVIGATION_MUTATION_KEY||event.key===null)&&dashboardHasView&&dashboardMutationEpoch!==mutationEpoch()){
  dashboardStale=true;
  const indicator=document.getElementById('payroll-data-freshness');
  if(indicator){indicator.textContent=dashboardFreshnessLabel('stale');indicator.dataset.freshness='stale';}
  document.querySelectorAll<HTMLButtonElement>('.statement-item__actions [data-record-id]').forEach(button=>{button.disabled=true;});
  sideZipButton.disabled=true;renderPendingDeletion();
 }
});
window.addEventListener('focus',()=>{
 if(dashboardHasView&&dashboardMutationEpoch!==mutationEpoch()&&!dashboardLoading&&!deletionBusy()&&!exportingSideZip)void refreshDashboard(true);
});
// Keep refresh next to the page title; the independent lock action stays in the footer.
const refreshActions=document.querySelector<HTMLElement>('.dashboard-sync');
if(refreshActions&&!refreshActions.querySelector('#payroll-refresh-data')) {
 const control=document.createElement('span');control.className='payroll-data-sync';
 const state=document.createElement('span');state.id='payroll-data-freshness';state.textContent='確認中…';
 state.setAttribute('role','status');state.setAttribute('aria-live','polite');
 const refresh=document.createElement('button');refresh.id='payroll-refresh-data';refresh.type='button';refresh.className='site-footer__button';refresh.textContent='最新データを確認';
 refresh.addEventListener('click',()=>{void refreshDashboard(true);});
 control.append(state,refresh);refreshActions.append(control);
}
void refreshDashboard();
