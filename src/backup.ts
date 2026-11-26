import {mountNotificationHistory} from './ui/notificationHistoryView';
import {noticeCode,recordNotification} from './ui/notificationHistory';
import {confirmOperation,type OperationDialogRequest} from './ui/operationDialog';
import {mountSettingsNavigation} from './ui/settingsNavigation';
import { createAppStatus } from './ui/appStatus';
import {microsoftDiagnostic} from './cloud/msalPolicy';
import {operationFeedback,type OperationResult} from './ui/operationOutcome';
/** 暗号化完全バックアップの書出・PDF.jsでの復元前検査・全件置換。 */
import type {OrphanAnnualYear,DetachedOriginalReport,DetachedOriginal} from './cloud/vault';
import {migrateFromLegacyIndexedDb, inspectLegacyIndexedDb, verifyLegacyIndexedDbCloudBeforeDelete, deleteLegacyIndexedDb, loadRecords, inspectReplacementRestoreBaseline, type ReplacementRestoreBaseline, replaceAllRecords,inspectAdditiveRestore,restoreAdditiveRecords,type AdditiveRestorePreview, inspectEmployerAssignment, assignEmployers, recordSignature, type SavedPayrollSummary } from './storage/payrollStore';
import {employerDirectorySignature,upsertEmployer,type EmployerEntry} from './storage/employerDirectory';
import {defaultEmployerForecast,validateEmployerForecast,type EmployerForecastPreferences} from './storage/employerForecast';
import {PayrollPartialSuccessError} from './storage/operationError';
import {createEmployerId} from './storage/employerIdentity';
import {legacyEmployers,employerDisplayName,type LegacyEmployer} from './ui/employerSelection';
import { createBackup, readBackup, type LoadedBackup } from './storage/payrollBackup';
import { encryptBackup, decryptBackup, isEncryptedBackup } from './storage/encryptedBackup';
import {captureOperationAuthorization,cloudVault,tryResumeCloudVault,refreshSessionAfterKeyRotation,cloudConnectionState,saveCloudClientId,chooseMicrosoftAccount,signOutMicrosoftAccount,reconnectMicrosoftAccount,cloudRedirectUri,currentBrowserRememberState,rememberCurrentBrowser,forgetCurrentBrowser} from './cloud/auth';
import {clearNavigationSnapshot} from './cloud/snapshot';
import type {CloudFolderItem} from './cloud/graph';
import {YearEndRepository,type YearEndRestorePreview} from './yearEnd/repository';
import {createYearEndBackup,readYearEndBackup,type YearEndBackupData} from './yearEnd/backup';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`画面の要素が見つかりません: ${id}`);
  return element as T;
};
const exportButton = $<HTMLButtonElement>('export-button');
const exportSummary = $<HTMLElement>('export-summary');
const cloudLoad=$<HTMLButtonElement>('backup-cloud-load');
const exportPassword = $<HTMLInputElement>('export-password');
const exportConfirm = $<HTMLInputElement>('export-confirm');
const filePicker = $<HTMLInputElement>('restore-file');
const restorePasswordRow = $<HTMLElement>('restore-password-row');
const restorePassword = $<HTMLInputElement>('restore-password');
const verifyButton = $<HTMLButtonElement>('verify-button');
const restorePreview = $<HTMLElement>('restore-preview');
const ack = $<HTMLInputElement>('restore-ack');
const restoreButton = $<HTMLButtonElement>('restore-button');
const addInspect=$<HTMLButtonElement>('restore-add-inspect');
const addPreview=$<HTMLElement>('restore-add-preview');
const addButton=$<HTMLButtonElement>('restore-add-button');
let addPlan:AdditiveRestorePreview|undefined;
let addPlanAuthorized:(()=>boolean)|undefined;
const status = $<HTMLElement>('backup-status');
const changeCurrent=$<HTMLInputElement>('change-current');
const changeNew=$<HTMLInputElement>('change-new');
const changeConfirm=$<HTMLInputElement>('change-confirm');
const changeAck=$<HTMLInputElement>('change-ack');
const changeButton=$<HTMLButtonElement>('change-passphrase-button');
const changeStatus=$<HTMLElement>('change-passphrase-status');
const browserKeyState=$<HTMLElement>('remember-browser-state');
const browserKeyRegister=$<HTMLButtonElement>('remember-browser-register');
const browserKeyForget=$<HTMLButtonElement>('remember-browser-forget');
const browserKeyFeedback=$<HTMLElement>('remember-browser-feedback');
let browserKeyStateValue:'pending'|'saved'|'missing'|'unavailable'='pending';

type OldCloudPlan={generation:string;indexEtag:string;targets:Array<{parent:string[];item:CloudFolderItem}>;files:number;bytes:number};
let oldCloudPlan:OldCloudPlan|undefined;
const cloudCheck=$<HTMLButtonElement>('cloud-cleanup-check');
const cloudDelete=$<HTMLButtonElement>('cloud-cleanup-delete');
const cloudStatus=$<HTMLElement>('cloud-cleanup-status');
const localCheck=$<HTMLButtonElement>('legacy-cleanup-check');
const localDelete=$<HTMLButtonElement>('legacy-cleanup-delete');
const localStatus=$<HTMLElement>('legacy-cleanup-status');
let orphanYears:OrphanAnnualYear[]|undefined;
const orphanCheck=$<HTMLButtonElement>('orphan-year-check');
const orphanRecover=$<HTMLButtonElement>('orphan-year-recover');
const orphanStatus=$<HTMLElement>('orphan-year-status');
const detachedCheck=$<HTMLButtonElement>('detached-original-check');
const detachedStatus=$<HTMLElement>('detached-original-status');
const detachedList=$<HTMLElement>('detached-original-list');
let detachedReport:DetachedOriginalReport|undefined;
let detachedPage=0;
let preview: LoadedBackup | undefined;
let currentCount = 0;
let initialSnapshot: ReplacementRestoreBaseline | undefined;
let busy = false;
let settingsNavigation:ReturnType<typeof mountSettingsNavigation>|undefined;
let employers:EmployerEntry[]|undefined;
let legacyDirectory:LegacyEmployer[]=[];
const employerDirectoryLoad=$<HTMLButtonElement>('employer-directory-load');
const employerDirectoryStatus=$<HTMLElement>('employer-directory-status');
const employerDirectoryList=$<HTMLUListElement>('employer-directory-list');
const employerDirectoryForm=$<HTMLFormElement>('employer-directory-form');
const employerDirectoryTarget=$<HTMLSelectElement>('employer-directory-target');
const employerDirectoryName=$<HTMLInputElement>('employer-directory-name');
const employerDirectoryRole=$<HTMLSelectElement>('employer-directory-role');
const employerDirectoryCurrent=$<HTMLInputElement>('employer-directory-current');
const employerForecastSettings=$<HTMLFieldSetElement>('employer-forecast-settings');
const employerSalaryMethods=Array.from(employerForecastSettings.querySelectorAll<HTMLInputElement>('input[name="employer-salary-method"]'));
const employerBonusEnabled=$<HTMLInputElement>('employer-bonus-enabled');
const employerBonusSchedule=$<HTMLFieldSetElement>('employer-bonus-schedule');
const employerBonusMonths=Array.from(employerBonusSchedule.querySelectorAll<HTMLInputElement>('input[name="employer-bonus-month"]'));
function fillEmployerForecast(preferences:EmployerForecastPreferences):void{
 for(const input of employerSalaryMethods)input.checked=input.value===preferences.salaryMethod;
 employerBonusEnabled.checked=preferences.bonusMonths.length>0;
 for(const input of employerBonusMonths)input.checked=preferences.bonusMonths.includes(Number(input.value));
}
function draftEmployerForecast():EmployerForecastPreferences {
 const bonusMonths=employerBonusEnabled.checked?employerBonusMonths.filter(input=>input.checked).map(input=>Number(input.value)):[];
 if(employerBonusEnabled.checked&&!bonusMonths.length)throw new Error('賞与の支給予定月を選択してください。');
 return validateEmployerForecast({salaryMethod:employerSalaryMethods.find(input=>input.checked)?.value,bonusMonths});
}

