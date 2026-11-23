import { createAppStatus } from './ui/appStatus';
/** UI entry for isolated year-end support. No imports from the personal payrollStore. */
import {YearEndRepository} from './yearEnd/repository';
import {parseAssistedPdf} from './yearEnd/pdf';
import {openYearEndPdf} from './pdf/yearEndHandoff';
import {asVerifiedPdfBlob} from './pdf/safePdf';
import {yearEndPdfName,yearEndVisiblePdfName} from './storage/fileNaming';
import {createYearEndPdfZip} from './yearEnd/pdfExport';
import {calculateYear,monthOf,parseYen,yearMonth,validYear,validDate,forecastPreview,bonusEstimatePreview,documentAmountWarnings,inconsistentDetectedNames,normalizeDetectedName,
 type PersonId,type PersonProfile,type YearData,type DocumentRecord,type DraftDocument,type EstimateMethod} from './yearEnd/model';
const repo=new YearEndRepository();
const $=<T extends HTMLElement>(id:string):T=>{const e=document.getElementById(id);if(!e)throw new Error('画面構成が不正です。');return e as T;};
const status=$<HTMLParagraphElement>('yea-status');
const directory=$<HTMLElement>('yea-directory');
const personList=$<HTMLElement>('yea-person-list');
const yearSelect=$<HTMLSelectElement>('yea-calendar-year');
const yearContent=$<HTMLElement>('yea-content');
const uiPdf=$<HTMLInputElement>('yea-pdfs');
const drafts=$<HTMLUListElement>('yea-drafts');
const commit=$<HTMLButtonElement>('yea-commit');
const forecastError=$<HTMLElement>('yea-forecast-error');
const forecastState=$<HTMLElement>('yea-forecast-state');
const bonusMonthInput=$<HTMLInputElement>('yea-bonus-month');
const bonusValueInput=$<HTMLInputElement>('yea-bonus-value');
const bonusError=$<HTMLElement>('yea-bonus-error');
const estimateMonths=$<HTMLElement>('yea-estimate-months');
const methodChoices=$<HTMLElement>('yea-method');
const selectedMethod=():EstimateMethod=>(methodChoices.querySelector<HTMLInputElement>('input[type=radio]:checked')?.value??'latest') as EstimateMethod;
const currentName=$<HTMLElement>('yea-current-name');
const backDirectory=$<HTMLButtonElement>('yea-back-directory');
const backHome=$<HTMLAnchorElement>('yea-back-home');
const currentYear=new Date().getFullYear();
let people:Array<PersonProfile & {state:'active'|'deleting'}>=[];
let selected:PersonId|null=null;
let activeYear=currentYear;
let data:YearData|null=null;
let otherYearNames:string[]=[];
let forecastDirty=false;
let bonusDirty=false;
/** Only remembers a saved bonus month explicitly cleared in the editor. */
let bonusClearedMonth='';
let bonusLastMonth='';
let busy=false;
/** OneDriveへの明細保存操作だけを表す。PDF解析や読み込みには使わない。 */
let savingDocuments=false;
type QueueItem={id:number;file:File;draft:DraftDocument|null;personId:PersonId;year:number;hash:string;status:'reading'|'ready'|'duplicate'|'error';error:string;fieldErrors:Set<string>};
let fileQueue:QueueItem[]=[];
let activeDraft:number|null=null;
let activeSavedId:string|null=null;
type SavedEdit={draft:DraftDocument;fieldErrors:Set<string>};
const savedEdits=new Map<string,SavedEdit>();
/** A cross-tab-safe deletion draft; no remote write happens until Save. */
const pendingDeletions=new Map<string,number>();
/** Multi-delete stays compact even when replacing a full year of PDFs. */
let pendingGroupExpanded=false;
let draftSerial=0;
let uploadContext='';
const uploadAccordion=$<HTMLDetailsElement>('yea-upload-accordion');
const forecastAccordion=$<HTMLDetailsElement>('yea-forecast-accordion');
let peopleLoaded=false;
const reviewForm=$<HTMLFormElement>('yea-review-form');
const reviewValidation=$<HTMLParagraphElement>('yea-review-validation');
const saveAll=$<HTMLButtonElement>('yea-save-all');
const saveResult=$<HTMLElement>('yea-save-result');
const saveRecovery=$<HTMLElement>('yea-save-recovery');
const saveRecoveryStatus=$<HTMLElement>('yea-save-recovery-status');
const saveRecheck=$<HTMLButtonElement>('yea-save-recheck');
const saveReload=$<HTMLButtonElement>('yea-save-reload');
let saveRecoveryRequired=false;
let saveRecoveryChecked=false;
let saveRecoverySafe=false;
function resetSaveRecovery(){
 saveRecoveryRequired=false;saveRecoveryChecked=false;saveRecoverySafe=false;
 saveRecovery.hidden=true;saveRecoveryStatus.textContent='';saveResult.hidden=true;saveResult.replaceChildren();
}
function resetSaveRecoveryStateAfterSuccess(){
 saveRecoveryRequired=false;saveRecoveryChecked=false;saveRecoverySafe=false;
 saveRecovery.hidden=true;saveRecoveryStatus.textContent='';
}
function showSkippedResult(savedCount:number,updatedCount:number,excluded:Array<{name:string;reason:string}>){
 saveResult.replaceChildren();
 if(!excluded.length){saveResult.hidden=true;return;}
 saveResult.hidden=false;
 saveResult.append(el('strong','',`保存完了：新規 ${savedCount}件・変更 ${updatedCount}件、重複除外 ${excluded.length}件`));
 const heading=el('p','', '保存対象外となったPDF');
 const list=el('ul','yea-excluded-list');
 for(const item of excluded){
  const row=el('li');row.append(el('strong','',item.name),el('span','',item.reason));list.append(row);
 }
 saveResult.append(heading,list);
}

const reviewFields=['kind','paymentDate','targetMonth','taxable','gross','transportation','nonTaxable','healthInsurance','pension','employmentInsurance','incomeTax','residentTax'] as const;
type ReviewField=typeof reviewFields[number];

const displayDate=(value:string):string=>value.replace(/-/g,'/');
const formatBytes=(bytes:number):string=>bytes<1024*1024?`${Math.max(1,Math.round(bytes/1024))} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
function uploadIcon(name:'file'|'close'):SVGSVGElement{
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.classList.add('icon');svg.setAttribute('aria-hidden','true');
 const use=document.createElementNS('http://www.w3.org/2000/svg','use');
 use.setAttribute('href',`#icon-${name}`);svg.append(use);return svg;
}
let memoKey='';
let memoDirty=false;
const memoInput=$<HTMLTextAreaElement>('yea-year-memo');
const memoButton=$<HTMLButtonElement>('yea-save-memo');
const memoState=$<HTMLElement>('yea-memo-state');
const yen=(amount:number)=>`${Math.round(amount).toLocaleString('ja-JP')}円`;
const totalDetails=$<HTMLElement>('yea-taxable-breakdown');
const zipDownload=$<HTMLButtonElement>('yea-download-pdfs');
const appStatus=createAppStatus(status);
function say(message:string,error=false){if(error)appStatus.error(message);else if(message)appStatus.success(message);else appStatus.clear();}
function showBusy(message:string){appStatus.loading(`${message}…`);}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,klass='',label=''):HTMLElementTagNameMap[K]{const node=document.createElement(tag);if(klass)node.className=klass;if(label)node.textContent=label;return node;}
function setLocalError(node:HTMLElement,message=''){node.hidden=!message;node.textContent=message;}
function proposedForecastChanged():boolean{
 if(!data)return false;
 if(data.noPaymentMonths.length)return true;
 const months=Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'));
 const proposal=months.filter(x=>x.value.trim()).map(x=>({month:x.dataset.override!,amount:parseYen(x.value)}));
 if(proposal.length!==data.estimates.length)return true;
 const method=selectedMethod();
 return proposal.some(e=>!data!.estimates.some(old=>old.month===e.month&&old.amount===e.amount&&(!forecastDirty||old.method===method)));
}
function salaryUpdateRequested():boolean{
 // A bonus-only edit must never rebuild salary estimates merely because the
 // unedited auto-preview differs from a stored manual/latest mixed-year entry.
 return forecastDirty||(!bonusDirty&&proposedForecastChanged());
}
/** One validation contract for live button state and the save handler.
 * Keep per-month errors visible and reject number-input badInput/overflow. */
