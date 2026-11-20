import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../public/styles/year-end-assist.css', import.meta.url), 'utf8');
const ts = readFileSync(new URL('../src/year-end-assist.ts', import.meta.url), 'utf8');
// Both grid columns stretch to the same bottom edge without syncing equal card heights.
assert.match(css, /@media\(min-width:951px\)\{[\s\S]*?\.yea-upload-workspace\{align-items:stretch\}/);
assert.match(css, /\.yea-upload-left \.file-panel\{flex:1 1 0;min-height:0;display:flex;flex-direction:column\}/);
assert.match(css, /\.yea-upload-left \.file-list\{flex:1;min-height:0;max-height:none;overflow-y:auto/);
assert.doesNotMatch(css, /--yea-review-panel-height|height:var\(--yea-review-panel-height/);
assert.doesNotMatch(ts, /matchFilePanelToDetail|ResizeObserver/);
assert.match(css, /@media\(max-width:950px\)\{\.yea-upload-workspace\{grid-template-columns:minmax\(0,1fr\)\}\}/);
console.log('PASS: left list stretches below upload zone to match the right detail panel bottom, with inner scrolling');