const employerDirectorySave=$<HTMLButtonElement>('employer-directory-save');
const employerDirectoryAdd=$<HTMLButtonElement>('employer-directory-add');
const employerDirectoryCancel=$<HTMLButtonElement>('employer-directory-cancel');
const bulkPanel=$<HTMLElement>('employer-bulk-panel');
const bulkTarget=$<HTMLSelectElement>('employer-bulk-target');
const bulkList=$<HTMLElement>('employer-bulk-list');
const bulkCount=$<HTMLElement>('employer-bulk-count');
const bulkStatus=$<HTMLElement>('employer-bulk-status');
const bulkAll=$<HTMLButtonElement>('employer-bulk-all');
const bulkNone=$<HTMLButtonElement>('employer-bulk-none');
const bulkSave=$<HTMLButtonElement>('employer-bulk-save');
let bulkRecords:SavedPayrollSummary[]=[];
let bulkAuthorized:(()=>boolean)|undefined;
const bulkSelected=new Set<number>();
function bulkCandidates():SavedPayrollSummary[]{
 const role=employers?.find(e=>e.id===bulkTarget.value)?.role;
 return bulkRecords.filter(r=>r.employerId===undefined&&r.form.job===role).sort((a,b)=>b.form.targetMonth.localeCompare(a.form.targetMonth)||a.id-b.id);
}
function updateBulkControls():void{
 const enabled=!busy&&!!bulkAuthorized?.()&&!!employers;
 const candidates=bulkCandidates();
 bulkTarget.disabled=!enabled;bulkAll.disabled=!enabled||!candidates.length||bulkSelected.size===candidates.length;
 bulkNone.disabled=!enabled||!bulkSelected.size;bulkSave.disabled=!enabled||!bulkSelected.size||!bulkTarget.value;
 bulkList.querySelectorAll<HTMLInputElement>('input').forEach(el=>el.disabled=!enabled);
 bulkCount.textContent=`対象 ${candidates.length}件・選択 ${bulkSelected.size}件`;
}
function renderBulkList():void{
 bulkList.replaceChildren();
 for(const r of bulkCandidates()){
  const label=document.createElement('label'),box=document.createElement('input'),text=document.createElement('span');
  box.type='checkbox';box.checked=bulkSelected.has(r.id);
  const title=document.createElement('strong'),detail=document.createElement('small'),amount=document.createElement('span');
  title.textContent=`${r.form.targetMonth} ${r.form.kind==='bonus'?'賞与':'給与'}`;
  detail.textContent=`支給日 ${r.form.paymentDate} / ${r.fileName}`;
  amount.className='employer-bulk__amount';amount.textContent=String(r.form.gross??'').trim()?`${Number(r.form.gross).toLocaleString('ja-JP')}円`:'金額未取得';
  text.className='employer-bulk__record';text.append(title,detail);
  box.addEventListener('change',()=>{if(busy||!bulkAuthorized?.())return;if(box.checked)bulkSelected.add(r.id);else bulkSelected.delete(r.id);updateBulkControls();});
  label.append(box,text,amount);bulkList.append(label);
 }
 updateBulkControls();
}
function renderBulkPanel():void{
 bulkPanel.hidden=employers===undefined;bulkSelected.clear();bulkTarget.replaceChildren();
 const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='勤務先を選択';bulkTarget.append(placeholder);
 for(const entry of employers??[]){const option=document.createElement('option');option.value=entry.id;option.textContent=`${employerDisplayName(employers??[],entry.id)}（${entry.role==='main'?'本業':'副業'}・${entry.current?'現在':'過去'}）`;bulkTarget.append(option);}
 bulkStatus.textContent='';renderBulkList();
}
const roleLabel=(role:string)=>role==='main'?'本業':'副業';
function updateEmployerButtons():void{
 employerDirectoryLoad.disabled=busy;
 employerDirectoryAdd.disabled=busy||!employers;employerDirectoryCancel.disabled=busy;
 employerDirectoryTarget.disabled=busy||!employers;
 employerDirectoryName.disabled=busy||!employers;
 const entry=employers?.find(x=>x.id===employerDirectoryTarget.value);
 const legacy=legacyDirectory.find(x=>x.id===employerDirectoryTarget.value);
 employerDirectoryRole.disabled=busy||!employers||Boolean(entry)||legacy?.roles.length===1;
 employerDirectoryCurrent.disabled=busy||!employers;
 const roleValid=['main','side'].includes(employerDirectoryRole.value);
 employerForecastSettings.disabled=busy||!employers||!roleValid;
 employerBonusSchedule.hidden=!employerBonusEnabled.checked;
 employerBonusSchedule.disabled=employerForecastSettings.disabled||!employerBonusEnabled.checked;
 const forecastValid=employerSalaryMethods.some(input=>input.checked)&&(!employerBonusEnabled.checked||employerBonusMonths.some(input=>input.checked));
 employerDirectorySave.disabled=busy||!employers||!employerDirectoryName.value.trim()||!roleValid||!forecastValid;
}
function fillEmployerDraft():void{
 const entry=employers?.find(x=>x.id===employerDirectoryTarget.value);
 const legacy=legacyDirectory.find(x=>x.id===employerDirectoryTarget.value);
 employerDirectoryName.value=entry?.name??'';
 employerDirectoryRole.value=entry?.role??(legacy?(legacy.roles.length===1?legacy.roles[0]:''):'main');
 employerDirectoryCurrent.checked=entry?.current??false;
 fillEmployerForecast(entry?.forecast??defaultEmployerForecast(employerDirectoryRole.value==='side'?'side':'main'));
 updateEmployerButtons();
}
function renderEmployerDirectory():void{
 employerDirectoryForm.hidden=true;
 employerDirectoryList.hidden=employers===undefined;
 employerDirectoryList.replaceChildren();
 const option=(id:string,label:string)=>{const node=document.createElement('option');node.value=id;node.textContent=label;return node;};
 employerDirectoryTarget.replaceChildren(option('','新しい勤務先'));
 for(const entry of [...(employers??[])].sort((a,b)=>a.role.localeCompare(b.role)||Number(b.current)-Number(a.current)||a.name.localeCompare(b.name,'ja')||a.id.localeCompare(b.id))){
  const sameName=employers!.filter(x=>x.role===entry.role&&x.name===entry.name);
  const label=`${entry.name}（${roleLabel(entry.role)}・${entry.current?'現在':'過去'}${sameName.length>1?`・${sameName.findIndex(x=>x.id===entry.id)+1}`:''}）`;
  employerDirectoryTarget.append(option(entry.id,label));
  const li=document.createElement('li'),text=document.createElement('span'),edit=document.createElement('button');
  const name=document.createElement('strong'),meta=document.createElement('small');
  name.textContent=entry.name;meta.textContent=`${roleLabel(entry.role)} · ${entry.current?'現在':'過去'}${sameName.length>1?` · ${sameName.findIndex(x=>x.id===entry.id)+1}`:''}`;
  text.className='employer-settings__identity';text.append(name,meta);edit.type='button';edit.className='btn btn--secondary btn--small';edit.textContent='編集';
  edit.addEventListener('click',()=>{if(busy)return;employerDirectoryTarget.value=entry.id;fillEmployerDraft();employerDirectoryForm.hidden=false;employerDirectoryName.focus();});li.append(text,edit);employerDirectoryList.append(li);
 }
 legacyDirectory.forEach((entry,i)=>{
  const label=`未登録の勤務先 ${i+1}（${entry.roles.map(roleLabel).join('・')} / ${entry.first}〜${entry.last} / ${entry.count}件）`;
  employerDirectoryTarget.append(option(entry.id,label));
  const li=document.createElement('li'),text=document.createElement('span'),edit=document.createElement('button');text.textContent=label;edit.type='button';edit.className='btn btn--secondary btn--small';edit.textContent='名称を設定';
  edit.addEventListener('click',()=>{if(busy)return;employerDirectoryTarget.value=entry.id;fillEmployerDraft();employerDirectoryForm.hidden=false;employerDirectoryName.focus();});li.append(text,edit);employerDirectoryList.append(li);
 });
 employerDirectoryTarget.value='';fillEmployerDraft();renderBulkPanel();
}

async function approveSettings(request:OperationDialogRequest,current:()=>boolean=()=>!busy,authorized=captureOperationAuthorization()):Promise<boolean>{
 const guard=()=>authorized()&&current();
 return await confirmOperation(request,guard)&&guard();
}
let loadedDb = false;
let encryptedFile = false;
const appStatus=createAppStatus(undefined,'settings');
type Operation = {label:string;result:string};
let operationResult:OperationResult|null=null;
let operationCancelled=false;
function finishOperation(status:OperationResult['status'],message?:string):void{operationResult={status,message:message??''};}
function cancelOperation():void{operationCancelled=true;}
let currentOperation: Operation|null=null;
let wasBusy=false;
let notificationScope:ReturnType<typeof appStatus.begin>|undefined;
const operations: Record<string,Operation>={
 'employer-directory-load':{label:'勤務先一覧を確認',result:'employer-directory-status'},
 'employer-directory-save':{label:'勤務先を保存',result:'employer-directory-status'},
 'employer-bulk-save':{label:'勤務先の一括設定',result:'employer-bulk-status'},
 'export-button':{label:'バックアップを作成',result:'backup-status'},
 'verify-button':{label:'バックアップを検証',result:'backup-status'},
 'restore-button':{label:'バックアップを復元',result:'backup-status'},
 'restore-add-inspect':{label:'追加復元の対象を確認',result:'backup-status'},
 'restore-add-button':{label:'明細を追加復元',result:'backup-status'},
 'change-passphrase-button':{label:'パスフレーズを変更',result:'change-passphrase-status'},
 'cloud-cleanup-check':{label:'旧暗号データを確認',result:'cloud-cleanup-status'},
 'cloud-cleanup-delete':{label:'旧暗号データを整理',result:'cloud-cleanup-status'},
 'orphan-year-check':{label:'年度データを検査',result:'orphan-year-status'},
 'orphan-year-recover':{label:'年度データを復旧',result:'orphan-year-status'},
 'detached-original-check':{label:'未参照PDFを検査',result:'detached-original-status'},
 'payroll-income-publish':{label:'Finance連携を更新',result:'payroll-income-publish-status'},
 'migrate-legacy-cloud':{label:'旧データを移行',result:'migrate-legacy-cloud-status'},
 'legacy-cleanup-check':{label:'旧データを検査',result:'legacy-cleanup-status'},
 'legacy-cleanup-delete':{label:'旧データを削除',result:'legacy-cleanup-status'},
 'backup-cloud-load':{label:'OneDriveの明細を取得',result:'backup-status'},
 'ye-backup-export':{label:'従業員バックアップを保存',result:'ye-backup-status'},
 'ye-restore-verify':{label:'従業員バックアップを検証',result:'ye-backup-status'},
 'ye-restore-commit':{label:'従業員データを復元',result:'ye-backup-status'},
 'ye-restore-resume':{label:'従業員データの復元を再開',result:'ye-backup-status'},
};
document.addEventListener('click',event=>{
 const target=event.target;
 if(!(target instanceof Element))return;
 const button=target.closest<HTMLButtonElement>('button[id]');
 if(button&&!button.disabled&&operations[button.id]){currentOperation=operations[button.id];operationResult=null;operationCancelled=false;}
},true);
function reportStatusTransition(){
 if(busy&&!wasBusy){
  const code=noticeCode(Object.keys(operations).find(key=>operations[key]===currentOperation)??'settings');
  notificationScope=appStatus.begin(code,code==='payroll-income-publish'?code:undefined);
  appStatus.show('loading',`${currentOperation?.label??'設定を処理'}しています…`,false,{scope:notificationScope});
 }
 if(!busy&&wasBusy){
  const operation=currentOperation;
  // The operation sets its result explicitly; UI wording never decides success/failure.
  if(operationCancelled||!operation)appStatus.clear(notificationScope);
  else {
   const notification=operationFeedback(operation.label,operationResult);
   appStatus.show(notification.kind,notification.message,false,{scope:notificationScope});
  }
  currentOperation=null;operationResult=null;operationCancelled=false;notificationScope=undefined;
 }
 wasBusy=busy;
}

