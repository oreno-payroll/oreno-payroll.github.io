/** MSAL owns OAuth tokens in its browser cache; Payroll stores only a pinned account ID. Browser-key persistence remains opt-in. */
import {PayrollGraph} from './graph';
import {EmptyPayrollIndexError,InterruptedRotationError,PayrollVault,RememberedKeyMismatchError} from './vault';
import {rememberKey,restoredKey,clearKey,clearAllKeys,clearTabUnlock} from './session';
import {clearNavigationSnapshot,invalidateNavigationSnapshot,invalidateAuthSession,authEpoch} from './snapshot';
import {createTabLockCoordinator} from './tabLock';
import {signOutLocallyFirst} from './signOutFlow';
import {readRememberedBrowserKey,saveRememberedBrowserKey,forgetRememberedBrowserKey,forgetAllRememberedBrowserKeys} from './rememberedBrowser';
import {createAppStatus} from '../ui/appStatus';
import {rememberedAccountKey,pickPayrollAccount,needsMicrosoftInteraction,MicrosoftSignInRequiredError,MicrosoftTemporaryError,type MicrosoftConnectionStatus} from './msalPolicy.ts';
const CLIENT_KEY='finance-onedrive-public-client-id-v1';
// A BFCache page must never keep using a vault from a previously selected account.
const pageAuthEpoch=authEpoch();
if(typeof window!=='undefined')window.addEventListener('pageshow',event=>{
 if(event.persisted && authEpoch()!==pageAuthEpoch)window.location.reload();
});
const SCOPES=['Files.ReadWrite.AppFolder'];
interface Account {homeAccountId:string;username?:string}
interface Token {accessToken:string;account:Account|null;expiresOn?:Date|null}
interface Msal {
 initialize():Promise<void>;
 handleRedirectPromise():Promise<{account:Account|null}|null>;
 getAllAccounts():Account[];
 getActiveAccount():Account|null;
 setActiveAccount(account:Account):void;
 loginRedirect(request:{scopes:string[];prompt?:string}):Promise<void>;
 acquireTokenSilent(request:{scopes:string[];account:Account;forceRefresh?:boolean}):Promise<Token>;
 acquireTokenRedirect(request:{scopes:string[];account:Account}):Promise<void>;
 logoutRedirect(request?:{postLogoutRedirectUri?:string}):Promise<void>;
}
interface MsalBundle {PublicClientApplication:new(config:object)=>Msal}
let msal:Msal|undefined;
let msalClientId:string|undefined;
let pending:Promise<Msal>|undefined;
let vault:PayrollVault|undefined;
let unlocking:Promise<PayrollVault>|undefined;
let tokenCache:{scope:string;value:string;validUntil:number}|undefined;
let tokenPending:{scope:string;force:boolean;promise:Promise<string>}|undefined;
let mustRefreshToken=false;
let remoteLockInProgress=false;
const tabLocks=createTabLockCoordinator(()=>{
 if(remoteLockInProgress)return;
 remoteLockInProgress=true;
 // Mask previously decrypted salary information immediately, even before a pending
 // SharedWorker round-trip or the page reload finishes.
 if(typeof document!=='undefined')document.documentElement.style.visibility='hidden';
 clearTabUnlock();invalidateAuthSession();
 vault?.lock();vault=undefined;unlocking=undefined;
 tokenCache=undefined;tokenPending=undefined;
 void clearAllKeys().then(
  ()=>{if(typeof window!=='undefined')window.location.reload();},
  ()=>{if(typeof window!=='undefined')window.location.reload();}
 );
});
function requireCurrentLockEpoch(start:string):void {
 if(!tabLocks.check()||tabLocks.epoch()!==start)throw new Error('別のタブで保管庫がロックされました。再度開いてください。');
}
/** A concurrent global lock/sign-out must not leave a newly persisted key.
 * Recheck after IndexedDB transaction commit and undo a stale write. */
