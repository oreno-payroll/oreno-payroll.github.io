/** Deterministic security and preservation regression guards; no live account or PDF. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {asVerifiedPdfBlob,requirePdfMime} from '../src/pdf/safePdf.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const ui=read('src/year-end-assist.ts');
const repo=read('src/yearEnd/repository.ts');
const handoff=read('src/pdf/yearEndHandoff.ts');
const view=read('src/view.ts');
const workflow=read('.github/workflows/deploy.yml');
assert.match(ui,/bonusChange,salaryUpdate/);
assert.match(ui,/function salaryUpdateRequested\(\)/);
assert.match(ui,/function validateForecastEditor\(\)/);
assert.match(ui,/aria-describedby/);
assert.match(repo,/salaryUpdate\?\[\]:context\.data\.noPaymentMonths/);
// The 2026-11 forecast fix preserves method/references of months whose amounts did not change.
assert.match(repo,/const updatedSalaryEstimates=salaryUpdate\?\(fresh\?\.estimated\?\?\[\]\)\.map\(nextEstimate=>\{/);
assert.match(repo,/const old=context\.data\.estimates\.find\(e=>e\.month===nextEstimate\.month\)/);
assert.match(repo,/return method==='manual'&&old&&old\.amount===nextEstimate\.amount\?old:nextEstimate/);
assert.match(repo,/estimates:updatedSalaryEstimates/);
assert.match(handoff,/requirePdfMime\(message\.pdf\)/);
assert.match(view,/requirePdfMime\(payload\.pdf\)/);
assert.equal((workflow.match(/run: node scripts\/audit-dist\.mjs --require-private-terms/g)||[]).length,2);
assert.ok(workflow.indexOf('Headless Chromium end-to-end regression tests')<
 workflow.indexOf('Re-audit Pages distribution immediately before artifact upload'));
assert.ok(workflow.indexOf('Re-audit Pages distribution immediately before artifact upload')<
 workflow.indexOf('Upload exactly the audited Pages build'));
const fakeHtml=new Blob(['<html><script>console.log("bad")</script></html>'],{type:'text/html'});
await assert.rejects(asVerifiedPdfBlob(fakeHtml),/PDF形式を確認できません/);
const mislabeledPdf=new Blob(['%PDF-1.7\\n1 0 obj\\nendobj\\n'],{type:'text/html'});
const fixed=await asVerifiedPdfBlob(mislabeledPdf);
assert.equal(fixed.type,'application/pdf');
assert.equal((await fixed.text()),await mislabeledPdf.text());
assert.throws(()=>requirePdfMime(fakeHtml),/MIME/);
assert.doesNotThrow(()=>requirePdfMime(fixed));
await assert.rejects(asVerifiedPdfBlob(new Blob([])),/PDF原本/);
console.log('PASS: PDF signature+MIME boundaries, salary isolation, inline validation, post-E2E artifact gate');