const sizes = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(0, Math.round(n / 1024))} KiB`;
const yearEndRepo=new YearEndRepository();
const yearEndExport=$<HTMLButtonElement>('ye-backup-export');
const yearEndPassword=$<HTMLInputElement>('ye-backup-password');
const yearEndConfirm=$<HTMLInputElement>('ye-backup-confirm');
const yearEndFile=$<HTMLInputElement>('ye-restore-file');
const yearEndRestorePassword=$<HTMLInputElement>('ye-restore-password');
const yearEndVerify=$<HTMLButtonElement>('ye-restore-verify');
const yearEndCommit=$<HTMLButtonElement>('ye-restore-commit');
const yearEndPreviewLabel=$<HTMLElement>('ye-restore-preview');
const yearEndStatus=$<HTMLElement>('ye-backup-status');
const yearEndDiagnosis=$<HTMLElement>('ye-restore-diagnosis');
const yearEndResume=$<HTMLButtonElement>('ye-restore-resume');
const yearEndRecheck=$<HTMLButtonElement>('ye-restore-recheck');
const yearEndPeople=$<HTMLDetailsElement>('ye-restore-people');
const yearEndPeopleSummary=$<HTMLElement>('ye-restore-people-summary');
const yearEndPeopleList=$<HTMLUListElement>('ye-restore-people-list');
let yearEndPreview:YearEndBackupData|undefined;
let yearEndPlan:YearEndRestorePreview|undefined;
function showYearEndPlan(plan:YearEndRestorePreview){
 yearEndPlan=plan;
 yearEndPeople.hidden=false;
 yearEndPeople.open=plan.items.length<=8||plan.sameNameCollisions>0;
 yearEndPeopleSummary.textContent=`復元対象 ${plan.restorable}名・登録済み ${plan.skipped}名${plan.blocked?`・要確認 ${plan.blocked}名`:''}${plan.sameNameCollisions?`・同名注意 ${plan.sameNameCollisions}名`:''}`;
 yearEndPeopleList.replaceChildren();
 for(const entry of plan.items){
  const row=document.createElement('li');
  const label=document.createElement('strong');label.textContent=entry.label;
  const state=document.createElement('span');state.textContent=entry.reason;
  state.dataset.state=entry.status;
  if(entry.sameNameCollision)state.dataset.nameCollision='true';
  row.append(label,state);yearEndPeopleList.append(row);
 }
 if(plan.warning){
  const row=document.createElement('li');row.textContent=plan.warning;
  row.classList.add('ye-restore-warning');yearEndPeopleList.append(row);
 }
 updateButtons();
}


function updateButtons(): void {
  settingsNavigation?.setBusy(busy);
  updateEmployerButtons();
  updateBulkControls();
  employerDirectoryList.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=busy);
  reportStatusTransition();
  orphanCheck.disabled=busy;orphanRecover.disabled=busy||!orphanYears?.length;
  detachedCheck.disabled=busy;
  detachedList.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=busy);
  exportButton.disabled = busy || !loadedDb;
  yearEndExport.disabled=busy;yearEndVerify.disabled=busy||!yearEndFile.files?.length||!yearEndRestorePassword.value;
  yearEndCommit.disabled=busy||!yearEndPreview||!yearEndPlan?.canRestore||!yearEndPlan.restorable;
  yearEndResume.disabled=busy||Boolean(yearEndResume.hidden)||!yearEndPreview;
  yearEndRecheck.disabled=busy||Boolean(yearEndRecheck.hidden)||!yearEndPreview;
  for(const item of [yearEndPassword,yearEndConfirm,yearEndFile,yearEndRestorePassword])item.disabled=busy;
  cloudLoad.disabled=busy;
  changeButton.disabled=busy;
  browserKeyRegister.hidden=browserKeyStateValue!=='missing';
  browserKeyForget.hidden=browserKeyStateValue!=='saved';
  browserKeyRegister.disabled=busy||browserKeyStateValue!=='missing';
  browserKeyForget.disabled=busy||browserKeyStateValue!=='saved';
  const logoutControl=document.getElementById('backup-cloud-logout') as HTMLButtonElement|null;
  if(logoutControl)logoutControl.disabled=busy||Boolean(logoutControl.hidden);
  $<HTMLButtonElement>('payroll-income-publish').disabled=busy;
  cloudCheck.disabled=busy;cloudDelete.disabled=busy||!oldCloudPlan;localCheck.disabled=busy;localDelete.disabled=busy;
  for(const item of [changeCurrent,changeNew,changeConfirm,changeAck])item.disabled=busy;
  filePicker.disabled = busy;
  document.querySelector<HTMLButtonElement>('#migrate-legacy-cloud')?.toggleAttribute('disabled',busy);
  restorePassword.disabled = busy || !encryptedFile;
  verifyButton.disabled = busy || !filePicker.files?.length || (encryptedFile && !restorePassword.value);
  document.querySelectorAll<HTMLElement>('[data-personal-restore-stage]').forEach(panel=>panel.hidden=!preview);
  $<HTMLElement>('ye-restore-actions').hidden=!yearEndPreview||!yearEndPlan;
  ack.disabled = busy || !preview;
  restoreButton.disabled = busy || !preview || !ack.checked || !initialSnapshot;
  addInspect.disabled=busy||!preview;
  addButton.disabled=busy||!preview||!addPlan||!addPlanAuthorized?.()||!(addPlan.add||addPlan.employersAdded);
}
function info(message: string, isError = false, detail = false): void {
  status.textContent = isError||detail ? message : "";
  status.style.color = isError ? 'var(--color-danger)' : 'var(--color-success)';
  if(isError){if(busy&&currentOperation)finishOperation('error',message);else appStatus.error(message);}
  else if(busy&&!detail)appStatus.show('loading',message,false,{scope:notificationScope});
  else if(!busy&&message&&!detail)appStatus.success(message);
}
function resetPreview(): void {
  preview = undefined;
  addPlan=undefined;addPlanAuthorized=undefined;addPreview.textContent='ファイルを検証してから対象を確認してください。';
  ack.checked = false;
  updateButtons();
}
async function refreshCount(): Promise<void> {
  initialSnapshot = undefined;
  const snapshot = await inspectReplacementRestoreBaseline();
  currentCount = snapshot.count;
  initialSnapshot = snapshot;
  loadedDb = true;
  const bytes = snapshot.bytes;
  exportSummary.textContent = `明細 ${currentCount}件 / PDF ${sizes(bytes)}`;
}
exportButton.addEventListener('click', async () => {
  if (busy || !loadedDb) return;
  if (exportPassword.value !== exportConfirm.value) { info('2つのパスワードが一致しません。', true); return; }
  if ([...exportPassword.value].length < 12) { info('パスワードは12文字以上にしてください。', true); return; }
  busy = true; updateButtons(); info('暗号化バックアップを作成しています…');
  const started = performance.now();
  let step='OneDriveの原本PDFを確認しています…';
  let timer:ReturnType<typeof setInterval>|undefined;
  const display=()=>info(`${step}（経過 ${Math.round((performance.now()-started)/1000)}秒）`);
  timer=setInterval(display,1000);
  try {
    display();
    const vault=await cloudVault();
    const employers=await vault.readEmployerDirectory();
    const records=await loadRecords((completed,total)=>{
      step=`PDF原本 ${completed}/${total}件を取得・照合しました`;
      display();
    });
    step='ZIPファイルを作成しています…';display();
    if(employerDirectorySignature(await vault.readEmployerDirectory())!==employerDirectorySignature(employers))throw new Error('バックアップ中に勤務先一覧が更新されました。再実行してください。');
    const zip=await createBackup(records,employers);
    step='バックアップを暗号化しています…';display();
    const blob = await encryptBackup(zip, exportPassword.value);
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2,'0')}-${String(today.getHours()).padStart(2,'0')}${String(today.getMinutes()).padStart(2,'0')}${String(today.getSeconds()).padStart(2,'0')}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `payroll-backup-${stamp}.payroll`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    exportPassword.value = '';
    exportConfirm.value = '';
    info(`暗号化バックアップを作成しました（${sizes(blob.size)}）。保存先でファイルがあることを確認してください。`,false,true);finishOperation('success');
  } catch (error) { info(`バックアップに失敗しました: ${error instanceof Error ? error.message : String(error)}`, true); }
  finally { if(timer)clearInterval(timer);busy = false;updateButtons(); }
});

async function verifyRestore(file: File, password?: string): Promise<void> {
  busy = true; resetPreview(); updateButtons();
  info('バックアップの整合性とPDF原本を検査しています…');
  try {
    const content = password === undefined ? file : await decryptBackup(file, password);
    const loaded = await readBackup(content);
    preview = loaded;
    restorePassword.value = '';
    restorePreview.textContent = `検証完了：${loaded.records.length}件 ・ PDF ${sizes(loaded.bytes)}\n作成日時：${new Date(loaded.exportedAt).toLocaleString('ja-JP')}${loaded.unreviewedWarnings ? `\n旧データの検算未承認：${loaded.unreviewedWarnings}件` : ''}${loaded.legacyDuplicates ? `\n旧データの重複候補：${loaded.legacyDuplicates}件` : ''}${loaded.employers!==undefined?`\n勤務先一覧：${loaded.employers.length}件（既存の勤務先情報は維持）`:''}`;
    status.textContent='';finishOperation('success');
  } catch (error) {
    preview = undefined;
    restorePreview.textContent = '検証失敗。既存データは変更されていません。';
    info(`復元ファイルを検証できませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally { busy = false; updateButtons(); }
}
filePicker.addEventListener('change', async () => {
  resetPreview();
  restorePassword.value = '';
  encryptedFile = false;
  const file = filePicker.files?.[0];
  if (!file) { restorePreview.textContent = 'バックアップファイルを選択してください。'; updateButtons(); return; }
  busy = true; updateButtons();
  try {
    encryptedFile = await isEncryptedBackup(file);
    restorePasswordRow.dataset.backupFormat = encryptedFile ? 'encrypted' : 'legacy-zip';
    if (encryptedFile) {
      restorePreview.textContent = '暗号化バックアップ。パスワードを入力して検証してください。';
      status.textContent='';
    } else {
      restorePreview.textContent = '旧ZIPバックアップ。パスワードは不要です。「ファイルを検証」を押してください。';
    }
  } catch (error) {
    info(`ファイルを読み取れませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
    return;
  } finally { busy = false; updateButtons(); }
});
restorePassword.addEventListener('input', () => { resetPreview(); updateButtons(); });
verifyButton.addEventListener('click', async () => {
  const file = filePicker.files?.[0];
  if (!file || busy || (encryptedFile && !restorePassword.value)) return;
  await verifyRestore(file, encryptedFile ? restorePassword.value : undefined);
});
ack.addEventListener('change', updateButtons);
restoreButton.addEventListener('click', async () => {
  if (busy || !preview || !ack.checked || !initialSnapshot) return;
  const data = preview;
  const snapshot = {...initialSnapshot};
  const authorized=captureOperationAuthorization();
  const count=currentCount,sourceSnapshot=initialSnapshot;
  if (!await approveSettings({title:'本人用バックアップを置き換えて復元',subject:`現在 ${count}件 → バックアップ ${data.records.length}件`,details:['現在の明細を削除し、バックアップの全件で完全に置き換えます。','全明細とFinance連携を照合します。置換対象外の暗号化PDF原本は保全し、設定から別途整理できます。','現在のデータを別途バックアップしたことを確認してください。'],tone:'danger',acceptLabel:'置き換えて復元'},()=>!busy&&preview===data&&ack.checked&&initialSnapshot===sourceSnapshot&&currentCount===count,authorized)) return;
  busy = true; updateButtons(); info('全件復元中です。操作完了を確認してください…');
  try {
    await replaceAllRecords(data.records, snapshot,data.employers,authorized);finishOperation('success');
    if(authorized())recordNotification('restore-button','success');
    window.location.assign('../index.html');
  } catch (error) {
    // 別タブで変更されていた場合も、古い復元確認を再利用できないようにする。
    resetPreview();
    restorePreview.textContent = '復元を中断しました。バックアップの検証からやり直してください。';
    try { await refreshCount(); } catch { /* データの読み込み失敗は以下の詳細エラーを優先 */ }
    info(`復元が途中で停止しました。OneDriveの明細を確認してください: ${error instanceof Error ? error.message : String(error)}`, true);finishOperation('partial');
    busy = false; updateButtons();
  }
});
async function refreshBrowserKeyState():Promise<void>{
 const state=await currentBrowserRememberState();
 browserKeyStateValue=state;
 browserKeyState.textContent=state==='saved'?'このブラウザ：記憶済み':state==='missing'?'このブラウザ：未登録':'保存鍵を確認できません';
 updateButtons();
}
function describeAddPlan(plan:AdditiveRestorePreview):string{
 return `追加 ${plan.add}件 / 除外 ${plan.samePdf+plan.sameId+plan.samePeriod+plan.ambiguous+plan.backupConflict}件\n同じPDF ${plan.samePdf}件・同じID ${plan.sameId}件・同じ期間 ${plan.samePeriod}件・勤務先未確定 ${plan.ambiguous}件・バックアップ内競合 ${plan.backupConflict}件\n勤務先情報の追加 ${plan.employersAdded}件（既存名称・設定は維持）`;
}
addInspect.addEventListener('click',async()=>{
 if(busy||!preview)return;
 const data=preview;addPlan=undefined;addPlanAuthorized=undefined;busy=true;updateButtons();info('追加復元の対象を照合しています…');
 try{
  await cloudVault();const authorized=captureOperationAuthorization();
  const plan=await inspectAdditiveRestore(data.records,data.employers);
  if(!authorized()||preview!==data)throw new Error('バックアップが変更されました。');
  addPlan=plan;addPlanAuthorized=authorized;addPreview.textContent=describeAddPlan(plan);status.textContent='';finishOperation('success');
 }catch(error){addPreview.textContent='追加復元の検査を中断しました。';info(error instanceof Error?error.message:String(error),true);}
 finally{busy=false;updateButtons();}
});
addButton.addEventListener('click',async()=>{
 if(busy||!preview||!addPlan||!addPlanAuthorized?.()||!(addPlan.add||addPlan.employersAdded))return;
 const data=preview,plan=addPlan,authorized=addPlanAuthorized;
 if(!await approveSettings({title:'本人用バックアップを追加復元',subject:`明細 ${plan.add}件・勤務先 ${plan.employersAdded}件を追加`,details:[describeAddPlan(plan),'既存の明細は上書き・削除しません。',...(data.unreviewedWarnings?['旧データの検算未承認情報はそのまま保持します。']:[])],acceptLabel:'明細を追加復元'},()=>!busy&&preview===data&&addPlan===plan,authorized))return;
 busy=true;updateButtons();info('追加復元の対象を再検査しています…');
 try{
  const result=await restoreAdditiveRecords(data.records,plan.signature,data.employers,authorized,stage=>info(stage));
  await refreshCount();addPlan=undefined;addPlanAuthorized=undefined;ack.checked=false;
  addPreview.textContent=`追加復元完了：明細 ${result.add}件・勤務先 ${result.employersAdded}件。再確認する場合は対象を検査してください。`;
  status.textContent='';finishOperation('success');
 }catch(error){
  addPlan=undefined;addPlanAuthorized=undefined;ack.checked=false;
  addPreview.textContent='追加復元を中断しました。既に追加された明細がある可能性があります。最新の対象を確認してください。未参照PDFやFinance未同期がある場合は設定から復旧してください。';
  try{await refreshCount();}catch{ /* retain the original failure */ }
  info(`${addPreview.textContent} ${error instanceof Error?error.message:String(error)}`,true);finishOperation('partial');
 }finally{busy=false;updateButtons();}
});
browserKeyRegister.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 busy=true;updateButtons();browserKeyFeedback.textContent='現在のOneDrive索引と鍵を確認しています…';
 try{
  await rememberCurrentBrowser();
  browserKeyFeedback.textContent='このブラウザを記憶しました。次回から同じMicrosoftアカウントで自動解除できます。';
 }catch(error){browserKeyFeedback.textContent=`登録できませんでした：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;await refreshBrowserKeyState();updateButtons();}
})()});
browserKeyForget.addEventListener('click',()=>{void(async()=>{
 if(busy||browserKeyStateValue!=='saved')return;
 if(!await approveSettings({title:'このブラウザの記憶を解除',details:['このブラウザの保存鍵を削除し、開いているPayrollのすべてのタブをロックします。','次回は保管庫のパスフレーズで解除してください。'],tone:'warning',acceptLabel:'記憶を解除'},()=>!busy&&browserKeyStateValue==='saved'))return;
 busy=true;updateButtons();browserKeyFeedback.textContent='保存鍵を削除しています…';
 try{await forgetCurrentBrowser();busy=false;window.location.reload();}
 catch(error){browserKeyFeedback.textContent=`記憶を解除できませんでした：${error instanceof Error?error.message:String(error)}`;busy=false;await refreshBrowserKeyState();updateButtons();}
})()});