async function rememberBrowserForEpoch(scope:string,key:CryptoKey,salt:string,generation:string|null,startEpoch:string):Promise<void> {
 await saveRememberedBrowserKey(scope,key,salt,generation);
 try{requireCurrentLockEpoch(startEpoch);}
 catch(error){
  try{await forgetRememberedBrowserKey(scope);}catch{ /* the global lock still denies auto-unlock */ }
  throw error;
 }
}
// One stable OAuth callback for all screens; do not register every page in Entra.
const redirectUri=()=>new URL('./auth/redirect.html',import.meta.url).href;
const sessionScope=(id:string,user:Account)=>`${id}:${user.homeAccountId}`;
const validId=(v:string)=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
function clientId():string{try{return localStorage.getItem(CLIENT_KEY)??'';}catch{return '';}}
/** Only a stable homeAccountId is kept outside MSAL. Never persist Microsoft tokens ourselves. */
function previousAccountId(id:string):string {
 try{return localStorage.getItem(rememberedAccountKey(id))??'';}catch{return '';}
}
function pinAccount(id:string,user:Account):void {
 try{localStorage.setItem(rememberedAccountKey(id),user.homeAccountId);}catch{}
}
function account(app:Msal):Account|undefined {
 const accounts=app.getAllAccounts();
 return pickPayrollAccount(accounts,previousAccountId(clientId()),app.getActiveAccount(),null);
}
async function getMsal():Promise<Msal> {
 const id=clientId();
 if(msal&&msalClientId===id)return msal;
 if(msalClientId!==id){msal=undefined;msalClientId=undefined;}
 if(pending)return pending;
 pending=(async()=>{
  if(!validId(id))throw new Error('Financeと同じMicrosoft Entra Client IDを入力してください。');
  const url=new URL('./vendor/msal/msal-browser.bundle.js',import.meta.url).href;
  const lib=await import(/* @vite-ignore */url) as MsalBundle;
  const app=new lib.PublicClientApplication({
   auth:{clientId:id,authority:'https://login.microsoftonline.com/consumers',redirectUri:redirectUri(),postLogoutRedirectUri:new URL('./',import.meta.url).href,navigateToLoginRequestUrl:false},
   // MSAL v5 controls token encryption, expiration and refresh. Do not implement our own durable tokens.
   cache:{cacheLocation:'localStorage'},
  });
  await app.initialize();
  const result=await app.handleRedirectPromise();
  const selected=pickPayrollAccount(app.getAllAccounts(),previousAccountId(id),app.getActiveAccount(),result?.account??null);
  if(clientId()!==id)throw new MicrosoftSignInRequiredError('Microsoftの接続設定が変更されました。再接続してください。');
  if(selected){app.setActiveAccount(selected);pinAccount(id,selected);}
  msalClientId=id;
  return (msal=app);
 })();
 try{return await pending;}finally{pending=undefined;}
}
function invalidateTokenCache():void {tokenCache=undefined;}
function invalidateAfter401():void {tokenCache=undefined;mustRefreshToken=true;}
/** All background paths stay non-interactive, including the Graph 401 recovery. */
async function token(forceRefresh=false):Promise<string> {
 const app=await getMsal(),user=account(app);
 if(!user)throw new MicrosoftSignInRequiredError('Microsoftアカウントを選択・認証してください。');
 const id=clientId(),scope=sessionScope(id,user),startAuthEpoch=authEpoch();
 if(mustRefreshToken){forceRefresh=true;mustRefreshToken=false;}
 if(forceRefresh)invalidateTokenCache();
 else if(tokenCache?.scope===scope&&tokenCache.validUntil>Date.now())return tokenCache.value;
 if(tokenPending?.scope===scope){
  if(!forceRefresh||tokenPending.force)return tokenPending.promise;
  // If 401 raced with the normal request, wait for it before forcing a fresh token.
  try{await tokenPending.promise;}catch{}
  if(authEpoch()!==startAuthEpoch)throw new MicrosoftSignInRequiredError();
 }
 const operation=(async()=>{
  let result:Token;
  try{result=await app.acquireTokenSilent({scopes:SCOPES,account:user,...(forceRefresh?{forceRefresh:true}:{})});}
  catch(error){
   invalidateTokenCache();
   if(needsMicrosoftInteraction(error))throw new MicrosoftSignInRequiredError();
   throw new MicrosoftTemporaryError();
  }
  if(authEpoch()!==startAuthEpoch||clientId()!==id||account(app)?.homeAccountId!==user.homeAccountId)
   throw new MicrosoftSignInRequiredError('接続アカウントが変更されました。もう一度接続を確認してください。');
  if(!result.accessToken)throw new MicrosoftTemporaryError('Microsoftの認証結果を確認できません。再試行してください。');
  const expiresAt=result.expiresOn instanceof Date?result.expiresOn.getTime():NaN,now=Date.now();
  if(Number.isFinite(expiresAt)&&expiresAt>now+60_000)
   tokenCache={scope,value:result.accessToken,validUntil:Math.min(expiresAt-60_000,now+30_000)};
  pinAccount(id,user);
  return result.accessToken;
 })();
 tokenPending={scope,force:forceRefresh,promise:operation};
 try{return await operation;}finally{if(tokenPending?.promise===operation)tokenPending=undefined;}
}
/** A 401 invalidates the short application cache. Never resend writes. */
function payrollGraph():PayrollGraph {
 return new PayrollGraph(token,undefined,invalidateNavigationSnapshot,{
  invalidate:invalidateAfter401,
  refresh:()=>token(true),
 });
}
/** Called only from an explicit user click. Background operations never redirect. */
export async function reconnectMicrosoftAccount():Promise<void>{
 const app=await getMsal(),user=account(app);
 if(!user){
  // Explicit account selection is required if multiple cached identities are ambiguous.
  await app.loginRedirect({scopes:SCOPES,...(app.getAllAccounts().length>1?{prompt:'select_account'}:{})});
  return;
 }
 try{await token(true);return;}
 catch(error){if(!(error instanceof MicrosoftSignInRequiredError))throw error;}
 await app.acquireTokenRedirect({scopes:SCOPES,account:user});
}
type GateUI = {panel:HTMLElement;id:HTMLInputElement;password:HTMLInputElement;browser:HTMLInputElement;remembered:HTMLButtonElement;loginError:HTMLElement;unlockError:HTMLElement;button:HTMLButtonElement;login:HTMLButtonElement;loginForm:HTMLFormElement;unlockForm:HTMLFormElement};
function mount():GateUI {
 const panel=document.createElement('div');panel.id='payroll-cloud-gate';
 panel.innerHTML=`<section class="payroll-cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="payroll-cloud-title">
 <div class="payroll-cloud-heading"><span class="payroll-cloud-symbol" aria-hidden="true">&#9670;</span><div>
 <p class="payroll-cloud-eyebrow">SECURE VAULT</p><h2 id="payroll-cloud-title">給与データを開く</h2></div></div>
 <form id="payroll-cloud-login-form" class="payroll-cloud-form" autocomplete="off" hidden>
 <div class="payroll-cloud-secret">
 <label for="payroll-client-id">Client ID</label>
 <input id="payroll-client-id" name="clientId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required form="payroll-cloud-login-form" />
 </div>
 <p id="payroll-login-error" class="payroll-cloud-error" role="alert" hidden></p>
 <button id="payroll-login" type="submit" class="payroll-cloud-login" disabled>Microsoftアカウントに接続</button>
 </form>
 <form id="payroll-cloud-unlock-form" class="payroll-cloud-form" autocomplete="on" hidden>
 <div class="payroll-cloud-secret">
 <label for="payroll-passphrase">復号パスフレーズ</label>
 <input id="payroll-passphrase" type="password" name="password" autocomplete="current-password" placeholder="パスフレーズを入力" required />
 </div>
 <div class="payroll-cloud-retention" role="radiogroup" aria-label="復号鍵の保持方法">
 <label class="payroll-cloud-remember"><input type="radio" name="payroll-retention" value="none" checked /><span>記憶しない</span></label>
 <label class="payroll-cloud-remember"><input id="payroll-remember-browser" type="radio" name="payroll-retention" value="browser" /><span>このブラウザを記憶する</span></label>
 </div>
 <p class="payroll-cloud-remember-note">ブラウザ記憶は期限なし。共有端末では使わないでください。手動ロック後は明示的に開き直します。別の保持方法を選ぶと以前のブラウザ記憶は解除されます。</p>
 <p id="payroll-unlock-error" class="payroll-cloud-error" role="alert" hidden></p>
 <button id="payroll-unlock" type="submit" class="payroll-cloud-primary" disabled>保管庫を開く</button>
 <button id="payroll-open-remembered" type="button" class="payroll-cloud-login" hidden>記憶した鍵で開く</button>
 </form>
 </section>`;
 document.body.append(panel);
 const el=<T extends HTMLElement>(id:string)=>panel.querySelector<T>('#'+id)!;
 return {panel,id:el('payroll-client-id'),password:el('payroll-passphrase'),browser:el('payroll-remember-browser'),remembered:el('payroll-open-remembered'),loginError:el('payroll-login-error'),unlockError:el('payroll-unlock-error'),button:el('payroll-unlock'),login:el('payroll-login'),loginForm:el('payroll-cloud-login-form'),unlockForm:el('payroll-cloud-unlock-form')};
}
function showAccount(ui:GateUI, state:'checking'|'connected'|'disconnected'|'reauth'|'temporary'|'error'):void {
 ui.loginForm.hidden=state==='connected'||state==='checking';
 ui.unlockForm.hidden=state!=='connected';
 ui.login.disabled=state==='checking'||state==='connected';
 ui.login.textContent=state==='temporary'?'接続を再確認':state==='reauth'?'Microsoftに再接続':'Microsoftアカウントに接続';
 ui.button.disabled=state!=='connected';
 if(state!=='connected')ui.remembered.hidden=true;
}
async function showRememberedOption(ui:GateUI):Promise<void>{
 ui.remembered.hidden=true;
 try {
  const app=await getMsal(),user=account(app);if(!user||ui.unlockForm.hidden)return;
  const scope=sessionScope(clientId(),user);
  if(await readRememberedBrowserKey(scope)){
   ui.remembered.hidden=false;
   // Already-trusted browsers default to the previously chosen mode on manual reauthentication.
   ui.browser.checked=true;
  }
 }catch{ /* IndexedDB unavailable: password unlock remains available. */ }
}
function clearGateError(target:HTMLElement):void {target.textContent='';target.hidden=true;}
function showGateError(target:HTMLElement, message:string):void {target.textContent=message;target.hidden=false;}
async function beginUnlock():Promise<PayrollVault> {
 const ui=mount();ui.id.value=clientId();
 if(!validId(clientId()))showAccount(ui,'disconnected');
 const onClientIdEdited=()=>{
  clearGateError(ui.loginError);
  if(ui.id.value.trim()!==clientId())showAccount(ui,'disconnected');
 };
 // 1Password等の補完はinput/changeのどちらかだけを発火する場合がある。
 ui.id.addEventListener('input',onClientIdEdited);
 ui.id.addEventListener('change',onClientIdEdited);
 const ready=new Promise<PayrollVault>((resolve)=>{
  ui.loginForm.addEventListener('submit',event=>{event.preventDefault();void(async()=>{
   clearGateError(ui.loginError);
   ui.login.disabled=true;
   ui.login.textContent='Microsoft接続を確認中…';
   try{
    const id=ui.id.value.trim();if(!validId(id))throw new Error('Client IDの形式が不正です。');
    if(clientId()!==id){await clearAllKeys();tabLocks.broadcast(true);clearTabUnlock();invalidateAuthSession();localStorage.setItem(CLIENT_KEY,id);msal=undefined;msalClientId=undefined;pending=undefined;tokenCache=undefined;tokenPending=undefined;}
    await reconnectMicrosoftAccount();
    const app=await getMsal(),user=account(app);
    if(user){showAccount(ui,'connected');void showRememberedOption(ui);ui.password.focus();return;}
   }catch(e){
    showAccount(ui,e instanceof MicrosoftTemporaryError?'temporary':e instanceof MicrosoftSignInRequiredError?'reauth':'error');
    showGateError(ui.loginError,e instanceof Error?e.message:'Microsoftへ接続できませんでした。');
   }
   finally{if(!ui.loginForm.hidden)ui.login.disabled=false;}
  })();});
  ui.unlockForm.addEventListener('submit',event=>{event.preventDefault();if(ui.button.disabled)return;void(async()=>{
   clearGateError(ui.unlockError);
   ui.button.disabled=true;
   ui.button.textContent='保管庫を確認しています…';
   try {
    if(ui.id.value.trim()!==clientId())throw new Error('接続設定を保存し、Microsoftアカウントへ接続してください。');
    const app=await getMsal();if(!account(app))throw new Error('Microsoftアカウントへの接続が必要です。');
    const startEpoch=tabLocks.epoch();
    requireCurrentLockEpoch(startEpoch);
    const pass=ui.password.value;if([...pass].length<12)throw new Error('パスフレーズは12文字以上にしてください。');
    const candidate=new PayrollVault(payrollGraph());
    const connected=account(app)!;
    const scope=sessionScope(clientId(),connected);
    candidate.setNavigationScope(scope);
    clearTabUnlock(); // Remove keys from previous releases before unlocking.
    let unlocked=false;
    let recoveryApproved=false;
    try { unlocked=await candidate.unlock(pass,false); }
    catch(e) {
     if(e instanceof InterruptedRotationError){
      if(!window.confirm('パスフレーズ変更が途中で中断された可能性があります。ほかのタブで変更処理が実行中でないことを確認しましたか？\n変更開始から30分以上経過していれば、旧鍵で保管庫の変更ロックを復旧できます。'))throw e;
      const restored=await candidate.recoverInterruptedChange(pass);
      if(!restored)throw new Error('復旧する変更処理が見つかりません。再度開いてください。');
      unlocked=await candidate.unlock(pass,false);
     } else if(!(e instanceof EmptyPayrollIndexError))throw e;
     else {
     const ok=window.confirm('OneDriveの payroll/index.enc が0バイトです。\n\nPayrollフォルダーに他の保存データがないことを再確認したうえで、この空ファイルを別名で退避し、新しい暗号化索引を作ります。\n\nファイルは削除せず、Financeのデータにも触れません。続行しますか？');
     if(!ok)throw new Error('空ファイルの復旧を中止しました。OneDriveは変更していません。');
     await candidate.graph.archiveEmptyIndex();
     recoveryApproved=true;
     }
    }
    if(!unlocked){
     if(!recoveryApproved){
      // A previously trusted browser must never create an empty replacement vault
      // merely because the current remote index is missing/inaccessible.
      let previousVault=false;
      try{previousVault=Boolean(await readRememberedBrowserKey(scope));}catch{ /* storage errors leave the existing password path available */ }
      if(previousVault)throw new Error('以前に記憶したPayroll保管庫の索引が見つかりません。空の保管庫は作成せず、OneDriveの接続先と保存状態を確認してください。');
      const who=account(app)?.username??'Microsoftアカウント';
      if(!window.confirm(`OneDriveにPayroll保管庫がありません。\n接続先: ${who}\n\n新しい暗号化保管庫を作成しますか？`))throw new Error('保管庫の新規作成を取り消しました。');
     }
     unlocked=await candidate.unlock(pass,true);
    }
    if(!unlocked)throw new Error('保管庫を解除できませんでした。');
    requireCurrentLockEpoch(startEpoch);
    const session=candidate.sessionKey();
    await rememberKey(scope,session.key,session.salt);
    requireCurrentLockEpoch(startEpoch);
    if(!tabLocks.acceptUnlock(startEpoch))throw new Error('保管庫のロック状態が変更されました。再度開いてください。');
    // Permission is separate from the persisted key. Do not accidentally re-enable an old key.
    tabLocks.suspendPersistentAutoResume();
    let storageNotice='';
    let storedSuccessfully=false;
    if(ui.browser.checked){
     try {
      await rememberBrowserForEpoch(scope,session.key,session.salt,candidate.rememberedKeyGeneration(),startEpoch);
      if(!tabLocks.permitPersistentAutoResume(startEpoch))throw new Error('ロック状態が変更されました。');
      storedSuccessfully=true;storageNotice='このブラウザを記憶しました。';
     }catch{storageNotice='保管庫は開きましたが、このブラウザに鍵を保存できませんでした。';}
    }else{
     // An explicit "do not remember" choice revokes older durable consent.
     try {await forgetRememberedBrowserKey(scope);}catch{storageNotice='以前のブラウザ記憶を削除できませんでした。設定から解除してください。';}
    }
    requireCurrentLockEpoch(startEpoch);
    ui.password.value='';vault=candidate;ui.panel.remove();installHomeLock(scope);resolve(candidate);
    if(storageNotice){const status=createAppStatus(document.querySelector<HTMLElement>('.app-status'));if(storedSuccessfully)status.success(storageNotice);else status.error(storageNotice);}

   }catch(e){
    if(e instanceof MicrosoftSignInRequiredError||e instanceof MicrosoftTemporaryError){
     showAccount(ui,e instanceof MicrosoftSignInRequiredError?'reauth':'temporary');
     showGateError(ui.loginError,e.message);
    }else showGateError(ui.unlockError,e instanceof Error?e.message:'保管庫を開けませんでした。');
    ui.button.disabled=false;ui.button.textContent='保管庫を開く';
   }
  })();});
  ui.remembered.addEventListener('click',()=>{void(async()=>{
   if(ui.remembered.disabled)return;
   ui.remembered.disabled=true;clearGateError(ui.unlockError);
   try {
    const app=await getMsal(),user=account(app);if(!user)throw new Error('Microsoftアカウントへ接続してください。');
    const scope=sessionScope(clientId(),user),startEpoch=tabLocks.epoch();
    const stored=await readRememberedBrowserKey(scope);
    if(!stored)throw new Error('記憶した鍵がありません。パスフレーズを入力してください。');
    const candidate=new PayrollVault(payrollGraph());
    candidate.setNavigationScope(scope);
    try {
     await candidate.unlockWithKey(stored.key,stored.salt);
     if(candidate.rememberedKeyGeneration()!==stored.generation)throw new RememberedKeyMismatchError();
    }catch(error){
     if(error instanceof RememberedKeyMismatchError){
      // A mismatching remote index may itself be damaged. A user-visible
      // failure must not destroy a locally valid recovery key.
      tabLocks.suspendPersistentAutoResume();
     }
     throw error;
    }
    requireCurrentLockEpoch(startEpoch);
    const session=candidate.sessionKey();await rememberKey(scope,session.key,session.salt);
    requireCurrentLockEpoch(startEpoch);
    if(!tabLocks.acceptUnlock(startEpoch))throw new Error('保管庫のロック状態が変更されました。');
    const automaticAllowed=tabLocks.permitPersistentAutoResume(startEpoch);
    vault=candidate;ui.panel.remove();installHomeLock(scope);resolve(candidate);
    if(!automaticAllowed)createAppStatus(document.querySelector<HTMLElement>('.app-status')).error('鍵は利用できましたが、自動解除の許可を保存できませんでした。');
   }catch(error){
    if(error instanceof MicrosoftSignInRequiredError||error instanceof MicrosoftTemporaryError){
     showAccount(ui,error instanceof MicrosoftSignInRequiredError?'reauth':'temporary');
     showGateError(ui.loginError,error.message);
    }else showGateError(ui.unlockError,error instanceof Error?error.message:'鍵で開けませんでした。');
   }
   finally{ui.remembered.disabled=false;}
  })();});
 });
 if(validId(clientId())) {
  showAccount(ui,'checking');
  void getMsal().then(async app=>{
   const user=account(app);
   if(!user){showAccount(ui,'disconnected');return;}
   try{
    await token();
    showAccount(ui,'connected');void showRememberedOption(ui);ui.password.focus();
   }catch(error){
    showAccount(ui,error instanceof MicrosoftSignInRequiredError?'reauth':'temporary');
    showGateError(ui.loginError,error instanceof Error?error.message:'Microsoftの接続を確認できません。');
   }
  }).catch(e=>{
   showAccount(ui,'error');showGateError(ui.loginError,e instanceof Error?e.message:'Microsoftへ接続できませんでした。');
  });
 }
 return ready;
}
/** A lock action is available on the home page without adding clutter to each subpage. */
function installHomeLock(scope:string):void {
 const footerActions=document.querySelector<HTMLElement>('.site-footer__actions');
 if(!footerActions||footerActions.querySelector('#payroll-cloud-lock'))return;
 const button=document.createElement('button');button.id='payroll-cloud-lock';
 button.type='button';button.className='payroll-cloud-lock site-footer__button';button.textContent='保管庫をロック';
 button.title='開いているすべてのPayrollタブをロックします';
 button.addEventListener('click',()=>{void(async()=>{
  button.disabled=true;
  tabLocks.broadcast();
  clearTabUnlock();invalidateAuthSession();
  vault?.lock();vault=undefined;unlocking=undefined;
  tokenCache=undefined;tokenPending=undefined;
  document.documentElement.style.visibility='hidden';
  try{await clearAllKeys();}finally{window.location.reload();}
 })();});
 footerActions.append(button);
}

