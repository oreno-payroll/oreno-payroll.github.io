/** Synthetic-only settings security UX regression: no account, tokens, or Graph. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from "node:module";
import {readFileSync} from 'node:fs';
import {operationFeedback} from '../src/ui/operationOutcome.ts';
import {microsoftDiagnostic,microsoftSilentTemporaryError,MicrosoftSignInRequiredError} from '../src/cloud/msalPolicy.ts';
const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const backup=source('src/backup.ts'),auth=source('src/cloud/auth.ts'),html=source('public/backup/index.html');
const success=operationFeedback('削除',{status:'success',message:''});
const error=operationFeedback('削除',{status:'error',message:'アクセス権限がありません'});
const partial=operationFeedback('削除',{status:'partial',message:''});
assert.equal(success.kind,'success');
assert.equal(error.kind,'error');
assert.equal(error.message,'アクセス権限がありません');
assert.equal(partial.kind,'partial');
assert.match(partial.message,/一部完了/);
assert.equal(operationFeedback('削除',null).kind,'error');
assert.equal(operationFeedback('削除',{status:'success',message:'できません'}).kind,'success','user-visible text must never decide success');
assert.doesNotMatch(backup,/失敗\|できません\|中断\|停止\|エラー\|未完了\|問題\|不正/,'no string-based classification');
assert.match(backup,/operationFeedback\(/);
assert.match(backup,/operationResult:OperationResult\|null=null/);
assert.match(backup,/finishOperation\('partial'\)/,'partial operations are marked explicitly');
console.log('PASS: explicit success/partial/error, unknown fails closed, wording cannot change status');
const entry=backup.slice(backup.indexOf("cloudLogin.addEventListener('click'"),backup.indexOf('let logoutRedirectReady=false;'));
const consent=entry.indexOf('await approveSettings('),disable=entry.indexOf('cloudLogin.disabled=true'),switchAccount=entry.indexOf('chooseMicrosoftAccount()');
assert.ok(consent>=0 && disable>consent && switchAccount>consent,'confirmation must precede any account switch');
assert.match(entry,/すべてのタブをロック/);
assert.match(entry,/未保存/);
assert.match(auth,/tabLocks\.broadcast\(true\);clearTabUnlock\(\);invalidateAuthSession\(\)/,'security lock retained');
console.log('PASS: switch confirmation precedes lock, warns about all tabs and unsaved work');
for (const [error,expected] of [
 [microsoftSilentTemporaryError({errorCode:'monitor_window_timeout'}),'AUTH_TIMEOUT'],
 [microsoftSilentTemporaryError({errorCode:'network_error'}),'AUTH_NETWORK'],
 [microsoftSilentTemporaryError({errorCode:'temporarily_unavailable'}),'AUTH_SERVICE'],
 [microsoftSilentTemporaryError({errorCode:'unrecognized'}),'AUTH_TEMPORARY'],
 [new MicrosoftSignInRequiredError(),'AUTH_REAUTH'],
]) assert.equal(microsoftDiagnostic(error).code,expected);
assert.equal(microsoftDiagnostic(new Error('SYNTHETIC_UNSAFE_DETAIL_NO_ECHO')).code,'AUTH_INITIALIZE');
assert.doesNotMatch(microsoftDiagnostic(new Error('SYNTHETIC_UNSAFE_DETAIL_NO_ECHO')).message,/SYNTHETIC_UNSAFE_DETAIL_NO_ECHO/);
assert.equal(microsoftDiagnostic({},true).code,'AUTH_OFFLINE');
assert.match(auth,/diagnosticCode\?:string/);
assert.match(auth,/error.reason==='network'\|\|error.reason==='service'/,'service outage must not trigger account redirects');
assert.match(backup,/cloudDiagnostic\.textContent/);
assert.match(html,/id="backup-cloud-diagnostic"/);
assert.equal(/cloudState\.textContent=error instanceof Error\?error\.message/.test(backup),false,'untrusted exception details must not be displayed in account status');
assert.match(backup,/診断コード：AUTH_SETTINGS/,'settings errors have a curated, fixed code');
// Execute the exact Client ID save handler with a hostile synthetic exception.
// Neither a stack trace nor any text from the exception can reach the UI.
const saveHandler=backup.slice(backup.indexOf("cloudSave.addEventListener('click'"),backup.indexOf("cloudReconnect.addEventListener('click'"));
assert.match(saveHandler,/catch\{/,'Client ID save uses a sanitized error handler');
async function saveFailureScenario(input){
 let click;
 const cloudSave={disabled:false,addEventListener:(_event,listener)=>{click=listener}};
 const cloudState={textContent:'',dataset:{}};
 const cloudDiagnostic={textContent:'',hidden:true};
 const context={
  busy:false,cloudSave,cloudState,cloudDiagnostic,cloudId:{value:input},
  saveCloudClientId:async()=>{throw new Error('SYNTHETIC_UNSAFE_SECRET_SHOULD_NOT_RENDER');},
  location:{reload(){throw new Error('unexpected reload');}},
 };
 vm.runInNewContext(saveHandler,context);
 click();await new Promise(setImmediate);
 assert.equal(cloudSave.disabled,false);
 assert.equal(cloudState.dataset.error,'true');
 assert.doesNotMatch(cloudState.textContent+cloudDiagnostic.textContent,/SYNTHETIC_UNSAFE_SECRET_SHOULD_NOT_RENDER/);
 return {cloudState,cloudDiagnostic};
}
const invalidId=await saveFailureScenario('invalid-id');
assert.match(invalidId.cloudState.textContent,/UUID/);
assert.equal(invalidId.cloudDiagnostic.hidden,true);
const validIdFailure=await saveFailureScenario('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
assert.match(validIdFailure.cloudState.textContent,/保存できませんでした/);
assert.equal(validIdFailure.cloudDiagnostic.textContent,'診断コード：AUTH_SETTINGS');

console.log('PASS: offline/network/timeout/service/reauth distinct, safe bounded diagnostic code, no exception payloads');

// Exercise the real click handler with a synthetic confirmation and identity API.
async function switchScenario(approve){
 const events=[];let click;
 const cloudLogin={disabled:false,addEventListener:(_type,callback)=>{click=callback;}};
 const context={
  cloudLogin,busy:false,approveSettings:async(_request,guard)=>{events.push('confirm');return approve&&guard();},
  chooseMicrosoftAccount:async()=>{events.push('switch');},
  cloudState:{textContent:'',dataset:{}},cloudDiagnostic:{hidden:true,textContent:''},
  microsoftDiagnostic:()=>({message:'synthetic failure',code:'AUTH_INITIALIZE'}),navigator:{onLine:true},
 };
 vm.runInNewContext(entry,context);
 click();await new Promise(setImmediate);
 return {events,cloudLogin};
}
const cancelled=await switchScenario(false);
assert.deepEqual(cancelled.events,['confirm']);
assert.equal(cancelled.cloudLogin.disabled,false,'cancel does not lock, redirect, or disable');
const approved=await switchScenario(true);
assert.deepEqual(approved.events,['confirm','switch']);
console.log('PASS: actual account-switch click cancels without invoking any lock/switch action');

// Execute the real notification transition with explicit result objects.
const transition=backup.slice(backup.indexOf('function reportStatusTransition(){'),backup.indexOf('\nconst sizes ='));
assert.ok(transition.startsWith('function reportStatusTransition(){'));
function testTransition(result){
 const shown=[];
 const appStatus={clear:()=>shown.push(['clear']),loading:m=>shown.push(['loading',m]),success:m=>shown.push(['success',m]),error:m=>shown.push(['error',m]),show:(kind,m)=>shown.push([kind,m])};
 const context={busy:false,wasBusy:true,currentOperation:{label:'旧DBを削除',result:'legacy-cleanup-status'},operationResult:result,operationCancelled:false,notificationScope:undefined,appStatus,operationFeedback};
 vm.runInNewContext(transition+'\nglobalThis.fire=reportStatusTransition;',context);
 context.fire();return shown;
}
assert.equal(testTransition({status:'success',message:'できませんでしたと表示されても明示成功'})[0][0],'success');
assert.equal(testTransition({status:'error',message:'アクセス権限がありません'})[0][0],'error');
assert.equal(testTransition({status:'partial',message:''})[0][0],'partial');
assert.equal(testTransition(null)[0][0],'error');
console.log('PASS: actual transition uses the typed result, not the message body');

// Real settings retry target selection. A destination or selected record change
// must not silently resolve a different operation, even with the same code.
{
 const targetSource=backup.slice(backup.indexOf('function settingsRetryTarget('),backup.indexOf('function reportStatusTransition(){'));
 const file={},otherFile={},newDraft={};
 const ctx={employerDraft:{id:'synthetic-a',noticeTarget:newDraft},bulkCandidates:()=>[{id:2},{id:1},{id:3}],bulkTarget:{value:'synthetic-a'},bulkSelected:new Set([2,1]),filePicker:{files:[file]},yearEndFile:{files:[otherFile]}};
 vm.runInNewContext(stripTypeScriptTypes(targetSource,{mode:'strip'})+'\nglobalThis.target=settingsRetryTarget;',ctx);
 const target=ctx.target;
 assert.equal(target('employer-directory-save'),'synthetic-a');
 ctx.employerDraft={id:'synthetic-b',noticeTarget:{}};assert.notEqual(target('employer-directory-save'),'synthetic-a');
 ctx.employerDraft={id:'',noticeTarget:newDraft};assert.equal(target('employer-directory-save'),newDraft);
 ctx.employerDraft={id:'',noticeTarget:{}};assert.notEqual(target('employer-directory-save'),newDraft);
 const selection=target('employer-bulk-save');ctx.bulkSelected=new Set([1,2]);assert.equal(target('employer-bulk-save'),selection);
 ctx.bulkSelected=new Set([1,3]);assert.notEqual(target('employer-bulk-save'),selection);
 ctx.bulkSelected=new Set([1,2]);ctx.bulkTarget.value='synthetic-b';assert.notEqual(target('employer-bulk-save'),selection);
 ctx.bulkSelected.clear();assert.equal(target('employer-bulk-save'),undefined);
 assert.equal(target('verify-button'),file);ctx.filePicker.files=[otherFile];assert.notEqual(target('verify-button'),file);
 assert.equal(target('ye-restore-verify'),otherFile);assert.equal(target('employer-directory-load'),'whole-dataset');
 assert.equal(target('restore-button'),undefined);assert.equal(target('cloud-cleanup-delete'),undefined);
}
console.log('PASS: settings retry identities distinguish employers, new drafts, bulk record sets and file selections');