const cloudState=$<HTMLElement>('backup-cloud-status');
const cloudDiagnostic=$<HTMLElement>('backup-cloud-diagnostic');
const cloudLogin=$<HTMLButtonElement>('backup-cloud-login');
const cloudReconnect=$<HTMLButtonElement>('backup-cloud-reconnect');
const cloudLogout=$<HTMLButtonElement>('backup-cloud-logout');
const cloudId=$<HTMLInputElement>('backup-cloud-client-id');
const cloudSave=$<HTMLButtonElement>('backup-cloud-save');
$<HTMLElement>('backup-cloud-redirect-uri').textContent=cloudRedirectUri();
async function refreshCloudSettings():Promise<boolean>{
 const state=await cloudConnectionState();
 cloudId.value=state.clientId;
 $<HTMLDetailsElement>('backup-cloud-advanced').open=!state.clientId;
 cloudState.textContent=state.status==='connected'?`Microsoft認証済み · ${state.user??'Microsoftアカウント'}`:
  state.status==='reauth'?`${state.error??'Microsoftアカウントの再認証が必要です。'} · ${state.user??''}`:
  state.status==='temporary'?(state.error??'Microsoft認証を確認できませんでした。再接続してください。'):
  state.clientId?'Microsoftアカウントが未接続':'Client ID未設定';
 cloudState.dataset.error=String(state.status==='reauth'||state.status==='temporary');
 cloudDiagnostic.hidden=!state.diagnosticCode;
 cloudDiagnostic.textContent=state.diagnosticCode?`診断コード：${state.diagnosticCode}（認証情報・個人情報は含みません）`:'';
 cloudLogin.disabled=!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(state.clientId);
 cloudLogin.textContent=state.user?'別のアカウントに切り替え':'Microsoftに接続';
 cloudReconnect.hidden=state.status==='connected'||!state.clientId;
 cloudReconnect.disabled=busy||!state.clientId;
 cloudReconnect.textContent=state.status==='temporary'?'接続を再確認':'Microsoftに再接続';
 // MSAL may cache multiple identities even when none is selected.
 // Allow an explicit all-account sign-out whenever the Client ID is valid.
 const canSignOut=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(state.clientId);
 cloudLogout.hidden=!canSignOut;
 cloudLogout.disabled=busy||!canSignOut;
 return state.status==='connected';
}
cloudSave.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 cloudSave.disabled=true;
 try{
  const changed=await saveCloudClientId(cloudId.value);
  if(changed==='changed'){location.reload();return;}
  cloudState.textContent='Client IDは設定済みです。';
 }catch{
  // Client ID settings failures are not necessarily MSAL errors. Never echo raw
  // exceptions: local storage, worker and auth failures may include unsafe details.
  const malformed=!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cloudId.value.trim());
  cloudState.textContent=malformed
   ? 'Client IDの形式が正しくありません。UUID形式を入力してください。'
   : '接続設定を保存できませんでした。ページを再読み込みして再試行してください。';
  cloudState.dataset.error='true';
  cloudDiagnostic.hidden=malformed;
  cloudDiagnostic.textContent=malformed?'':'診断コード：AUTH_SETTINGS';
 }
 finally{cloudSave.disabled=false;}
})()});
cloudReconnect.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 cloudReconnect.disabled=true;
 try{await reconnectMicrosoftAccount();await refreshCloudSettings();}
 catch(error){const info=microsoftDiagnostic(error,typeof navigator!=='undefined'&&navigator.onLine===false);cloudState.textContent=info.message;cloudDiagnostic.hidden=false;cloudDiagnostic.textContent=`診断コード：${info.code}`;cloudState.dataset.error='true';}
 finally{cloudReconnect.disabled=false;}
})()});
cloudLogin.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 // This action locks ALL Payroll tabs, revokes in-memory keys and can discard unsaved edits.
 // Do not even start MSAL initialization or the lock flow before the user agrees.
 if(!await approveSettings({title:'Microsoftアカウントを切り替える',details:['開いているPayrollのすべてのタブをロックし、メモリ上の復号鍵を消去します。','他のタブの未保存の編集内容は失われます。保存を確認してください。'],tone:'warning',acceptLabel:'アカウントを切り替える'},()=>!busy&&!cloudLogin.disabled))return;
 cloudLogin.disabled=true;
 try{await chooseMicrosoftAccount();}
 catch(error){const info=microsoftDiagnostic(error,typeof navigator!=='undefined'&&navigator.onLine===false);cloudState.textContent=info.message;cloudDiagnostic.hidden=false;cloudDiagnostic.textContent=`診断コード：${info.code}`;cloudState.dataset.error='true';cloudLogin.disabled=false;}
})()});
let logoutRedirectReady=false;
cloudLogout.addEventListener('click',()=>{void(async()=>{
 if(busy||cloudLogout.disabled)return;
 if(!await approveSettings({title:'Microsoftからサインアウト',details:['このブラウザに記憶したPayrollの鍵をすべて削除します。','開いているPayrollのタブをロックし、Microsoftのサインアウト画面に移動します。'],tone:'warning',acceptLabel:'サインアウト'},()=>!busy&&!cloudLogout.disabled))return;
 busy=true;updateButtons();cloudLogout.disabled=true;
 cloudState.textContent='Payrollをロックし、鍵の消去を確認しています…';
 try{await signOutMicrosoftAccount(()=>{logoutRedirectReady=true;});}
 catch(error){
  logoutRedirectReady=false;busy=false;updateButtons();
  // Once the vault is locked, do not redisplay old decrypted DOM content.
  // A locked document must stay hidden; do not unmask salary data to display a modal.
  window.alert('サインアウトを完了できませんでした。Payrollはロックしたまま再読み込みします。\n鍵の削除が確認できなかった場合は、再読み込み後にもう一度サインアウトを実行してください。');
  window.location.reload();
 }
})()});
// 旧DBが見つかればクラウド解除の自動開始を避け、ローカルの整理を優先する。
// 明細を読み込みたい場合だけ、利用者が明示的にOneDrive読み込みを開始する。
cloudLoad.addEventListener('click',()=>{void(async()=>{
 if(busy||loadedDb)return;
 cloudLoad.disabled=true;
 exportSummary.textContent='OneDriveの明細を読み込んでいます…';
 try{await refreshCount();cloudLoad.hidden=true;finishOperation('success');}
 catch(error){
  exportSummary.textContent='OneDrive明細を読み込めませんでした。';
  info(error instanceof Error?error.message:String(error),true);
 }finally{cloudLoad.disabled=false;updateButtons();}
})()});
appStatus.loading('設定を確認しています…');
void(async()=>{
 let legacyExists=false;
 try{legacyExists=(await inspectLegacyIndexedDb()).exists;}
 catch{ /* 旧DB確認が非対応なら従来どおりクラウド情報を表示する。 */ }
 if(legacyExists){
  cloudLoad.hidden=false;
  exportSummary.textContent='旧ブラウザ保存データがあります。必要に応じて移行・整理してください。';
  updateButtons();
 }
 const connected=await refreshCloudSettings();
 void refreshBrowserKeyState();
 if(legacyExists){appStatus.clear();return;}
 if(!connected){exportSummary.textContent='Microsoftに接続すると明細件数を確認できます。';appStatus.clear();return;}
 await refreshCount();updateButtons();if(!busy&&appStatus.element.dataset.state==='loading')appStatus.clear();
})().catch(error=>{
 exportSummary.textContent='保存済みデータを確認できませんでした。';
 info(error instanceof Error?error.message:'OneDriveのデータを取得できませんでした。',true);
 updateButtons();
});