/** ページ移動時は同じMicrosoftアカウントとSharedWorkerのメモリ鍵を照合。
 * 別途明示的に記憶したブラウザ鍵以外は永続化しない。 */
async function resumeOrPrompt():Promise<PayrollVault> {
 const id=clientId();
 clearTabUnlock();
 const startEpoch=tabLocks.epoch();
 if(validId(id)) {
  try {
   const app=await getMsal();
   const user=account(app);
   if(user) {
    // Before restoring a tab snapshot or a persistent key, validate MSAL identity.
    // Network/auth failure is handled by the gate, never by a background redirect.
    await token();
    const scope=sessionScope(id,user);
    // The discontinued tab storage is never read; expire all old raw-key records.
    clearTabUnlock();
    const eligible=tabLocks.canResume();
    const session=eligible?await restoredKey(scope):null;
    if(session) {
     try {
      const candidate=new PayrollVault(payrollGraph());
      candidate.setNavigationScope(scope);
      if(!await candidate.resumeFromSnapshot(session.key,session.salt))
       await candidate.unlockWithKey(session.key,session.salt);
      requireCurrentLockEpoch(startEpoch);
      if(!tabLocks.acceptUnlock(startEpoch))throw new Error('別のタブで保管庫がロックされました。');
      vault=candidate;
      await rememberKey(scope,session.key,session.salt);
      requireCurrentLockEpoch(startEpoch);
      installHomeLock(scope);
      return candidate;
     } catch(error) {
      if(!tabLocks.check())throw error;
      // A remote index parse/decrypt failure is not evidence that the
      // in-memory key is invalid. Do not clear an otherwise valid key.
      // The current navigation still falls back to explicit unlock.
     }
    }
    // Only a separately approved, per-browser CryptoKey may unlock across restarts.
    // Always verify the current OneDrive index, never the short-lived navigation snapshot.
    if(tabLocks.canAutoResumePersistent()){
     try {
      const stored=await readRememberedBrowserKey(scope);
      if(stored){
       const candidate=new PayrollVault(payrollGraph());
       candidate.setNavigationScope(scope);
       try {
        await candidate.unlockWithKey(stored.key,stored.salt);
        if(candidate.rememberedKeyGeneration()!==stored.generation)throw new RememberedKeyMismatchError();
       }catch(error){
        if(error instanceof RememberedKeyMismatchError){
         // Suspend repeated automatic attempts but preserve the browser key;
         // a corrupt index and a genuinely rotated key are indistinguishable.
         tabLocks.suspendPersistentAutoResume();
        }
        throw error;
       }
       requireCurrentLockEpoch(startEpoch);
       const session=candidate.sessionKey();
       await rememberKey(scope,session.key,session.salt);
       requireCurrentLockEpoch(startEpoch);
       if(!tabLocks.acceptUnlock(startEpoch))throw new Error('ロック状態が変更されました。');
       vault=candidate;installHomeLock(scope);return candidate;
      }
      // Browser storage was evicted or the local key was corrupt. No automatic retry.
      tabLocks.suspendPersistentAutoResume();
     }catch{ /* Graph/MSAL/IndexedDB temporary errors must not erase a valid saved key. */ }
    }
   }
  }catch { /* Microsoft認証が必要ならモーダルで案内する */ }
 }
 return beginUnlock();
}
/** A PDF may leave the opener only while the exact unlocked vault and lock
 * generation from the initiating click are still current. This guard runs
 * synchronously again after the awaited original download/verification.
 * Nothing sensitive is serialized or sent to the viewer by this guard. */
