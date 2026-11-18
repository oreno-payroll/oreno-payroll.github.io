/** 暗号化完全バックアップの書出・PDF.jsでの復元前検査・全件置換。 */
import type {OrphanAnnualYear} from './cloud/vault';
import {migrateFromLegacyIndexedDb, inspectLegacyIndexedDb, deleteLegacyIndexedDb, loadRecords, loadRecordSummaries, payrollSnapshot, replaceAllRecords } from './storage/payrollStore';
import { createBackup, readBackup, type LoadedBackup } from './storage/payrollBackup';
import { encryptBackup, decryptBackup, isEncryptedBackup } from './storage/encryptedBackup';
import {cloudVault,refreshSessionAfterKeyRotation,cloudConnectionState,saveCloudClientId,chooseMicrosoftAccount,cloudRedirectUri} from './cloud/auth';
import {clearNavigationSnapshot} from './cloud/snapshot';
import type {CloudFolderItem} from './cloud/graph';

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
const status = $<HTMLElement>('backup-status');
const changeCurrent=$<HTMLInputElement>('change-current');
const changeNew=$<HTMLInputElement>('change-new');
const changeConfirm=$<HTMLInputElement>('change-confirm');
const changeAck=$<HTMLInputElement>('change-ack');
const changeButton=$<HTMLButtonElement>('change-passphrase-button');
const changeStatus=$<HTMLElement>('change-passphrase-status');
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
let preview: LoadedBackup | undefined;
let currentCount = 0;
let initialSnapshot: string[] | undefined;
let busy = false;
let loadedDb = false;
let encryptedFile = false;
const sizes = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(0, Math.round(n / 1024))} KiB`;
function updateButtons(): void {
  orphanCheck.disabled=busy;orphanRecover.disabled=busy||!orphanYears?.length;
  exportButton.disabled = busy || !loadedDb;
  cloudLoad.disabled=busy;
  changeButton.disabled=busy;
  $<HTMLButtonElement>('payroll-income-publish').disabled=busy;
  cloudCheck.disabled=busy;cloudDelete.disabled=busy||!oldCloudPlan;localCheck.disabled=busy;localDelete.disabled=busy;
  for(const item of [changeCurrent,changeNew,changeConfirm,changeAck])item.disabled=busy;
  filePicker.disabled = busy;
  document.querySelector<HTMLButtonElement>('#migrate-legacy-cloud')?.toggleAttribute('disabled',busy);
  restorePassword.disabled = busy || !encryptedFile;
  verifyButton.disabled = busy || !encryptedFile || !filePicker.files?.length || !restorePassword.value;
  ack.disabled = busy || !preview;
  restoreButton.disabled = busy || !preview || !ack.checked;
}
function info(message: string, isError = false): void {
  status.textContent = message;
  status.style.color = isError ? 'var(--color-danger)' : 'var(--color-success)';
}
function resetPreview(): void {
  preview = undefined;
  ack.checked = false;
  updateButtons();
}
async function refreshCount(): Promise<void> {
  const records = await loadRecordSummaries({priorityYears:[]});
  currentCount = records.length;
  initialSnapshot = payrollSnapshot(records);
  loadedDb = true;
  const bytes = records.reduce((sum, r) => sum + r.pdfSize, 0);
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
    const records=await loadRecords((completed,total)=>{
      step=`PDF原本 ${completed}/${total}件を取得・照合しました`;
      display();
    });
    step='ZIPファイルを作成しています…';display();
    const zip=await createBackup(records);
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
    info(`暗号化バックアップを作成しました（${sizes(blob.size)}）。保存先でファイルがあることを確認してください。`);
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
    restorePreview.textContent = `検証完了：${loaded.records.length}件 ・ PDF ${sizes(loaded.bytes)}\n作成日時：${new Date(loaded.exportedAt).toLocaleString('ja-JP')}${loaded.unreviewedWarnings ? `\n旧データの検算未承認：${loaded.unreviewedWarnings}件` : ''}${loaded.legacyDuplicates ? `\n旧データの重複候補：${loaded.legacyDuplicates}件` : ''}`;
    info('バックアップを検証しました。復元内容を確認してください。');
  } catch (error) {
    preview = undefined;
    restorePreview.textContent = '検証失敗。既存データは変更されていません。';
    info(`復元ファイルを検証できませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally { busy = false; updateButtons(); }
}
filePicker.addEventListener('change', async () => {
  resetPreview();
  restorePassword.value = '';
  const file = filePicker.files?.[0];
  if (!file) { restorePreview.textContent = 'バックアップファイルを選択してください。'; return; }
  busy = true; updateButtons();
  try {
    encryptedFile = await isEncryptedBackup(file);
    restorePasswordRow.hidden = !encryptedFile;
    verifyButton.hidden = !encryptedFile;
    if (encryptedFile) {
      restorePreview.textContent = '暗号化バックアップ。パスワードを入力して検証してください。';
      info('暗号化バックアップを検出しました。');
    } else {
      restorePreview.textContent = 'ZIPファイルを検証中…';
    }
  } catch (error) {
    info(`ファイルを読み取れませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
    return;
  } finally { busy = false; updateButtons(); }
  if (!encryptedFile) await verifyRestore(file);
});
restorePassword.addEventListener('input', () => { resetPreview(); updateButtons(); });
verifyButton.addEventListener('click', async () => {
  const file = filePicker.files?.[0];
  if (!file || !encryptedFile || busy) return;
  await verifyRestore(file, restorePassword.value);
});
ack.addEventListener('change', updateButtons);
restoreButton.addEventListener('click', async () => {
  if (busy || !preview || !ack.checked || !initialSnapshot) return;
  const data = preview;
  const snapshot = [...initialSnapshot];
  if (!window.confirm(`現在の${currentCount}件を削除して、バックアップ内の${data.records.length}件で完全に置き換えます。続けますか？`)) return;
  busy = true; updateButtons(); info('全件復元中です。操作完了を確認してください…');
  try {
    await replaceAllRecords(data.records, snapshot);
    window.location.assign('../index.html');
  } catch (error) {
    // 別タブで変更されていた場合も、古い復元確認を再利用できないようにする。
    resetPreview();
    restorePreview.textContent = '復元を中断しました。バックアップの検証からやり直してください。';
    try { await refreshCount(); } catch { /* データの読み込み失敗は以下の詳細エラーを優先 */ }
    info(`復元が途中で停止しました。OneDriveの明細を確認してください: ${error instanceof Error ? error.message : String(error)}`, true);
    busy = false; updateButtons();
  }
});
const cloudState=$<HTMLElement>('backup-cloud-status');
const cloudLogin=$<HTMLButtonElement>('backup-cloud-login');
const cloudId=$<HTMLInputElement>('backup-cloud-client-id');
const cloudSave=$<HTMLButtonElement>('backup-cloud-save');
$<HTMLElement>('backup-cloud-redirect-uri').textContent=cloudRedirectUri();
async function refreshCloudSettings():Promise<boolean>{
 const state=await cloudConnectionState();
 cloudId.value=state.clientId;
 cloudState.textContent=state.error??(state.user?`サインイン済み · ${state.user}`:state.clientId?'未ログイン':'Client ID未設定');
 cloudState.dataset.error=String(Boolean(state.error));
 cloudLogin.disabled=!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(state.clientId);
 cloudLogin.textContent=state.user?'別のアカウントでログイン':'Microsoftにログイン';
 return Boolean(state.user);
}
cloudSave.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 cloudSave.disabled=true;
 try{
  const changed=await saveCloudClientId(cloudId.value);
  if(changed==='changed'){location.reload();return;}
  cloudState.textContent='Client IDは設定済みです。';
 }catch(error){cloudState.textContent=error instanceof Error?error.message:String(error);cloudState.dataset.error='true';}
 finally{cloudSave.disabled=false;}
})()});
cloudLogin.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 cloudLogin.disabled=true;
 try{await chooseMicrosoftAccount();}
 catch(error){cloudState.textContent=error instanceof Error?error.message:String(error);cloudState.dataset.error='true';cloudLogin.disabled=false;}
})()});
// 旧DBが見つかればクラウド解除の自動開始を避け、ローカルの整理を優先する。
// 明細を読み込みたい場合だけ、利用者が明示的にOneDrive読み込みを開始する。
cloudLoad.addEventListener('click',()=>{void(async()=>{
 if(busy||loadedDb)return;
 cloudLoad.disabled=true;
 exportSummary.textContent='OneDriveの明細を読み込んでいます…';
 try{await refreshCount();cloudLoad.hidden=true;}
 catch(error){
  exportSummary.textContent='OneDrive明細を読み込めませんでした。';
  info(error instanceof Error?error.message:String(error),true);
 }finally{cloudLoad.disabled=false;updateButtons();}
})()});
void(async()=>{
 let legacyExists=false;
 try{legacyExists=(await inspectLegacyIndexedDb()).exists;}
 catch{ /* 旧DB確認が非対応なら従来どおりクラウド情報を表示する。 */ }
 if(legacyExists){
  cloudLoad.hidden=false;
  exportSummary.textContent='旧DBの整理を優先できます。OneDriveの明細は必要なときだけ読み込んでください。';
  updateButtons();
 }
 const connected=await refreshCloudSettings();
 if(legacyExists)return;
 if(!connected){exportSummary.textContent='Microsoftに接続すると明細件数を確認できます。';return;}
 await refreshCount();updateButtons();
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
  orphanRecover.hidden=!orphanYears.length;
 }catch(error){orphanStatus.textContent=`検査できませんでした：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
orphanRecover.addEventListener('click',()=>{void(async()=>{
 if(busy||!orphanYears?.length)return;
 const expected=orphanYears;
 if(!window.confirm(`索引に登録されていない年度 ${expected.length}件を復旧します。\n対象：${expected.map(v=>`${v.year}年度（${v.records}件${v.records===0?"・空の年度ファイル":""}）`).join('、')}\n\n暗号化ファイルを照合して年度索引に追加し、収入情報を同期します。よろしいですか？`))return;
 busy=true;updateButtons();orphanStatus.textContent='年度索引を復旧しています…';
 try{
  const vault=await cloudVault();
  const count=await vault.recoverOrphanYears(expected);
  orphanYears=undefined;orphanRecover.hidden=true;
  orphanStatus.textContent=`${count}年度を復旧しました。最新の明細一覧を確認してください。`;
  loadedDb=false;await refreshCount();
 }catch(error){orphanYears=undefined;orphanRecover.hidden=true;orphanStatus.textContent=`復旧を完了できませんでした。年度索引が一部更新済みの可能性があります：${error instanceof Error?error.message:String(error)}`;}
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
  label.textContent='全年度のFinance連携データを更新・読み戻し照合しました。';
 }catch(error){label.textContent=`連携データの更新に失敗しました：${error instanceof Error?error.message:'通信エラー'}`;}
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
 if(!confirm('旧IndexedDBの給与明細をOneDriveへ移行します。移行前にバックアップを保管しましたか？'))return;
 busy=true;updateButtons();
 try{
  const result=await migrateFromLegacyIndexedDb(message=>{migrateStatus.textContent=message;});
  migrateStatus.textContent=`旧データ ${result.found}件中、新規に${result.migrated}件を移行しました。旧IndexedDBは削除していません。`;
  await refreshCount();
 }catch(error){migrateStatus.textContent=`移行を中断しました：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
 })();});

// データ書換中はタブを閉じる前に確認。ページ遷移ではロックと転送状況を守る。
window.addEventListener('beforeunload',event=>{
 if(busy){event.preventDefault();event.returnValue='';}
});
changeButton.addEventListener('click',()=>{void(async()=>{
 if(busy)return;
 if(changeNew.value!==changeConfirm.value){changeStatus.textContent='新しいパスフレーズが一致しません。';return;}
 if([...changeCurrent.value].length<12||[...changeNew.value].length<12){changeStatus.textContent='現在・新しいパスフレーズを12文字以上で入力してください。';return;}
 if(changeCurrent.value===changeNew.value){changeStatus.textContent='現在と異なるパスフレーズを指定してください。';return;}
 if(!changeAck.checked){changeStatus.textContent='バックアップと他タブの終了を確認してください。';return;}
 if(!window.confirm('OneDriveの全暗号ファイルを新しい鍵へ移行します。完了まで画面移動はできません。開始しますか？'))return;
 busy=true;updateButtons();
 const started=performance.now();let stage='変更の準備中…';
 const report=()=>{changeStatus.textContent=`${stage}（経過 ${Math.round((performance.now()-started)/1000)}秒）`;};
 const timer=setInterval(report,1000);
 try{
  const vault=await cloudVault();
  clearNavigationSnapshot();
  await vault.changePassphrase(changeCurrent.value,changeNew.value,value=>{stage=value;report();});
  // 移行はこの時点でOneDriveに確定済み。旧タブ鍵を消し、メモリ鍵を更新する。
  changeCurrent.value='';changeNew.value='';changeConfirm.value='';changeAck.checked=false;
  try{await refreshSessionAfterKeyRotation();}
  catch{changeStatus.textContent='OneDriveの変更は完了しました。セッションの引継ぎに失敗したため、次回は新しいパスフレーズで解除してください。';return;}
  changeStatus.textContent='パスフレーズを変更しました。次回の解除には新しいパスフレーズを使用してください。';
 }catch(error){changeStatus.textContent=`変更を完了できませんでした: ${error instanceof Error?error.message:String(error)}`;}
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
  cloudDelete.hidden=!plan.targets.length;
 }catch(error){cloudStatus.textContent=error instanceof Error?error.message:String(error);}
 finally{busy=false;updateButtons();}
})()});
cloudDelete.addEventListener('click',()=>{void(async()=>{
 if(busy||!oldCloudPlan)return;
 const plan=oldCloudPlan;
 if(!confirm(`現行データ・PDFをすべて照合したあと、旧暗号フォルダー ${plan.targets.length}件をOneDriveのごみ箱へ移動します。\nごみ箱には古いパスフレーズで開けるファイルが残ります。\n暗号化バックアップを別途保存し、他タブを閉じましたか？`))return;
 if(prompt('削除するには「整理」と入力してください。')!=='整理')return;
 oldCloudPlan=undefined;cloudDelete.hidden=true;busy=true;updateButtons();
 try{
  const vault=await cloudVault();
  const count=await vault.cleanupOldEncryptedData(plan,text=>{cloudStatus.textContent=text;});
  cloudStatus.textContent=`旧暗号フォルダー ${count}件をごみ箱に移動しました。完全に消す場合はOneDriveのごみ箱も空にしてください。`;
 }catch(error){cloudStatus.textContent=`途中で停止しました。残りの対象を再確認してください：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
// 旧DBの検査は任意。削除ボタンは検査・OneDriveサインイン前でも押せる。
localCheck.addEventListener('click',()=>{void(async()=>{
 if(busy)return;busy=true;updateButtons();
 localStatus.textContent='この端末の旧IndexedDBを確認しています…';
 try{
  const result=await inspectLegacyIndexedDb();
  localStatus.textContent=result.exists?`旧IndexedDB：${result.count}件。OneDriveとの照合なしで、この端末から削除できます。`:'この端末に旧IndexedDBはありません。';
 }catch(error){localStatus.textContent=`旧DBを確認できませんでした：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
localDelete.addEventListener('click',()=>{void(async()=>{
 if(busy)return;busy=true;updateButtons();
 try{
  // 誤って空の新規DBを作らず、既存の旧DBだけを列挙する。
  const result=await inspectLegacyIndexedDb();
  if(!result.exists){localStatus.textContent='この端末に旧IndexedDBはありません。';return;}
  if(!window.confirm(`この端末の旧IndexedDB（${result.count}件）を削除します。\nOneDriveとの照合は行いません。未移行の明細があれば失われ、元に戻せません。\nバックアップを確認したうえで削除しますか？`))return;
  const deleted=await deleteLegacyIndexedDb(result.count,text=>{localStatus.textContent=text;});
  localStatus.textContent=`この端末の旧IndexedDBを削除しました（${deleted}件）。OneDriveやMicrosoftの接続情報は変更していません。`;
 }catch(error){localStatus.textContent=`旧DBは削除できませんでした：${error instanceof Error?error.message:String(error)}`;}
 finally{busy=false;updateButtons();}
})()});