// Existing saved salaries can be republished without editing or duplicating their PDF records.
orphanCheck.addEventListener('click',()=>{void(async()=>{
 if(busy)return;busy=true;orphanYears=undefined;orphanRecover.hidden=true;updateButtons();
 orphanStatus.textContent='OneDriveの索引未登録年度を検査しています…';
 try {
  const vault=await cloudVault();
  orphanYears=await vault.inspectOrphanYears();
  orphanStatus.textContent=orphanYears.length
   ? `孤立した年度：${orphanYears.map(v=>`${v.year}年度（${v.records}件${v.records===0?"・空の年度ファイル":""}）`).join('、')}。内容を確認してから復旧してください。`
   : '索引未登録の明細データは見つかりませんでした。';
  orphanRecover.hidden=!orphanYears.length;finishOperation('success');
 }catch(error){finishOperation('error');orphanStatus.textContent=`検査できませんでした：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
orphanRecover.addEventListener('click',()=>{void(async()=>{
 if(busy||!orphanYears?.length)return;
 const expected=orphanYears;
 if(!await approveSettings({title:'年度索引を復旧',subject:`対象：${expected.length}年度`,details:[...expected.map(v=>`${v.year}年度（${v.records}件${v.records===0?'・空の年度ファイル':''}）`),'暗号化ファイルを照合して年度索引に追加し、収入情報を同期します。'],tone:'warning',acceptLabel:'年度索引を復旧'},()=>!busy&&orphanYears===expected))return;
 busy=true;updateButtons();orphanStatus.textContent='年度索引を復旧しています…';
 try{
  const vault=await cloudVault();
  const count=await vault.recoverOrphanYears(expected);
  orphanYears=undefined;orphanRecover.hidden=true;
  orphanStatus.textContent=`${count}年度を復旧しました。最新の明細一覧を確認してください。`;
  loadedDb=false;await refreshCount();finishOperation('success');
 }catch(error){finishOperation('partial');orphanYears=undefined;orphanRecover.hidden=true;orphanStatus.textContent=`復旧を完了できませんでした。年度索引が一部更新済みの可能性があります：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
$<HTMLButtonElement>('payroll-income-publish').addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 busy=true;updateButtons();
 const label=$<HTMLElement>('payroll-income-publish-status');
 label.textContent='保存済み明細を確認して、収入情報を暗号化して更新しています…';
 try{
  const vault=await cloudVault();
  await vault.syncIncome();
  label.textContent='全年度のFinance連携データを更新・読み戻し照合しました。';finishOperation('success');
 }catch(error){finishOperation('error');label.textContent=`連携データの更新に失敗しました：${error instanceof Error?error.message:'通信エラー'}`;}
 finally{busy=false;updateButtons();}
})()});

// 表示状態は入力欄ごとに独立。パスワード値をログ・保存領域に出さない。
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-toggle-password]'))) {
  const targetId = button.dataset.togglePassword;
  const target = targetId ? document.getElementById(targetId) : null;
  if (!(target instanceof HTMLInputElement)) continue;
  button.addEventListener('click', () => {
    const visible = target.type === 'password';
    target.type = visible ? 'text' : 'password';
    button.textContent = visible ? '隠す' : '表示';
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? 'パスワードを隠す' : 'パスワードを表示');
  });
}