export function capturePdfHandoffAuthorization():()=>boolean {
 const sourceVault=vault;
 const startEpoch=tabLocks.epoch();
 return ()=>Boolean(sourceVault && sourceVault===vault && sourceVault.isUnlocked() &&
  tabLocks.check() && tabLocks.epoch()===startEpoch);
}

export async function cloudVault():Promise<PayrollVault> {
 if(typeof window!=='undefined'&&window.top!==window.self)throw new Error('埋め込まれたページでは保管庫を開けません。');
 if(!tabLocks.check())throw new Error('別のタブで保管庫がロックされました。再度開いてください。');
 if(vault?.isUnlocked())return vault;
 if(!unlocking)unlocking=resumeOrPrompt();
 try{return await unlocking;}catch(e){unlocking=undefined;throw e;}
}


/** Inspect the current Microsoft account's browser key without reading payroll data. */
export async function currentBrowserRememberState():Promise<'saved'|'missing'|'unavailable'>{
 try {
  const app=await getMsal(),user=account(app);if(!user)return 'unavailable';
  return await readRememberedBrowserKey(sessionScope(clientId(),user))?'saved':'missing';
 }catch{return 'unavailable';}
}
/** Registration from settings requires an unlocked session and rechecks the live index. */
export async function rememberCurrentBrowser():Promise<void>{
 const app=await getMsal(),user=account(app);if(!user)throw new Error('Microsoftへ接続してください。');
 const startEpoch=tabLocks.epoch(),scope=sessionScope(clientId(),user);
 const opened=vault;
 if(!opened?.isUnlocked())throw new Error('保管庫をパスフレーズで開いてから登録してください。');
 const session=opened.sessionKey();
 const verified=new PayrollVault(payrollGraph());
 await verified.unlockWithKey(session.key,session.salt);
 requireCurrentLockEpoch(startEpoch);
 await rememberBrowserForEpoch(scope,session.key,session.salt,verified.rememberedKeyGeneration(),startEpoch);
 if(!tabLocks.permitPersistentAutoResume(startEpoch))throw new Error('ロック状態が変更されました。');
}
/** Forget locally, then explicitly lock every tab; no SharedWorker/tab-cache bypass. */
export async function forgetCurrentBrowser():Promise<void>{
 const app=await getMsal(),user=account(app);if(!user)throw new Error('Microsoftへ接続してください。');
 await forgetRememberedBrowserKey(sessionScope(clientId(),user));
 tabLocks.broadcast();clearTabUnlock();invalidateAuthSession();
 vault?.lock();vault=undefined;unlocking=undefined;
 tokenCache=undefined;tokenPending=undefined;
 if(typeof document!=='undefined')document.documentElement.style.visibility='hidden';
 try{await clearAllKeys();}catch{ /* Global lock epoch still blocks key reuse. */ }
}