function validateForecastEditor():boolean{
 if(!data)return true;
 let salaryMessage='';
 for(const input of Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'))){
  const raw=input.value.trim();
  const invalid=input.validity.badInput||!input.validity.valid||(raw!==''&&parseYen(raw)===null);
  input.setAttribute('aria-invalid',String(invalid));
  const monthError=input.closest('.yea-month')?.querySelector<HTMLElement>('[data-month-error]');
  if(monthError){monthError.hidden=!invalid;monthError.textContent=invalid?'0円以上の整数を入力してください。':'';}
  if(invalid&&!salaryMessage)salaryMessage=`${Number(input.dataset.override?.slice(5))}月の給与見込み額が不正です。`;
 }
 if(salaryMessage)setLocalError(forecastError,salaryMessage);
 else if(!busy&&forecastError.textContent?.includes('給与見込み額が不正です'))setLocalError(forecastError);
 let bonusMessage='';
 if(bonusDirty){
  const month=bonusMonthInput.value,raw=bonusValueInput.value.trim();
  if(bonusValueInput.validity.badInput||!bonusValueInput.validity.valid||(raw!==''&&parseYen(raw)===null))
   bonusMessage='賞与の見込み額は0円以上の整数で入力してください。';
  else if(month&&(!month.startsWith(String(activeYear)+'-')||data.documents.some(d=>d.kind==='bonus'&&monthOf(d.paymentDate)===month)))
   bonusMessage='賞与見込みの支給月が不正、または登録済みです。';
  else if(month&&!raw&&!data.bonusEstimates.some(e=>e.month===month))
   bonusMessage='賞与の見込み額を入力してください。';
  else if(!month&&raw)bonusMessage='賞与の支給予定月を選択してください。';
 }
 bonusValueInput.setAttribute('aria-invalid',String(Boolean(bonusMessage)));
 bonusMonthInput.setAttribute('aria-invalid',String(Boolean(bonusMessage)));
 if(bonusMessage)setLocalError(bonusError,bonusMessage);
 else if(bonusError.textContent?.includes('見込み額')||bonusError.textContent?.includes('支給予定月')||bonusError.textContent?.includes('支給月が不正'))setLocalError(bonusError);
 return !salaryMessage&&!bonusMessage;
}
function updateForecastSaveState(){
 const valid=validateForecastEditor();
 commit.disabled=busy||!selected||!data||!(salaryUpdateRequested()||bonusDirty)||!valid;
 forecastState.textContent=forecastDirty||bonusDirty?'未保存の変更があります。':'';
 updateUnsavedForecastPreview();
 for(const input of Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'))){
  input.disabled=busy||!data;
 }
 bonusMonthInput.disabled=busy||!data;
 bonusValueInput.disabled=busy||!data;
}
/** Read-only arithmetic: never publish unsaved figures as the annual taxable total. */
function updateUnsavedForecastPreview():void {
 const salaryNote=$<HTMLElement>('yea-draft-forecast');
 const annualNote=$<HTMLElement>('yea-draft-annual');
 salaryNote.hidden=true;annualNote.hidden=true;
 if(!data||busy)return;
 const saved=calculateYear(data);
 const salaryDraft=salaryUpdateRequested();
 let proposedSalary=salaryDraft?0:saved.salaryForecast;
 let valid=true;
 for(const input of Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'))){
  const raw=input.value.trim();
  if(!salaryDraft)continue;
  if(!raw)continue;
  const amount=parseYen(raw);
  if(amount===null){valid=false;break;}
  proposedSalary+=amount;
 }
 const bonuses=new Map<string,number>(data.bonusEstimates.map(e=>[e.month,e.amount]));
 if(bonusDirty){
  if(bonusClearedMonth)bonuses.delete(bonusClearedMonth);
  const month=bonusMonthInput.value,raw=bonusValueInput.value.trim();
  if(month){
   if(!month.startsWith(String(activeYear)+'-')||data.documents.some(d=>d.kind==='bonus'&&monthOf(d.paymentDate)===month))valid=false;
   else if(raw){
    const amount=parseYen(raw);
    if(amount===null)valid=false;
    else bonuses.set(month,amount);
   }else if(bonuses.has(month))bonuses.delete(month);
  }else if(raw)valid=false;
 }
 if(!valid){
  salaryNote.textContent='試算額を確認できません。入力内容を確認してください。';
  salaryNote.hidden=false;
  return;
 }
 const proposedForecast=proposedSalary+[...bonuses.values()].reduce((sum,n)=>sum+n,0);
 if(proposedForecast===saved.forecast&&!salaryDraft&&!bonusDirty)return;
 salaryNote.textContent=`未保存の試算：${yen(proposedForecast)}${proposedForecast===saved.forecast?'（月別内訳・計算根拠に変更あり）':''}`;
 annualNote.textContent=proposedForecast===saved.forecast?'年間合計は同額ですが、月別内訳・計算根拠は未保存です。':`保存すると ${yen(saved.actual+proposedForecast)}（現在の年間合計には未反映）`;
 salaryNote.hidden=false;annualNote.hidden=false;
}
function markForecastDirty(){forecastDirty=true;setLocalError(forecastError);updateForecastSaveState();}
function updateBonusSaveState(){updateForecastSaveState();}
function markBonusDirty(){bonusDirty=true;setLocalError(bonusError);updateBonusSaveState();}
function resetBonusForm(){bonusDirty=false;bonusClearedMonth='';bonusLastMonth='';bonusMonthInput.value='';bonusValueInput.value='';setLocalError(bonusError);updateBonusSaveState();}
type BonusInputSnapshot={month:string;amount:string;clearedMonth:string;lastMonth:string};
function captureBonusInput():BonusInputSnapshot{
 return {month:bonusMonthInput.value,amount:bonusValueInput.value,clearedMonth:bonusClearedMonth,lastMonth:bonusLastMonth};
}
function restoreBonusInput(snapshot:BonusInputSnapshot){
 bonusMonthInput.value=snapshot.month;bonusValueInput.value=snapshot.amount;
 bonusClearedMonth=snapshot.clearedMonth;bonusLastMonth=snapshot.lastMonth;
 bonusDirty=true;updateBonusSaveState();
}
type BonusForecastChange={month:string;amount:number}|{month:string;remove:true};
function requestedBonusChange():BonusForecastChange|undefined{
 const month=bonusMonthInput.value,raw=bonusValueInput.value.trim();
 if(!month){
  if(raw)throw new Error('賞与の支給予定月を選択してください。');
  return bonusClearedMonth?{month:bonusClearedMonth,remove:true}:undefined;
 }
 if(!raw){
  if(data?.bonusEstimates.some(e=>e.month===month))return {month,remove:true};
  throw new Error('賞与の見込み額を入力してください。');
 }
 const amount=parseYen(raw);
 if(amount===null)throw new Error('賞与の見込み額は0円以上の整数で入力してください。');
 return {month,amount};
}
function resetForecastForm(){
 forecastDirty=false;setLocalError(forecastError);
 const first=methodChoices.querySelector<HTMLInputElement>('input[type=radio]');if(first)first.checked=true;
 updateForecastSaveState();
}
type ForecastInputSnapshot={method:EstimateMethod;months:Record<string,{value:string;edited:boolean}>};
function captureForecastInput():ForecastInputSnapshot{
 const months:ForecastInputSnapshot['months']={};
 for(const input of Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'))){
  months[input.dataset.override!]={value:input.value,edited:input.dataset.userEdited==='true'};
 }
 return {method:selectedMethod(),months};
}
function restoreForecastInput(snapshot:ForecastInputSnapshot){
 const radio=methodChoices.querySelector<HTMLInputElement>(`input[value="${snapshot.method}"]`);if(radio)radio.checked=true;
 for(const input of Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'))){
  const saved=snapshot.months[input.dataset.override!];if(!saved)continue;
  input.value=saved.value;input.dataset.userEdited=String(saved.edited);
 }
 forecastDirty=true;updateForecastSaveState();
}
function clearDrafts(){fileQueue=[];activeDraft=null;activeSavedId=null;savedEdits.clear();pendingDeletions.clear();pendingGroupExpanded=false;drafts.replaceChildren();uiPdf.value='';updateDrafts();}
function pendingEdits(){return Boolean(fileQueue.length||pendingDeletions.size)||[...savedEdits].some(([id,edit])=>{const original=data?.documents.find(r=>r.id===id);return Boolean(original&&isChanged(original,edit));});}
async function action(description:string,fn:()=>Promise<void>,_showSuccess=true){
 if(busy)return;
 busy=true;showBusy(description);updateForecastSaveState();updateBonusSaveState();
 let failed=false;
 try{await fn();}
 catch(err){failed=true;say(`失敗：${err instanceof Error?err.message:'通信または処理エラー'}`,true);}
 finally{
  busy=false;if(!failed&&appStatus.element.dataset.state!=='error'){if(_showSuccess)appStatus.success(`${description.replace(/を保存中$/,'の保存').replace(/を削除中$/,'の削除')}が完了しました`);else appStatus.clear();}
  if(failed&&!selected)directory.hidden=false;
  updateDrafts(true);updateForecastSaveState();updateBonusSaveState();
 }
}
/** One decision for all draft categories; never ask again for the same navigation. */
function checkDetailExit():boolean{
 const unsaved:string[]=[];
 if(pendingEdits())unsaved.push('明細');
 if(forecastDirty||bonusDirty)unsaved.push('給与・賞与の見込み');
 if(memoDirty)unsaved.push('年度メモ');
 return unsaved.length===0||window.confirm(`未保存の変更があります。\n対象：${unsaved.join('・')}\n破棄して移動しますか？`);
}
const displayPerson=(p:PersonProfile):string=>p.alias?`${p.displayName}（${p.alias}）`:p.displayName;
function clearMemo(){memoKey='';memoDirty=false;memoInput.value='';memoButton.disabled=true;memoState.textContent='';}
function resetSelection(){clearMemo();selected=null;data=null;otherYearNames=[];yearContent.hidden=true;yearContent.dataset.empty="false";yearContent.dataset.loading='false';directory.hidden=false;backDirectory.hidden=true;backHome.hidden=false;clearDrafts();resetForecastForm();resetBonusForm();const dialog=$<HTMLDialogElement>('yea-manage-dialog');if(dialog.open)dialog.close();}
function renderPeople(){
 const initial=selected;
 personList.replaceChildren();
 const active=people.filter(p=>p.state==='active');
 const empty=$<HTMLElement>('yea-person-empty');empty.hidden=active.length>0;empty.textContent='従業員を登録すると、ここに表示されます。';
 for(const p of active){
  const button=el('button','yea-person-option');button.type='button';
  button.append(el('span','',displayPerson(p)),el('span','yea-person-chevron','›'));
  button.addEventListener('click',()=>{if(busy)return;void action('従業員の選択',()=>selectPerson(p.id),false);});
  personList.append(button);
 }
 const pending=$<HTMLElement>('yea-pending-deletes');pending.replaceChildren();
 for(const p of people.filter(x=>x.state==='deleting')){
  const button=el('button','btn yea-danger',`${displayPerson(p)}：削除を再試行`);button.type='button';
  button.addEventListener('click',()=>{if(!window.confirm('削除未完了の従業員データを再検査して削除を続けますか？'))return;void action('削除の再試行',async()=>{await repo.deletePerson(p.id);await loadPeople();});});
  pending.append(button);
 }
 pending.hidden=!pending.childElementCount;
 if(initial&&!active.some(p=>p.id===initial))resetSelection();
}
function person(){const p=people.find(x=>x.id===selected&&x.state==='active');if(!p)throw new Error('従業員を選択してください。');return p;}
function renderYearOptions(){
 const p=person();const min=Math.max(1990,Math.min(currentYear-5,...Object.keys(p.yearFiles).map(Number)));const max=Math.min(2120,Math.max(currentYear+2,...Object.keys(p.yearFiles).map(Number)));
 yearSelect.replaceChildren();for(let y=max;y>=min;y--){const opt=el('option','',`${y}年`);opt.value=String(y);yearSelect.append(opt);}
 if(activeYear<min||activeYear>max)activeYear=currentYear;yearSelect.value=String(activeYear);
}
async function selectPerson(id:string){
 resetSaveRecovery();data=null;otherYearNames=[];clearDrafts();resetForecastForm();resetBonusForm();clearMemo();
 if(!id){resetSelection();return;}
 const p=people.find(x=>x.id===id&&x.state==='active');if(!p){say('削除中・未登録の従業員は編集できません。',true);resetSelection();return;}
 selected=p.id;activeYear=currentYear;uploadContext='';
 currentName.textContent=displayPerson(p);renderYearOptions();directory.hidden=true;yearContent.hidden=false;backDirectory.hidden=false;backHome.hidden=true;
 await loadYear();
}
async function loadPeople(){
 const empty=$<HTMLElement>('yea-person-empty');
 if(!peopleLoaded&&!personList.childElementCount){empty.hidden=false;empty.textContent='読み込みが終わると従業員が表示されます。';}
 const next=await repo.people();people=next;peopleLoaded=true;renderPeople();
}
function showYearPlaceholders(){
 yearContent.hidden=false;yearContent.dataset.loading='true';
 for(const id of ['yea-salary','yea-bonus','yea-forecast','yea-total'])$(id).textContent='—';
 $('yea-total-missing').hidden=true;
 $('yea-total-missing-note').hidden=true;
 zipDownload.disabled=true;totalDetails.replaceChildren();
 $('yea-workspace-count').textContent='読み込み中';
 $('yea-file-count').textContent='…';
 const fileEmpty=$('yea-files-empty');
 const fileTitle=fileEmpty.querySelector('strong'),fileHelp=fileEmpty.querySelector('p');
 if(fileTitle)fileTitle.textContent='明細を読み込み中';
 if(fileHelp)fileHelp.textContent='読み込みが終わると明細が表示されます。';
 $('yea-files-empty').hidden=false;drafts.hidden=true;
 $('yea-review-empty').hidden=false;$('yea-review-content').hidden=true;
 $('yea-bonus-result').hidden=true;
 estimateMonths.replaceChildren();
 for(let m=1;m<=12;m++){
  const card=el('div','yea-month');card.dataset.state='loading';
  card.append(el('strong','',`${m}月`),el('span','yea-month__amount','—'));estimateMonths.append(card);
 }
 memoInput.value='';memoInput.disabled=true;memoButton.disabled=true;
 bonusMonthInput.value='';bonusValueInput.value='';
 updateForecastSaveState();
}
async function loadYear(){
 if(!selected)return;
 const editSnapshot=forecastDirty&&data?captureForecastInput():null;
 const bonusSnapshot=bonusDirty?captureBonusInput():null;
 uploadAccordion.open=false;data=null;otherYearNames=[];uiPdf.disabled=true;
 showYearPlaceholders();
 try{
  const id=selected,year=activeYear;
  const view=await repo.yearWithOtherYearNames(id,year);
  data=view.data;
  renderYear();
  // Share the verified active-index/profile context, keeping name matching
  // asynchronous so the document list appears without waiting for other years.
  void view.otherYearNames().then(names=>{
   if(selected===id&&activeYear===year){otherYearNames=names;updateDrafts(true);}
  }).catch(()=>{if(selected===id&&activeYear===year)say('他年度のPDF氏名照合は完了していません。',true);});
  if(editSnapshot)restoreForecastInput(editSnapshot);
  if(bonusSnapshot)restoreBonusInput(bonusSnapshot);
 }finally{
  yearContent.dataset.loading='false';memoInput.disabled=false;uiPdf.disabled=!data;
 }
}
function renderYear(){
 if(!selected||!data)return;
 const fileEmpty=$('yea-files-empty');
 const fileTitle=fileEmpty.querySelector('strong'),fileHelp=fileEmpty.querySelector('p');
 if(fileTitle)fileTitle.textContent='明細はまだありません';
 if(fileHelp)fileHelp.textContent='PDFを追加してください。';
 yearContent.dataset.empty=data.documents.length===0?'true':'false';
 const contextKey=`${selected}/${activeYear}`;
 if(uploadContext!==contextKey){
  uploadContext=contextKey;uploadAccordion.open=data.documents.length===0;
  const savedMethod=data.estimates[0]?.method;
  const radio=savedMethod?methodChoices.querySelector<HTMLInputElement>(`input[value="${savedMethod}"]`):null;
  if(radio)radio.checked=true;
 }
 if(data.documents.length===0)uploadAccordion.open=true;
 const totals=calculateYear(data);
 const nextMemoKey=`${selected}/${activeYear}`;
 if(memoKey!==nextMemoKey){memoKey=nextMemoKey;memoDirty=false;memoInput.value=data.memo??'';}
 else if(!memoDirty){memoInput.value=data.memo??'';}
 memoButton.disabled=!memoDirty;
 memoState.textContent=memoDirty?'未保存の変更があります。':'';
 $('yea-salary').textContent=yen(totals.salary);$('yea-bonus').textContent=yen(totals.bonus);
 $('yea-forecast').textContent=yen(totals.forecast);$('yea-total').textContent=yen(totals.total);
 zipDownload.disabled=data.documents.length===0||pendingDeletions.size>0;renderTaxableBreakdown();
 const missing=$<HTMLElement>('yea-total-missing'),missingNote=$<HTMLElement>('yea-total-missing-note');
 missing.hidden=missingNote.hidden=totals.unknownMonths.length===0;
 if(totals.unknownMonths.length){
  const months=totals.unknownMonths.map(month=>`${Number(month.slice(5))}月`).join('・');
  missing.textContent=`未取得の月あり（${months}）`;
  missing.title='未取得月の金額は年間課税支給額に含まれていません。';
  missingNote.hidden=true;missingNote.textContent='';
 }else{missing.textContent='';missingNote.textContent='';}
 const bonusRows=data.bonusEstimates.map(x=>`${displayDate(x.month)}: ${yen(x.amount)}`).join(' / ');
 const bonusHeadline=$<HTMLElement>('yea-bonus-result');
 bonusHeadline.hidden=!bonusRows;bonusHeadline.textContent=bonusRows?`保存済みの賞与見込み：${bonusRows}`:'';
 forecastDirty=false;renderEstimateMonths();updateForecastSaveState();
 updateBonusSaveState();updateDrafts();
}
/** 支給日の暦年に属する実績・見込みを、画面表示と同じソースから月別に再集計。 */
function renderTaxableBreakdown():void {
 totalDetails.replaceChildren();
 if(!data)return;
 const totals=calculateYear(data),table=el('table','yea-taxable-table');
 const head=el('thead'),heading=el('tr');
 for(const title of ['支給月','給与（実績／見込み）','賞与（実績／見込み）','月計'])heading.append(el('th','',title));
 head.append(heading);table.append(head);
 const body=el('tbody');let check=0;
 for(let m=1;m<=12;m++){
  const month=yearMonth(activeYear,m);
  const salary=data.documents.filter(r=>r.kind==='salary'&&monthOf(r.paymentDate)===month);
  const bonus=data.documents.filter(r=>r.kind==='bonus'&&monthOf(r.paymentDate)===month);
  const salaryEstimate=data.estimates.filter(r=>r.month===month);
  const bonusEstimate=data.bonusEstimates.filter(r=>r.month===month);
  const salaryActual=salary.reduce((s,r)=>s+r.taxable,0),bonusActual=bonus.reduce((s,r)=>s+r.taxable,0);
  const salaryForecast=salaryEstimate.reduce((s,r)=>s+r.amount,0),bonusForecast=bonusEstimate.reduce((s,r)=>s+r.amount,0);
  const monthly=salaryActual+bonusActual+salaryForecast+bonusForecast;check+=monthly;
  const row=el('tr');row.append(el('th','',`${m}月`));
  const salaryCell=salary.length?`${yen(salaryActual)}（実績）`:salaryEstimate.length?`${yen(salaryForecast)}（見込み）`:
   data.noPaymentMonths.includes(month)?'支給なし':'未取得';
  const bonusCell=bonus.length?`${yen(bonusActual)}（実績）`:bonusEstimate.length?`${yen(bonusForecast)}（見込み）`:'—';
  row.append(el('td','',salaryCell),el('td','',bonusCell),el('td','',yen(monthly)));body.append(row);
 }
 if(check!==totals.total)throw new Error('年間集計と月別内訳が一致しません。データを再読み込みしてください。');
 const foot=el('tr','yea-taxable-table__total');
 foot.append(el('th','','合計'),el('td','',yen(totals.salary+totals.salaryForecast)),
  el('td','',yen(totals.bonus+totals.bonusForecast)),el('td','',yen(check)));body.append(foot);
 table.append(body);totalDetails.append(table);
}
/** Radio switches recalculate all unconfirmed months locally, never through OneDrive. */
function syncForecastAmounts(methodChanged=false){
 if(!data)return;
 const method=selectedMethod();
 const fields=Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'));
 const months=fields.map(x=>x.dataset.override!);
 let calculated=new Map<string,number>();
 if(method!=='manual'&&months.length){
  try{
   const preview=forecastPreview({...data,noPaymentMonths:[]},method,months,{});
   calculated=new Map(preview.estimated.map(e=>[e.month,e.amount]));
  }catch{
   setLocalError(forecastError,'確定給与がないため自動計算できません。手動入力を選択してください。');
  }
 }
 for(const input of fields){
  const month=input.dataset.override!;
  // Changing estimation method must never discard an edited monthly draft.
  if(input.dataset.userEdited==='true')continue;
  const existing=data.estimates.find(e=>e.month===month);
  const oldZero=data.noPaymentMonths.includes(month);
  // The old method may have supplied this value, but the amount belongs to
  // the saved month, not to the selector. Manual editing must retain it.
  if(method==='manual')input.value=oldZero?'0':existing?String(existing.amount):methodChanged?'':input.value;
  else if(calculated.has(month))input.value=oldZero?'0':existing?String(existing.amount):String(calculated.get(month)!);
  else input.value='';
  input.placeholder=method==='manual'?'金額を入力':'推定できません';
 }
 updateForecastSaveState();
}
function renderEstimateMonths(){
 if(!data)return;
 estimateMonths.replaceChildren();
 for(let m=1;m<=12;m++){
  const month=yearMonth(activeYear,m);
  const salary=data.documents.find(d=>d.kind==='salary'&&monthOf(d.paymentDate)===month);
  const oldNoPay=data.noPaymentMonths.includes(month);
  const existing=data.estimates.find(e=>e.month===month);
  const card=el('div','yea-month');
  card.append(el('strong','yea-month__head',`${m}月`));
  if(salary){
   card.dataset.state='actual';
   const amount=el('b','yea-month__amount',yen(salary.taxable));
   card.append(amount);
  }else{
   card.dataset.state='draft';
   const input=el('input') as HTMLInputElement;
   input.type='number';input.min='0';input.step='1';input.max='999999999';input.dataset.override=month;
   input.value=oldNoPay?'0':existing?String(existing.amount):'';
   input.dataset.userEdited='false';
   input.setAttribute('aria-label',`${m}月の給与見込み額`);
    const monthError=el('span','yea-month__error');monthError.dataset.monthError='';monthError.hidden=true;
    monthError.id=`yea-month-error-${m}`;input.setAttribute('aria-describedby',monthError.id);
    input.addEventListener('input',()=>{input.dataset.userEdited='true';markForecastDirty();});
    card.append(input,monthError);
  }
  estimateMonths.append(card);
 }
 syncForecastAmounts();
}
function forecastSelection():{months:string[];overrides:Record<string,number>}{
 const months:string[]=[],overrides:Record<string,number>={};
 for(const input of Array.from(estimateMonths.querySelectorAll<HTMLInputElement>('input[data-override]'))){
  if(!input.value.trim())continue;
  const amount=parseYen(input.value);
  if(amount===null)throw new Error('見込み額は0円以上の整数で入力してください。');
  const month=input.dataset.override!;months.push(month);overrides[month]=amount;
 }
 return {months,overrides};
}
function saveForecast(){
 if(!selected||!data||busy||commit.disabled)return;
 try{
   if(!validateForecastEditor())return;
   const salaryUpdate=salaryUpdateRequested();
   const {months,overrides}=salaryUpdate?forecastSelection():{months:[] as string[],overrides:{} as Record<string,number>};
   const method=selectedMethod();
  const bonusChange=bonusDirty?requestedBonusChange():undefined;
  const clean={...data,noPaymentMonths:[]};
   const snapshot=salaryUpdate&&months.length?forecastPreview(clean,method,months,overrides):null;
  if(bonusChange&&'amount' in bonusChange)bonusEstimatePreview(clean,bonusChange.month,bonusChange.amount);
  const id=selected,year=activeYear;
  setLocalError(forecastError);setLocalError(bonusError);
  const oldEstimates=data.estimates,oldNoPay=data.noPaymentMonths,oldBonus=data.bonusEstimates;
  const previousInput=captureForecastInput();
  void action('給与・賞与の見込みを保存中',async()=>{
    await repo.replaceIncomeForecasts(id,year,method,months,overrides,oldEstimates,oldNoPay,snapshot?.references??[],oldBonus,
     bonusChange,salaryUpdate);
   forecastDirty=false;bonusDirty=false;
   const refreshed=await repo.year(id,year);
   data=refreshed;renderYear();
   // Retain the explicit editor method and zero amounts after the save.
   if(previousInput.method!==selectedMethod()){
    const radio=methodChoices.querySelector<HTMLInputElement>(`input[value="${previousInput.method}"]`);if(radio)radio.checked=true;
    renderEstimateMonths();
   }
   bonusMonthInput.value='';bonusValueInput.value='';bonusClearedMonth='';bonusLastMonth='';updateBonusSaveState();
  });
 }catch(err){setLocalError(forecastError,err instanceof Error?err.message:'見込み額の入力内容を確認してください。');}
}
function openBlobPdf(blob:Blob,displayedName?:string){
 try{
  const id=crypto.randomUUID();
  openYearEndPdf(id,async()=>({pdf:await asVerifiedPdfBlob(blob),fileName:displayedName??(blob instanceof File?blob.name:'確認用原本.pdf')}));
 }catch(error){say(error instanceof Error?error.message:'PDF原本を開けません。',true);}
}
function openStoredPdf(id:string){
 if(!selected)return;
 const person=selected,year=activeYear;
 const record=data?.documents.find(row=>row.id===id);
 try{
  openYearEndPdf(id,async()=>({pdf:await asVerifiedPdfBlob(await repo.original(person,year,id)),fileName:record?yearEndVisiblePdfName(record.kind,record.paymentDate,record.fileName):'給与明細原本.pdf'}));
 }catch(error){say(error instanceof Error?error.message:'PDF原本を開けません。',true);}
}
const selectedQueueItem=():QueueItem|undefined=>fileQueue.find(x=>x.id===activeDraft);
const recordDraft=(r:DocumentRecord):DraftDocument=>({
 kind:r.kind,paymentDate:r.paymentDate,targetMonth:r.targetMonth,taxable:r.taxable,gross:r.gross,transportation:r.transportation,
 nonTaxable:r.nonTaxable,healthInsurance:r.healthInsurance,pension:r.pension,employmentInsurance:r.employmentInsurance,
 incomeTax:r.incomeTax,residentTax:r.residentTax,detectedName:r.detectedName??null,warnings:[]
});
const selectedRecord=()=>data?.documents.find(r=>r.id===activeSavedId&&!pendingDeletions.has(r.id));
const effectiveSavedDraft=(r:DocumentRecord)=>savedEdits.get(r.id)?.draft??recordDraft(r);
function isChanged(r:DocumentRecord,e:SavedEdit):boolean{
 return reviewFields.some(k=>r[k]!==e.draft[k]);
}
function validateSavedEdit(record:DocumentRecord,edit:SavedEdit):string|null{
 const d=edit.draft;
 if(edit.fieldErrors.size)return '金額は円単位の整数で入力してください。';
 if(!validDate(d.paymentDate)||Number(d.paymentDate.slice(0,4))!==activeYear)return '支給日が対象年と一致しません。';
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(d.targetMonth))return '対象年月が正しくありません。';
 if(d.taxable===null)return '課税支給合計を入力してください。';
 if(d.kind==='salary'&&data?.documents.some(other=>other.id!==record.id&&!pendingDeletions.has(other.id)&&effectiveSavedDraft(other).kind==='salary'&&effectiveSavedDraft(other).paymentDate.slice(0,7)===d.paymentDate.slice(0,7)))
  return '同じ支給月の給与がほかにあります。';
 if(d.kind==='salary'&&fileQueue.some(q=>q.status==='ready'&&q.draft?.kind==='salary'&&q.draft.paymentDate.slice(0,7)===d.paymentDate.slice(0,7)))
  return '新規PDFと同じ支給月です。';
 return null;
}
/** Display names may be pseudonyms. Only compare names extracted from PDFs. */
function namesInWorkspace():Array<string|null|undefined>{
 return [...otherYearNames,...(data?.documents.filter(d=>!pendingDeletions.has(d.id)).map(d=>d.detectedName)??[]),
  ...fileQueue.filter(q=>q.status==='ready').map(q=>q.draft?.detectedName)];
}
function possibleNameMismatch(item:QueueItem):boolean{
 const observed=normalizeDetectedName(item.draft?.detectedName);
 if(!observed)return false;
 return namesInWorkspace().some(name=>{const other=normalizeDetectedName(name);return Boolean(other&&other!==observed);});
}
function updateNameWarning(){
 const notice=$<HTMLElement>('yea-name-warning');
 const mismatch=inconsistentDetectedNames(namesInWorkspace());
 notice.hidden=!mismatch;
 notice.textContent=mismatch?'登録されたPDF間で読み取り氏名が一致していません。原本を確認してください。':'';
}
function validateQueueItem(item:QueueItem):string|null{
 const d=item.draft;
 if(item.status!=='ready'||!d)return 'PDFを正常に解析できていません。';
 if(item.fieldErrors.size)return '金額は円単位の整数で入力してください。';
 if(!['salary','bonus'].includes(d.kind))return '給与・賞与の区分を確認してください。';
 if(!validDate(d.paymentDate)||Number(d.paymentDate.slice(0,4))!==item.year)return '支給日が対象年と一致しません。';
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(d.targetMonth))return '対象年月を入力してください。';
 if(d.taxable===null)return '課税支給合計を原本から確認してください。';
 if(data?.documents.some(record=>!pendingDeletions.has(record.id)&&record.fileHash===item.hash))return 'このPDFは保存済みです。';
 const duplicates=fileQueue.filter(x=>x!==item&&x.status==='ready'&&x.hash===item.hash);
 if(duplicates.some(x=>x.id<item.id))return '同一PDFが取り込み一覧にあります。';
 const month=d.paymentDate.slice(0,7);
 if(d.kind==='salary'){
  if(data?.documents.some(r=>{if(pendingDeletions.has(r.id))return false;const e=effectiveSavedDraft(r);return e.kind==='salary'&&e.paymentDate.slice(0,7)===month;}))return 'この支給月の給与は登録済みです。';
  if(fileQueue.some(x=>x!==item&&x.status==='ready'&&x.draft?.kind==='salary'&&x.draft.paymentDate.slice(0,7)===month))return '同じ支給月の給与が複数選択されています。';
 }
 return null;
}
function updateSaveState(){
 const ready=fileQueue.filter(item=>item.status==='ready'&&item.draft);
 const updates=data?.documents.filter(r=>{const e=savedEdits.get(r.id);return Boolean(!pendingDeletions.has(r.id)&&e&&isChanged(r,e));})??[];
 const pending=fileQueue.some(item=>item.status==='reading');
 const errors=fileQueue.some(item=>item.status==='error');
 const duplicates=fileQueue.filter(item=>item.status==='duplicate').length;
 const blocked=ready.some(item=>validateQueueItem(item)!==null)||updates.some(r=>validateSavedEdit(r,savedEdits.get(r.id)!)!==null);
 saveAll.disabled=busy||saveRecoveryRequired||!selected||!data||pending||errors||blocked||(ready.length===0&&updates.length===0&&pendingDeletions.size===0);
 saveAll.textContent=savingDocuments?'保存中…':'すべて保存';
 saveRecheck.disabled=busy;saveReload.disabled=busy||!saveRecoveryChecked||!saveRecoverySafe;
 $('yea-upload-progress').textContent=savingDocuments?'保存中…':
  !ready.length&&!updates.length&&!pendingDeletions.size&&!errors&&!pending&&!duplicates?'':pending?'PDFを解析中…':
  errors?'解析できないPDFを確認・削除してください。':blocked?'入力内容に問題があります。':
  saveRecoveryRequired?'前回の保存が未完了です。OneDriveの状態を確認してください。':
  !ready.length&&!updates.length&&duplicates?`重複${duplicates}件は保存対象外です。`:
  `新規${ready.length}件・変更${updates.length}件・削除${pendingDeletions.size}件${duplicates?`・重複除外${duplicates}件`:''}`;
}
/** When the primary queued copy is removed, the next identical file is no longer a duplicate.
 * Reparse it instead of leaving every remaining copy permanently excluded. */
