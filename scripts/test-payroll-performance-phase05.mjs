/** Phase 5: deterministic UX regressions, no personal records or Microsoft access. */
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
import {navigationFeedback} from '../src/ui/navigationNotice.ts';
import {dashboardFreshnessLabel} from '../src/ui/operationFeedback.ts';
const src=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
for(const state of ['checking','rechecking','snapshot','verified','stale','unavailable']){
 assert.ok(dashboardFreshnessLabel(state).length>3);
}
assert.match(dashboardFreshnessLabel('snapshot'),/表示専用/);
assert.match(dashboardFreshnessLabel('stale'),/変更操作は停止/);
assert.match(dashboardFreshnessLabel('unavailable'),/未表示/);
const dashboard=src('src/main.ts'),upload=src('src/upload.ts'),edit=src('src/edit.ts');
const store=src('src/storage/payrollStore.ts');
assert.match(dashboard,/dashboardHasView/);
assert.match(dashboard,/dashboardStale/);
assert.match(dashboard,/if\(!hadView\)\{registrationPanel\.hidden = true/,'a recheck must not erase a previously verified screen');
assert.match(dashboard,/if\(!hadView\)periodLabel\.textContent=message/,'background progress cannot replace a visible date range');
assert.match(dashboard,/dashboardHasView\?'stale':'unavailable'/);
assert.match(dashboard,/dashboardLoading\|\|dashboardStale/,'mutation gate must reject saving while rechecking or stale');
assert.match(dashboard,/sideZipButton\.disabled = exportingSideZip \|\| exportCount === 0 \|\| dashboardLoading \|\| dashboardStale/);
assert.match(upload,/function showSaveProgress\(view:PayrollSaveFeedback\)/);
assert.match(upload,/if\(view\.phase>=savePhase\)/,'parallel upload progress must not regress');
assert.match(upload,/saveProgress\.removeAttribute\('aria-valuenow'\)/,'unknown progress is indeterminate, never a fake percent');
assert.match(upload,/明細・PDFの書き込みは開始していません/);
assert.match(upload,/選択したPDFと入力内容は保持しています/);
assert.match(store,/onProgress\?\:\(stage:string\)=>void/,'metadata-only edit exposes progress callback without fetching PDF');
assert.match(store,/await vault\.save\(\{\.\.\.record,revision:\(prior\.revision\?\?0\)\+1\},onProgress,/);
assert.match(edit,/updateRecordMetadata\(updated, conflicts, recordSignature\(record\),stage=>appStatus\.loading\(stage\),employerDirectorySignature\(employerDirectory\)\)/);
assert.doesNotMatch(dashboard,/localStorage\.setItem\(|sessionStorage\.setItem\(/);
assert.doesNotMatch(upload,/localStorage\.setItem\(|sessionStorage\.setItem\(/);

// Execute the dashboard's actual refresh function against a synthetic, account-free
// UI. A failed fresh recheck must leave the last complete screen visible but lock
// cloud mutations until a later successful recheck.
{
 const begin=dashboard.indexOf('let dashboardValidUntil=0;');
 const finish=dashboard.indexOf('// Back/forward cache does not imply',begin);
 assert.ok(begin>=0&&finish>begin);
 const body=stripTypeScriptTypes(dashboard.slice(begin,finish),{mode:'strip'})+
  '\nglobalThis.phase5Refresh=refreshDashboard;globalThis.phase5State=()=>({dashboardHasView,dashboardStale,dashboardLoading});';
 const indicator={textContent:'',dataset:{}};
 const button={disabled:false,dataset:{recordId:'17'}};
 const refresh={disabled:false};
 const periodLabel={textContent:'',attributes:new Map(),style:{color:'',removeProperty(){}},
  setAttribute(k,v){this.attributes.set(k,v);},removeAttribute(k){this.attributes.delete(k);}};
 const registrationPanel={hidden:false};
 const yearSelect={disabled:false,value:'2026'},bonusToggle={disabled:false},forecastToggle={disabled:false};
 const sideZipButton={disabled:false},fiscalModeButton={disabled:false},calendarModeButton={disabled:false};
 const radios=[{disabled:false},{disabled:false},{disabled:false}];
 const periodControls=[yearSelect,bonusToggle,forecastToggle,fiscalModeButton,calendarModeButton,...radios];
 let tries=0,failInitial=true,renders=0;
 const notifications=[];const toastElement={dataset:{}};let nextNotice={operation:'upload-saved',count:3};
 const ctx={
  dashboardFreshnessLabel,registrationPanel,periodLabel,yearSelect,bonusToggle,forecastToggle,sideZipButton,fiscalModeButton,calendarModeButton,
  selectedPeriodRecords:()=>[{form:{job:'side'}}],exportingSideZip:false,
  deletionBusy:()=>false,renderPendingDeletion(){},renderList(){},initialYear:2026,currentPeriodYear:()=>2026,
  saved:[],employerDirectory:[],legacyDirectory:[],legacyEmployers:()=>[],employerFilter:{disabled:true},mutatingSnapshot:null,
  document:{getElementById:()=>indicator,querySelector:()=>refresh,querySelectorAll:selector=>selector.includes("statement-kind")?radios:[button]},
  appStatus:{element:toastElement,clear(){delete toastElement.dataset.state;notifications.push(['clear']);},loading(m){toastElement.dataset.state='loading';notifications.push(['loading',m]);},success(m){toastElement.dataset.state='success';notifications.push(['success',m]);},error(m){toastElement.dataset.state='error';notifications.push(['error',m]);},show(k,m){toastElement.dataset.state=k;notifications.push([k,m]);}},
  authEpoch:()=> 'fixture-epoch',takeNavigationNotice:()=>{const n=nextNotice;nextNotice=null;return n;},navigationFeedback,
  loadRecordSummaries:async opts=>{
   if(failInitial)throw new Error('synthetic initial failure');
   tries++;opts.onProgress?.('模擬: OneDrive読込中');
   if(tries===2)throw new Error('synthetic HTTP 503');
   opts.onEmployerDirectory?.([{id:'fixture',name:tries===1?'Synthetic old':'Synthetic new',role:'side',current:true}]);
   return [{id:17,form:{job:'side'}}];
  },
  updateYearOptions(){},render(){renders++;registrationPanel.hidden=false;periodLabel.textContent='2026年度の前回確認済みデータ';},
  mutationEpoch:()=> 'fixture-epoch',summaryCacheInfo:async()=>({cached:tries===1,deadline:Date.now()+120_000}),
  console:{error(){}},
 };
 runInNewContext(body,ctx);
 await ctx.phase5Refresh();
 assert.equal(ctx.phase5State().dashboardHasView,false);assert.equal(renders,0,'unavailable records must never be aggregated');
 assert.ok(periodControls.every(x=>x.disabled));assert.equal(sideZipButton.disabled,true);assert.equal(indicator.dataset.freshness,'unavailable');assert.equal(refresh.disabled,false);
 failInitial=false;
 await ctx.phase5Refresh();
 assert.ok(periodControls.every(x=>!x.disabled));
 assert.equal(ctx.phase5State().dashboardHasView,true);assert.equal(ctx.employerDirectory[0].name,'Synthetic old');
 assert.deepEqual(notifications.at(-1),['success','明細3件を保存しました。Finance連携データも更新済みです。']);
 assert.equal(nextNotice,null,'one-time handoff consumed after successful load');
 assert.match(indicator.textContent,/表示専用/);
 assert.equal(registrationPanel.hidden,false);assert.equal(button.disabled,false);
 const priorLabel=periodLabel.textContent;
 await ctx.phase5Refresh(true);
 assert.equal(ctx.phase5State().dashboardStale,true);assert.equal(ctx.employerDirectory[0].name,'Synthetic old');
 assert.equal(registrationPanel.hidden,false,'recheck error must not blank the previous complete screen');
 assert.equal(periodLabel.textContent,priorLabel,'recheck progress must not destroy visible fiscal period');
 assert.match(indicator.textContent,/変更操作は停止/);
 assert.equal(button.disabled,true,'a failed recheck disables deletion');
 assert.equal(sideZipButton.disabled,true,'a failed recheck disables bulk PDF ZIP');
 assert.equal(yearSelect.disabled,false,'local year filtering remains available');
 await ctx.phase5Refresh(true,{kind:'partial',message:'削除完了・連携未同期'});
 assert.deepEqual(notifications.at(-1),['partial','削除完了・連携未同期'],'refresh cannot overwrite operation outcome');
 assert.equal(ctx.phase5State().dashboardStale,false);assert.equal(ctx.employerDirectory[0].name,'Synthetic new');
 assert.equal(button.disabled,false,'successful Graph confirmation restores mutation controls');
 assert.equal(sideZipButton.disabled,false);
 assert.equal(indicator.textContent,'最新データ確認済み');
 await ctx.phase5Refresh(true);
 assert.deepEqual(notifications.at(-1),['partial','削除完了・連携未同期'],'ordinary read must preserve unresolved partial notice');
 ctx.appStatus.clear();
 await ctx.phase5Refresh(true);
 assert.deepEqual(notifications.at(-1),['clear'],'ordinary read completion must not show a success toast');
 assert.ok(!notifications.some(([kind])=>kind==='loading'),'dashboard progress must stay inline');
 assert.equal(tries,5,'each explicit refresh performs exactly one load');
}

console.log('PASS: phase 5 actual-stage UX, partial-sync truth, recheck preserving view, stale mutation lock, no new storage or network');
