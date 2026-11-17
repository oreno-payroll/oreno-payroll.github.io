/** Finance v1.1 のMSAL 5.29.0バンドルを同梱して共通Client IDを利用。
 * Client IDはlocalStorage、パスフレーズは非保存。明示許可時だけタブ内一時鍵を保持。 */
import {PayrollGraph} from './graph';
import {EmptyPayrollIndexError,InterruptedRotationError,PayrollVault} from './vault';
import {rememberKey,restoredKey,clearKey,rememberTabUnlock,restoredTabUnlock,clearTabUnlock} from './session';
import {clearNavigationSnapshot,invalidateNavigationSnapshot,invalidateAuthSession,authEpoch} from './snapshot';
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
 loginRedirect(request:{scopes:string[];prompt:string}):Promise<void>;
 acquireTokenSilent(request:{scopes:string[];account:Account}):Promise<Token>;
 acquireTokenRedirect(request:{scopes:string[];account:Account}):Promise<void>;
}
interface MsalBundle {PublicClientApplication:new(config:object)=>Msal}
let msal:Msal|undefined;
let pending:Promise<Msal>|undefined;
let vault:PayrollVault|undefined;
let unlocking:Promise<PayrollVault>|undefined;
let tokenCache:{scope:string;value:string;validUntil:number}|undefined;
let tokenPending:{scope:string;promise:Promise<string>}|undefined;
// One stable OAuth callback for all screens; do not register every page in Entra.
const redirectUri=()=>new URL('./',import.meta.url).href;
const sessionScope=(id:string,user:Account)=>`${id}:${user.homeAccountId}`;
const validId=(v:string)=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
function clientId():string{try{return localStorage.getItem(CLIENT_KEY)??'';}catch{return '';}}
async function getMsal():Promise<Msal> {
 if(msal)return msal;
 if(pending)return pending;
 pending=(async()=>{
  const id=clientId();if(!validId(id))throw new Error('Financeと同じMicrosoft Entra Client IDを入力してください。');
  // 配信のdist/*jsから見た相対パス。FinanceでビルドされたMSAL 5.29.0を同梱。
  const url=new URL('./vendor/msal/msal-browser.bundle.js',import.meta.url).href;
  const lib=await import(/* @vite-ignore */url) as MsalBundle;
  const app=new lib.PublicClientApplication({
   auth:{clientId:id,authority:'https://login.microsoftonline.com/consumers',redirectUri:redirectUri(),postLogoutRedirectUri:redirectUri(),navigateToLoginRequestUrl:false},
   cache:{cacheLocation:'sessionStorage'},
  });
  await app.initialize();
  const result=await app.handleRedirectPromise();
  const account=result?.account??app.getActiveAccount()??app.getAllAccounts()[0];
  if(account)app.setActiveAccount(account);
  return (msal=app);
 })();
 try{return await pending;}finally{pending=undefined;}
}
function account(app:Msal):Account|undefined{return app.getActiveAccount()??app.getAllAccounts()[0];}
async function token():Promise<string> {
 const app=await getMsal(),user=account(app);
 if(!user)throw new Error('Microsoftアカウントへログインしてください。');
 const scope=sessionScope(clientId(),user);
 if(tokenCache?.scope===scope && tokenCache.validUntil>Date.now())return tokenCache.value;
 if(tokenPending?.scope===scope)return tokenPending.promise;
 const pending=(async()=>{
  try{
   const result=await app.acquireTokenSilent({scopes:SCOPES,account:user});
   // Only cache a token with a verified expiration. Never persist it to application storage.
   const expiresAt=result.expiresOn instanceof Date?result.expiresOn.getTime():NaN;
   const now=Date.now();
   if(Number.isFinite(expiresAt)&&expiresAt>now+60_000){
    tokenCache={scope,value:result.accessToken,validUntil:Math.min(expiresAt-60_000,now+30_000)};
   }
   return result.accessToken;
  }catch{
   tokenCache=undefined;
   if(!window.confirm('Microsoftの再認証が必要です。未保存の操作を確認してから再ログインしますか？'))throw new Error('Microsoft認証を中止しました。');
   await app.acquireTokenRedirect({scopes:SCOPES,account:user});
   throw new Error('Microsoft認証画面へ移動しています。');
  }
 })();
 tokenPending={scope,promise:pending};
 try{return await pending;}finally{if(tokenPending?.promise===pending)tokenPending=undefined;}
}
type GateUI = {panel:HTMLElement;id:HTMLInputElement;password:HTMLInputElement;remember:HTMLInputElement;status:HTMLElement;button:HTMLButtonElement;login:HTMLButtonElement;account:HTMLElement;details:HTMLDetailsElement};
function mount():GateUI {
 const panel=document.createElement('div');panel.id='payroll-cloud-gate';
 panel.innerHTML=`<section class="payroll-cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="payroll-cloud-title" aria-describedby="payroll-cloud-description">
 <div class="payroll-cloud-heading"><span class="payroll-cloud-symbol" aria-hidden="true">&#9670;</span><div>
 <p class="payroll-cloud-eyebrow">SECURE VAULT</p><h2 id="payroll-cloud-title">給与データを開く</h2>
 <p id="payroll-cloud-description">OneDriveの明細を復号します。</p></div></div>
 <div class="payroll-cloud-account is-checking" id="payroll-account-state" role="status" aria-live="polite">
 <span class="payroll-cloud-dot" aria-hidden="true"></span><span id="payroll-account-label">Microsoftアカウントを確認中…</span>
 </div>
 <button id="payroll-login" type="button" class="payroll-cloud-login" disabled hidden>Microsoftアカウントに接続</button>
 <div class="payroll-cloud-secret">
 <label for="payroll-passphrase">復号パスフレーズ</label>
 <input id="payroll-passphrase" type="password" autocomplete="off" placeholder="パスフレーズを入力" />
 </div>
 <label class="payroll-cloud-remember"><input id="payroll-remember" type="checkbox" /><span>このタブでは再入力を省略する（最長8時間）</span></label>
 <p class="payroll-cloud-remember-note">選択時は復号に使える一時鍵をタブ内に保持します。共有端末では選択しないでください。</p>
 <button id="payroll-unlock" type="button" class="payroll-cloud-primary" disabled>保管庫を開く</button>
 <p id="payroll-cloud-status" role="status" aria-live="polite"></p>
 <details id="payroll-client-settings" class="payroll-cloud-settings"><summary>Microsoft接続設定を変更</summary>
 <label for="payroll-client-id">Client ID</label><input id="payroll-client-id" autocomplete="off" spellcheck="false" />
 <p class="payroll-cloud-tip">初回のみFinanceと同じClient IDを入力してください。</p></details>
 <p class="payroll-cloud-footnote">パスフレーズはこの端末へ保存しません。</p>
 </section>`;
 document.body.append(panel);
 const el=<T extends HTMLElement>(id:string)=>panel.querySelector<T>('#'+id)!;
 return {panel,id:el('payroll-client-id'),password:el('payroll-passphrase'),remember:el('payroll-remember'),status:el('payroll-cloud-status'),button:el('payroll-unlock'),login:el('payroll-login'),account:el('payroll-account-state'),details:el('payroll-client-settings')};
}
function showAccount(ui:GateUI, state:'checking'|'connected'|'disconnected'|'error', user?:Account):void {
 const label=ui.account.querySelector<HTMLElement>('#payroll-account-label')!;
 ui.account.className=`payroll-cloud-account is-${state}`;
 label.textContent=state==='connected'
  ? `Microsoft接続済み · ${user?.username??'アカウント確認済み'}`
  : state==='checking'?'Microsoftアカウントを確認中…'
  : state==='error'?'Microsoftの接続設定を確認してください':'Microsoftアカウントへの接続が必要です';
 // 接続済みなのに押しても無反応なボタンを表示しない。
 ui.login.hidden=state==='connected'||state==='checking';
 ui.login.disabled=state==='checking'||state==='connected';
 ui.button.disabled=state!=='connected';
}
async function beginUnlock():Promise<PayrollVault> {
 const ui=mount();ui.id.value=clientId();
 if(!validId(clientId())){ui.details.open=true;showAccount(ui,'disconnected');}
 const ready=new Promise<PayrollVault>((resolve)=>{
  ui.login.addEventListener('click',()=>{void(async()=>{
   ui.login.disabled=true;
   ui.login.textContent='Microsoft接続を確認中…';
   try{
    const id=ui.id.value.trim();if(!validId(id))throw new Error('Client IDの形式が不正です。');
    if(clientId()!==id){clearTabUnlock();invalidateAuthSession();localStorage.setItem(CLIENT_KEY,id);msal=undefined;tokenCache=undefined;tokenPending=undefined;}
    const app=await getMsal();
    const user=account(app);
    if(user){showAccount(ui,'connected',user);ui.status.textContent='復号パスフレーズを入力してください。';return;}
    if(!window.confirm('Microsoftアカウントのログイン画面へ移動します。続行しますか？'))return;
    ui.status.textContent='Microsoftのログイン画面へ移動しています…';
    await app.loginRedirect({scopes:SCOPES,prompt:'select_account'});
   }catch(e){showAccount(ui,'error');ui.status.textContent=e instanceof Error?e.message:String(e);}
   finally{ui.login.textContent='Microsoftアカウントに接続';if(!ui.login.hidden)ui.login.disabled=false;}
  })();});
  ui.button.addEventListener('click',()=>{void(async()=>{
   ui.button.disabled=true;
   ui.button.textContent='保管庫を確認しています…';
   try {
    if(ui.id.value.trim()!==clientId())throw new Error('接続設定を保存し、Microsoftアカウントへ接続してください。');
    const app=await getMsal();if(!account(app))throw new Error('Microsoftアカウントへの接続が必要です。');
    const pass=ui.password.value;if([...pass].length<12)throw new Error('パスフレーズは12文字以上にしてください。');
    const candidate=new PayrollVault(new PayrollGraph(token,undefined,invalidateNavigationSnapshot));
    const connected=account(app)!;
    const scope=sessionScope(clientId(),connected);
    candidate.setNavigationScope(scope);
    const retain=ui.remember.checked ? (raw:Uint8Array,salt:string)=>{rememberTabUnlock(scope,raw,salt);} : undefined;
    if(!ui.remember.checked)clearTabUnlock();
    ui.status.textContent='OneDriveの暗号索引を確認しています…';
    let unlocked=false;
    let recoveryApproved=false;
    try { unlocked=await candidate.unlock(pass,false,retain); }
    catch(e) {
     if(e instanceof InterruptedRotationError){
      if(!window.confirm('パスフレーズ変更が途中で中断された可能性があります。ほかのタブで変更処理が実行中でないことを確認しましたか？\n変更開始から30分以上経過していれば、旧鍵で保管庫の変更ロックを復旧できます。'))throw e;
      ui.status.textContent='変更処理の中断状態を検証しています…';
      const restored=await candidate.recoverInterruptedChange(pass);
      if(!restored)throw new Error('復旧する変更処理が見つかりません。再度開いてください。');
      unlocked=await candidate.unlock(pass,false,retain);
     } else if(!(e instanceof EmptyPayrollIndexError))throw e;
     else {
     const ok=window.confirm('OneDriveの payroll/index.enc が0バイトです。\n\nPayrollフォルダーに他の保存データがないことを再確認したうえで、この空ファイルを別名で退避し、新しい暗号化索引を作ります。\n\nファイルは削除せず、Financeのデータにも触れません。続行しますか？');
     if(!ok)throw new Error('空ファイルの復旧を中止しました。OneDriveは変更していません。');
     ui.status.textContent='空の索引を検証し、退避しています…';
     await candidate.graph.archiveEmptyIndex();
     recoveryApproved=true;
     }
    }
    if(!unlocked){
     if(!recoveryApproved){
      const who=account(app)?.username??'Microsoftアカウント';
      if(!window.confirm(`OneDriveにPayroll保管庫がありません。\n接続先: ${who}\n\n新しい暗号化保管庫を作成しますか？`))throw new Error('保管庫の新規作成を取り消しました。');
     }
     ui.status.textContent='暗号化索引を作成し、保存結果を検証しています…';
     unlocked=await candidate.unlock(pass,true,retain);
    }
    if(!unlocked)throw new Error('保管庫を解除できませんでした。');
    ui.status.textContent='復号に成功しました。セッションを引き継いでいます…';
    const session=candidate.sessionKey();
    await rememberKey(scope,session.key,session.salt);
    ui.password.value='';vault=candidate;ui.panel.remove();installHomeLock(scope);resolve(candidate);
   }catch(e){ui.status.textContent=e instanceof Error?e.message:String(e);ui.button.disabled=false;ui.button.textContent='保管庫を開く';}
  })();});
 });
 if(validId(clientId())) {
  showAccount(ui,'checking');
  void getMsal().then(app=>{const user=account(app);showAccount(ui,user?'connected':'disconnected',user);}).catch(e=>{
   showAccount(ui,'error');ui.status.textContent=e instanceof Error?e.message:String(e);
  });
 }
 return ready;
}
/** A lock action is available on the home page without adding clutter to each subpage. */
function installHomeLock(scope:string):void {
 const footer=document.querySelector<HTMLElement>('.site-footer');
 if(!footer||footer.querySelector('#payroll-cloud-lock'))return;
 const button=document.createElement('button');button.id='payroll-cloud-lock';
 button.type='button';button.className='payroll-cloud-lock';button.textContent='保管庫をロック';
 button.title='このタブの一時的な解除状態を破棄します';
 button.addEventListener('click',()=>{void(async()=>{
  button.disabled=true;
  clearTabUnlock();invalidateAuthSession();await clearKey(scope);tokenCache=undefined;tokenPending=undefined;
  vault?.lock();vault=undefined;unlocking=undefined;
  window.location.reload();
 })();});
 footer.append(button);
}

