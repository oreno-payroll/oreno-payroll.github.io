/** V22 UX safety: no real PDF, credentials or salary data. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const edit=read('src/edit.ts'),upload=read('src/upload.ts'),html=read('public/upload/index.html');
const dashboard=read('public/styles/dashboard.css'),theme=read('public/styles/theme.css'),css=read('public/styles/style.css');
for(const page of ['public/upload/index.html','public/edit/index.html']){
  assert.doesNotMatch(read(page),/<nav class="breadcrumb"/,'the header already links to home');
  assert.match(read(page),/ホームへ戻る/);
}
assert.match(edit,/saveButton\.disabled = saving \|\| !changed \|\| errors\.length/);
assert.match(edit,/if \(!record \|\| saving \|\| deletionNeedsReload \|\| !hasUnsavedChanges\(\)\) return/);
assert.match(edit,/subject:`残す明細：\$\{employerDisplayName\(employerDirectory,updated\.employerId,updated\.form\.job\)\}/);
assert.match(edit,/一覧・収入情報から除外する明細：\$\{conflicts\.length\}件/);
assert.match(edit,/employerDisplayName\(employerDirectory,c\.employerId,c\.period\.split/);
assert.match(upload,/describeUploadDuplicates\(result\.skipped/);
assert.match(upload,/saveDuplicates\.hidden=false/);
assert.match(upload,/if\(!skipped\) \{[\s\S]*?rememberNavigationNotice\([\s\S]*?window\.location\.assign\('\.\.\/index\.html'\)/);
assert.match(upload,/leavingAfterSave && saveFeedback\.classList\.contains\('is-complete'\)/);
for(const id of ['save-duplicates','save-duplicate-list','save-duplicate-title']) assert.match(html,new RegExp(`id="${id}"`));
assert.match(dashboard,/\.details-list > div\.has-missing-data,\s*\.job-card__footer\.has-missing-data\s*\{\s*align-items:\s*flex-start/);
assert.match(dashboard,/\.forecast-caution--warning \{[^}]*var\(--state-warning-bg\)/);
assert.doesNotMatch(dashboard,/\.job-card__footer\.has-missing-data,\s*\.forecast-caution--warning/);
assert.doesNotMatch(theme,/html\[data-theme="dark"\] \.details-list > div\.has-missing-data/);
for(const token of ['selected-bg','selected-border','warning-bg','warning-border','warning-text','error-bg','error-border','success-bg']){
  assert.ok(css.includes(`--state-${token}:`));assert.ok(theme.includes(`--state-${token}:`));
}
const {describeUploadDuplicates}=await import('../src/ui/duplicateResult.ts');
assert.deepEqual(describeUploadDuplicates([
 {fileName:'stored-a.pdf',originalFileName:'original-a.pdf',reason:'saved-pdf'},
 {fileName:'stored-b.pdf',originalFileName:'original-b.pdf',reason:'saved-period'},
 {fileName:'stored-c.pdf',reason:'batch-period'},
], [{fileName:'duplicate.pdf',firstFileName:'first.pdf'}]), [
 {fileName:'original-a.pdf',reason:'OneDriveに同一PDF原本が登録済み'},
 {fileName:'original-b.pdf',reason:'OneDriveに同じ勤務先・対象年月・種別の明細が登録済み'},
 {fileName:'stored-c.pdf',reason:'今回の保存対象に同じ勤務先・対象年月・種別の明細がある'},
 {fileName:'duplicate.pdf',reason:'今回のアップロード内の同一PDF（先に追加: first.pdf）'},
]);
console.log('PASS: v22 save no-op, explicit conflict, duplicate details, navigation and role-based colors');
