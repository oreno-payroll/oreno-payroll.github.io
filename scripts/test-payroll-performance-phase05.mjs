/** Phase 5: deterministic UX regressions, no personal records or Microsoft access. */
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
import {dashboardFreshnessLabel,describePayrollSaveProgress} from '../src/ui/operationFeedback.ts';
const src=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const sequences=[
 ['OneDriveの保存済み明細を確認しています…',0],
 ['PDF 1/3件：原本PDFを暗号化しています',1],
 ['原本PDFの保存・照合 2/3件完了',1],
 ['2026年度の解析データを保存・検証しています（0/3件確定）',2],
 ['収入データを支給年1件分同期しています',3],
 ['3件のOneDrive保存・読み戻し検証がすべて完了しました',4],
];
let last=0;
for(const [message,expected] of sequences){
 const next=describePayrollSaveProgress(message);
 assert.equal(next.phase,expected,message);assert.ok(next.phase>=last);last=next.phase;
}
assert.equal(describePayrollSaveProgress('PDF 1/2件：暗号化PDFの送信 75%').percent,75);
assert.equal(describePayrollSaveProgress('収入データを支給年1件分同期しています').percent,null,'PDF 100% does not imply a completed Finance sync');
assert.equal(describePayrollSaveProgress('PDF 2/4件：原本照合済み').count,'2 / 4件 · ');
assert.equal(describePayrollSaveProgress('プログレス 999%').percent,null);
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
assert.match(dashboard,/if\(!hadView\)registrationPanel\.hidden = true/,'a recheck must not erase a previously verified screen');
assert.match(dashboard,/if\(!hadView\)periodLabel\.textContent=message/,'background progress cannot replace a visible date range');
assert.match(dashboard,/dashboardHasView\?'stale':'unavailable'/);
assert.match(dashboard,/dashboardLoading\|\|dashboardStale/,'mutation gate must reject saving while rechecking or stale');
assert.match(dashboard,/sideZipButton\.disabled = exportingSideZip \|\| side\.length === 0 \|\| dashboardLoading \|\| dashboardStale/);
assert.match(upload,/describePayrollSaveProgress\(message\)/);
assert.match(upload,/if\(view\.phase>=savePhase\)/,'parallel upload progress must not regress');
assert.match(upload,/saveProgress\.removeAttribute\('aria-valuenow'\)/,'unknown progress is indeterminate, never a fake percent');
assert.match(upload,/saveGuidance\.textContent='OneDriveの保存済み一覧を確認してから再試行してください/);
assert.match(store,/onProgress\?\:\(stage:string\)=>void/,'metadata-only edit exposes progress callback without fetching PDF');
assert.match(store,/await vault\.save\(\{\.\.\.record,revision:\(prior\.revision\?\?0\)\+1\},onProgress,/);
assert.match(edit,/updateRecordMetadata\(updated, conflicts, recordSignature\(record\),stage=>appStatus\.loading\(stage\)\)/);
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
 const sideZipButton={disabled:false};
 let tries=0;
 const ctx={
  dashboardFreshnessLabel,registrationPanel,periodLabel,yearSelect,bonusToggle,forecastToggle,sideZipButton,
  selectedPeriodRecords:()=>[{form:{job:'side'}}],exportingSideZip:false,
  deletingRecordIds:new Set(),initialYear:2026,currentPeriodYear:()=>2026,
  saved:[],mutatingSnapshot:null,
  document:{getElementById:()=>indicator,querySelector:()=>refresh,querySelectorAll:()=>[button]},
  appStatus:{loading(){},success(){},error(){}},
  loadRecordSummaries:async opts=>{
   tries++;opts.onProgress?.('模擬: OneDrive読込中');
   if(tries===2)throw new Error('synthetic HTTP 503');
   return [{id:17,form:{job:'side'}}];
  },
  updateYearOptions(){},render(){registrationPanel.hidden=false;periodLabel.textContent='2026年度の前回確認済みデータ';},
  mutationEpoch:()=> 'fixture-epoch',summaryCacheInfo:async()=>({cached:tries===1,deadline:Date.now()+120_000}),
  console:{error(){}},
 };
 runInNewContext(body,ctx);
 await ctx.phase5Refresh();
 assert.equal(ctx.phase5State().dashboardHasView,true);
 assert.match(indicator.textContent,/表示専用/);
 assert.equal(registrationPanel.hidden,false);assert.equal(button.disabled,false);
 const priorLabel=periodLabel.textContent;
 await ctx.phase5Refresh(true);
 assert.equal(ctx.phase5State().dashboardStale,true);
 assert.equal(registrationPanel.hidden,false,'recheck error must not blank the previous complete screen');
 assert.equal(periodLabel.textContent,priorLabel,'recheck progress must not destroy visible fiscal period');
 assert.match(indicator.textContent,/変更操作は停止/);
 assert.equal(button.disabled,true,'a failed recheck disables deletion');
 assert.equal(sideZipButton.disabled,true,'a failed recheck disables bulk PDF ZIP');
 assert.equal(yearSelect.disabled,false,'local year filtering remains available');
 await ctx.phase5Refresh(true);
 assert.equal(ctx.phase5State().dashboardStale,false);
 assert.equal(button.disabled,false,'successful Graph confirmation restores mutation controls');
 assert.equal(sideZipButton.disabled,false);
 assert.equal(indicator.textContent,'OneDrive確認済み');
 assert.equal(tries,3,'UX-only updates may not initiate an additional cloud read');
}

console.log('PASS: phase 5 actual-stage UX, partial-sync truth, recheck preserving view, stale mutation lock, no new storage or network');
