/** Payroll-only MSAL account selection and error classification. No token storage here. */
export interface PayrollMsalAccount {homeAccountId:string;username?:string}
export type MicrosoftConnectionStatus='connected'|'disconnected'|'reauth'|'temporary';
const LAST_ACCOUNT_PREFIX='payroll-msal-last-account-v1:';
export const rememberedAccountKey=(clientId:string)=>LAST_ACCOUNT_PREFIX+clientId.toLowerCase();
export class MicrosoftSignInRequiredError extends Error {
 readonly kind='reauth';
 constructor(message='Microsoftアカウントの再認証が必要です。再接続ボタンから認証してください。'){super(message);this.name='MicrosoftSignInRequiredError';}
}
export type MicrosoftTemporaryReason='network'|'timeout'|'service'|'other';
export class MicrosoftTemporaryError extends Error {
 readonly kind='temporary';
 constructor(message='Microsoft認証を一時的に確認できません。通信状態を確認して再試行してください。',readonly reason:MicrosoftTemporaryReason='other'){
  super(message);this.name='MicrosoftTemporaryError';
 }
}
/** Keep transport failures distinct from an iframe timeout; never expose MSAL payloads in UI. */
export function microsoftSilentTemporaryError(error:unknown,offline=false):MicrosoftTemporaryError {
 const raw=error&&typeof error==='object'?error as {errorCode?:unknown;code?:unknown;name?:unknown}:{};
 const code=typeof raw.errorCode==='string'?raw.errorCode:typeof raw.code==='string'?raw.code:'';
 if(offline||raw.name==='TypeError'||[
  'network_error','no_network_connectivity','failed_to_fetch','post_request_failed',
  'get_request_failed',
 ].includes(code))
  return new MicrosoftTemporaryError('Microsoftとの通信に失敗しました。接続状態を確認して再試行してください。','network');
 if(['temporarily_unavailable','service_unavailable','server_error'].includes(code))
  return new MicrosoftTemporaryError('Microsoft側で認証処理を完了できませんでした。少し後で再接続してください。','service');
 if(['monitor_window_timeout','timed_out','iframe_closed_prematurely'].includes(code))
  return new MicrosoftTemporaryError('Microsoftのサイレント認証が時間内に完了しませんでした。再接続を選ぶとMicrosoftの認証画面で確認できます。','timeout');
 return new MicrosoftTemporaryError();
}
/** Public, curated diagnostic labels. Never expose MSAL raw text, stack traces or OAuth contents. */
export type MicrosoftDiagnosticCode='AUTH_REAUTH'|'AUTH_OFFLINE'|'AUTH_NETWORK'|'AUTH_TIMEOUT'|'AUTH_SERVICE'|'AUTH_TEMPORARY'|'AUTH_INITIALIZE';
export interface MicrosoftDiagnostic {code:MicrosoftDiagnosticCode;message:string}
export function microsoftDiagnostic(error:unknown,offline=false):MicrosoftDiagnostic {
 if(offline)return {code:'AUTH_OFFLINE',message:'端末がオフラインです。ネットワーク接続を確認してください。'};
 if(error instanceof MicrosoftSignInRequiredError)
  return {code:'AUTH_REAUTH',message:'Microsoftアカウントの再認証が必要です。元のアカウントで再接続してください。'};
 if(error instanceof MicrosoftTemporaryError){
  if(error.reason==='timeout')return {code:'AUTH_TIMEOUT',message:'Microsoftのサイレント認証がタイムアウトしました。「再接続」から認証画面へ進んでください。'};
  if(error.reason==='network')return {code:'AUTH_NETWORK',message:'Microsoftとの通信に失敗しました。ネットワーク状態を確認して再試行してください。'};
  if(error.reason==='service')return {code:'AUTH_SERVICE',message:'Microsoft側の一時的な認証エラーです。少し後で再接続してください。'};
  return {code:'AUTH_TEMPORARY',message:'Microsoft認証を確認できませんでした。「再接続」をお試しください。'};
 }
 return {code:'AUTH_INITIALIZE',message:'Microsoft認証の初期化に失敗しました。ページを再読み込みし、再接続してください。'};
}
export type PayrollRedirectIntent={mode:'reconnect'|'signin'|'switch';expectedAccountId?:string};
/** Never trust a redirected identity as a switch unless the user explicitly requested it. */
export function selectPayrollAccountAfterRedirect<T extends PayrollMsalAccount>(
 accounts:T[],previousId:string,active:T|null,redirected:T|null,intent:PayrollRedirectIntent|null,
):T|undefined {
 if(redirected?.homeAccountId&&intent?.mode==='reconnect'&&redirected.homeAccountId!==intent.expectedAccountId)
  throw new MicrosoftSignInRequiredError('再接続で以前と異なるMicrosoftアカウントが返されました。元のアカウントで再接続するか、設定から明示的にアカウントを切り替えてください。');
 const approved=Boolean(redirected)&&(
  intent?.mode==='switch'||
  (intent?.mode==='signin'&&!previousId)||
  (intent?.mode==='reconnect'&&intent.expectedAccountId===redirected?.homeAccountId)
 );
 return pickPayrollAccount(accounts,previousId,active,approved?redirected:null);
}
/** MSAL's typed/errorCode signals, not guessed Japanese error text. */
export function needsMicrosoftInteraction(error:unknown):boolean {
 if(!error||typeof error!=='object')return false;
 const value=error as {name?:unknown;errorCode?:unknown;code?:unknown};
 if(value.name==='InteractionRequiredAuthError')return true;
 const code=typeof value.errorCode==='string'?value.errorCode:typeof value.code==='string'?value.code:'';
 return ['interaction_required','login_required','consent_required','no_tokens_found','no_account_error','bad_token','token_refresh_required'].includes(code);
}
/** A pinned account disappearing must never silently switch Payroll to another OneDrive. */
export function pickPayrollAccount<T extends PayrollMsalAccount>(accounts:T[],previousId:string,active:T|null,redirected:T|null):T|undefined {
 if(redirected?.homeAccountId)return redirected;
 if(previousId)return accounts.find(user=>user.homeAccountId===previousId);
 if(accounts.length===1)return accounts[0];
 // In a multi-account cache, an arbitrary MSAL activeAccount can be stale or shared.
 // Require an explicit selection instead of guessing.
 return undefined;
}
