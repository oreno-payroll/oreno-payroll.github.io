/* MSAL Browser v5 dedicated redirect bridge. This page runs no app code. */
import {broadcastResponseToMainFrame} from '@azure/msal-browser/redirect-bridge';
broadcastResponseToMainFrame().catch(()=>{
  // No tokens or OAuth fragments in logs or telemetry.
  document.body.textContent='Microsoft認証結果をアプリへ返せませんでした。戻って再接続してください。';
});
