/** UI regression guard. Synthetic/static assertions only, no OneDrive or salary data. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const upload=source('src/upload.ts');
const home=source('public/index.html');
const main=source('src/main.ts');
const auth=source('src/cloud/auth.ts');
const dashboard=source('public/styles/dashboard.css');
const settings=source('public/backup/index.html');
const settingsCss=source('public/styles/vault.css');

// The no-new-records result is a successful duplicate skip, not an error.
assert.match(upload,/if \(result\.saved\) \{/);
assert.match(upload,/saveStage\.textContent='新しく保存する明細はありません'/);
assert.match(upload,/重複として除外したファイルを下で確認してください/);
assert.match(upload,/if\(!skipped\) window\.setTimeout\(\(\) => window\.location\.assign\('\.\.\/index\.html'\), 1500\)/);
assert.match(upload,/catch \(error\) \{[\s\S]*?showInlineError\(saveStatus, `保存に失敗しました/);
const noOpBranch=upload.match(/\} else \{\s*stopSaveClock\(\);([\s\S]*?)\n    \}\n    \/\/ 重複がなければ従来どおり自動帰還/);
assert.ok(noOpBranch,'duplicate-only success branch not found');
assert.doesNotMatch(noOpBranch[1],/saving\s*=\s*false|updateSaveState\(\)/,'no button flicker before navigation');
console.log('PASS: ordinary saves return home; duplicate results remain visible; save failures remain on screen');

const block=home.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/);
assert.ok(block,'home footer missing');
assert.match(block[1],/class="site-footer__about"/);
assert.match(block[1],/class="site-footer__actions"/);
assert.match(block[1],/Payroll · 個人用給与管理ツール/);
assert.match(block[1],/PDFの解析はブラウザ内で行います/);
assert.match(main,/footerActions\.append\(control\)/);
assert.match(auth,/footerActions\.append\(button\)/);
assert.match(main,/refresh\.className='site-footer__button'/);
assert.match(auth,/button\.className='payroll-cloud-lock site-footer__button'/);
assert.match(dashboard,/\.site-footer__actions\s*\{[^}]*justify-content: flex-end/);
assert.match(dashboard,/\.site-footer__about\s*\{[^}]*flex-direction: column/);
assert.match(dashboard,/@media \(max-width: 640px\)[\s\S]*?\.site-footer__actions \{ justify-content: flex-start/);
console.log('PASS: footer has stable description and action groups on desktop and mobile');

const finance=settings.match(/<section class="settings-details-column settings-finance-income"[^>]*>([\s\S]*?)<\/section>/);
assert.ok(finance,'Finance settings card missing');
assert.match(finance[1],/<div class="settings-action-row">\s*<button type="button" id="payroll-income-publish"/);
assert.match(settingsCss,/\.settings-page \.settings-details-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
assert.match(settingsCss,/\.settings-page \.settings-details-column \.settings-action-row,/);
assert.match(settingsCss,/\.settings-page \.settings-action-row \{[^}]*justify-content: flex-end/);
console.log('PASS: Finance action remains in shared settings panel below its description');