/** 保管庫の鍵切替後、古いタブ鍵とSharedWorker鍵を無効化して新鍵に差し替える。 */
export async function refreshSessionAfterKeyRotation():Promise<'updated'|'not-registered'|'storage-warning'> {
 const app=await getMsal(),user=account(app);
 if(!user)throw new Error('Microsoft接続を確認できません。変更後の新しいパスフレーズで入り直してください。');
 const scope=sessionScope(clientId(),user);
 let existed=false,storageFailure=false;
 try{existed=Boolean(await readRememberedBrowserKey(scope));}catch{storageFailure=true;}
 tabLocks.broadcast(true);
 const rotationEpoch=tabLocks.epoch();
 clearTabUnlock();clearNavigationSnapshot();
 await clearAllKeys();
 if(vault?.isUnlocked()){
  const session=vault.sessionKey();
  await rememberKey(scope,session.key,session.salt);
  if(existed){
   try {
    await rememberBrowserForEpoch(scope,session.key,session.salt,vault.rememberedKeyGeneration(),rotationEpoch);
    if(!tabLocks.permitPersistentAutoResume(rotationEpoch))throw new Error('ロック状態が変更されました。');
   }catch{
    storageFailure=true;
    try{await forgetRememberedBrowserKey(scope);}catch{}
   }
  }else if(storageFailure){
   // Failure to inspect the old key: attempt deletion after a confirmed rotation.
   try{await forgetRememberedBrowserKey(scope);}catch{}
  }
 }
 return storageFailure?'storage-warning':existed?'updated':'not-registered';
}

