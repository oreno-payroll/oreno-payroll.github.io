/** Local-first sign-out. A failing key store must never prevent an attempt to
 * clear the other key store, and MSAL must never run before local revocation. */
export interface SignOutSteps {
 lockImmediately():void;
 clearSharedWorkerKeys():Promise<void>;
 clearRememberedBrowserKeys():Promise<void>;
 logoutMicrosoft():Promise<void>;
}

export class LocalSignOutIncompleteError extends Error {
 constructor(readonly workerCleared:boolean,readonly browserKeysCleared:boolean) {
  const failures=[
   ...(!workerCleared?['SharedWorkerの一時鍵']:[]),
   ...(!browserKeysCleared?['ブラウザに記憶した鍵']:[]),
  ];
  super(`Payrollはロックしましたが、${failures.join('と')}の消去を確認できませんでした。Microsoftのサインアウトは開始していません。安全のため、再読み込み後にサインアウトを再試行してください。`);
  this.name='LocalSignOutIncompleteError';
 }
}

export async function signOutLocallyFirst(steps:SignOutSteps):Promise<void> {
 // This must be synchronous: no network or worker/IndexedDB wait before locking.
 steps.lockImmediately();
 let workerCleared=false;
 let browserKeysCleared=false;
 try {await steps.clearSharedWorkerKeys();workerCleared=true;}
 catch { /* The local lock remains active; still clear the other key store. */ }
 try {await steps.clearRememberedBrowserKeys();browserKeysCleared=true;}
 catch { /* Do not redirect or claim a full sign-out if any key may remain. */ }
 if(!workerCleared||!browserKeysCleared)
  throw new LocalSignOutIncompleteError(workerCleared,browserKeysCleared);
 // An MSAL initialization or logout failure cannot undo the local lock/erasure.
 await steps.logoutMicrosoft();
}