const migrateButton=document.querySelector<HTMLButtonElement>('#migrate-legacy-cloud');
const migrateStatus=document.querySelector<HTMLElement>('#migrate-legacy-cloud-status');
migrateButton?.addEventListener('click',()=>{void(async()=>{
 if(!migrateStatus||busy)return;
 if(!await approveSettings({title:'旧ブラウザ保存データを移行',details:['旧ブラウザ保存データをOneDriveへ移行します。','移行前のバックアップを保管したことを確認してください。'],tone:'warning',acceptLabel:'移行を開始'}))return;
 busy=true;updateButtons();
 try{
  const result=await migrateFromLegacyIndexedDb(message=>{migrateStatus.textContent=message;});
  migrateStatus.textContent=`旧データ ${result.found}件中、新規に${result.migrated}件を移行しました。旧ブラウザ保存データは保持しています。`;
  await refreshCount();finishOperation('success');
 }catch(error){finishOperation('partial');migrateStatus.textContent=`移行を中断しました：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
 })();});

// データ書換中はタブを閉じる前に確認。ページ遷移ではロックと転送状況を守る。
window.addEventListener('beforeunload',event=>{
 if(busy&&!logoutRedirectReady){event.preventDefault();event.returnValue='';}
});
changeButton.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 if(changeNew.value!==changeConfirm.value){changeStatus.textContent='新しいパスフレーズが一致しません。';return;}
 if([...changeCurrent.value].length<12||[...changeNew.value].length<12){changeStatus.textContent='現在・新しいパスフレーズを12文字以上で入力してください。';return;}
 if(changeCurrent.value===changeNew.value){changeStatus.textContent='現在と異なるパスフレーズを指定してください。';return;}
 if(!changeAck.checked){changeStatus.textContent='バックアップと他タブの終了を確認してください。';return;}
 const currentPass=changeCurrent.value,newPass=changeNew.value;
 if(!await approveSettings({title:'保管庫のパスフレーズを変更',details:['OneDriveの全暗号ファイルを新しい鍵へ移行します。','完了まで画面移動はできません。バックアップと他タブの終了を確認してください。'],tone:'warning',acceptLabel:'鍵の変更を開始'},()=>!busy&&changeAck.checked&&changeCurrent.value===currentPass&&changeNew.value===newPass&&changeConfirm.value===newPass))return;
 busy=true;updateButtons();
 const started=performance.now();let stage='変更の準備中…';
 const report=()=>{changeStatus.textContent=`${stage}（経過 ${Math.round((performance.now()-started)/1000)}秒）`;};
 const timer=setInterval(report,1000);
 try{
  const vault=await cloudVault();
  clearNavigationSnapshot();
  await vault.changePassphrase(currentPass,newPass,value=>{stage=value;report();});
  // 移行はこの時点でOneDriveに確定済み。旧タブ鍵を消し、メモリ鍵を更新する。
  changeCurrent.value='';changeNew.value='';changeConfirm.value='';changeAck.checked=false;
  let remembered:'updated'|'not-registered'|'storage-warning';
  try{remembered=await refreshSessionAfterKeyRotation();notificationScope=appStatus.begin('change-passphrase-button');}
  catch{changeStatus.textContent='OneDriveの変更は完了しました。セッションの引継ぎに失敗したため、次回は新しいパスフレーズで解除してください。';finishOperation('partial');return;}
  changeStatus.textContent=remembered==='updated'?'パスフレーズを変更し、このブラウザの記憶鍵も更新しました。':
   remembered==='storage-warning'?'パスフレーズの変更は完了しましたが、ブラウザ記憶の更新・削除を確認できませんでした。設定から確認してください。':
   'パスフレーズを変更しました。次回の解除には新しいパスフレーズを使用してください。';
  finishOperation(remembered==='storage-warning'?'partial':'success');
  await refreshBrowserKeyState();
 }catch(error){finishOperation('partial');changeStatus.textContent=`変更を完了できませんでした: ${error instanceof Error?error.message:String(error)}`;}
 finally{clearInterval(timer);busy=false;updateButtons();}
})()});

cloudCheck.addEventListener('click',()=>{void(async()=>{
 if(busy)return;oldCloudPlan=undefined;cloudDelete.hidden=true;busy=true;updateButtons();
 cloudStatus.textContent='OneDriveの旧暗号領域を確認しています…';
 try{
  const vault=await cloudVault();
  const plan=await vault.inspectOldEncryptedData();
  oldCloudPlan=plan;
  cloudStatus.textContent=plan.targets.length?`旧暗号フォルダー ${plan.targets.length}件 / 暗号ファイル ${plan.files}件（約${sizes(plan.bytes)}）。現行の保存世代は対象外です。`:'整理できる旧暗号データはありません。';
  cloudDelete.hidden=!plan.targets.length;finishOperation('success');
 }catch(error){finishOperation('error');const message=error instanceof Error?error.message:String(error);cloudStatus.textContent=message.includes('が現行世代にありません')?`${message} 直前に原本をごみ箱へ移動した場合は、OneDriveで現行原本を復元し、未参照PDFを再検査してください。`:message;}
 finally{busy=false;updateButtons();}
})()});
cloudDelete.addEventListener('click',()=>{void(async()=>{
 if(busy||!oldCloudPlan)return;
 const plan=oldCloudPlan;
 if(!await approveSettings({title:'旧暗号データを整理',subject:`旧暗号フォルダー ${plan.targets.length}件`,details:['現行データ・PDFと確定済み原本整理履歴を照合してからOneDriveのごみ箱へ移動します。原本の欠落や履歴不一致がある場合は停止します。','ごみ箱には古いパスフレーズで開けるファイルが残ります。','暗号化バックアップを別途保存し、他タブを閉じたことを確認してください。'],tone:'danger',requiredText:'整理',acceptLabel:'ごみ箱へ移動'},()=>!busy&&oldCloudPlan===plan))return;
 oldCloudPlan=undefined;cloudDelete.hidden=true;busy=true;updateButtons();
 try{
  const vault=await cloudVault();
  const count=await vault.cleanupOldEncryptedData(plan,text=>{cloudStatus.textContent=text;});
  cloudStatus.textContent=`旧暗号フォルダー ${count}件をごみ箱に移動しました。完全に消す場合はOneDriveのごみ箱も空にしてください。`;finishOperation('success');
 }catch(error){finishOperation('partial');cloudStatus.textContent=`途中で停止しました。残りの対象を再確認してください：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
// 暗号化原本の管理は本人用のみ。どの操作も最新年度・索引・原本ETagを再検証する。
function clearDetachedReport():void{detachedReport=undefined;detachedPage=0;detachedList.replaceChildren();}
function detachedItemLabel(item:DetachedOriginal):string{return `${item.month} / ${item.uuid.slice(0,8)}… / ${sizes(item.size)}`;}
async function downloadDetached(item:DetachedOriginal,report:DetachedOriginalReport):Promise<void>{
  const vault=await cloudVault();
  const pdf=await vault.retrieveDetachedOriginal(report,item);
  const link=document.createElement('a');
  const url=URL.createObjectURL(pdf);
  try{
    link.href=url;link.download=`payroll-unreferenced-${item.month}-${item.uuid}.pdf`;
    document.body.append(link);link.click();link.remove();
  }finally{setTimeout(()=>URL.revokeObjectURL(url),30_000);}
}
function renderDetachedReport(report:DetachedOriginalReport):void{
  detachedList.replaceChildren();
  const pages=Math.ceil(report.originals.length/200);
  detachedPage=Math.min(detachedPage,Math.max(0,pages-1));
  for(const item of report.originals.slice(detachedPage*200,(detachedPage+1)*200)){
    const row=document.createElement('li');row.className='detached-original-row';
    const name=document.createElement('span');name.textContent=detachedItemLabel(item);
    const actions=document.createElement('div');actions.className='detached-original-actions';
    const retrieve=document.createElement('button');retrieve.type='button';retrieve.className='btn btn--secondary';retrieve.textContent='PDFを回収';
    retrieve.addEventListener('click',()=>{void(async()=>{
      if(busy||!detachedReport)return;
      busy=true;updateButtons();detachedStatus.textContent='原本を復号・検証しています…';
      try{await downloadDetached(item,report);detachedStatus.textContent='PDFをダウンロードしました。再登録する場合はアップロード画面から取り込んでください。';}
      catch(error){clearDetachedReport();detachedStatus.textContent=`原本の回収に失敗しました。再検査してください：${error instanceof Error?error.message:String(error)}`;}
      finally{busy=false;updateButtons();}
    })();});
    const trash=document.createElement('button');trash.type='button';trash.className='btn btn--danger-outline';trash.textContent='ごみ箱へ移動';
    trash.addEventListener('click',()=>{void(async()=>{
      if(busy||!detachedReport)return;
      if(!await approveSettings({title:'未参照PDF原本を整理',subject:detachedItemLabel(item),details:['現在の本人明細から参照されていないPDFをOneDriveのごみ箱へ移動します。','削除済み明細の原本だけでなく、保存中断で残ったPDFの可能性もあります。旧世代にある同じ原本の情報は暗号化索引に記録し、別途確認した旧世代整理に利用します。','Finance連携が最新であることを照合します。未同期の場合は再生成後に再検査してください。','バックアップを別途保存したことを確認してください。'],tone:'danger',requiredText:'原本整理',acceptLabel:'ごみ箱へ移動'},()=>!busy&&detachedReport===report))return;
      busy=true;updateButtons();detachedStatus.textContent='参照先と原本の内容を再検証しています…';
      try{
        const vault=await cloudVault();
        await vault.trashDetachedOriginal(report,item);
        clearDetachedReport();
        detachedStatus.textContent='PDF原本をごみ箱へ移動しました。完全消去が必要ならOneDrive側のごみ箱も確認してください。残りの原本を見るには再検査してください。';
      }catch(error){clearDetachedReport();detachedStatus.textContent=`原本整理を中断しました。Finance連携を確認し、最新の状態を再検査してください：${error instanceof Error?error.message:String(error)}`;}
      finally{busy=false;updateButtons();}
    })();});
    actions.append(retrieve,trash);row.append(name,actions);detachedList.append(row);
  }
  if(pages>1){
    const pager=document.createElement('li');pager.className='detached-original-pager';
    const prev=document.createElement('button');prev.type='button';prev.className='btn btn--secondary';prev.textContent='前の200件';prev.disabled=detachedPage===0;
    const next=document.createElement('button');next.type='button';next.className='btn btn--secondary';next.textContent='次の200件';next.disabled=detachedPage>=pages-1;
    const current=document.createElement('span');current.textContent=`${detachedPage+1} / ${pages}ページ`;
    prev.addEventListener('click',()=>{detachedPage--;renderDetachedReport(report);});
    next.addEventListener('click',()=>{detachedPage++;renderDetachedReport(report);});
    pager.append(prev,current,next);detachedList.append(pager);
  }
}
detachedCheck.addEventListener('click',()=>{void(async()=>{
  if(busy)return;
  clearDetachedReport();busy=true;updateButtons();detachedStatus.textContent='OneDriveの全年度と暗号化PDF原本を照合しています…';
  try{
    const vault=await cloudVault();
    const report=await vault.inspectDetachedOriginals();
    detachedReport=report;renderDetachedReport(report);
    detachedStatus.textContent=report.originals.length
      ?`未参照の暗号化PDF原本 ${report.originals.length}件（${sizes(report.originals.reduce((sum,item)=>sum+item.size,0))}）。削除済み明細・中断した保存の区別はできません。${report.originals.length>200?'200件ずつ表示します。':''}`
      :'未参照の暗号化PDF原本はありません。';finishOperation('success');
  }catch(error){finishOperation('error');clearDetachedReport();detachedStatus.textContent=`原本を検査できませんでした：${error instanceof Error?error.message:String(error)}`;}
  finally{busy=false;updateButtons();}
})()});
// 旧DBは任意検査可能。削除時はOneDriveの全件照合に成功した場合のみ実行する。
localCheck.addEventListener('click',()=>{void(async()=>{
 if(busy)return;busy=true;updateButtons();
 localStatus.textContent='旧ブラウザ保存データを確認しています…';
 try{
  const result=await inspectLegacyIndexedDb();
  finishOperation('success');localStatus.textContent=result.exists?`旧ブラウザ保存データ：${result.count}件。削除前にOneDriveの全明細・PDF原本を照合します。`:'旧ブラウザ保存データはありません。';
 }catch(error){finishOperation('error');localStatus.textContent=`旧データを確認できませんでした：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
localDelete.addEventListener('click',()=>{void(async()=>{
 if(busy)return;const authorized=captureOperationAuthorization();busy=true;updateButtons();
 try{
  // 誤って空の新規DBを作らず、既存の旧DBだけを列挙する。
  const result=await inspectLegacyIndexedDb();
  if(!result.exists){localStatus.textContent='旧ブラウザ保存データはありません。';finishOperation('success');return;}
  if(!await approveSettings({title:'旧ブラウザ保存データを削除',subject:`旧明細 ${result.count}件`,details:['削除前にOneDriveへの移行済みデータとPDF原本をすべて照合します。一致しない場合は削除しません。','バックアップを確認してください。'],tone:'danger',acceptLabel:'旧データを削除'},()=>busy,authorized)){cancelOperation();return;}
  await verifyLegacyIndexedDbCloudBeforeDelete(result.count,text=>{localStatus.textContent=text;});
  if(!authorized()){cancelOperation();return;}
  const deleted=await deleteLegacyIndexedDb(result.count,text=>{localStatus.textContent=text;});
  localStatus.textContent=`旧ブラウザ保存データを削除しました（${deleted}件）。OneDriveやMicrosoftの接続情報は変更していません。`;finishOperation('success');
 }catch(error){finishOperation('partial');localStatus.textContent=`旧データは削除できませんでした：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});

// Year-end records belong to a separate, encrypted OneDrive namespace. Never mix
// their restore action with personal payroll's destructive replaceAllRecords().
function invalidateYearEndPreview(message='暗号化バックアップを選択してください。'){
 yearEndResume.hidden=true;yearEndRecheck.hidden=true;yearEndDiagnosis.hidden=true;yearEndDiagnosis.textContent='';
 yearEndPreview=undefined;yearEndPlan=undefined;yearEndPreviewLabel.textContent=message;
 yearEndPeople.hidden=true;yearEndPeopleList.replaceChildren();
 updateButtons();
}
yearEndFile.addEventListener('change',()=>invalidateYearEndPreview());
yearEndRestorePassword.addEventListener('input',()=>invalidateYearEndPreview('パスワードを入力し、ファイルを検証してください。'));
function reportYearEnd(message:string){yearEndStatus.textContent=message;}
async function diagnoseIncompleteYearEndRestore(backup:YearEndBackupData,context:'failure'|'manual'='failure'):Promise<boolean>{
 yearEndResume.hidden=true;yearEndDiagnosis.hidden=false;
 try{
  const report=await yearEndRepo.inspectRestoreOrphans(backup);
  if(!report.items.length){
   yearEndDiagnosis.textContent=context==='manual'
    ?'索引未登録の従業員フォルダーは見つかりませんでした。従業員別の復元対象を確認してください。'
    :'索引未登録の従業員フォルダーは見つかりませんでした。ネットワーク・競合状態を確認し、バックアップを再検証してください。';
   return true;
  }
  const lines=report.items.slice(0,20).map(item=>
   `・${item.label}［ID: ${item.id}］（${item.state==='deleted'?'削除済み':item.state==='deleting'?'削除途中':item.state==='unexpected'?'不明な項目':'索引未登録'}）: 原本 ${item.originals}件、年度 ${item.yearFiles}件、プロフィール ${item.profile?'あり':'なし'}${item.inBackup?' / 選択したバックアップに含まれる':' / 選択したバックアップに含まれない'}${item.unexpectedFiles?' / 想定外の項目あり':''}`);
  yearEndDiagnosis.textContent=`保存途中とみられる従業員フォルダー ${report.items.length}件を検出しました。\n${lines.join('\n')}${report.items.length>20?'\nほかの項目もあります。':''}\n\n暗号化ファイルは削除・上書きしていません。バックアップ原本を保管してください。`+
   (report.canAttemptResume?'\n保存途中のデータが見つかりました。同じバックアップを使って復元を再開できます。再開時にすべてのファイルを照合し、一致しない場合は変更せず中断します。':'\n安全に再開できないデータがあります。自動再開せず、OneDriveの年末調整領域を確認してください。手動削除はしないでください。');
  yearEndResume.hidden=!report.canAttemptResume;
  return true;
 }catch(error){
  yearEndDiagnosis.textContent=`保存状態の確認に失敗しました：${error instanceof Error?error.message:'通信エラー'}。ファイルは自動削除していません。バックアップ原本を保管してください。`;
  return false;
 }finally{updateButtons();}
}

function yearEndError(error:unknown){
 const message=error instanceof Error?error.message:'操作に失敗しました。';
 reportYearEnd(`処理を完了できませんでした：${message}`);
}
yearEndExport.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 if(yearEndPassword.value!==yearEndConfirm.value){reportYearEnd('バックアップ用パスワードが一致しません。');return;}
 if([...yearEndPassword.value].length<12){reportYearEnd('パスワードは12文字以上にしてください。');return;}
 busy=true;updateButtons();reportYearEnd('OneDriveの従業員情報・原本PDFを検証しています…');
 try{
  const data=await yearEndRepo.exportBackupSnapshot(reportYearEnd);
  reportYearEnd('年末調整バックアップZIPを構築・暗号化しています…');
  const zip=await createYearEndBackup(data);
  const encrypted=await encryptBackup(zip,yearEndPassword.value);
  const stamp=new Date().toISOString().replace(/[:.]/g,'').replace('T','-').slice(0,15);
  const url=URL.createObjectURL(encrypted);
  const anchor=document.createElement('a');anchor.href=url;anchor.download=`payroll-year-end-${stamp}.payroll`;
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);
  yearEndPassword.value='';yearEndConfirm.value='';
  reportYearEnd(`従業員 ${data.persons.length}名、原本 ${data.persons.reduce((n,p)=>n+p.originals.length,0)}件の暗号化バックアップを生成しました（${sizes(encrypted.size)}）。ファイルが保存されたことを確認してください。`);finishOperation('success');
 }catch(error){finishOperation('error');yearEndError(error);}
 finally{busy=false;updateButtons();}
})()});
yearEndVerify.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 const file=yearEndFile.files?.[0];if(!file)return;
 invalidateYearEndPreview('バックアップ内容を検証しています…');
 busy=true;updateButtons();reportYearEnd('年末調整のバックアップを復号・検証しています…');
 try{
  if(!await isEncryptedBackup(file))throw new Error('暗号化された.payrollファイルだけを受け付けます。');
  const decoded=await decryptBackup(file,yearEndRestorePassword.value);
  const data=await readYearEndBackup(decoded);
  const plan=await yearEndRepo.previewBackupRestore(data);
  yearEndPreview=data;yearEndRestorePassword.value='';
  showYearEndPlan(plan);
  // A browser crash loses the previous diagnosis; allow read-only inspection after any valid backup.
  yearEndRecheck.hidden=false;
  const pdfs=data.persons.reduce((n,p)=>n+p.originals.length,0);
  const years=data.persons.reduce((n,p)=>n+p.years.length,0);
  yearEndPreviewLabel.textContent=`検証済み：従業員 ${data.persons.length}名、年度 ${years}件、原本PDF ${pdfs}件。作成日時 ${new Date(data.exportedAt).toLocaleString('ja-JP')}。`+
   (plan.canRestore?(plan.restorable?`復元対象は${plan.restorable}名です。`:'復元対象の従業員はいません。'):'OneDriveに未完了・不整合の可能性があるため、復元を開始できません。')+
   (plan.sameNameCollisions?`同名の別データが${plan.sameNameCollisions}名追加されます。従業員別一覧を確認してください。`:'');
  if(!plan.canRestore){yearEndRecheck.hidden=false;await diagnoseIncompleteYearEndRestore(data);}
  reportYearEnd(plan.canRestore?'バックアップの完全性検査が完了しました。':'バックアップは検証済みです。OneDriveの保存状態を確認してください。');finishOperation(plan.canRestore?'success':'partial');
 }catch(error){finishOperation('error');yearEndError(error);invalidateYearEndPreview('バックアップの検証に失敗しました。OneDriveのデータは変更していません。');}
 finally{busy=false;updateButtons();}
})()});
yearEndCommit.addEventListener('click',()=>{void(async()=>{
 if(busy||!yearEndPreview||!yearEndPlan?.canRestore||!yearEndPlan.restorable)return;
 const data=yearEndPreview;
 const plan=yearEndPlan;
 if(!await approveSettings({title:'年末調整の従業員を追加復元',subject:`復元 ${plan.restorable}名・登録済み ${plan.skipped}名は維持`,details:[...(plan.sameNameCollisions?[`注意：同名の別データが${plan.sameNameCollisions}名追加されます。`]:[]),'登録済み従業員は上書きせず、未登録・削除済みの従業員だけを追加します。','索引不整合・孤立ファイルがあれば中止します。'],tone:'warning',acceptLabel:'従業員を追加復元'},()=>!busy&&yearEndPreview===data&&yearEndPlan===plan))return;
 busy=true;updateButtons();reportYearEnd('従業員データの復元を開始しています…');
 try{
  const result=await yearEndRepo.restoreBackupSnapshot(data,reportYearEnd);
  invalidateYearEndPreview('復元完了。年末調整画面から内容を確認してください。');
  yearEndFile.value='';reportYearEnd(`従業員 ${result.restored}名を復元しました（既存の ${result.skipped}名は変更なし）。`);finishOperation('success');
 }catch(error){finishOperation('partial');
  yearEndRecheck.hidden=false;yearEndPlan=undefined;
  yearEndPreviewLabel.textContent='復元は完了していません。下の保存状況を確認してください。';
  yearEndError(error);
  await diagnoseIncompleteYearEndRestore(data);
 }
 finally{busy=false;updateButtons();}
})()});
yearEndResume.addEventListener('click',()=>{void(async()=>{
 if(busy||!yearEndPreview||yearEndResume.hidden)return;
 const data=yearEndPreview;
 if(!await approveSettings({title:'従業員データの復元を再開',details:['保存途中の暗号化ファイルを選択中のバックアップとすべて照合します。','一致するファイルは利用し、不足分のみ新規保存して、最後に従業員索引へ登録します。','一致しないファイル・未知の項目があれば書き込まず停止します。'],tone:'warning',acceptLabel:'復元を再開'},()=>!busy&&yearEndPreview===data&&!yearEndResume.hidden))return;
 busy=true;updateButtons();reportYearEnd('復元途中のデータを照合しています…');
 try{
  const result=await yearEndRepo.restoreBackupSnapshot(data,reportYearEnd,{resumeVerifiedOrphans:true});
  invalidateYearEndPreview('復元完了。年末調整画面から内容を確認してください。');
  yearEndFile.value='';reportYearEnd(`従業員 ${result.restored}名の復元を完了しました（既存の ${result.skipped}名は変更なし）。`);finishOperation('success');
 }catch(error){finishOperation('partial');yearEndRecheck.hidden=false;yearEndError(error);await diagnoseIncompleteYearEndRestore(data);}
 finally{busy=false;updateButtons();}
})()});