/** Settings page can inspect MSAL account selection without unlocking salary data. */
export async function cloudConnectionState():Promise<{clientId:string;user:string|null;status:MicrosoftConnectionStatus;error?:string}> {
 const id=clientId();
 if(!validId(id))return {clientId:id,user:null,status:'disconnected'};
 try{
  const app=await getMsal(),user=account(app),label=user?.username??(user?'Microsoftアカウント':null);
  if(!user)return {clientId:id,user:null,status:'disconnected'};
  try {await token();return {clientId:id,user:label,status:'connected'};}
  catch(error){
   const status=error instanceof MicrosoftSignInRequiredError?'reauth':'temporary';
   return {clientId:id,user:label,status,error:error instanceof Error?error.message:'Microsoft接続を確認できません。'};
  }
 }catch{return {clientId:id,user:null,status:'temporary',error:'Microsoftの接続状態を確認できません。'};}
}
/** Client ID is public configuration, not a credential. Other settings are never overwritten. */
export async function saveCloudClientId(input:string):Promise<'unchanged'|'changed'> {
 const id=input.trim();if(!validId(id))throw new Error('Client IDはUUID形式で指定してください。');
 if(id===clientId())return 'unchanged';
 await clearAllKeys();
 tabLocks.broadcast(true);clearTabUnlock();invalidateAuthSession();
 vault?.lock();vault=undefined;unlocking=undefined;
 tokenCache=undefined;tokenPending=undefined;msal=undefined;msalClientId=undefined;pending=undefined;
 localStorage.setItem(CLIENT_KEY,id);
 return 'changed';
}
/** Explicit switch/login button. OAuth tokens remain exclusively under MSAL. */
export async function chooseMicrosoftAccount():Promise<void> {
 const app=await getMsal();
 // Mask all decrypted UI before starting any redirect or awaiting a worker lock.
 if(typeof document!=='undefined')document.documentElement.style.visibility='hidden';
 tabLocks.broadcast(true);clearTabUnlock();invalidateAuthSession();vault?.lock();vault=undefined;unlocking=undefined;
 tokenCache=undefined;tokenPending=undefined;
 try{
  await clearAllKeys();
  await app.loginRedirect({scopes:SCOPES,prompt:'select_account'});
 }catch(error){
  if(typeof window!=='undefined')window.location.reload();
  throw error;
 }
}

