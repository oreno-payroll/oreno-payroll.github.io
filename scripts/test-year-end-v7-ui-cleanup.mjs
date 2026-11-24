/** UI cleanup: no example prefixes, redundant month text or blocked cursors. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/year-end-assist/index.html');
const css=read('public/styles/year-end-assist.css');
const ts=read('src/year-end-assist.ts');
assert.doesNotMatch(html, /placeholder\s*=\s*["']例[：:]/);
assert.match(html, /placeholder="スタッフA"/);
assert.match(html, /placeholder="メモを入力"/);
assert.doesNotMatch(html, /灰色の月は|未確定月は、|推定方法を切り替えると|id="yea-method-help"|id="yea-estimate-summary"/);
assert.doesNotMatch(html, /賞与は必要な場合のみ入力してください/);
assert.doesNotMatch(css, /\.yea-month\[data-state="actual"\] \.yea-month__head::after/);
assert.doesNotMatch(ts, /amount\.title='確定済み給与/);
assert.doesNotMatch(css, /cursor:not-allowed/);
assert.match(read('public/styles/style.css'), /details\[open\] > \.accordion-summary::after \{ transform:rotate\(45deg\)/);
assert.match(read('public/styles/style.css'), /\.accordion-summary::after \{[^}]*transform:rotate\(-45deg\)/);
console.log('PASS: placeholders, lean month cards, neutral disabled cursors and chevrons for ALL accordions');