function promoteRemainingDuplicate(removed:QueueItem){
 const hash=removed.hash;
 if(!hash||data?.documents.some(record=>!pendingDeletions.has(record.id)&&record.fileHash===hash)){updateDrafts();return;}
 const next=fileQueue.filter(item=>item.hash===hash&&item.status==='duplicate')
  .sort((a,b)=>a.id-b.id)
  .find(item=>!fileQueue.some(other=>other!==item&&other.id<item.id&&other.hash===hash));
 if(!next){updateDrafts();return;}
 next.status='reading';next.error='';next.draft=null;
 updateDrafts();
 void action('重複PDFの再解析',async()=>{
  try{
   const parsed=await parseAssistedPdf(next.file);
   if(!fileQueue.includes(next))return;
   next.draft=parsed;next.status='ready';
  }catch(error){
   next.status='error';next.error=error instanceof Error?error.message:'PDFの解析に失敗しました。';
  }finally{updateDrafts();}
 },false);
}
function renderSelectedReview(){
 const queue=selectedQueueItem(),record=selectedRecord(),saved=record? savedEdits.get(record.id):undefined;
 const d=queue?.draft??(record?(saved?.draft??recordDraft(record)):null);
 const visible=Boolean(queue||record);
 $('yea-review-empty').hidden=visible;$('yea-review-content').hidden=!visible;
 if(!visible)return;
 $('yea-selected-name').textContent=record?yearEndVisiblePdfName(record.kind,record.paymentDate,record.fileName):queue?.draft?yearEndPdfName(queue.draft.kind,queue.draft.paymentDate,queue.file.name):queue?.file.name??'';
 $('yea-selected-meta').textContent=record?(saved&&isChanged(record,saved)?'変更あり':'保存済み'):
  queue?.status==='ready'?'新規・保存待ち':queue?.status==='reading'?'解析中':queue?.status==='duplicate'?'重複・保存対象外':'読み取りエラー';
 const warningAmounts=d?documentAmountWarnings(d):[];
 const message=record?warningAmounts.join('\n'):queue?.status==='ready'&&queue?.draft?
  [possibleNameMismatch(queue)?'他のPDFと読み取り氏名が一致しません。':'',...warningAmounts,...queue.draft.warnings].filter(Boolean).join('\n'):
  queue?.status==='error'?queue.error:queue?.status==='duplicate'?queue.error||'同じPDFが登録済み、または一覧にあります。':'';
 const notice=$<HTMLElement>('yea-review-notice');notice.hidden=!message;notice.textContent=message;
 notice.classList.toggle('read-result--warning',Boolean(message));notice.classList.toggle('read-result--error',queue?.status==='error');
 $<HTMLButtonElement>('yea-discard-edit').hidden=!record||!saved||!isChanged(record,saved);
 $<HTMLButtonElement>('yea-open-draft-pdf').disabled=queue?.status==='reading';
 reviewForm.hidden=!d||(queue?.status!=='ready'&&!record);
 if(!d||reviewForm.hidden)return;
 for(const field of reviewFields){
  if(field==='kind'){
   const radio=reviewForm.querySelector<HTMLInputElement>(`input[data-field="kind"][value="${d.kind}"]`);
   if(radio)radio.checked=true;
   continue;
  }
  const input=reviewForm.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-field="${field}"]`);
  if(input)input.value=String(d[field]??'');
 }
 const error=record&&saved?validateSavedEdit(record,saved):queue?validateQueueItem(queue):null;
 reviewValidation.hidden=!error;reviewValidation.textContent=error??'';
 reviewValidation.classList.toggle('is-error',Boolean(error));
}
function updateDrafts(preserveReview=false){
 if(activeSavedId&&!data?.documents.some(r=>r.id===activeSavedId&&!pendingDeletions.has(r.id)))activeSavedId=null;
 if(activeDraft!==null&&!fileQueue.some(x=>x.id===activeDraft))activeDraft=null;
 if(activeSavedId===null&&activeDraft===null){activeSavedId=data?.documents.find(r=>!pendingDeletions.has(r.id))?.id??null;if(!activeSavedId)activeDraft=fileQueue[0]?.id??null;}
 drafts.replaceChildren();
 const savedRecords=(data?.documents??[]).filter(r=>!pendingDeletions.has(r.id));
 const orderedItems:Array<{month:string;date:string;node:HTMLLIElement}>=[];
 $('yea-file-count').textContent=`${savedRecords.length+fileQueue.length}件`;
 $('yea-files-empty').hidden=savedRecords.length+fileQueue.length>0||pendingDeletions.size>0;
 drafts.hidden=savedRecords.length+fileQueue.length===0&&pendingDeletions.size===0;
 $('yea-clear-all').hidden=fileQueue.length===0;
 $<HTMLButtonElement>('yea-clear-all').disabled=busy;
 $('yea-parse-state').textContent=pendingDeletions.size?`保存済み${savedRecords.length}件 · 新規${fileQueue.length}件 · 削除待ち${pendingDeletions.size}件（保存で確定）`:savedRecords.length+fileQueue.length?`保存済み${savedRecords.length}件 · 新規${fileQueue.length}件`:'取り込み待ち';
 updateNameWarning();
 for(const r of savedRecords){
  const chosen=r.id===activeSavedId;
  const li=el('li','file-list__item is-saved');li.classList.toggle('is-selected',chosen);
  const choose=el('button','file-list__select');choose.type='button';
  const displayName=yearEndVisiblePdfName(r.kind,r.paymentDate,r.fileName);
  choose.setAttribute('aria-label',`${displayName} の内容を確認`);
  choose.setAttribute('aria-pressed',String(chosen));
  const icon=el('span','file-list__icon');icon.append(uploadIcon('file'));
  const info=el('span','file-list__text');
  const fileName=el('span','file-name',displayName);fileName.title=displayName;
  const edited=savedEdits.get(r.id),d=edited?.draft??r;
  const detail=el('span','file-caption',formatBytes(r.pdfSize));
  const failed=edited&&validateSavedEdit(r,edited),changed=edited&&isChanged(r,edited);
  const state=el('span',`file-status file-status--${failed?'error':changed?'warning':'confirmed'}`,failed?'要修正':changed?'変更あり':'保存済み');
  info.append(fileName,detail,state);choose.append(icon,info);
  if(chosen){const current=el('span','file-list__current','表示中');choose.append(current);}
  choose.addEventListener('click',()=>{activeSavedId=r.id;activeDraft=null;updateDrafts();});
  const remove=el('button','file-list__remove');remove.type='button';remove.disabled=busy;
  remove.title='保存済み明細を削除';remove.setAttribute('aria-label',`${displayName} の保存済み明細を削除`);
  remove.append(uploadIcon('close'));
  remove.addEventListener('click',()=>{
   if(busy||!selected||!data)return;
   pendingDeletions.set(r.id,r.revision);
   if(activeSavedId===r.id)activeSavedId=null;
   saveResult.hidden=true;saveResult.replaceChildren();
   updateDrafts();
  });
  li.append(choose,remove);orderedItems.push({month:r.targetMonth,date:r.paymentDate,node:li});
 }
 for(const item of fileQueue){
  const chosen=item.id===activeDraft;
  const li=el('li','file-list__item');li.classList.toggle('is-selected',chosen);
  const choose=el('button','file-list__select');choose.type='button';
  const pendingName=item.draft?yearEndPdfName(item.draft.kind,item.draft.paymentDate,item.file.name):item.file.name;
  choose.setAttribute('aria-label',`${pendingName} の内容を確認`);
  choose.setAttribute('aria-pressed',String(chosen));
  const icon=el('span','file-list__icon');icon.append(uploadIcon('file'));
  const info=el('span','file-list__text');
  const name=el('span','file-name',pendingName);name.title=`取込元：${item.file.name}`;
  const detail=el('span','file-caption',formatBytes(item.file.size));
  const failed=item.status==='error'||item.status==='duplicate';
  const valid=item.status==='ready'&&!validateQueueItem(item);
  const label=item.status==='reading'?'解析中':item.status==='duplicate'?'重複・除外':item.status==='error'?'読取不可':valid?'保存待ち':'要修正';
  const status=el('span',`file-status file-status--${item.status==='duplicate'?'warning':failed?'error':item.status==='reading'?'pending':valid?'ready':'warning'}`,label);
  if(item.status==='duplicate')detail.textContent=`${formatBytes(item.file.size)} · ${item.error||'同一PDF'}`;
  info.append(name,detail,status);choose.append(icon,info);
  if(chosen){const current=el('span','file-list__current','表示中');choose.append(current);}
  choose.addEventListener('click',()=>{activeDraft=item.id;activeSavedId=null;updateDrafts();});
  const remove=el('button','file-list__remove');remove.type='button';
  remove.title='一覧から削除';remove.setAttribute('aria-label',`${item.file.name} を一覧から削除`);
  remove.disabled=busy;remove.append(uploadIcon('close'));
  remove.addEventListener('click',()=>{if(busy)return;fileQueue=fileQueue.filter(x=>x!==item);promoteRemainingDuplicate(item);});
  li.append(choose,remove);orderedItems.push({month:item.draft?.targetMonth??'',date:item.draft?.paymentDate??'',node:li});
 }
 // List rows match the standard PDF importer. Sorting is chronological, not grouping:
 // January comes first, December last; unparsed PDFs without a month go to the end.
 orderedItems.sort((a,b)=>{
  if(!a.month)return b.month?1:a.date.localeCompare(b.date);
  if(!b.month)return -1;
  return a.month.localeCompare(b.month)||a.date.localeCompare(b.date);
 });
 for(const item of orderedItems)drafts.append(item.node);
 // Keep pending removals INSIDE the same scrollable list, not as an unbounded
 // second panel. 10 deleted + 10 re-imported files must not stretch the card.
 const pendingRecords=(data?.documents??[]).filter(record=>pendingDeletions.has(record.id));
 const pendingRow=(record:DocumentRecord):HTMLLIElement=>{
  const li=el('li','file-list__item yea-file-pending');
  const icon=el('span','file-list__icon');icon.append(uploadIcon('file'));
  const info=el('span','file-list__text');
  const filename=yearEndVisiblePdfName(record.kind,record.paymentDate,record.fileName);
  const name=el('span','file-name',filename);name.title=filename;
  const meta=el('span','file-caption',formatBytes(record.pdfSize));
  const state=el('span','file-status yea-file-pending__state','削除待ち');
  info.append(name,meta,state);
  const undo=el('button','btn btn--ghost btn--small yea-undo-delete','元に戻す');
  undo.type='button';undo.disabled=busy;undo.setAttribute('aria-label',`${filename} の削除を取り消す`);
  undo.addEventListener('click',()=>{if(busy)return;pendingDeletions.delete(record.id);if(!pendingDeletions.size)pendingGroupExpanded=false;updateDrafts();});
  li.append(icon,info,undo);
  return li;
 };
 if(pendingRecords.length===1){
  drafts.append(pendingRow(pendingRecords[0]));
 }else if(pendingRecords.length>1){
  const group=el('li','yea-pending-group');
  const header=el('div','yea-pending-group__header');
  const toggle=el('button','yea-pending-group__toggle',`削除待ち ${pendingRecords.length}件`);
  toggle.type='button';toggle.setAttribute('aria-expanded',String(pendingGroupExpanded));
  toggle.title=pendingGroupExpanded?'削除待ちを折りたたむ':'削除待ちの明細を表示';
  const restoreAll=el('button','btn btn--ghost btn--small yea-undo-all','すべて元に戻す');
  restoreAll.type='button';restoreAll.disabled=busy;
  restoreAll.addEventListener('click',()=>{if(busy)return;pendingDeletions.clear();pendingGroupExpanded=false;updateDrafts();});
  header.append(toggle,restoreAll);
  const entries=el('ul','yea-pending-group__items');entries.hidden=!pendingGroupExpanded;
  for(const record of pendingRecords)entries.append(pendingRow(record));
  toggle.addEventListener('click',()=>{pendingGroupExpanded=!pendingGroupExpanded;entries.hidden=!pendingGroupExpanded;toggle.setAttribute('aria-expanded',String(pendingGroupExpanded));toggle.title=pendingGroupExpanded?'削除待ちを折りたたむ':'削除待ちの明細を表示';});
  group.append(header,entries);drafts.append(group);
 }
 const count=$<HTMLElement>('yea-workspace-count');
 const changes=data?.documents.filter(r=>{const edit=savedEdits.get(r.id);return Boolean(!pendingDeletions.has(r.id)&&edit&&isChanged(r,edit));}).length??0;
 const pendingCount=fileQueue.length+changes+pendingDeletions.size;
 count.textContent=pendingCount?`未保存 ${pendingCount}件`:`${savedRecords.length}件`;
 zipDownload.disabled=busy||Boolean(pendingDeletions.size)||!data?.documents.length;
 if(!preserveReview)renderSelectedReview();updateSaveState();
}
async function saveAllDocuments(){
 if(busy||saveAll.disabled||!selected||!data)return;
 const id=selected,year=activeYear;
 const updates=data.documents.filter(r=>{const e=savedEdits.get(r.id);return Boolean(!pendingDeletions.has(r.id)&&e&&isChanged(r,e));});
 const deletions=data.documents.filter(r=>pendingDeletions.has(r.id)).map(r=>({documentId:r.id,expectedRevision:pendingDeletions.get(r.id)!}));
 const additions=fileQueue.filter(x=>x.status==='ready'&&x.draft);
 const excluded=fileQueue.filter(x=>x.status==='duplicate').map(x=>({name:x.file.name,reason:x.error||'同一PDFのため除外'}));
 if(!updates.length&&!additions.length&&!deletions.length)return;
 for(const record of updates){const edit=savedEdits.get(record.id)!;
  if(validateSavedEdit(record,edit)){activeSavedId=record.id;activeDraft=null;updateDrafts();say('変更する明細の入力内容を確認してください。',true);return;}
 }
 for(const item of additions){if(item.personId!==id||item.year!==year||validateQueueItem(item)){
  activeSavedId=null;activeDraft=item.id;updateDrafts();say('新規明細の入力内容を確認してください。',true);return;}}
 // Normal saves have no extra dialog. Only inconsistencies require explicit consent.
 const amountWarnings=[...updates.map(r=>savedEdits.get(r.id)!.draft),...additions.map(i=>i.draft!)].flatMap(documentAmountWarnings);
 const acknowledged=amountWarnings.length>0;
 if(acknowledged&&!window.confirm(`支給額の検算に不一致があります。\n${[...new Set(amountWarnings)].join('\n')}\nPDF原本を確認し、この金額で保存しますか？`))return;
 saveResult.hidden=true;saveResult.replaceChildren();
 busy=true;savingDocuments=true;uploadAccordion.open=false;showBusy('明細を保存中');updateSaveState();
 try{
  const result=await repo.saveDocumentsBatch(id,year,
   updates.map(record=>({documentId:record.id,expectedRevision:record.revision,draft:savedEdits.get(record.id)!.draft})),
   additions.map(item=>({file:item.file,draft:item.draft!})),acknowledged,
   (done,total)=>showBusy(`明細を保存中（原本${done}/${total}件を照合済み）`),deletions);
  if(selected!==id||activeYear!==year)throw new Error('保存中に従業員または年が変更されました。');
  const forecastSnapshot=forecastDirty?captureForecastInput():null;
  const bonusSnapshot=bonusDirty?captureBonusInput():null;
  data=result.data;
  const profile=people.find(p=>p.id===id);
  if(profile)profile.yearFiles=result.yearFiles;
  savedEdits.clear();pendingDeletions.clear();pendingGroupExpanded=false;fileQueue=[];activeDraft=null;activeSavedId=null;
  uiPdf.value='';
  renderYear();
  showSkippedResult(additions.length,updates.length,excluded);
  if(forecastSnapshot)restoreForecastInput(forecastSnapshot);
  if(bonusSnapshot)restoreBonusInput(bonusSnapshot);
  if(result.data.documents.length)uploadAccordion.open=excluded.length>0;
  if(result.cleanupPending)appStatus.error(`明細の保存は完了しましたが、削除済みPDF原本${result.cleanupPending}件のごみ箱への移動は未完了です。`);
  else appStatus.success(excluded.length?`明細を保存しました。重複${excluded.length}件は除外しました。`:'明細を保存しました');
  resetSaveRecoveryStateAfterSuccess();
 }catch(error){
  uploadAccordion.open=true;saveRecoveryRequired=true;saveRecoveryChecked=false;saveRecoverySafe=false;
  saveRecovery.hidden=false;saveReload.disabled=true;saveRecoveryStatus.textContent='保存状態が不明です。再保存する前にOneDriveの状態を確認してください。';
  say(`保存できませんでした：${error instanceof Error?error.message:'通信エラー'}`,true);
 }finally{
  busy=false;savingDocuments=false;updateDrafts();updateForecastSaveState();updateBonusSaveState();
 }
}
async function refreshPeopleKeepSelection(){
 const id=selected;people=await repo.people();renderPeople();if(id&&people.some(p=>p.id===id&&p.state==='active')){selected=id;currentName.textContent=displayPerson(person());renderYearOptions();await loadYear();}
}
function bind(){
 zipDownload.addEventListener('click',()=>{
  if(busy||!selected||pendingDeletions.size||!data?.documents.length)return;
  const id=selected,year=activeYear,personLabel=displayPerson(person());
  void action('保存済みPDFをZIPにまとめてダウンロード',async()=>{
   const verified=await repo.originalsForYear(id,year);
   if(selected!==id||activeYear!==year)throw new Error('ダウンロード中に従業員・年度が変更されました。');
   const archive=createYearEndPdfZip(verified);
   const link=document.createElement('a'),url=URL.createObjectURL(archive);
   const safePerson=personLabel.replace(/[\/\\\u0000-\u001f\u007f<>:"|?*]/g,'_').slice(0,50)||'従業員';
   link.href=url;link.download=`年末調整_${safePerson}_${year}.zip`;
   document.body.append(link);link.click();link.remove();
   window.setTimeout(()=>URL.revokeObjectURL(url),60_000);
   say(`${verified.length}件のPDFをZIPにまとめました。`);
  },false);
 });
 $<HTMLButtonElement>('yea-back-directory').addEventListener('click',()=>{if(busy||!checkDetailExit())return;resetSelection();say('従業員を選択してください。');});
 $<HTMLButtonElement>('yea-open-manage').addEventListener('click',()=>{if(!selected||busy)return;$<HTMLInputElement>('yea-rename-name').value=displayPerson(person());$<HTMLDialogElement>('yea-manage-dialog').showModal();});
 $<HTMLButtonElement>('yea-close-manage').addEventListener('click',()=>{$<HTMLDialogElement>('yea-manage-dialog').close();});
 yearSelect.addEventListener('change',()=>{if(busy||!checkDetailExit()){yearSelect.value=String(activeYear);return;}if(!selected)return;const y=Number(yearSelect.value);if(!validYear(y))return;resetSaveRecovery();activeYear=y;clearMemo();data=null;clearDrafts();resetForecastForm();resetBonusForm();void action('暦年データの読み込み',loadYear,false);});
 $<HTMLFormElement>('yea-person-create').addEventListener('submit',e=>{e.preventDefault();const name=$<HTMLInputElement>('yea-new-name').value;void action('従業員の登録',async()=>{const id=await repo.createPerson(name,'');await loadPeople();$<HTMLInputElement>('yea-new-name').value='';await selectPerson(id);});});
 $<HTMLFormElement>('yea-rename').addEventListener('submit',e=>{e.preventDefault();if(!selected)return;const id=selected,name=$<HTMLInputElement>('yea-rename-name').value;void action('従業員名の変更',async()=>{await repo.renamePerson(id,name,'');await refreshPeopleKeepSelection();$<HTMLDialogElement>('yea-manage-dialog').close();});});
 $<HTMLButtonElement>('yea-delete-person').addEventListener('click',()=>{
  if(!selected||busy||!checkDetailExit())return;
  const p=person(),id=p.id;
  if(!window.confirm(`${displayPerson(p)} の従業員データ（PDF原本・年度データ・見込みを含む）を削除しますか？\nOneDriveのごみ箱やバージョン履歴には残る場合があります。`))return;
  const input=window.prompt('削除する従業員の表示名を入力してください。');
  if(input!==displayPerson(p))return;
  // Close before the potentially long OneDrive deletion sequence begins.
  const dialog=$<HTMLDialogElement>('yea-manage-dialog');if(dialog.open)dialog.close();
  void action('従業員を削除中',async()=>{
   await repo.deletePerson(id);
   resetSelection();await loadPeople();
  });
 });
 memoInput.addEventListener('input',()=>{memoDirty=memoInput.value!==(data?.memo??'');memoButton.disabled=!memoDirty;memoState.textContent=memoDirty?'未保存の変更があります。':'';});
 memoButton.addEventListener('click',()=>{if(!selected||!data||!memoDirty||busy)return;const id=selected,year=activeYear,text=memoInput.value;
  void action('年度メモの暗号化保存',async()=>{
   const draft=forecastDirty?captureForecastInput():null;
   const bonusDraft=bonusDirty?{month:bonusMonthInput.value,amount:bonusValueInput.value}:null;
   await repo.saveYearMemo(id,year,text);data=await repo.year(id,year);memoDirty=false;renderYear();
   if(draft)restoreForecastInput(draft);
   if(bonusDraft){bonusMonthInput.value=bonusDraft.month;bonusValueInput.value=bonusDraft.amount;bonusDirty=true;updateBonusSaveState();}
  });
 });
 window.addEventListener('beforeunload',event=>{if(memoDirty||pendingEdits()||forecastDirty||bonusDirty){event.preventDefault();event.returnValue='';}});
 methodChoices.addEventListener('change',event=>{
  if(!(event.target instanceof HTMLInputElement)||event.target.type!=='radio')return;
  markForecastDirty();
  syncForecastAmounts(true);
 });
 commit.addEventListener('click',saveForecast);
 const queuePdfFiles=(files:File[])=>{
  if(busy||!selected||!data){say('従業員を選択してください。',true);return;}
  if(!files.length)return;
  saveResult.hidden=true;saveResult.replaceChildren();
  if(files.length+fileQueue.length>30){say('一度に選択できるPDFは最大30件です。',true);return;}
  const id=selected,year=activeYear;
  const items:QueueItem[]=files.map(file=>({id:++draftSerial,file,draft:null,personId:id,year,hash:'',status:'reading',error:'',fieldErrors:new Set<string>()}));
  fileQueue.push(...items);activeDraft=items[0]?.id??null;activeSavedId=null;
  uploadAccordion.open=false;updateDrafts();
  void action('PDFをブラウザ内で解析',async()=>{
   // Keep PDF.js work bounded to two workers to reduce ten-file parsing time
   // without spawning ten decoders at once on a phone.
   let cursor=0;
   const worker=async()=>{
    while(cursor<items.length){
     const item=items[cursor++];
     if(!fileQueue.includes(item))continue;
     try{
      const bytes=await item.file.arrayBuffer();
      item.hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const saved=data?.documents.some(r=>!pendingDeletions.has(r.id)&&r.fileHash===item.hash);
      // With concurrent parsing, later files may finish first. Compare all
      // earlier hash results after the workers settle before allowing save.
      if(saved){item.status='duplicate';item.error='OneDriveに同じPDF原本が保存済みです。';continue;}
      item.draft=await parseAssistedPdf(item.file,bytes);item.status='ready';
     }catch(error){item.status='error';item.error=error instanceof Error?error.message:'PDFの解析に失敗しました。';}
     finally{updateDrafts();}
    }
   };
   await Promise.all(Array.from({length:Math.min(2,items.length)},()=>worker()));
   const firstHash=new Map<string,QueueItem>();
   for(const item of fileQueue){
    if(!item.hash)continue;
    if(firstHash.has(item.hash)&&item.status!=='error'){
     item.status='duplicate';item.error='今回選択したPDFと内容が重複しています。';
    }else if(!firstHash.has(item.hash))firstHash.set(item.hash,item);
   }
   updateDrafts();
   if(selected!==id||activeYear!==year){clearDrafts();throw new Error('解析中に従業員や年が変更されました。');}
  },false).finally(()=>{if(selected===id&&activeYear===year)uploadAccordion.open=true;});
 };
 uiPdf.addEventListener('change',()=>{const files=Array.from(uiPdf.files??[]);uiPdf.value='';queuePdfFiles(files);});
 const drop=$<HTMLElement>('yea-pdf-dropzone');
 drop.addEventListener('click',()=>{if(!busy&&!uiPdf.disabled)uiPdf.click();});
 drop.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&!busy&&!uiPdf.disabled){event.preventDefault();uiPdf.click();}});
 drop.addEventListener('dragenter',event=>{event.preventDefault();drop.classList.add('is-dragging');});
 drop.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';drop.classList.add('is-dragging');});
 drop.addEventListener('dragleave',event=>{if(!drop.contains(event.relatedTarget as Node|null))drop.classList.remove('is-dragging');});
 drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('is-dragging');queuePdfFiles(Array.from(event.dataTransfer?.files??[]));});
 $<HTMLButtonElement>('yea-mobile-file-picker').addEventListener('click',()=>{if(!busy&&!uiPdf.disabled)uiPdf.click();});
 $<HTMLButtonElement>('yea-open-draft-pdf').addEventListener('click',()=>{
  const item=selectedQueueItem(),record=selectedRecord();
  if(item)openBlobPdf(item.file,item.draft?yearEndPdfName(item.draft.kind,item.draft.paymentDate,item.file.name):undefined);
  else if(record)void openStoredPdf(record.id);
 });
 $<HTMLButtonElement>('yea-discard-edit').addEventListener('click',()=>{const r=selectedRecord();if(!r||busy)return;savedEdits.delete(r.id);updateDrafts();});
 $<HTMLButtonElement>('yea-clear-all').addEventListener('click',()=>{if(busy||!fileQueue.length)return;fileQueue=[];activeDraft=null;uiPdf.value='';updateDrafts();});
 reviewForm.addEventListener('input',event=>{
  const node=event.target;
  if(!(node instanceof HTMLInputElement||node instanceof HTMLSelectElement)||!node.dataset.field)return;
  const item=selectedQueueItem(),record=selectedRecord();
  if(!record&&(!item?.draft||item.status!=='ready'))return;
  const key=node.dataset.field as ReviewField;if(!reviewFields.includes(key))return;
  let edit:SavedEdit|undefined;
  if(record){
   edit=savedEdits.get(record.id);
   if(!edit){edit={draft:recordDraft(record),fieldErrors:new Set()};savedEdits.set(record.id,edit);}
  }
  const draft=edit?.draft??item!.draft!,errors=edit?.fieldErrors??item!.fieldErrors;
  if(key==='kind'||key==='paymentDate'||key==='targetMonth'){
   (draft as unknown as Record<string,string>)[key]=node.value;
   if(key==='kind'&&node.value==='bonus'&&draft.taxable===null&&draft.gross!==null&&
     (draft.nonTaxable===null||draft.nonTaxable===0)&&(draft.transportation===null||draft.transportation===0)){
    draft.taxable=draft.gross;
    const taxable=reviewForm.querySelector<HTMLInputElement>('input[data-field="taxable"]');
    if(taxable)taxable.value=String(draft.taxable);
   }
  }else{
   const amount=node.value.trim()?parseYen(node.value):null;
   (draft as unknown as Record<string,number|null>)[key]=amount;
   if(node.value.trim()&&amount===null)errors.add(key);else errors.delete(key);
  }
  const error=record?validateSavedEdit(record,edit!):validateQueueItem(item!);
  reviewValidation.hidden=!error;reviewValidation.textContent=error??'';reviewValidation.classList.toggle('is-error',Boolean(error));
  // Re-render warning details without wiping typed form fields.
  const warnings=[...(item&&possibleNameMismatch(item)?['他のPDFと読み取り氏名が一致しません。']:[]),
   ...documentAmountWarnings(draft),...(item?.draft?.warnings??[])];
  const notice=$<HTMLElement>('yea-review-notice');
  notice.hidden=!warnings.length;notice.textContent=[...new Set(warnings)].join('\n');notice.classList.toggle('read-result--warning',Boolean(warnings.length));
  if(record&&edit){
   const changed=isChanged(record,edit);
   $<HTMLButtonElement>('yea-discard-edit').hidden=!changed;
   $('yea-selected-meta').textContent=changed?'変更あり':'保存済み';
  }
  updateDrafts(true);
 });
 saveRecheck.addEventListener('click',()=>{void(async()=>{
  if(busy||!selected||!saveRecoveryRequired)return;
  busy=true;updateSaveState();saveRecoveryStatus.textContent='OneDriveの保存状態を確認しています…';
  try{
   const id=selected,year=activeYear;
   const [latest,integrity]=await Promise.all([repo.year(id,year),repo.inspectUnreferencedOriginals(id)]);
   if(selected!==id||activeYear!==year)throw new Error('確認中に従業員・年が変わりました。');
   saveRecoveryChecked=true;saveRecoverySafe=integrity.unreferenced===0&&integrity.missing===0;
   saveRecoveryStatus.textContent=saveRecoverySafe?
    `OneDriveの保存済み明細 ${latest.documents.length}件を確認しました。保存前に「保存済みデータを読み直す」を押してください。`:
    `参照されていないPDF原本 ${integrity.unreferenced}件・参照先が欠落したPDF ${integrity.missing}件を検出しました。自動削除・再保存は行いません。OneDriveの暗号化ファイルを保持し、保存状態を調査してください。`;
  }catch(error){saveRecoveryChecked=false;saveRecoverySafe=false;
   saveRecoveryStatus.textContent=`OneDriveの確認に失敗しました：${error instanceof Error?error.message:'通信エラー'}。再保存しないでください。`;
  }finally{busy=false;saveReload.disabled=!saveRecoveryChecked||!saveRecoverySafe;updateSaveState();}
 })()});
 saveReload.addEventListener('click',()=>{void(async()=>{
  if(busy||!saveRecoveryChecked||!saveRecoverySafe||!selected)return;
  if(!window.confirm('新規PDFの取り込み待ち・明細の未保存編集を破棄し、OneDriveの最新の明細を読み直しますか？\nPDFファイルは必要に応じて再度選択してください。'))return;
  busy=true;showBusy('OneDriveの明細を再取得中');
  try{
   // Reinspect immediately before discarding local drafts. No cloud write is performed.
   const id=selected,year=activeYear;
   const integrity=await repo.inspectUnreferencedOriginals(id);
   if(integrity.unreferenced||integrity.missing)throw new Error('原本の参照状態が変わりました。再確認してください。');
   if(id!==selected||year!==activeYear)throw new Error('従業員または年が切り替わりました。');
   clearDrafts();resetSaveRecovery();
   await loadYear();uploadAccordion.open=true;
   say('OneDriveの最新の明細を読み直しました。変更内容を確認してから保存してください。');
  }catch(error){saveRecoveryRequired=true;saveRecoveryChecked=false;saveRecoverySafe=false;
   saveRecovery.hidden=false;saveRecoveryStatus.textContent=`再読み込みできませんでした：${error instanceof Error?error.message:'通信エラー'}。OneDriveの状態を再確認してください。`;
  }finally{busy=false;updateDrafts();updateForecastSaveState();}
 })()});
 saveAll.addEventListener('click',()=>{void saveAllDocuments();});
 bonusMonthInput.addEventListener('input',()=>{
  const month=bonusMonthInput.value;
  // Clearing the month field after selecting a saved entry removes that entry on Save.
  bonusClearedMonth=!month&&bonusLastMonth&&data?.bonusEstimates.some(e=>e.month===bonusLastMonth)?bonusLastMonth:'';
  bonusLastMonth=month;
  const saved=data?.bonusEstimates.find(e=>e.month===month);
  bonusValueInput.value=saved?String(saved.amount):'';
  markBonusDirty();
 });
 bonusValueInput.addEventListener('input',markBonusDirty);

}
bind();

void action('保管庫の読み込み',async()=>{await loadPeople();},false);