/** ページ移動・Ctrl+R後は同じMicrosoftアカウントを確認してサイレント復号。
 * メモリのみの鍵を最優先し、利用者が明示的に許可したときだけ
 * タブの一時解除鍵を使う。新しいアカウントでは決して流用しない。 */
async function resumeOrPrompt():Promise<PayrollVault> {
 const id=clientId();
 if(validId(id)) {
  try {
   const app=await getMsal();
   const user=account(app);
   if(user) {
    const scope=sessionScope(id,user);
    // sessionStorageはページをまたぐ。SharedWorker単独ではリロード時に消えることがある。
    // 期限切れの一時鍵は復元時に除去される。
    const tabSession=await restoredTabUnlock(scope);
    const session=tabSession??await restoredKey(scope);
    if(session) {
     try {
      const candidate=new PayrollVault(new PayrollGraph(token,undefined,invalidateNavigationSnapshot));
      candidate.setNavigationScope(scope);
      if(!await candidate.resumeFromSnapshot(session.key,session.salt))
       await candidate.unlockWithKey(session.key,session.salt);
      vault=candidate;
      await rememberKey(scope,session.key,session.salt);
      installHomeLock(scope);
      return candidate;
     } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(/暗号鍵|パスフレーズ|破損|暗号形式|用途が一致/.test(message)) {
       clearTabUnlock();await clearKey(scope);
      }
      // OneDriveへの接続不良だけでtabSessionを削除しない。
     }
    }
   }
  }catch { /* Microsoft認証が必要ならモーダルで案内する */ }
 }
 return beginUnlock();
}
export async function cloudVault():Promise<PayrollVault> {
 if(vault?.isUnlocked())return vault;
 if(!unlocking)unlocking=resumeOrPrompt();
 try{return await unlocking;}catch(e){unlocking=undefined;throw e;}
}