/** Exact SPA redirect URI shown so the user can register the single expected URL. */
export function cloudRedirectUri():string{return redirectUri();}

/** Explicit Payroll sign-out. Revoke access synchronously and clear both local
 * key stores before attempting any asynchronous Microsoft/MSAL operation.
 * If either store cannot confirm erasure, stay locked and do not redirect. */
export async function signOutMicrosoftAccount(onRedirectReady?:()=>void):Promise<void> {
 await signOutLocallyFirst({
  lockImmediately:()=>{
   // Mask salary data and broadcast the lock before even initializing MSAL.
   if(typeof document!=='undefined')document.documentElement.style.visibility='hidden';
   tabLocks.broadcast();
   clearTabUnlock();invalidateAuthSession();clearNavigationSnapshot();
   vault?.lock();vault=undefined;unlocking=undefined;
   tokenCache=undefined;tokenPending=undefined;mustRefreshToken=false;
   try{localStorage.removeItem(rememberedAccountKey(clientId()));}catch{}
  },
  clearSharedWorkerKeys:()=>clearAllKeys(),
  clearRememberedBrowserKeys:()=>forgetAllRememberedBrowserKeys(),
  logoutMicrosoft:async()=>{
   const app=await getMsal();
   // getMsal may pin an account during initialization: remove that pin as well.
   try{localStorage.removeItem(rememberedAccountKey(clientId()));}catch{}
   // Disable the edit-page navigation warning only after local keys are erased.
   onRedirectReady?.();
   await app.logoutRedirect({postLogoutRedirectUri:new URL('./',import.meta.url).href});
  },
 });
}
