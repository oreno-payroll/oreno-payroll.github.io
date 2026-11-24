/** Regression guard for desktop's empty upload state, without real PDFs or accounts. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const css = read('public/styles/upload.css');
const html = read('public/upload/index.html');
const ui = read('src/upload.ts');
const marker = 'PAYROLL-DESKTOP-EMPTY-UPLOAD-20261123';
assert.equal(css.split(marker).length - 1, 1, 'exactly one empty desktop override');
assert.ok(css.indexOf(marker) > css.indexOf('/* 2026-11: 左'), 'empty state overrides compact desktop layout');
const override = css.slice(css.indexOf(marker));
assert.equal((override.match(/align-items: start;/g) ?? []).length, 2, 'desktop and tablet are top-aligned');
assert.doesNotMatch(override, /align-items: center;/, 'empty state is never vertically centered');
assert.match(override, /@media \(min-width: 861px\)/);
assert.match(css, /\.workspace\.is-empty \{ grid-template-columns: minmax\(0,1fr\); width: 100%; \}/);
assert.doesNotMatch(override, /760px/, 'empty picker inherits the full app-shell content width');
assert.match(override, /\.upload-page \.workspace\.is-empty \{\s*grid-template-columns: minmax\(0, 1fr\)/);
assert.match(override, /\.upload-page \.workspace\.is-empty \.zone-content \{\s*min-height: clamp\(220px, 34dvh, 320px\)/);
assert.match(override, /@media \(min-width: 641px\) and \(max-width: 860px\)/);
assert.match(css, /\.upload-left \.zone-content \{ min-height: 133px/,'with-files uploader stays compact');
assert.match(css, /@media\(max-width:640px\)\{[\s\S]*?\.upload-zone-card #drop-zone\{display:none\}/);
assert.match(css, /\.mobile-file-picker-wrap\{display:none\}/);
assert.match(html, /class="workspace is-empty"/);
assert.match(html, /id="drop-zone" role="button"/);
assert.match(html, /id="mobile-file-picker"/);
assert.match(ui, /workspace\.classList\.toggle\('is-empty',isEmpty\)/);
assert.match(ui, /dropZone\.addEventListener\("click"/);
assert.match(ui, /mobileFilePicker\.addEventListener\("click"/);

// PAYROLL-UPLOAD-FOOTER-FIT-20261123: keep the version/footer visible without body-level scrolling.
assert.match(html, /<body class="payroll-upload-viewport">/, 'upload page owns scoped viewport sizing');
const footerFit = css.slice(css.indexOf('PAYROLL-UPLOAD-FOOTER-FIT-20261123'));
assert.match(footerFit, /@media \(min-width: 641px\) and \(min-height: 621px\)/);
assert.match(footerFit, /body\.payroll-upload-viewport \{[\s\S]*?height: 100dvh/);
assert.match(footerFit, /body\.payroll-upload-viewport > \.app-shell \{[\s\S]*?flex: 1 1 auto/);
assert.match(footerFit, /body\.payroll-upload-viewport \.upload-page \{[\s\S]*?height: auto/);
assert.doesNotMatch(html,/class="build-info"/);

console.log('PASS: desktop empty picker top-aligned/large, populated layout and mobile picker preserved');

// Startup UI is inert until the first render and every event handler are installed.
assert.match(html, /id="file-input"[^>]*\bdisabled\b/);
assert.match(html, /id="mobile-file-picker"[^>]*\bdisabled\b/);
assert.match(html, /id="drop-zone"[^>]*tabindex="-1"[^>]*aria-disabled="true"/);
assert.match(ui, /function updateFilePickerState\(\): void \{\s*if \(!uploadInitialized\) return;/);
assert.match(ui, /render\(\);\s*uploadInitialized = true;\s*updateFilePickerState\(\);\s*\/\/[^\n]*\nvoid refreshEmployerChoices\(false\);\s*$/);
assert.ok(ui.indexOf('fileInput.addEventListener("change"') < ui.lastIndexOf('uploadInitialized = true;'));
console.log('PASS: initial PDF picker is disabled until upload initialization');