// Available after backup verification, including after browser restart. Read-only: never retries the restore.
yearEndRecheck.addEventListener('click',()=>{void(async()=>{
 if(busy||!yearEndPreview||yearEndRecheck.hidden)return;
 busy=true;yearEndResume.hidden=true;yearEndPlan=undefined;
 updateButtons();reportYearEnd('OneDriveの復元状態を確認しています…');
 try{
  const data=yearEndPreview;
  const plan=await yearEndRepo.previewBackupRestore(data);
  showYearEndPlan(plan);
  const inspected=await diagnoseIncompleteYearEndRestore(data,'manual');
  if(!inspected){
   // A read failure cannot confirm a safe restore plan.
   yearEndPlan=undefined;
   reportYearEnd('OneDriveの復元状態を確認できませんでした。通信状態を確認して再試行してください。');
  }else if(plan.canRestore){
   reportYearEnd('復元状態を確認しました。最新の復元対象を確認してから操作してください。');
  }else reportYearEnd('安全に復元を開始できないデータがあります。診断結果を確認してください。');
 }catch(error){yearEndPlan=undefined;yearEndResume.hidden=true;yearEndError(error);}
 finally{busy=false;updateButtons();}
})()});

// Employer names stay in the unlocked page and encrypted index. No browser storage or console output.
employerDirectoryTarget.addEventListener('change',fillEmployerDraft);
employerDirectoryAdd.addEventListener('click',()=>{if(busy||!employers)return;employerDirectoryTarget.value='';fillEmployerDraft();employerDirectoryForm.hidden=false;employerDirectoryName.focus();});
employerDirectoryCancel.addEventListener('click',()=>{if(busy)return;employerDirectoryForm.hidden=true;employerDirectoryTarget.value='';fillEmployerDraft();employerDirectoryAdd.focus();});
employerDirectoryName.addEventListener('input',updateEmployerButtons);
employerDirectoryRole.addEventListener('change',()=>{
 fillEmployerForecast(defaultEmployerForecast(employerDirectoryRole.value==='side'?'side':'main'));
 updateEmployerButtons();
});
employerForecastSettings.addEventListener('change',updateEmployerButtons);
// Use the directory from the same authenticated index as the annual records.
async function readEmployerSnapshot(vault:Awaited<ReturnType<typeof cloudVault>>,authorized:()=>boolean){
 let list:EmployerEntry[]|undefined;
 const records=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,onEmployerDirectory:value=>{list=value;}});
 if(!list||!authorized()||employerDirectorySignature(await vault.readEmployerDirectory())!==employerDirectorySignature(list)||!authorized())throw new Error('勤務先一覧の確認中に状態が変更されました。');
 return {list,records};
}
// Never replay the failed write or its consent. Restore controls only from a
// fresh authenticated snapshot; unknown write locks are not released here.
async function recoverEmployerDirectory(authorized:()=>boolean,detail:string,target=''):Promise<void>{
 employers=undefined;legacyDirectory=[];bulkRecords=[];bulkAuthorized=undefined;renderEmployerDirectory();
 employerDirectoryStatus.textContent=authorized()?detail+' 最新状態を確認しています…':'認証状態が変更されました。';
 try{
  if(!authorized())throw new Error('認証状態が変更されました。');
  const vault=await tryResumeCloudVault();
  if(!vault||!authorized())throw new Error('認証状態が変更されました。');
  const {list,records}=await readEmployerSnapshot(vault,authorized);
  if(!authorized())throw new Error('認証状態が変更されました。');
  employers=list;legacyDirectory=legacyEmployers(records,list);bulkRecords=records;bulkAuthorized=authorized;renderEmployerDirectory();
  if(list.some(e=>e.id===target)){bulkTarget.value=target;renderBulkList();}
  employerDirectoryLoad.textContent='更新';
  employerDirectoryStatus.textContent=detail+' 最新の一覧を反映しました。';
 }catch{
  employerDirectoryLoad.textContent='再読み込み';
  employerDirectoryStatus.textContent=authorized()?detail+' 勤務先一覧を更新し、保存結果を確認してください。':'認証状態が変更されました。勤務先一覧を読み直してください。';
 }
}
async function loadEmployerDirectory(allowPrompt:boolean):Promise<void>{
 if(busy)return;
 if(!allowPrompt){currentOperation=null;operationResult=null;operationCancelled=false;}
 const authorized=captureOperationAuthorization();
 busy=true;employers=undefined;legacyDirectory=[];bulkRecords=[];bulkAuthorized=undefined;renderEmployerDirectory();updateButtons();
 try{
  employerDirectoryStatus.textContent='勤務先一覧を読み込んでいます…';
  const vault=allowPrompt?await cloudVault():await tryResumeCloudVault();
  if(!authorized())throw new Error('認証状態が変更されました。');
  if(!vault){employerDirectoryLoad.textContent='保管庫を開く';employerDirectoryStatus.textContent='勤務先を管理するには保管庫を開いてください。';return;}
  const {list,records}=await readEmployerSnapshot(vault,authorized);
  if(!authorized())throw new Error('認証状態が変更されました。');
  employers=list;legacyDirectory=legacyEmployers(records,list);bulkRecords=records;bulkAuthorized=authorized;renderEmployerDirectory();
  employerDirectoryLoad.textContent='更新';
  employerDirectoryStatus.textContent=`登録済み ${list.length}件・名称未設定 ${legacyDirectory.length}件`;finishOperation('success');
 }catch{employerDirectoryLoad.textContent='再読み込み';employerDirectoryStatus.textContent='勤務先一覧を読み込めませんでした。もう一度お試しください。';finishOperation('error');}
 finally{busy=false;updateButtons();}
}
employerDirectoryLoad.addEventListener('click',()=>{void loadEmployerDirectory(true);});
employerDirectoryForm.addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!employers||employerDirectorySave.disabled)return;
 // Enter submission also sets an explicit operation, rather than inheriting a previous click.
 currentOperation=operations['employer-directory-save'];operationResult=null;operationCancelled=false;
 const expected=employers,selected=employerDirectoryTarget.value,existing=expected.find(x=>x.id===selected),legacy=legacyDirectory.find(x=>x.id===selected);
 if(selected&&!existing&&!legacy)return;
 const role=employerDirectoryRole.value;
 if((role!=='main'&&role!=='side')||(existing&&existing.role!==role)||(legacy&&!legacy.roles.includes(role)))return;
 let next:EmployerEntry[];
 try{
  const forecast=draftEmployerForecast();
  // Keep untouched defaults in the old four-field format. Explicit choices travel with the employer.
  const custom=!!existing?.forecast||JSON.stringify(forecast)!==JSON.stringify(defaultEmployerForecast(role));
  next=upsertEmployer(expected,{id:selected||createEmployerId(),name:employerDirectoryName.value.trim(),role,current:employerDirectoryCurrent.checked,...(custom?{forecast}:{})});
 }
 catch{employerDirectoryStatus.textContent='表示名・見込み設定・勤務先の件数を確認してください。';appStatus.warning(employerDirectoryStatus.textContent);return;}
 const authorized=captureOperationAuthorization();
 busy=true;updateButtons();
 try{
  const vault=await cloudVault();
  if(!authorized())throw new Error('認証状態が変わりました。');
  if(legacy){const records=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});if(!legacyEmployers(records,expected).some(x=>x.id===legacy.id&&x.roles.includes(role)))throw new Error('既存明細が更新されました。');}
  if(!authorized())throw new Error('認証状態が変わりました。');
  const saved=await vault.writeEmployerDirectory(expected,next);
  if(!authorized())throw new Error('認証状態が変わりました。');
  employers=saved;legacyDirectory=legacyDirectory.filter(x=>!saved.some(y=>y.id===x.id));renderEmployerDirectory();
  employerDirectoryStatus.textContent='勤務先を保存しました。';finishOperation('success');
 }catch{await recoverEmployerDirectory(authorized,'勤務先の保存結果を確認できませんでした。');finishOperation('error');}
 finally{busy=false;updateButtons();}
});

