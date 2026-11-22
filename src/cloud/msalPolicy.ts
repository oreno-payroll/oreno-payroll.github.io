/** Payroll-only MSAL account selection and error classification. No token storage here. */
export interface PayrollMsalAccount {homeAccountId:string;username?:string}
export type MicrosoftConnectionStatus='connected'|'disconnected'|'reauth'|'temporary';
const LAST_ACCOUNT_PREFIX='payroll-msal-last-account-v1:';
export const rememberedAccountKey=(clientId:string)=>LAST_ACCOUNT_PREFIX+clientId.toLowerCase();
export class MicrosoftSignInRequiredError extends Error {
 readonly kind='reauth';
 constructor(message='Microsoftアカウントの再認証が必要です。再接続ボタンから認証してください。'){super(message);this.name='MicrosoftSignInRequiredError';}
}
export class MicrosoftTemporaryError extends Error {
 readonly kind='temporary';
 constructor(message='Microsoft認証を一時的に確認できません。通信状態を確認して再試行してください。'){super(message);this.name='MicrosoftTemporaryError';}
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