/** 保管庫の鍵切替後、古いタブ鍵とSharedWorker鍵を無効化して新鍵に差し替える。 */
export async function refreshSessionAfterKeyRotation():Promise<void> {
 const app=await getMsal(),user=account(app);
 if(!user)throw new Error('Microsoft接続を確認できません。変更後の新しいパスフレーズで入り直してください。');
 const scope=sessionScope(clientId(),user);
 clearTabUnlock();clearNavigationSnapshot();
 await clearKey(scope);
 if(vault?.isUnlocked()){
  const session=vault.sessionKey();
  await rememberKey(scope,session.key,session.salt);
 }
}

/** Settings page can inspect MSAL account selection without unlocking salary data. */
export async function cloudConnectionState():Promise<{clientId:string;user:string|null;error?:string}> {
 const id=clientId();
 if(!validId(id))return {clientId:id,user:null};
 try{const app=await getMsal();return {clientId:id,user:account(app)?.username??(account(app)?'Microsoftアカウント':null)};}
 catch(error){return {clientId:id,user:null,error:error instanceof Error?error.message:String(error)};}
}
/** Client ID is public configuration, not a credential. Other settings are never overwritten. */
export async function saveCloudClientId(input:string):Promise<'unchanged'|'changed'> {
 const id=input.trim();if(!validId(id))throw new Error('Client IDはUUID形式で指定してください。');
 if(id===clientId())return 'unchanged';
 const previous=msal?account(msal):undefined;
 if(previous)await clearKey(sessionScope(clientId(),previous));
 clearTabUnlock();invalidateAuthSession();
 vault?.lock();vault=undefined;unlocking=undefined;
 tokenCache=undefined;tokenPending=undefined;msal=undefined;pending=undefined;
 localStorage.setItem(CLIENT_KEY,id);
 return 'changed';
}
/** Explicit switch/login button. OAuth tokens remain exclusively under MSAL. */
export async function chooseMicrosoftAccount():Promise<void> {
 const app=await getMsal();
 const previous=account(app);
 if(previous)await clearKey(sessionScope(clientId(),previous));
 clearTabUnlock();invalidateAuthSession();vault?.lock();vault=undefined;unlocking=undefined;
 tokenCache=undefined;tokenPending=undefined;
 await app.loginRedirect({scopes:SCOPES,prompt:'select_account'});
}

/** Exact SPA redirect URI shown so the user can register the single expected URL. */
export function cloudRedirectUri():string{return redirectUri();}