bulkTarget.addEventListener('change',()=>{bulkSelected.clear();bulkStatus.textContent='';renderBulkList();});
bulkAll.addEventListener('click',()=>{if(busy||!bulkAuthorized?.())return;for(const r of bulkCandidates())bulkSelected.add(r.id);renderBulkList();});
bulkNone.addEventListener('click',()=>{if(busy)return;bulkSelected.clear();renderBulkList();});
bulkSave.addEventListener('click',async()=>{
 if(busy||bulkSave.disabled||!employers||!bulkAuthorized?.())return;
 const authorized=bulkAuthorized,entry=employers.find(e=>e.id===bulkTarget.value);
 if(!entry)return;
 const directory=employerDirectorySignature(employers),targets=bulkCandidates().filter(r=>bulkSelected.has(r.id)).map(r=>({id:r.id,signature:recordSignature(r)}));
 const selectedSignature=JSON.stringify(targets),guard=()=>authorized()&&busy&&bulkTarget.value===entry.id&&!!employers&&employerDirectorySignature(employers)===directory&&JSON.stringify(bulkCandidates().filter(r=>bulkSelected.has(r.id)).map(r=>({id:r.id,signature:recordSignature(r)})))===selectedSignature;
 busy=true;bulkStatus.textContent='選択した明細を確認しています…';updateButtons();let writing=false;
 try{
  const plan=await inspectEmployerAssignment(targets,entry.id,directory,guard);
  if(!await approveSettings({title:'明細の勤務先を一括設定',subject:`未設定の明細 ${plan.count}件 → ${employerDisplayName(employers,entry.id)}`,details:['選択した明細の勤務先だけを変更します。金額・PDF原本・確認履歴は維持します。','同じ期間の重複や他端末での変更を検査してから保存します。'],acceptLabel:'勤務先を設定'},guard,authorized)){bulkStatus.textContent='';cancelOperation();return;}
  bulkStatus.textContent='勤務先を設定しています…';writing=true;
  const records=await assignEmployers(targets,entry.id,directory,plan.signature,guard);
  if(!guard())throw new Error('認証状態または対象が変更されました。保存結果を確認してください。');
  // Fresh, verified post-write snapshot. Reset consent/selection, not the directory.
  bulkRecords=records;legacyDirectory=legacyEmployers(records,employers);renderEmployerDirectory();
  bulkTarget.value=entry.id;renderBulkList();
  employerDirectoryStatus.textContent=`${plan.count}件の勤務先を設定しました。`;finishOperation('success');
 }catch(error){
  const detail=authorized()&&error instanceof Error?`${error.message}${error instanceof PayrollPartialSuccessError&&error.cause instanceof Error?` 原因: ${error.cause.message}`:''}`:'認証状態または通信状態を確認してください。';
  if(writing||!authorized())await recoverEmployerDirectory(authorized,detail,entry.id);
  else bulkStatus.textContent=detail;
  finishOperation(error instanceof PayrollPartialSuccessError?'partial':'error');
 }finally{busy=false;updateButtons();}
});

// Activate navigation only after the original settings handlers are registered.
settingsNavigation=mountSettingsNavigation($<HTMLElement>('settings-menu').closest<HTMLElement>('.settings-page')!,()=>!busy&&!document.querySelector('dialog[open]'),view=>{
 if(view==='employers'&&!employers)void loadEmployerDirectory(false);
});
settingsNavigation.setBusy(busy);
mountNotificationHistory();
