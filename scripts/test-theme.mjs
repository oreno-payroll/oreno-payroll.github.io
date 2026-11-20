/** Dark appearance regression checks: no payroll data or network access. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const pages = [
  'public/index.html', 'public/upload/index.html', 'public/edit/index.html',
  'public/backup/index.html', 'public/year-end-assist/index.html', 'public/view/index.html',
];
for (const page of pages) {
  const html = read(page);
  assert.equal((html.match(/data-theme-toggle/g) ?? []).length, 1, `${page}: exactly one theme control`);
  assert.match(html, /class="theme-toggle"/, `${page}: icon-only theme control`);
  assert.match(html, /aria-label="ダークモードに切り替える"/, `${page}: accessible label`);
  assert.match(html, /theme-icon--moon/, `${page}: moon icon`);
  assert.match(html, /theme-icon--sun/, `${page}: sun icon`);
  assert.match(html, /<script src="(?:\.\.\/|\.\/)theme\.js"><\/script>/, `${page}: local external script`);
  assert.match(html, /<link rel="stylesheet" href="(?:\.\.\/|\.\/)styles\/theme\.css">/, `${page}: common palette`);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('theme.js'), `${page}: CSP enforced before script`);
  assert.ok(html.indexOf('theme.js') < html.indexOf('style.css'), `${page}: theme selected before CSS paints`);
  assert.ok(html.indexOf('theme.css') > html.indexOf('style.css'), `${page}: dark rules override base CSS`);
  assert.ok(html.indexOf('theme.css') < html.indexOf('</head>'), `${page}: palette loaded in head`);
  assert.ok(!/\bonclick\s*=/.test(html), `${page}: no inline handler`);
  // Navigation actions remain rightmost, rather than the theme control.
  const header = html.match(/<(?:div class="header-actions"|header class="reader-toolbar")[^>]*>([\s\S]*?)<\/(?:div|header)>/);
  assert.ok(header, `${page}: header action container exists`);
  const toggleAt = header[1].indexOf('data-theme-toggle');
  assert.ok(toggleAt >= 0, `${page}: theme control in header`);
  if (page === 'public/index.html') {
    assert.ok(header[1].indexOf('href="./backup/index.html"') < toggleAt, 'Home: theme immediately after settings');
    assert.ok(toggleAt < header[1].indexOf('href="./year-end-assist/index.html"'), 'Home: year-end navigation follows theme');
    assert.ok(header[1].indexOf('href="./upload/index.html"') > toggleAt, 'Home: upload CTA remains rightmost');
  } else {
    assert.ok(toggleAt < header[1].lastIndexOf('href="../index.html"'), `${page}: back/home navigation remains rightmost`);
  }
}
const theme = read('src/theme.ts');
assert.match(theme, /localStorage\.setItem\(key, next\)/, 'choice persists between views');
assert.match(theme, /window\.addEventListener\('storage'/, 'sync across open tabs');
assert.match(theme, /try \{ localStorage\.setItem/, 'storage exceptions handled');
assert.match(theme, /aria-pressed/, 'accessible pressed state');
assert.doesNotMatch(theme, /prefers-color-scheme|matchMedia/, 'no OS theme dependency');
assert.doesNotMatch(theme, /fetch\(|XMLHttpRequest|indexedDB/, 'no payroll/network data side effects');
const css = read('public/styles/theme.css');
for (const expected of ['color-scheme:dark', '.site-header .header-actions', '.app-status', '.yea-month[data-state="actual"]', '.segmented-choice', '.payroll-cloud-dialog input']) {
  assert.ok(css.includes(expected), `Shared dark palette missing ${expected}`);
}
// Regression: a shorthand `background:` on the custom select resets its no-repeat
// rule and draws hundreds of little chevrons in dark mode.
assert.match(css, /html\[data-theme="dark"\] select\.select \{[\s\S]*?background-repeat:no-repeat;/);
assert.match(css, /html\[data-theme="dark"\] select\.select \{[\s\S]*?background-position:right 11px center;/);
assert.match(css, /html\[data-theme="dark"\] \.settings-page \.vault-info \{ background:transparent;/, 'Settings metadata stays unboxed in dark mode');
console.log('PASS: theme control order, 6 pages, CSP, persistence, select arrow, backup metadata');
