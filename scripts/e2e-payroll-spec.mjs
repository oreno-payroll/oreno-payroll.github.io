import { test, expect } from '@playwright/test';
import { readFileSync } from "node:fs";

// Deterministic, synthetic-only smoke/E2E tests. Never sign in or contact OneDrive.
// Real payroll PDFs, tokens, account information, or saved browser profiles are not used.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4177') {
      await route.abort('blockedbyclient');
    } else {
      await route.continue();
    }
  });
});

test('dashboard requires a vault unlock before salary data becomes available', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.getByRole('heading', { name: '収入ダッシュボード', exact: true })).toBeVisible();
  await expect(page.locator('#mode-fiscal')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mode-calendar')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('main > .period-switcher')).toHaveCount(1);
  await expect(page.locator('.total-card .period-switcher')).toHaveCount(0);
  await expect(page.locator('input[name="statement-kind"][value="all"]')).toBeChecked();
  await expect(page.locator('input[name="statement-kind"]')).toHaveCount(3);
  await expect(page.locator('#statement-employer')).toHaveCount(0);
  await expect(page.locator('.statement-filter')).toHaveClass(/segmented-choice--three/);
  await expect(page.locator('.page-heading #payroll-refresh-data')).toHaveCount(1);
  await expect(page.locator('#total-taxable')).toHaveText('--');
  await expect(page.locator('#total-non-taxable')).toHaveText('--');
  await expect(page.locator('.total-breakdown')).not.toHaveAttribute('open','');
  await expect(page.locator('#total-taxable')).toBeHidden();
  await expect(page.locator('#total-net-rate')).toHaveCount(0);
  await expect(page.locator('.job-card .details-list')).toHaveCount(2);
  await expect(page.locator('#forecast-panel')).not.toHaveAttribute('open','');
  await expect(page.locator('.side-zip-scope,.registration-card__note')).toHaveCount(0);
  await expect(page.locator('#download-side-zip')).toBeDisabled();
  await expect(page.locator('#pending-deletion')).toBeHidden();
  await expect(page.locator('#pending-deletion-save')).toBeDisabled();
  // On a fresh profile there is no Microsoft login or decrypted vault. A modal gate
  // intentionally blocks period controls until the user authenticates. Do not
  // click through this security boundary or fabricate a signed-in session.
  const gate = page.locator('#payroll-cloud-gate');
  await expect(gate.getByRole('dialog', { name: '給与データを開く' })).toBeVisible();
  await expect(gate.locator('#payroll-cloud-login-form')).toBeVisible();
  await expect(gate.locator('#payroll-cloud-unlock-form')).toBeHidden();
});

test('dark-mode control persists across page reload', async ({ page }) => {
  // Upload is intentionally usable without unlocking a vault; the dashboard
  // correctly places a modal authentication gate over its controls.
  await page.goto('/upload/index.html');
  await expect(page.getByRole('heading', { name: 'PDFを追加', exact: true, level: 1 })).toBeVisible();
  const toggle = page.locator('[data-theme-toggle]').first();
  await expect(toggle).toBeVisible();
  const before = await toggle.getAttribute('aria-pressed');
  expect(['true', 'false']).toContain(before);
  await toggle.click();
  const after = before === 'true' ? 'false' : 'true';
  await expect(toggle).toHaveAttribute('aria-pressed', after);
  await page.reload();
  await expect(page.locator('[data-theme-toggle]').first()).toHaveAttribute('aria-pressed', after);
});

test('settings password can be shown and hidden without sending data', async ({ page }) => {
  await page.goto('/backup/index.html');
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
  await page.getByRole('button',{name:"バックアップ",exact:true}).click();
  const secret = page.locator('#export-password');
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(secret).toHaveCSS('min-height','44px');
  await secret.fill('synthetic-only');
  await page.locator('[data-toggle-password="export-password"]').click();
  await expect(secret).toHaveAttribute('type', 'text');
  await page.locator('[data-toggle-password="export-password"]').click();
  await expect(secret).toHaveAttribute('type', 'password');
  const original=page.viewportSize();
  for(const [width,height] of [[390,430],[320,250]]){
    await page.setViewportSize({width,height});await secret.focus();await secret.scrollIntoViewIfNeeded();await expect(secret).toBeInViewport();
    await page.locator('#export-button').scrollIntoViewIfNeeded();await expect(page.locator('#export-button')).toBeInViewport();
  }
  if(original)await page.setViewportSize(original);

});

test('upload page displays PDF-only selection and returns home', async ({ page }) => {
  await page.goto('/upload/index.html');
  await expect(page.getByRole('heading', { name: 'PDFを追加', exact: true, level: 1 })).toBeVisible();
  const pdfInput = page.locator('input[type="file"]').first();
  await expect(pdfInput).toHaveAttribute('accept', /pdf/i);
  await expect(page.locator('.eyebrow,.section-kicker,.notice--privacy')).toHaveCount(0);
  await expect(page.locator('#drop-heading')).toHaveText('PDFを選択');
  await page.locator('a.header-back').click();
  await expect(page.getByRole('heading', { name: '収入ダッシュボード' })).toBeVisible();
});

test('year-end directory is reachable without any real employee data', async ({ page }) => {
  await page.goto('/year-end-assist/index.html');
  await expect(page.getByRole('heading', { name: '年末調整サポート', exact: true })).toBeVisible();
  await expect(page.locator('#yea-new-name')).toBeHidden();
  // The startup vault gate may cover the directory; do not bypass it to open the form.
  await expect(page.locator('#yea-create-open')).toBeVisible();
  await expect(page.locator('#yea-people-refresh')).toBeVisible();
  await expect(page.locator('#yea-create-dialog')).not.toHaveAttribute('open','');
  await expect(page.locator('#yea-new-name')).toHaveCSS('min-height','44px');
  await expect(page.locator('#yea-review-form .unit-field input[type=number]')).toHaveCount(9);
  await expect(page.locator('#yea-person-create')).toBeHidden();
  await expect(page.locator('#yea-open-manage,#yea-manage-dialog,#yea-create-details')).toHaveCount(0);
  await expect(page.locator('.yea-upload-savebar')).toHaveCSS('box-shadow','none');
  await expect(page.locator('#yea-drop-heading')).toHaveText('PDFを追加する');
  await expect(page.locator('.brand__icon use')).toHaveAttribute('href','#icon-ledger');
  await expect(page.locator('#yea-year-memo')).toHaveAttribute('maxlength','16000');
});

test('four public pages keep strict CSP and no referrer metadata', async ({ page }) => {
  for (const location of ['/index.html', '/upload/index.html', '/backup/index.html', '/year-end-assist/index.html']) {
    await page.goto(location);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
    const referrer = await page.locator('meta[name="referrer"]').getAttribute('content');
    expect(referrer).toBe('no-referrer');
  }
});


test('monthly registration uses a native collapsed accordion', async ({ page }) => {
  await page.goto('/index.html');
  const panel = page.locator('#monthly-registration');
  await expect(panel).toHaveJSProperty('open', false);
  await expect(panel.locator('summary')).toContainText('月別登録状況');
  // Before cloud authentication the sensitive registration data stays hidden.
  await expect(panel).toBeHidden();
});

test('mobile Microsoft account actions occupy their settings row width', async ({ page, isMobile }) => {
  await page.goto('/backup/index.html');
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
  if (!isMobile) return;
  await page.getByRole('button',{name:/^Microsoft接続・認証/}).click();
  const dimensions = await page.evaluate(() => {
    const row = document.querySelector('.settings-connection-account > .settings-action-row');
    if (!row) throw new Error('Microsoft settings actions not mounted');
    const actions = ['backup-cloud-login', 'backup-cloud-logout', 'backup-cloud-reconnect'];
    return actions.map(id => {
      const button = document.getElementById(id);
      if (!button) throw new Error('Missing Microsoft action');
      // CSS-only inspection, no account changes or button clicks.
      button.hidden = false;
      const width = button.getBoundingClientRect().width;
      return { id, width, rowWidth: row.getBoundingClientRect().width };
    });
  });
  for (const { id, width, rowWidth } of dimensions) {
    expect(width, id).toBeGreaterThan(150);
    expect(Math.abs(width - rowWidth), id).toBeLessThan(2);
  }
});


// setInputFiles waits for attachment, not for app-specific event listeners.
// The real picker is disabled until upload initialization has completed.
async function readyUploadInput(page) {
 const input=page.locator('#file-input');
 await expect(input).toBeEnabled();
 await expect(page.locator('#drop-zone')).toHaveAttribute('aria-disabled','false');
 await expect(page.locator('#mobile-file-picker')).toBeEnabled();
 return input;
}

// Browser-side PDF upload/parse is exercised without a real payroll account.
test('synthetic PDF can enter the actual upload analysis UI without connecting to Graph', async ({page}) => {
 await page.goto('/upload/index.html');
 const bytes=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
 await (await readyUploadInput(page)).setInputFiles({name:'synthetic-only.pdf',mimeType:'application/pdf',buffer:bytes});
 await expect(page.locator('.file-list__item').first()).toBeVisible();
 await expect(page.locator('.file-list__item').first()).toContainText('synthetic-only.pdf');
 // No authenticated vault: do not attempt to store the document in OneDrive.
});

// One-use handoff tests the REAL receiving page: an HTML blob must be rejected
// before an iframe ever receives a blob: URL. Deliberately no sign-in bypass.
test('year-end viewer rejects an HTML Blob handed off as a PDF', async ({page}) => {
 const id='11111111-1111-4111-8111-111111111111';
 const ticket='22222222-2222-4222-8222-222222222222';
 await page.addInitScript(({ticket})=>{
  const channel=new BroadcastChannel('payroll-yearend-view-v1-'+ticket);
  window.__syntheticPdfHandoffChannel=channel;
  channel.onmessage=event=>{
   if(event.data?.type==='ready')channel.postMessage({type:'pdf',id:event.data.id,ticket,
    pdf:new Blob(['<html><script>throw new Error("executable")</script></html>'],{type:'text/html'}),
    fileName:'synthetic-only.pdf'});
  };
 },{ticket});
 await page.goto('/view/index.html#yearend='+id+'&handoff='+ticket);
 await expect(page).toHaveURL(new RegExp('#yearend='+id+'$'));
 await expect(page).toHaveTitle('Payroll | PDF原本');
 await expect(page.locator('#pdf-status')).toContainText('PDF以外のMIME形式は閲覧できません。', {timeout:15000});
 await expect(page.locator('#pdf-reader')).toBeHidden();
 await expect(page.locator('#pdf-reader')).not.toHaveAttribute('src',/blob:/);
});

test('personal PDF handoff keeps fragment ID, strips ticket and never exposes original filename in title', async ({page}) => {
 const id=42,ticket='33333333-3333-4333-8333-333333333333';
 await page.addInitScript(({id,ticket})=>{
  const channel=new BroadcastChannel('payroll-pdf-handoff-v1-'+ticket);
  window.__syntheticPdfHandoffChannel=channel;
  channel.onmessage=event=>{
   if(event.data?.action==='ready'&&event.data.id===id)channel.postMessage({action:'pdf',id,ticket,
    pdf:new Blob(['%PDF-1.7\nsynthetic-only\n%%EOF'],{type:'application/pdf'}),fileName:'synthetic-private-name.pdf'});
  };
 },{id,ticket});
 const navigations=[];
 page.on('request',request=>{const url=new URL(request.url());if(request.isNavigationRequest()&&url.pathname==='/view/index.html')navigations.push(url.search);});
 await page.goto('/view/index.html#id='+id+'&handoff='+ticket);
 await expect(page.locator('#pdf-reader')).toHaveAttribute('src',/^blob:/);
 await expect(page.locator('#pdf-reader')).toHaveAttribute('title','PDF原本');
 await expect(page).toHaveTitle('Payroll | PDF原本');
 await expect(page).toHaveURL(/\/view\/index\.html#id=42$/);
 expect(navigations).toEqual(['']);
});

test('legacy viewer route migrates without accepting a query ticket, malformed fragments fail closed', async ({page}) => {
 await page.goto('/view/index.html?id=0&handoff=ignored');
 await expect(page).toHaveURL(/\/view\/index\.html#id=0$/);
 await expect(page.locator('#pdf-status')).toContainText('PDF原本のIDが不正');
 await expect(page.locator('#pdf-reader')).toBeHidden();
 // Force a new document so this test exercises initialization rather than hashchange.
 await page.goto('/view/index.html?legacy=1#id=42&id=43');
 await expect(page.locator('#pdf-status')).toContainText('PDF原本のIDが不正');
 await expect(page.locator('#pdf-reader')).toBeHidden();
 await expect(page).toHaveTitle('Payroll | PDF原本');
});

// Responsive layout regression: no actual PDF is read and no OneDrive calls are made.
test('empty desktop upload is top-aligned and spacious, populated and mobile layouts remain usable', async ({ page, isMobile }) => {
  await page.goto('/upload/index.html');
  const workspace = page.locator('.workspace');
  const drop = page.locator('#drop-zone');
  const mobilePicker = page.locator('#mobile-file-picker');
  await expect(workspace).toHaveClass(/is-empty/);
  if (isMobile) {
    await expect(drop).toBeHidden();
    await expect(mobilePicker).toBeVisible();
    return;
  }
  await expect(drop).toBeVisible();
  const empty = await drop.boundingBox();
  const area = await workspace.boundingBox();
  expect(empty).not.toBeNull();
  expect(area).not.toBeNull();
  expect(empty.width).toBeGreaterThan(420);
  expect(empty.height).toBeGreaterThan(210);
  expect(Math.abs((empty.x + empty.width / 2) - (area.x + area.width / 2))).toBeLessThan(30);
  expect(Math.abs(empty.y - area.y)).toBeLessThan(30); // top-aligned within content workspace
  await workspace.evaluate(node => node.classList.remove('is-empty'));
  const populated = await drop.boundingBox();
  expect(populated.height).toBeLessThan(empty.height);
  await expect(page.locator('.file-panel')).toBeVisible();
  await page.setViewportSize({ width: 820, height: 900 });
  await workspace.evaluate(node => node.classList.add('is-empty'));
  const tablet = await drop.boundingBox();
  expect(tablet.width).toBeGreaterThan(420);
  expect(tablet.height).toBeGreaterThan(180);
  const tabletWorkspace = await workspace.boundingBox();
  expect(tabletWorkspace).not.toBeNull();
  expect(Math.abs(tablet.y - tabletWorkspace.y)).toBeLessThan(30);
});

// PAYROLL-UPLOAD-FOOTER-FIT-20261123: synthetic-only layout checks, no Microsoft account or real PDF.
test('desktop upload has no footer-caused document scroll, including populated layout', async ({ page, isMobile }) => {
  if (isMobile) return; // On mobile, allow necessary natural page scrolling.
  for (const [width, height] of [[1280, 800], [820, 900]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/upload/index.html');
    await expect(page.locator('.build-info')).toHaveCount(0);
    const fit = async () => page.evaluate(() => {
      const footer = document.querySelector('.upload-page');
      return {
        documentHeight: document.documentElement.scrollHeight,
        bodyHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        footerBottom: footer.getBoundingClientRect().bottom,
      };
    });
    const empty = await fit();
    expect(empty.documentHeight - empty.viewportHeight).toBeLessThanOrEqual(1);
    expect(empty.bodyHeight - empty.viewportHeight).toBeLessThanOrEqual(1);
    expect(empty.footerBottom).toBeLessThanOrEqual(empty.viewportHeight + 1);
    await page.locator('.workspace').evaluate(node => node.classList.remove('is-empty'));
    await page.locator('.review-panel').evaluate(panel => {
      const sample = document.createElement('div');
      sample.style.height = '1800px';
      sample.setAttribute('data-layout-fixture', '');
      panel.append(sample);
    });
    await expect(page.locator('.file-panel')).toBeVisible();
    const populated = await fit();
    expect(populated.documentHeight - populated.viewportHeight).toBeLessThanOrEqual(1);
    expect(populated.footerBottom).toBeLessThanOrEqual(populated.viewportHeight + 1);
    const panel = await page.locator('.review-panel').evaluate(node => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY,
    }));
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
    expect(panel.overflowY).toBe('auto');
  }
});

// Round4/B: real upload UI exercised with a text-only, synthetic, single-page PDF.
// No Microsoft sign-in or OneDrive mutation, and the Save button is never clicked.
function syntheticOnePagePdf(){
 const stream='BT /F1 12 Tf 15 350 Td (synthetic) Tj ET';
 const objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
 ];
 let source='%PDF-1.4\n';const offsets=[0];
 for(const [i,object] of objects.entries()){
  offsets.push(Buffer.byteLength(source));
  source+=`${i+1} 0 obj\n${object}\nendobj\n`;
 }
 const cross=Buffer.byteLength(source);
 source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))source+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 source+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${cross}\n%%EOF\n`;
 return Buffer.from(source);
}
test('PDF picker stays disabled until the upload module has initialized',async({page})=>{
 let release;
 const held=new Promise(resolve=>{release=resolve;});
 // Hold the real upload module, not the parser or the app's initialization logic.
 // The per-test route is registered after the external-network blocking route.
 await page.route('http://127.0.0.1:4177/upload.js',async route=>{
  await held;
  await route.continue();
 });
 try {
  await page.goto('/upload/index.html',{waitUntil:'commit'});
  await expect(page.locator('#file-input')).toBeDisabled();
  await expect(page.locator('#mobile-file-picker')).toBeDisabled();
  await expect(page.locator('#drop-zone')).toHaveAttribute('aria-disabled','true');
  await expect(page.locator('#drop-zone')).toHaveAttribute('tabindex','-1');
  await expect(page.locator('#upload-guide')).toContainText('PDF追加の準備中');
 } finally { release(); }
 await page.waitForLoadState('load');
 const input=await readyUploadInput(page);
 await expect(page.locator('#drop-zone')).toHaveAttribute('tabindex','0');
 await input.setInputFiles({name:'synthetic-startup.pdf',mimeType:'application/pdf',buffer:syntheticOnePagePdf()});
 await expect(page.locator('#review-content')).toBeVisible();
 await expect(page.locator('.file-list__item')).toHaveCount(1);
 await expect(page.locator('.file-list__item')).toContainText('synthetic-startup.pdf');
 await expect(page.locator('#employer-load')).toBeEnabled();
 await expect(page.locator('#read-result')).toContainText('文字を取得しました');
});

test('zero consent rejects stale inputs and never auto-selects itself',async({page})=>{
 await page.goto('/upload/index.html');
 const zero=page.locator('#zero-missing-amounts');
 await expect(zero).not.toBeChecked();
 await expect(page.locator('#zero-approval')).toBeHidden();
 await (await readyUploadInput(page)).setInputFiles({
  name:'synthetic-only.pdf',mimeType:'application/pdf',buffer:syntheticOnePagePdf(),
 });
 await expect(page.locator('#review-content')).toBeVisible();
 await expect(page.locator('#review-form input[name="gross"]')).toHaveCSS('min-height','44px');
 await expect(page.locator('#save-all')).toHaveCSS('min-height','44px');
 await expect(page.locator('#save-all')).toBeDisabled();
 await expect(page.locator('#save-all')).toHaveCSS('opacity','0.55');
 // The synthetic PDF contains no salary layout, so no kind can be inferred.
 // The opt-in must stay hidden until the user explicitly selects salary/bonus.
 await expect(page.locator('#zero-approval')).toBeHidden();
 await expect(zero).not.toBeChecked();
 // The radio input is a visually hidden 1px control. Click the visible
 // segmented-choice label as a user would, not the hidden input's 1px box.
 // Keep the real pointer hit-test (no force:true / evaluate(click)).
 await expect(page.locator('body > .build-info')).toHaveCount(0);
 await page.locator('#review-form input[name="job"][value="main"] + span').click();
 await expect(page.locator('#review-form input[name="job"][value="main"]')).toBeChecked();
 await page.locator('#review-form input[name="kind"][value="salary"] + span').click();
 await expect(page.locator('#review-form input[name="kind"][value="salary"]')).toBeChecked();
 await expect(page.locator('#zero-approval')).toBeVisible();
 await expect(zero).not.toBeChecked();
 await page.locator('#review-form input[name="targetMonth"]').fill('2026-11');
 await page.locator('#review-form input[name="paymentDate"]').fill('2026-11-27');
 await page.locator('#review-form input[name="gross"]').fill('250000');
 await page.locator('#review-form input[name="net"]').fill('245000');
 await page.locator('#review-form input[name="taxable"]').fill('250000');
 await page.locator('#review-form input[name="nonTaxable"]').fill('0');
 const confirmation=page.locator('#upload-review-confirm');
 await expect(confirmation).toBeVisible();
 await expect(page.locator('#upload-review-confirmation [data-review-rows]')).toContainText('差額（計算値 − 入力値）');
 await expect(page.locator('#upload-review-confirmation [data-review-rows]')).toContainText('5,000円');
 // A separate taxable/non-taxable discrepancy must be visible and invalidate consent too.
 const taxable=page.locator('#review-form input[name="taxable"]');
 await taxable.fill('240000');
 await expect(page.locator('#upload-review-confirmation [data-review-rows]')).toContainText('差額（内訳合計 − 総支給額）');
 await expect(page.locator('#upload-review-confirmation [data-review-rows]')).toContainText('-10,000円');
 await taxable.fill('250000');
 await expect(confirmation).not.toBeChecked();
 await expect(page.locator('#save-all')).toBeDisabled();
 await confirmation.check();
 await expect(confirmation).toBeChecked();
 await expect(zero).toBeEnabled();
 await zero.check();
 await expect(zero).toBeChecked();
 // Changing just one field invalidates both the per-file review and the global
 // zero-conversion consent. It cannot silently apply to the updated form.
 await page.locator('#review-form input[name="residentTax"]').fill('0');
 await expect(zero).not.toBeChecked();
 await expect(confirmation).not.toBeChecked();
 await expect(page.locator('#save-all')).toBeDisabled();
 await page.reload();
 await expect(zero).not.toBeChecked();
});

// Without a connected vault, neither a role nor an employer is inferred from an unrecognized PDF.
// The raw identity is never an editable text field. No Microsoft sign-in is triggered automatically.
test('employer selection uses names and requires an available directory',async({page})=>{
 await page.goto('/upload/index.html');
 const employer=page.locator('#employer-id');
 await expect(employer).toHaveCount(1);
 await (await readyUploadInput(page)).setInputFiles({name:'synthetic-employer.pdf',mimeType:'application/pdf',buffer:syntheticOnePagePdf()});
 await expect(page.locator('#review-content')).toBeVisible();
 await expect(page.locator('#employer-load')).toBeEnabled();
 await expect(page.locator('#employer-load')).toHaveText('保管庫を開く');
 await expect(page.locator('.employer-identity__help:not(#employer-status)')).toHaveCount(0);
 await expect(employer).toBeDisabled();
 expect(await employer.evaluate(el=>el.tagName)).toBe('SELECT');
 await expect(employer).toHaveValue('');
 await expect(employer.locator('option')).toHaveText(['未設定']);
 await expect(page.locator('#employer-create')).toHaveCount(0);
 const main=page.locator('#review-form input[name="job"][value="main"]');
 const side=page.locator('#review-form input[name="job"][value="side"]');
 await expect(main).not.toBeChecked();await expect(side).not.toBeChecked();
 await page.locator('#review-form input[name="job"][value="main"] + span').click();
 await expect(main).toBeChecked();await expect(employer).toHaveValue('');
 await page.locator('#review-form input[name="job"][value="side"] + span').click();
 await expect(side).toBeChecked();await expect(employer).toHaveValue('');
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 await page.reload();await expect(employer).toHaveValue('');
});

// A long modal scrolls its body only; header and footer stay in the viewport.
async function assertScrollableModal(dialog){
 const result=await dialog.evaluate(e=>{
  const body=e.querySelector('.operation-dialog__body'),header=e.querySelector('.operation-dialog__header'),actions=e.querySelector('.operation-dialog__actions');
  const bounds=el=>{const r=el.getBoundingClientRect();return [r.top,r.bottom];};
  const before=[bounds(header),actions?bounds(actions):null];
  body.scrollTop=body.scrollHeight;
  const after=[bounds(header),actions?bounds(actions):null];
  const content=body.querySelector('.operation-dialog__data');
  return {scrolled:body.scrollTop>0,outer:e.scrollHeight<=e.clientHeight+1&&e.scrollTop===0,visible:after.flat().filter(v=>v!==null).every(v=>v>=0&&v<=innerHeight+1),fixed:JSON.stringify(before)===JSON.stringify(after),single:!content||content.scrollHeight<=content.clientHeight+1};
 });
 expect(result).toEqual({scrolled:true,outer:true,visible:true,fixed:true,single:true});
}

// A single PDF diagnostic dialog: cancellation must never reveal the raw text.
test('PDF diagnostic uses one dialog and copies only the selected disclosure mode',async({page})=>{
 await page.addInitScript(()=>{window.syntheticCopies=[];window.syntheticClipboardFailure=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){if(window.syntheticClipboardFailure)throw new Error("synthetic clipboard failure");window.syntheticCopies.push(text);}}});});
 await page.goto('/upload/index.html');
 await (await readyUploadInput(page)).setInputFiles({name:'synthetic-dialog.pdf',mimeType:'application/pdf',buffer:syntheticOnePagePdf()});
 await expect(page.locator('#review-content')).toBeVisible();
 const trigger=page.locator('#diagnostic-button');
 await expect(trigger).toBeVisible();
 const current=page.locator('.file-list__current');
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
  expect(await current.evaluate(el=>{const s=getComputedStyle(el);return [s.backgroundColor,s.borderTopWidth,s.paddingTop];})).toEqual(['rgba(0, 0, 0, 0)','0px','0px']);
  await trigger.click();
  const outer=page.locator('#diagnostic-dialog'),shared=outer.locator('#diagnostic-shared'),copy=outer.locator('#diagnostic-copy');
  await expect(copy).toBeEnabled();await expect(shared).toHaveText(/\[マスク済み\]/);await expect(shared).not.toHaveText(/"synthetic"/);
  await expect(outer.locator('#diagnostic-mode-shared')).toBeChecked();
  const originalOutput=await shared.textContent();
  await shared.evaluate(el=>{el.textContent=(el.textContent+'\n').repeat(150);});
  await assertScrollableModal(outer);
  await shared.evaluate((el,text)=>{el.textContent=text;},originalOutput);await expect(page.locator('dialog[open]')).toHaveCount(1);
  await copy.click();expect(await page.evaluate(()=>window.syntheticCopies.at(-1))).not.toContain('"synthetic"');
  await outer.getByText('原文（個人情報を含む）',{exact:true}).click();await expect(shared).toHaveText(/"synthetic"/);
  await expect(copy).toHaveText('個人情報を含む原文をコピー');await expect(page.locator('dialog[open]')).toHaveCount(1);
  await copy.click();expect(await page.evaluate(()=>window.syntheticCopies.at(-1))).toContain('"synthetic"');
  await page.evaluate(()=>{window.syntheticClipboardFailure=true;});
  await copy.click();await expect(outer.getByRole('status')).toHaveText('コピーできませんでした。もう一度お試しください。');
  expect(await page.evaluate(()=>window.getSelection().toString())).toBe('');
  await outer.getByText('共有用（文字を伏せる）',{exact:true}).click();await expect(shared).not.toHaveText(/"synthetic"/);
  await copy.click();await expect(outer.getByRole('status')).toHaveText('自動コピーできませんでした。共有用データを選択しました。');
  const selected=await page.evaluate(()=>window.getSelection().toString());expect(selected).toContain('[マスク済み]');expect(selected).not.toContain('"synthetic"');
  await page.evaluate(()=>{window.syntheticClipboardFailure=false;});
  await copy.click();expect(await page.evaluate(()=>window.syntheticCopies.at(-1))).not.toContain('"synthetic"');
  await outer.locator('#diagnostic-close').click();await expect(outer).toBeHidden();await expect(shared).toHaveText('');expect(await page.evaluate(()=>window.getSelection().toString())).toBe('');
  await trigger.click();await expect(copy).toBeEnabled();await expect(shared).not.toHaveText(/"synthetic"/);
  await page.keyboard.press('Escape');await expect(outer).toBeHidden();await expect(shared).toHaveText('');expect(await page.evaluate(()=>window.getSelection().toString())).toBe('');
 }
});

// No account or real data. The actual settings migration action is cancelled before any read/write.
test('settings migration confirmation cancels without opening the vault',async({page})=>{
 await page.goto('/backup/index.html');
 await page.getByRole('button',{name:/^Microsoft接続・認証/}).click();
 await expect(page.locator('#backup-cloud-status')).toContainText('Client ID未設定');
 await page.getByRole('button',{name:/^メンテナンス/}).click();
 const migrate=page.locator('#migrate-legacy-cloud');
 const legacy=page.locator('.settings-legacy > details.settings-recovery-details');
 const summary=legacy.locator('summary');
 const dialog=page.getByRole('dialog',{name:'旧ブラウザ保存データを移行',exact:true});
 await expect(summary).toBeVisible();
 await expect(legacy).not.toHaveAttribute('open','');
 await expect(migrate).toBeHidden();
 await summary.click();
 await expect(legacy).toHaveAttribute('open','');
 await expect(migrate).toBeVisible();
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 await migrate.click();
 await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('button',{name:'キャンセル',exact:true})).toBeFocused();
 await dialog.getByRole('button',{name:'キャンセル',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 await expect(page.locator('#migrate-legacy-cloud-status')).toHaveText('');
 await migrate.click();
 await expect(dialog).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(dialog).toHaveCount(0);
 await expect(migrate).toBeEnabled();
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 await expect(page.locator('#migrate-legacy-cloud-status')).toHaveText('');
 await summary.click();
 await expect(migrate).toBeHidden();
});

// Real category navigation, no account or backup operations are invoked.
test('settings overview separates categories and retains only in-page drafts',async({page})=>{
 await page.goto('/backup/index.html');
 const menu=page.locator('#settings-menu');
 const version=page.locator('#settings-version');
 await expect(version).toBeVisible();
 await expect(version.locator('[data-build-version]')).toHaveText(/^v\d+\.\d+\.\d+$/);
 const buildDetails=page.locator('[data-build-details]');
 await expect(buildDetails).toHaveText(/^\d{4}[/.-]\d{1,2}[/.-]\d{1,2} .+ · (?:[a-f0-9]{4,64}|local)$/);
 await expect(version.locator('[data-build-details]')).toHaveCount(0);
 // Release notes are accessible before connecting or unlocking, without extra navigation.
 const historyDialog=page.getByRole('dialog',{name:'アップデート履歴'});
 const buildVersion=await version.locator('[data-build-version]').textContent();
 await buildDetails.click();await expect(historyDialog).toBeHidden();
 await version.focus();await page.keyboard.press('Enter');
 await expect(historyDialog).toBeVisible();
 await expect(historyDialog.locator('.release-history__entry').first().locator('strong').first()).toHaveText(buildVersion);
 await expect(historyDialog.getByText('最新版',{exact:true})).toHaveCount(1);
 const historyClose=historyDialog.locator('.operation-dialog__header #release-history-close');
 await expect(historyClose).toHaveText('×');
 await expect(historyClose).toHaveAccessibleName('閉じる');
 await expect(historyClose).toBeFocused();
 const historyBody=historyDialog.locator('#release-history-content');
 await historyBody.evaluate(el=>{el.scrollTop=el.scrollHeight;});
 await expect(historyClose).toBeInViewport();
 const bodyRect=await historyBody.boundingBox(),closeRect=await historyClose.boundingBox();
 expect(closeRect.y+closeRect.height).toBeLessThanOrEqual(bodyRect.y+1);
 await expect(historyDialog.getByText('Payroll 初期公開',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(historyDialog).toBeHidden();await expect(version).toBeFocused();
 await page.route('**/release-notes.json',route=>route.fulfill({status:503,body:'unavailable'}));
 await version.click();await expect(historyDialog.getByText(/履歴を読み込めませんでした/)).toBeVisible();
 await historyDialog.getByRole('button',{name:'閉じる',exact:true}).click();
 await expect(historyDialog).toBeHidden();
 await page.unroute('**/release-notes.json');
 const personal=menu.getByRole('button',{name:"バックアップ",exact:true});
 const viewport=page.viewportSize();
 const left=await menu.boundingBox();
 const right=await page.locator('#settings-auth-panel').boundingBox();
 expect(left).not.toBeNull();expect(right).not.toBeNull();
 if(viewport.width>760)expect(right.x).toBeGreaterThanOrEqual(left.x+left.width);
 else expect(right.y).toBeGreaterThanOrEqual(left.y+left.height);
 await expect(personal).toBeEnabled();
 await expect(menu).toBeVisible();
 await expect(page.locator('.settings-group:visible')).toHaveCount(1);
 await personal.click();
 await expect(page.locator('#settings-personal-panel')).toBeVisible();
 await expect(page.locator('.settings-group:visible')).toHaveCount(1);
 await expect(page.locator('#settings-page-title')).toHaveText('設定');
 await expect(personal).toHaveAttribute('aria-current','true');
 await expect(version).toBeVisible();
 await expect(page.locator('#restore-button')).toBeHidden();
 await expect(page.locator('#restore-add-inspect')).toBeHidden();
 await expect(page.locator('#restore-button')).toHaveText('置き換えて復元');
 await expect(page.locator('#restore-add-button')).toHaveText('明細を追加復元');
 await expect(page.locator('#restore-add-button')).toBeDisabled();
 await expect(page.locator('#restore-add-inspect')).toBeDisabled();
 await expect(page.locator('#restore-add-ack')).toHaveCount(0);
 await expect(page.locator('#restore-ack')).toBeDisabled();
 const secret=page.locator('#export-password');
 await secret.fill('synthetic-only');
 await page.locator('[data-toggle-password="export-password"]').click();
 await expect(secret).toHaveAttribute('type','text');
 const historyLength=await page.evaluate(()=>history.length);
 const auth=menu.getByRole('button',{name:/^Microsoft接続・認証/});
 await auth.click();
 await expect(secret).toHaveAttribute('type','password');
 await expect(secret).toBeHidden();
 await expect(menu).toBeVisible();
 await expect(version).toBeVisible();
 await personal.click();
 await expect(secret).toBeVisible();
 await expect(secret).toHaveValue('synthetic-only');
 await expect(secret).toHaveAttribute('type','password');
 expect(await page.evaluate(()=>history.length)).toBe(historyLength);
 await expect(page.locator('#settings-yearend-panel')).toBeVisible();
 await expect(page.locator('#ye-restore-commit')).toBeHidden();
 await expect(page.locator('#ye-restore-commit')).toHaveText('従業員を追加復元');
 await expect(page.locator('#ye-restore-commit')).toBeDisabled();
 await expect(page.locator('#ye-restore-ack')).toHaveCount(0);
 await expect(page.locator('#settings-personal-panel')).toBeVisible();
 await expect(menu.locator('button')).toHaveCount(5);
 await menu.getByRole('button',{name:/^通知履歴/}).click();
 await expect(page.locator('#settings-notifications-panel')).toBeVisible();
 await expect(page.locator('#notification-empty')).toBeVisible();
 await expect(page.locator('#notification-confirm-all')).toBeDisabled();
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 await menu.getByRole('button',{name:/^勤務先管理/}).click();
 await expect(page.locator('#settings-backup-panel')).toBeHidden();
 await expect(page.locator('#settings-employers-panel')).toBeVisible();
 await expect(page.locator('#employer-directory-load')).toBeEnabled();
 await expect(page.locator('#employer-directory-load')).toHaveText('保管庫を開く');
 await expect(page.locator('#employer-directory-form')).toBeHidden();
 await expect(page.locator('#employer-directory-save')).toBeDisabled();
 await expect(page.locator('#employer-bulk-panel')).toBeHidden();
 await expect(page.locator('#employer-bulk-save')).toBeDisabled();
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 await menu.getByRole('button',{name:/^メンテナンス/}).click();
 await expect(page.locator('#legacy-cleanup-delete')).toBeHidden();
 await page.locator('.settings-legacy > details > summary').click();
 await expect(page.locator('#legacy-cleanup-delete')).toBeVisible();
 await expect(page.locator('#payroll-income-publish')).toBeVisible();
 await expect(page.locator('#settings-auth-panel')).toBeHidden();
 await page.locator('#migrate-legacy-cloud').click();
 const confirm=page.locator('dialog.operation-dialog[open]');
 await expect(confirm).toBeVisible();
 await expect(confirm).toBeVisible();
 // Real modal blocks background pointer interaction; the controller also rejects
 // programmatic category clicks while a destructive confirmation is open.
 await page.evaluate(()=>document.querySelector('[data-settings-open="auth"]').click());
 await expect(page.locator('#legacy-cleanup-delete')).toBeVisible();
 await expect(menu).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(confirm).toHaveCount(0);
 await auth.click();
 await expect(page.locator('#settings-auth-panel')).toBeVisible();
 await expect(page.locator('.settings-group:visible')).toHaveCount(1);
 await expect(version).toBeVisible();
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
});

// Measure the real source markup and shared CSS in a static, synthetic fixture.
// No application script is run, no auth gate is bypassed, and no data is loaded.
test('shared disclosure, statement columns and settings spacing stay aligned', async ({ page }) => {
 // Keep the checked-in HTML intact. Block scripts and network access instead
 // of attempting to sanitize HTML with regular expressions. Only explicitly
 // approved local stylesheet files are added to the isolated document.
 const pages = new Set(['index.html','upload/index.html','edit/index.html',
  'year-end-assist/index.html','backup/index.html']);
 const styles = new Map(['ress','style','dashboard','cloud','theme','upload','vault','year-end-assist']
  .map(name=>{const url=new URL(`../public/styles/${name}.css`,import.meta.url);return [url.href,url];}));
 const fixtureCsp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";
 await page.route('**/*',route=>route.abort('blockedbyclient'));
 const fixture = async name => {
  if (!pages.has(name)) throw new Error('Unknown static fixture');
  const url = new URL('../public/'+name,import.meta.url);
  const html = readFileSync(url,'utf8');
  if (!html.includes('<head>')) throw new Error('Missing fixture head');
  // Insert the restrictive policy before any executable markup. The source's
  // own CSP remains in place as an additional policy.
  await page.setContent(html.replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${fixtureCsp}">`));
  const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
   const stylesheet = new URL(href,url);
   stylesheet.search = '';
   const source = styles.get(stylesheet.href);
   if (!source) throw new Error('Unexpected static fixture stylesheet');
   await page.addStyleTag({content:readFileSync(source,'utf8')});
  }
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]').first()).toHaveAttribute('content',fixtureCsp);
  await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 };
 for (const theme of ['light','dark']) {
  await fixture('index.html');
  const home=await page.evaluate(theme=>{
   document.documentElement.dataset.theme=theme;
   for(const id of ['forecast-panel','monthly-registration']){const d=document.getElementById(id);d.hidden=false;d.open=true;}
   document.querySelector('.total-breakdown').open=true;
   document.querySelector('#download-side-zip').disabled=false;
   const el=s=>document.querySelector(s),rect=s=>el(s).getBoundingClientRect(),css=s=>getComputedStyle(el(s));
   const x=s=>rect(s).left+parseFloat(css(s).paddingLeft);
   return {offset:x('.total-breakdown summary')-x('#forecast-heading'),border:css('.registration-card__heading').borderBottomWidth,
    listOffset:rect('#main-records').top-rect('#side-records').top,radioOpacity:css('.statement-filter input').opacity,
    width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth};
  },theme);
  await expect(page.locator('#side-zip-status')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'PDFを追加',exact:true})).toHaveCount(1);
  expect(Math.abs(home.offset)).toBeLessThan(1);
  expect(home.border).toBe('0px');expect(home.radioOpacity).toBe('0');expect(home.overflow).toBe(0);
  if(home.width>640)expect(Math.abs(home.listOffset)).toBeLessThan(1);
  const originalViewport=page.viewportSize();
  for(const width of [1280,861,860,641,640,390,320]){
   await page.setViewportSize({width,height:900});
   await fixture('index.html');
   const controls=await page.evaluate(theme=>{
    document.documentElement.dataset.theme=theme;
    const r=s=>document.querySelector(s).getBoundingClientRect();
    const header=r('.statements-card__header'),title=r('#statements-heading'),filter=r('.statement-filter');
    return {right:header.right-filter.right,center:(title.top+title.bottom-filter.top-filter.bottom)/2,
     gap:filter.left-title.right,height:r('.statement-filter span').height,overflow:document.documentElement.scrollWidth-innerWidth};
   },theme);
   expect(Math.abs(controls.right)).toBeLessThan(1);expect(Math.abs(controls.center)).toBeLessThan(1);
   expect(controls.gap).toBeGreaterThanOrEqual(0);expect(controls.height).toBe(36);expect(controls.overflow).toBe(0);
   await expect(page.getByRole('link',{name:'PDFを追加',exact:true})).toHaveCount(1);
   // The source starts disabled until a dashboard view has been loaded.
   for(const radio of await page.locator('input[name="statement-kind"]').all())await expect(radio).toBeDisabled();
   await page.locator('input[name="statement-kind"]').evaluateAll(nodes=>nodes.forEach(node=>node.disabled=false));
   await page.locator('.statement-filter label').nth(1).click();
   await expect(page.locator('input[name="statement-kind"][value="salary"]')).toBeChecked();
   await page.keyboard.press('ArrowRight');
   await expect(page.locator('input[name="statement-kind"][value="bonus"]')).toBeChecked();
   await fixture('upload/index.html');
   const upload=await page.evaluate(theme=>{
    document.documentElement.dataset.theme=theme;
    const r=s=>document.querySelector(s).getBoundingClientRect();
    const content=r('.upload-page'),zone=r('.upload-zone-card');
    return {left:zone.left-content.left,right:content.right-zone.right,
     width:r('.workspace').width-content.width,overflow:document.documentElement.scrollWidth-innerWidth};
   },theme);
   expect(Math.abs(upload.left)).toBeLessThan(1);expect(Math.abs(upload.right)).toBeLessThan(1);
   expect(Math.abs(upload.width)).toBeLessThan(1);expect(upload.overflow).toBe(0);
   await expect(page.locator('.file-panel')).toBeHidden();await expect(page.locator('.review-panel')).toBeHidden();
   await page.mouse.move(0,0);
   const uploadHeading=await page.locator('.upload-heading h1').evaluate(e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return [c.fontSize,c.fontWeight,c.lineHeight,r.left,r.top];});
   const uploadFile=await page.locator('.selected-file').evaluate(e=>{const c=getComputedStyle(e),n=getComputedStyle(e.querySelector('strong'));return [c.backgroundColor,c.borderColor,c.borderRadius,n.fontSize,n.fontWeight];});
   await fixture('edit/index.html');
   const edit=await page.evaluate(theme=>{
    document.documentElement.dataset.theme=theme;
    document.querySelector('#editor').hidden=false;
    const r=s=>document.querySelector(s).getBoundingClientRect();
    const original=r('#original-pdf'),download=r('#download-pdf'),remove=r('#edit-delete'),icon=r('#download-pdf .icon');
    const appearance=s=>{const c=getComputedStyle(document.querySelector(s));return [c.borderColor,c.borderWidth,c.borderStyle,c.borderRadius,c.backgroundColor,c.color];};
    return {original:original.height,download:download.height,width:download.width,remove:remove.height,
     originalStyle:appearance('#original-pdf'),downloadStyle:appearance('#download-pdf'),removeStyle:appearance('#edit-delete'),
     icon:[icon.width,icon.height],overflow:document.documentElement.scrollWidth-innerWidth};
   },theme);
   const editHeading=await page.locator('.upload-heading h1').evaluate(e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return [c.fontSize,c.fontWeight,c.lineHeight,r.left,r.top];});
   const editFile=await page.locator('.selected-file').evaluate(e=>{const c=getComputedStyle(e),n=getComputedStyle(e.querySelector('strong'));return [c.backgroundColor,c.borderColor,c.borderRadius,n.fontSize,n.fontWeight];});
   expect(editHeading).toEqual(uploadHeading);expect(editFile).toEqual(uploadFile);
   expect(edit.download).toBe(edit.original);expect(edit.download).toBe(edit.remove);
   expect(edit.width).toBe(edit.download);expect(edit.icon).toEqual([14,14]);expect(edit.overflow).toBe(0);
   expect(edit.downloadStyle).toEqual(edit.originalStyle);
   expect(edit.removeStyle.slice(1,4)).toEqual(edit.originalStyle.slice(1,4));
   expect(edit.removeStyle[0]).not.toBe(edit.originalStyle[0]);
   await page.addStyleTag({content:'.selected-file__actions .btn { transition: none !important; }'});
   const hoveredStyle=id=>page.locator(id).evaluate(el=>{const c=getComputedStyle(el);return [c.borderColor,c.backgroundColor,c.color];});
   await page.locator('#original-pdf').hover();const originalHover=await hoveredStyle('#original-pdf');
   await page.locator('#download-pdf').hover();expect(await hoveredStyle('#download-pdf')).toEqual(originalHover);
   await expect(page.locator('#download-pdf')).toHaveAttribute('aria-label','原本PDFをダウンロード');
  }
  await page.setViewportSize(originalViewport);
  await fixture('year-end-assist/index.html');
  const modal=await page.evaluate(theme=>{
   document.documentElement.dataset.theme=theme;
   const add=document.querySelector('#yea-create-dialog');add.showModal();
   const reference=document.createElement('dialog');reference.className='operation-dialog';document.body.append(reference);reference.showModal();
   const style=element=>{const s=getComputedStyle(element);return [s.borderRadius,s.padding,s.backgroundColor,s.boxShadow,getComputedStyle(element,'::backdrop').backgroundColor];};
   return {add:style(add),reference:style(reference),overflow:document.documentElement.scrollWidth-innerWidth};
  },theme);
  expect(modal.add).toEqual(modal.reference);expect(modal.overflow).toBe(0);

  await fixture('backup/index.html');
  const settings=await page.evaluate(theme=>{
   document.documentElement.dataset.theme=theme;
   document.querySelector('#settings-employers-panel').hidden=false;
   const a=document.querySelector('.employer-settings');
   return {radius:getComputedStyle(a).borderRadius,menuRadius:getComputedStyle(document.querySelector('#settings-menu')).borderRadius,overflow:document.documentElement.scrollWidth-innerWidth};
  },theme);
  expect(settings.radius).toBe('9px');expect(settings.menuRadius).toBe(settings.radius);expect(settings.overflow).toBe(0);
  const employerViewport=page.viewportSize();
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:650});
   const formLayout=await page.evaluate(()=>{
    const dialog=document.querySelector('#employer-directory-dialog'),form=document.querySelector('#employer-directory-form');dialog.showModal();
    const bounds=dialog.getBoundingClientRect(),body=form.querySelector('.employer-dialog__body'),actions=form.querySelector('.operation-dialog__actions');
    const inputs=[...form.querySelectorAll('input[name="employer-role"],input[name="employer-bonus-month"]')];
    const inside=inputs.every(input=>{const b=input.closest('label').getBoundingClientRect();return b.width>=16&&b.height>=16&&b.left>=bounds.left&&b.right<=bounds.right;});
    const footer=actions.getBoundingClientRect().bottom<=bounds.bottom;
    const overflow=document.documentElement.scrollWidth-innerWidth;
    const horizontal=body.scrollWidth>body.clientWidth;
    dialog.close();return {inside,overflow,horizontal,footer,count:inputs.length};
   });
   expect(formLayout).toEqual({inside:true,overflow:0,horizontal:false,footer:true,count:14});
  }
  await page.setViewportSize(employerViewport);
  const originalSettingsViewport=page.viewportSize();
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(()=>{for(const s of document.querySelectorAll('main>.settings-group'))s.hidden=s.id!=='settings-auth-panel';});
   const auth=await page.evaluate(()=>{
    const grid=document.querySelector('.settings-auth-grid'),a=grid.children[0].getBoundingClientRect(),b=grid.children[1].getBoundingClientRect();
    return {cards:grid.children.length,sameRow:Math.abs(a.top-b.top)<1,stacked:b.top>=a.bottom,overflow:document.documentElement.scrollWidth-innerWidth};
   });
   expect(auth.cards).toBe(2);expect(auth.overflow).toBe(0);expect(width>830?auth.sameRow:auth.stacked).toBe(true);
   await expect(page.locator('#write-lock-recovery-title')).toBeHidden();
   await page.evaluate(()=>{for(const s of document.querySelectorAll('main>.settings-group'))s.hidden=s.id!=='settings-details-panel';});
   await expect(page.locator('#settings-details-panel #write-lock-recovery-title')).toBeVisible();
  }
  if(originalSettingsViewport)await page.setViewportSize(originalSettingsViewport);
  for(const id of ['settings-backup-panel','settings-details-panel','settings-auth-panel']){
   await page.evaluate(id=>{for(const s of document.querySelectorAll('main>.settings-group'))s.hidden=s.id!==id;},id);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
  }
 }
 // Keyboard-height layout: check the actual inactive forms as isolated fixtures,
 // without running the app or invoking any save/authentication operation.
 const keyboardViewport=page.viewportSize();
 for(const theme of ['light','dark'])for(const [width,height] of [[390,430],[320,250]]){
  await page.setViewportSize({width,height});await fixture('backup/index.html');
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.getElementById('settings-employers-panel').hidden=false;document.getElementById('employer-directory-dialog').showModal();},theme);
  const name=page.locator('#employer-directory-name');await name.fill('synthetic');await name.scrollIntoViewIfNeeded();await expect(name).toBeInViewport();await expect(page.locator('#employer-directory-save')).toBeInViewport();
  await page.evaluate(()=>document.getElementById('employer-directory-dialog').close());
  await fixture('year-end-assist/index.html');await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;const memo=document.getElementById('yea-year-memo');for(let node=memo;node;node=node.parentElement)node.hidden=false;memo.disabled=false;},theme);
  const memo=page.locator('#yea-year-memo');await memo.fill('synthetic');await memo.scrollIntoViewIfNeeded();await expect(memo).toBeInViewport();
  const save=page.locator('#yea-save-memo');await save.scrollIntoViewIfNeeded();await expect(save).toBeInViewport();
 }
 if(keyboardViewport)await page.setViewportSize(keyboardViewport);

});

// Actual page markup and CSS, with synthetic states; never access a real vault.
test('upload save footer remains usable through success and recovery at phone and desktop widths',async({page})=>{
 await page.route('**/*',route=>route.abort('blockedbyclient'));
 const url=new URL('../public/upload/index.html',import.meta.url);
 const csp="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";
 await page.setContent(readFileSync(url,'utf8').replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${csp}">`));
 const styles=new Set(['ress','style','theme','upload','cloud','vault'].map(name=>new URL(`../public/styles/${name}.css`,import.meta.url).href));
 for(const href of await page.locator('link[rel="stylesheet"]').evaluateAll(links=>links.map(link=>link.getAttribute('href')))){
  const source=new URL(href,url);source.search='';expect(styles.has(source.href)).toBe(true);await page.addStyleTag({content:readFileSync(source,'utf8')});
 }
 for(const [width,height] of [[360,800],[390,844],[412,915],[820,900],[1280,800]]){
  await page.setViewportSize({width,height});
  for(const theme of ['light','dark'])for(const state of ['before','checked','saving','failed','recovery','checking','success']){
   const out=await page.evaluate(([theme,state])=>{
     const $=id=>document.getElementById(id),el=s=>document.querySelector(s);
     document.documentElement.dataset.theme=theme;el('.workspace').classList.remove('is-empty');el('.save-bar').classList.remove('is-empty');
     $('file-list-empty').hidden=true;$('file-list').hidden=false;$('file-list').replaceChildren();const li=document.createElement('li');li.className='file-list__item';li.textContent='synthetic.pdf';$('file-list').append(li);
     $('review-empty').hidden=true;$('review-content').hidden=false;
     const recover=['recovery','checking'].includes(state),active=state==='saving',failed=['failed','recovery','checking'].includes(state),success=state==='success';
     el('.save-bar').classList.toggle('is-recovering',recover);
     $('save-status').hidden=active;$('save-status').setAttribute('role',failed?'alert':'status');$('save-status').textContent=failed?'保存に失敗しました: OneDriveフォルダー一覧の取得：OneDriveへの照会通信に失敗しました（再試行上限）。':'1件を保存できます。';
     $('zero-approval').hidden=!['before','checked','failed'].includes(state);$('zero-approval-count').textContent='1件・9項目（未選択時は空欄）';$('zero-missing-amounts').checked=state==='checked';
     $('save-all').disabled=!['before','checked','failed'].includes(state);$('save-feedback').hidden=['before','checked'].includes(state);$('save-feedback').classList.toggle('is-failed',failed);$('save-feedback').classList.toggle('is-complete',success);
     $('save-stage').textContent=failed?'保存を完了できませんでした':success?'OneDriveへの保存完了':'保存済みデータを確認中…';$('save-elapsed').textContent='経過 1:20';$('save-guidance').textContent=failed?'選択したPDFと入力内容は保持しています。':'完了するまでこの画面を開いてください。';
     $('upload-save-recovery').hidden=!recover;$('upload-save-recovery-status').textContent=state==='checking'?'OneDriveの保存結果を確認中…':'書き込み結果が不明です。OneDriveの状態を確認してください。入力内容は保持しています。';
     const rect=e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height,x:r.x,y:r.y,bottom:r.bottom,right:r.right}};
     return {option:rect($('zero-approval')),hasDetails:Boolean($('zero-approval').querySelector('details')),stage:rect($('save-stage')),overflow:document.documentElement.scrollWidth-innerWidth,bar:rect(el('.save-bar')),status:rect(el('.save-bar__status')),actions:rect(el('.save-bar__actions')),button:rect($('save-all')),feedback:rect($('save-feedback')),list:rect($('file-list')),panel:rect(el('.file-panel')),review:rect(el('.review-panel')),recheck:rect($('upload-save-recheck')),rootHeight:document.documentElement.scrollHeight};
    },[theme,state]);
   const label=`${width} ${theme} ${state}`;
   expect(out.hasDetails,label).toBe(false);expect(out.overflow,label).toBeLessThanOrEqual(1);expect(out.list.h,label).toBeGreaterThan(15);expect(out.status.w,label).toBeGreaterThan(100);expect(out.bar.h,label).toBeLessThan(500);
   if(['before','checked','failed'].includes(state)){expect(out.option.w,label).toBeGreaterThanOrEqual(out.bar.w-45);expect(out.option.bottom,label).toBeLessThanOrEqual(out.status.y+1);}
   if(state==='failed')expect(out.stage.h,label).toBe(0);
   if(width>860&&out.button.w){expect(out.button.x,label).toBeGreaterThanOrEqual(out.status.right);expect(out.status.w,label).toBeGreaterThan(out.bar.w*.65);}
   if(width<=860){
    expect(out.status.w,label).toBeGreaterThanOrEqual(out.bar.w-45);
    if(!['recovery','checking'].includes(state)){expect(out.button.w,label).toBeGreaterThanOrEqual(out.bar.w-45);expect(out.actions.y,label).toBeGreaterThanOrEqual(out.status.bottom-1);}
    else expect(out.recheck.w,label).toBeGreaterThan(out.bar.w*.75);
   }
  }
 }
});

// Real shared controller and CSS, with an isolated synthetic save surface.
// No app bootstrap, credentials, or OneDrive request is needed for layout.
test('shared loading notification keeps its anchor across save phases',async({page})=>{
 const {build}=await import('esbuild');
 const {fileURLToPath}=await import('node:url');
 const bundle=await build({stdin:{contents:"export {createAppStatus} from './src/ui/appStatus.ts'",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,format:'iife',globalName:'NoticeFixture',write:false,logLevel:'silent'});
 await page.route('**/*',route=>route.abort('blockedbyclient'));
 for(const width of [320,390,1280])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:800});
  for(const cls of ['vault-bottom','save-bar','yea-upload-savebar']){
   await page.setContent(`<main><div class="${cls}" style="position:fixed;right:12px;bottom:85px;width:120px;height:34px;z-index:2"><button type="button">保存</button></div></main><div id="synthetic-status" hidden></div>`);
   for(const name of ['ress','style','theme'])await page.addStyleTag({content:readFileSync(new URL(`../public/styles/${name}.css`,import.meta.url),'utf8')});
   await page.addScriptTag({content:bundle.outputFiles[0].text});
   const result=await page.evaluate(({theme,cls})=>{
    document.documentElement.dataset.theme=theme;
    const el=document.getElementById('synthetic-status'),surface=document.querySelector('.'+cls);
    const status=NoticeFixture.createAppStatus(el,'edit'),scope=cls==='vault-bottom'?undefined:status.begin('edit');
    const show=message=>status.show('loading',message,false,{scope});
    show('解析済み給与データを保存・検証しています。'.repeat(8));
    const before=el.getBoundingClientRect(),anchor=el.style.getPropertyValue('--status-bottom');
    const dismiss=el.querySelector('.app-status__dismiss'),dismissBorder=getComputedStyle(dismiss).borderTopWidth;
    const observer=new MutationObserver(()=>{});observer.observe(el,{attributes:true,attributeFilter:['hidden']});
    show('Finance連携中…');
    const after=el.getBoundingClientRect(),hiddenChanges=observer.takeRecords().length;observer.disconnect();
    const b=surface.getBoundingClientRect();
    const overlap=after.top<b.bottom&&after.bottom>b.top&&after.left<b.right&&after.right>b.left;
    surface.style.bottom='500px';window.dispatchEvent(new Event('scroll'));
    const reset=el.style.getPropertyValue('--status-bottom');
    status.show('success','保存完了',false,{scope});
    const outcome=el.dataset.state;status.clear();
    return {anchor,dismissBorder,drift:Math.abs(before.bottom-after.bottom),hiddenChanges,overlap,reset,outcome,hidden:el.hidden};
   },{theme,cls});
   expect(result.anchor,`${width} ${theme} ${cls}`).not.toBe('');
   expect(result.dismissBorder).toBe('0px');
   expect(result.drift).toBeLessThanOrEqual(1);expect(result.hiddenChanges).toBe(0);expect(result.overlap).toBe(false);
   expect(result.reset).toBe('');expect(result.outcome).toBe('success');expect(result.hidden).toBe(true);
  }
 }
 // No separate region is available: reuse the status slot rather than cover the button.
 for(const cls of ['save-bar','yea-upload-savebar'])for(const theme of ['light','dark']){
  await page.setViewportSize({width:390,height:300});
  await page.setContent(`<main><div class="${cls}" style="position:fixed;inset:5px 10px;display:flex;flex-direction:column;align-items:stretch;justify-content:center"><div data-status-inline></div><button type="button">保存</button></div></main><div id="synthetic-status" hidden></div>`);
  for(const name of ['ress','style','theme'])await page.addStyleTag({content:readFileSync(new URL(`../public/styles/${name}.css`,import.meta.url),'utf8')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const fallback=await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;const status=NoticeFixture.createAppStatus(document.getElementById('synthetic-status'),'edit');status.error('長い合成エラー'.repeat(80));const host=document.querySelector('[data-status-inline]'),a=status.element.getBoundingClientRect(),b=host.nextElementSibling.getBoundingClientRect();const result={inline:host.contains(status.element),separate:status.element.hasAttribute('data-inline'),overlap:a.top<b.bottom&&a.bottom>b.top&&a.left<b.right&&a.right>b.left,button:b.top>=0&&b.bottom<=innerHeight,one:document.querySelectorAll('.app-status:not([hidden])').length===1};status.clear();return {...result,cleared:status.element.hidden&&!host.contains(status.element)};},theme);
  expect(fallback).toEqual({inline:true,separate:true,overlap:false,button:true,one:true,cleared:true});
 }

});

 test('employer overview, editor and assignment use verified data without writing on cancel',async({page})=>{
  const {employerFixtureScript}=await import('./employer-ui-fixture.mjs');
  await page.route('**/backup.js',route=>route.fulfill({contentType:'application/javascript',body:employerFixtureScript()}));
  await page.route('**/release-history.js',route=>route.fulfill({contentType:'application/javascript',body:''}));
  await page.goto('/backup/index.html');
  const list=page.locator('#employer-directory-list'),modal=page.locator('#employer-directory-dialog'),bulk=page.locator('#employer-bulk-dialog');
  await expect(list).toContainText('架空本業');await expect(list).toContainText('2月・8月');
  await expect(list).toContainText('架空副業');await expect(list).toContainText('名称未登録の勤務先');
  await expect(list.locator('details')).not.toHaveAttribute('open','');
  await expect(page.locator('#employer-bulk-total')).toHaveText('勤務先未設定の明細 2件');
  const initialViewport=page.viewportSize(),initialTheme=await page.evaluate(()=>document.documentElement.getAttribute('data-theme'));
  for(const theme of ['light','dark']){
   await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
   for(const width of [320,390,855,1280]){
    await page.setViewportSize({width,height:900});
    const layout=await list.evaluate(el=>{
     const [main,side]=el.querySelectorAll(':scope > .employer-settings__group');
     const a=main.getBoundingClientRect(),b=side.getBoundingClientRect();
     const forecastRows=[...el.querySelectorAll('.employer-settings__forecast > div')];
     return {width:el.clientWidth,sideBySide:Math.abs(a.top-b.top)<1,overflow:document.documentElement.scrollWidth-innerWidth,
      gaps:forecastRows.map(row=>row.querySelector('dd').getBoundingClientRect().left-row.querySelector('dt').getBoundingClientRect().right),
      clipped:forecastRows.some(row=>row.querySelector('dd').scrollWidth>row.querySelector('dd').clientWidth)};
    });
    expect(layout.sideBySide).toBe(layout.width>=600);expect(layout.overflow).toBeLessThanOrEqual(0);expect(layout.clipped).toBe(false);
    for(const gap of layout.gaps){expect(gap).toBeGreaterThanOrEqual(8);expect(gap).toBeLessThanOrEqual(16);}
   }
  }
  if(initialViewport)await page.setViewportSize(initialViewport);
  await page.evaluate(value=>{if(value===null)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',value);},initialTheme);
  const edit=list.getByRole('button',{name:/架空本業を編集/});await edit.click();
  await expect(modal).toBeVisible();await expect(modal.locator('input[name="employer-role"][value="side"]')).toBeDisabled();
  await expect(modal.locator('input[name="employer-bonus-month"][value="2"]')).toBeChecked();
  await modal.locator('#employer-directory-name').fill('破棄する入力');await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();await expect(edit).toBeFocused();expect(await page.evaluate(()=>window.fixture.writes)).toBe(0);
  await edit.click();await expect(modal.locator('#employer-directory-name')).toHaveValue('架空本業');
  await modal.locator('input[name="employer-bonus-month"][value="2"]').uncheck();await modal.locator('input[name="employer-bonus-month"][value="8"]').uncheck();
  await expect(modal.locator('#employer-bonus-month-hint')).toHaveText('算出しない');
  await page.evaluate(()=>window.fixture.pauseWrite=true);await modal.locator('#employer-directory-save').click();
  await expect(modal.locator('#employer-directory-save')).toBeDisabled();await page.keyboard.press('Escape');await expect(modal).toBeVisible();
  await page.evaluate(()=>window.fixture.release());await expect(modal).toBeHidden();expect(await page.evaluate(()=>window.fixture.writes)).toBe(1);
  expect(await page.evaluate(()=>window.fixture.list.find(e=>e.current&&e.role==='main').forecast.bonusMonths)).toEqual([]);
  await page.locator('#employer-directory-add').click();await modal.locator('#employer-directory-name').fill('架空追加');
  await modal.locator('#employer-directory-current').check();await expect(modal.locator('#employer-current-hint')).toContainText('架空本業');
  await modal.locator('#employer-directory-close').click();await expect(modal).toBeHidden();
  await page.evaluate(()=>window.fixture.pauseWrite=false);
  await list.locator('details summary').click();
  await list.getByRole('button',{name:/架空旧勤務先を編集/}).click();await modal.locator('#employer-directory-current').check();
  await expect(modal.locator('#employer-current-hint')).toContainText('架空本業');await modal.locator('#employer-directory-save').click();await expect(modal).toBeHidden();
  expect(await page.evaluate(()=>window.fixture.list.find(e=>e.name==='架空本業').current)).toBe(false);
  expect(await page.evaluate(()=>window.fixture.list.find(e=>e.name==='架空旧勤務先').current)).toBe(true);
  const beforeLegacy=await page.evaluate(()=>window.fixture.records);
  await list.getByRole('button',{name:'名称を設定',exact:true}).click();await expect(modal.locator('#employer-directory-heading')).toHaveText('勤務先の名称を設定');
  await modal.locator('#employer-directory-name').fill('架空名称設定');await modal.locator('#employer-directory-save').click();await expect(modal).toBeHidden();
  expect(await page.evaluate(()=>window.fixture.records)).toEqual(beforeLegacy);await expect(list).not.toContainText('名称未登録の勤務先');
  await page.evaluate(()=>window.fixture.failWrite=true);await list.getByRole('button',{name:/架空旧勤務先を編集/}).click();await modal.locator('#employer-directory-name').fill('保存失敗の入力');await modal.locator('#employer-directory-save').click();
  await expect(modal).toBeHidden();await expect(page.locator('#employer-directory-status')).toContainText('保存結果を確認できませんでした');await expect(list).not.toContainText('保存失敗の入力');
  const toast=page.locator('.app-status');await expect(toast).toHaveAttribute('data-state','error');
  await page.evaluate(()=>window.fixture.failWrite=false);
  await list.getByRole('button',{name:/架空副業を編集/}).click();await modal.locator('#employer-directory-save').click();await expect(modal).toBeHidden();
  await expect(toast).toHaveAttribute('data-state','success');
  await list.getByRole('button',{name:/架空旧勤務先を編集/}).click();await modal.locator('#employer-directory-save').click();await expect(modal).toBeHidden();
  await expect(toast).toHaveAttribute('data-state','success');
  await page.locator('#employer-bulk-open').click();await expect(bulk).toBeVisible();
  await expect(bulk.locator('#employer-bulk-save')).toBeDisabled();
  const target=bulk.locator('#employer-bulk-target');await target.selectOption({label:'架空本業（本業）'});
  await expect(bulk.locator('#employer-bulk-list input')).toHaveCount(1);await bulk.locator('#employer-bulk-all').click();
  await target.selectOption({label:'架空副業（副業）'});await expect(bulk.locator('#employer-bulk-save')).toBeDisabled();
  await bulk.locator('#employer-bulk-all').click();await bulk.locator('#employer-bulk-save').click();
  await expect(page.locator('dialog[open]')).toHaveCount(1);await expect(bulk).toBeHidden();
  await page.locator('dialog[open]').getByRole('button',{name:'キャンセル'}).click();await expect(bulk).toBeVisible();expect(await page.evaluate(()=>window.fixture.writes)).toBe(6);
  await bulk.locator('#employer-bulk-save').click();await page.locator('dialog[open]').getByRole('button',{name:'勤務先を設定',exact:true}).click();
  await expect(bulk).toBeHidden();await expect(page.locator('#employer-bulk-total')).toHaveText('勤務先未設定の明細 1件');
  await page.locator('#employer-bulk-open').click();await target.selectOption({label:'架空本業（本業）'});await bulk.locator('#employer-bulk-all').click();await bulk.locator('#employer-bulk-save').click();await page.locator('dialog[open]').getByRole('button',{name:'勤務先を設定',exact:true}).click();
  await expect(page.locator('#employer-bulk-panel')).toBeHidden();expect(await page.evaluate(()=>window.fixture.writes)).toBe(8);
  await page.evaluate(()=>window.fixture.failRead=true);await page.locator('#employer-directory-load').click();
  await expect(page.locator('#employer-directory-load')).toHaveText('再読み込み');await expect(list).toBeHidden();await expect(page.locator('#employer-directory-add')).toBeHidden();
 });

// Isolated production dialog controller; no real records or account connection.
test('missing statement details show one distinct link per record on desktop and mobile', async ({page})=>{
 const {stripTypeScriptTypes}=await import('node:module');
 const source=readFileSync(new URL('../src/ui/operationDialog.ts',import.meta.url),'utf8').replace(/^export /gm,'');
 await page.route('**/*',route=>route.abort('blockedbyclient'));
 await page.setContent('<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><button id="trigger">未入力</button></body></html>');
 for(const name of ['ress','style','dashboard','theme'])await page.addStyleTag({content:readFileSync(new URL(`../public/styles/${name}.css`,import.meta.url),'utf8')});
 await page.addScriptTag({content:stripTypeScriptTypes(source,{mode:'strip'})+'\nwindow.openMissingFixture=showOperationMessage;window.confirmFixture=confirmOperation;'});
 const href='./edit/index.html#id=3&mode=calendar&year=2026&hintYear=2025';
 const label='synthetic-'+ 'longfilename'.repeat(12)+'.pdf';
 const description='2026年2月 · 本業 · <synthetic> · 賞与';
 const trigger=page.locator('#trigger');
 for(const theme of ['light','dark'])for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:800});
  await page.evaluate(({theme,href,label,description})=>{
   document.documentElement.dataset.theme=theme;document.getElementById('trigger').focus();
   void window.openMissingFixture({title:'本業：総支給額の未入力',details:['未入力の明細：1件'],links:[{label,description,href}],afterLinks:['見込みの算出不足：1件'],acceptLabel:'閉じる'},()=>true);
  },{theme,href,label,description});
  const dialog=page.locator('dialog');const link=dialog.getByRole('link');
  await expect(dialog.locator('li')).toHaveCount(1);await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href',href);
  await expect(link.locator('.operation-dialog__link-label')).toHaveText(label);
  await expect(link.locator('.operation-dialog__link-description')).toHaveText(description);
  expect(await link.evaluate(e=>{const r=e.getBoundingClientRect();const d=e.closest('dialog').getBoundingClientRect();return r.width>0&&r.height>=44&&r.left>=d.left&&r.right<=d.right&&e.scrollWidth<=e.clientWidth;})).toBe(true);
  await expect(dialog.locator('.operation-dialog__link-note')).toHaveCount(1);
  await expect(dialog).not.toContainText('0を入力して保存');
  await link.hover();
  await expect(link).toHaveCSS('text-decoration-line','none');
  await expect(link.locator('.operation-dialog__link-label')).toHaveCSS('text-decoration-line','none');
  await expect(link.locator('.operation-dialog__link-description')).toHaveCSS('text-decoration-line','none');
  await link.focus();await expect(link).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();
 }
 // Real long confirmation and error dialogs, including short landscape screens.
 for(const theme of ['light','dark'])for(const [width,height] of [[320,430],[740,320],[1280,800]]){
  await page.setViewportSize({width,height});
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.longResult=null;void window.confirmFixture({title:'確認',subject:'合成の確認',details:['長い確認内容\n'.repeat(400)],acceptLabel:'実行',requiredText:'確認',tone:'danger'},()=>true).then(result=>{window.longResult=result;});},theme);
  const d=page.locator('dialog');await expect(d).toBeVisible();await expect(d.getByRole('button',{name:'実行'})).toBeDisabled();
  await assertScrollableModal(d);await d.locator('input').fill('確認');await expect(d.getByRole('button',{name:'実行'})).toBeEnabled();await d.getByRole('button',{name:'キャンセル'}).click();await expect(d).toHaveCount(0);expect(await page.evaluate(()=>window.longResult)).toBe(false);
  await page.evaluate(()=>{void window.openMissingFixture({title:'エラー',details:['長いエラー内容\n'.repeat(400)],acceptLabel:'閉じる',tone:'danger'},()=>true);});
  await assertScrollableModal(d);await d.getByRole('button',{name:'閉じる'}).click();await expect(d).toHaveCount(0);
 }
 // Different records remain different rows; forecast-only rows are not links.
 await page.evaluate(({href,label,description})=>{void window.openMissingFixture({title:'未入力',details:['未入力の明細：2件'],links:[{href,label,description},{href:href.replace('id=3','id=4'),label:'other.pdf',description}],afterLinks:['見込みの算出不足：1件'],acceptLabel:'閉じる'},()=>true);},{href,label,description});
 await expect(page.locator('dialog li')).toHaveCount(2);await expect(page.locator('dialog a')).toHaveCount(2);
 await page.getByRole('button',{name:'閉じる'}).click();
 await page.evaluate(()=>{void window.openMissingFixture({title:'未入力',details:['登録済み明細に未入力はありません。'],links:[],afterLinks:['見込みの算出不足：1件'],acceptLabel:'閉じる'},()=>true);});
 await expect(page.locator('dialog a')).toHaveCount(0);await expect(page.locator('dialog')).toContainText('見込みの算出不足：1件');
});

// Real edit markup, styles and shared notification controller, without auth or cloud I/O.
test('saved editor scrolls independently and integrates notices into the save controls',async({page})=>{
 const {build}=await import('esbuild');
 const {fileURLToPath}=await import('node:url');
 const bundle=await build({stdin:{contents:"export {createAppStatus} from './src/ui/appStatus.ts'",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,format:'iife',globalName:'NoticeFixture',write:false,logLevel:'silent'});
 // Keep the genuine page and its CSP. Only the document, its styles, and the
 // synthetic notification bundle may load; the actual application never starts.
 const origin='http://127.0.0.1:4177';
 const fixtureUrl=origin+'/__e2e__/editor-notice.js';
 const styles=new Map(['ress','style','upload','vault','cloud','theme'].map(name=>[origin+`/styles/${name}.css`,fileURLToPath(new URL(`../public/styles/${name}.css`,import.meta.url))]));
 await page.route('**/*',async route=>{
  const request=route.request(),url=request.url(),type=request.resourceType();
  if(request.method()==='GET'){
   if(type==='script'&&url===fixtureUrl)return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
   if(type==='document'&&url===origin+'/edit/index.html')return route.fulfill({contentType:'text/html; charset=utf-8',path:fileURLToPath(new URL('../public/edit/index.html',import.meta.url))});
   if(type==='stylesheet'&&styles.has(url))return route.fulfill({contentType:'text/css; charset=utf-8',path:styles.get(url)});
  }
  return route.abort('blockedbyclient');
 });
 await page.goto('/edit/index.html');
 await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
 await expect(page.locator('#editor')).toBeHidden();
 await page.addScriptTag({url:fixtureUrl});
 await page.evaluate(()=>{
  document.getElementById('record-name').textContent='synthetic-statement.pdf';
  document.getElementById('record-details').textContent='2026-01 / synthetic';
  document.getElementById('editor').hidden=false;
  window.editorNotice=NoticeFixture.createAppStatus(undefined,'edit');
 });
 for(const [width,height] of [[1280,800],[855,650],[390,800],[320,600]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});
  const toolbar=await page.evaluate(({width,theme})=>{
   document.documentElement.dataset.theme=theme;
   const bar=document.querySelector('.selected-file'),name=document.getElementById('record-name'),diagnostic=document.getElementById('record-diagnostic-open');
   name.textContent='synthetic-statement.pdf';document.getElementById('record-details').textContent='PDF 141 KB';
   const bounds=bar.getBoundingClientRect(),d=diagnostic.getBoundingClientRect();
   const fits=()=>{const b=bar.getBoundingClientRect();return [...bar.querySelectorAll('.btn')].every(e=>{const r=e.getBoundingClientRect();return r.left>=b.left-1&&r.right<=b.right+1;})&&document.querySelector('.edit-scroll').scrollWidth<=document.querySelector('.edit-scroll').clientWidth&&document.documentElement.scrollWidth<=innerWidth;};
   const compact=bounds.height<=(width>680?70:110),singleRow=Math.abs(d.top-bar.querySelector('.selected-file__actions').getBoundingClientRect().top)<1,normalFits=fits();
   name.textContent='synthetic_long_filename_'.repeat(10)+'.pdf';const longFits=fits();name.textContent='synthetic-statement.pdf';
   return {compact,singleRow,normalFits,longFits,diagnosticInToolbar:bar.contains(diagnostic),diagnosticDisabled:diagnostic.disabled,diagnosticAccessible:diagnostic.getAttribute('aria-label')==='詳細診断',diagnosticSize:d.width>=36&&d.height>=36,insideEditor:document.querySelector('.saved-editor-panel').contains(bar),sharedFile:bar.querySelector('.selected-file__icon')!==null,headingOnly:document.querySelector('.edit-page > .upload-heading').textContent.trim()==='明細を編集'};
  },{width,theme});
  expect(toolbar).toEqual({compact:true,singleRow:true,normalFits:true,longFits:true,diagnosticInToolbar:true,diagnosticDisabled:true,diagnosticAccessible:true,diagnosticSize:true,insideEditor:true,sharedFile:true,headingOnly:true});
  const result=await page.evaluate(async({width,theme})=>{
   document.documentElement.dataset.theme=theme;
   const region=document.querySelector(width>680?'.saved-editor-panel':'.edit-scroll');
   const footer=document.querySelector('.edit-page .vault-bottom'),button=document.getElementById('edit-save');
   const notice=window.editorNotice,el=notice.element;
   const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const draft=document.getElementById('edit-status');draft.setAttribute('data-routine','');draft.textContent='未保存の変更があります。';
   // Each viewport/theme is an independent focus test. Re-focusing the
   // already focused input does not invoke the browser's focus scrolling.
   if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
   notice.clear();region.scrollTop=0;await settle();
   const scope=notice.begin('edit');notice.show('loading','保存処理中…',false,{scope});await settle();
   const initialFooter=footer.getBoundingClientRect();
   region.scrollTop=region.scrollHeight;await settle();const moved=region.scrollTop>0;
   notice.show('loading','合成データの保存結果を検証しています。'.repeat(80),false,{scope});await settle();
   const long=el.querySelector('.app-status__message');const longScrollable=long.scrollHeight>long.clientHeight;
   notice.show('error','合成データの保存に失敗しました。'.repeat(30),false,{scope});await settle();
   const last=el.getBoundingClientRect(),f=footer.getBoundingClientRect(),b=button.getBoundingClientRect();
   const lastField=document.querySelector('[name="otherDeductions"]');lastField.focus();await settle();
   const field=lastField.getBoundingClientRect(),r=region.getBoundingClientRect();
   const overlap=last.left<b.right&&last.right>b.left&&last.top<b.bottom&&last.bottom>b.top;
   const result={moved,docScroll:document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight,scrollY:window.scrollY,footerDrift:Math.abs(initialFooter.bottom-f.bottom),inline:el.hasAttribute('data-inline')&&footer.contains(el),longScrollable,overlap,routineHidden:getComputedStyle(draft).display==='none',onlyOne:document.querySelectorAll('.app-status:not([hidden])').length===1&&document.getElementById('edit-error').hidden,buttonVisible:b.top>=0&&b.bottom<=innerHeight,fieldVisible:field.top>=r.top-1&&field.bottom<=r.bottom+1,overflow:document.documentElement.scrollWidth>innerWidth,closeVisible:el.querySelector('button').getBoundingClientRect().top>=0};
   el.querySelector('button').click();return {...result,draftRestored:getComputedStyle(draft).display!=='none'&&el.hidden};
  },{width,theme});
  expect(result,`${width}×${height} ${theme}`).toMatchObject({moved:true,scrollY:0,inline:true,longScrollable:true,overlap:false,routineHidden:true,onlyOne:true,buttonVisible:true,fieldVisible:true,overflow:false,closeVisible:true,draftRestored:true});
  expect(result.docScroll).toBeLessThanOrEqual(1);expect(result.footerDrift).toBeLessThanOrEqual(1);
 }
 for(const [width,height] of [[390,430],[740,320],[320,250]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});
  const short=await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;const button=document.getElementById('edit-save'),notice=window.editorNotice;button.scrollIntoView({block:'end'});notice.error('合成の長文エラー'.repeat(80));button.scrollIntoView({block:'end'});const a=notice.element.getBoundingClientRect(),b=button.getBoundingClientRect();const result={natural:document.scrollingElement.scrollHeight>innerHeight,inline:notice.element.hasAttribute('data-inline'),button:b.top>=0&&b.bottom<=innerHeight+1,overlap:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,overflow:document.documentElement.scrollWidth>innerWidth};notice.clear();return result;},theme);
  expect(short).toEqual({natural:true,inline:true,button:true,overlap:false,overflow:false});
 }
 // Initial loading or failed authorization must not be clipped by the editor layout.
 await page.evaluate(()=>{document.getElementById('editor').hidden=true;const error=document.getElementById('edit-error');error.hidden=false;error.textContent='合成の読み込みエラー';});
 await expect(page.locator('#edit-error')).toBeVisible();
});

// The diagnostic uses one native dialog; explicit reveal precedes explicit copy.
test('saved record diagnostic has one dialog, contextual action and top close',async({page})=>{
 const {build}=await import('esbuild');
 const {fileURLToPath}=await import('node:url');
 const bundle=await build({stdin:{contents:"export {openRecordDiagnostic,dismissRecordDiagnostic} from './src/ui/recordDiagnostic.ts'",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,format:'iife',globalName:'DiagnosticFixture',write:false,logLevel:'silent'});
 await page.route('**/*',route=>route.abort('blockedbyclient'));
 await page.setContent('<button id="trigger" type="button">詳細診断</button>');
 for(const name of ['ress','style','vault','theme'])await page.addStyleTag({content:readFileSync(new URL(`../public/styles/${name}.css`,import.meta.url),'utf8')});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(()=>{
  window.diagnosticReads=0;window.diagnosticCopies=[];window.diagnosticAllowed=true;
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){window.diagnosticCopies.push(value);}}});
  document.getElementById('trigger').addEventListener('click',()=>DiagnosticFixture.openRecordDiagnostic(()=>{window.diagnosticReads++;return JSON.stringify({synthetic:Array.from({length:100},(_,i)=>`synthetic-${i}`)},null,2);},()=>window.diagnosticAllowed));
 });
 for(const [width,height] of [[320,600],[390,800],[1280,800]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.diagnosticReads=0;window.diagnosticCopies=[];window.diagnosticAllowed=true;},theme);
  await page.locator('#trigger').click();const d=page.locator('.record-diagnostic');
  await expect(d).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(1);await expect(d.locator('button')).toHaveCount(2);
  await expect(d.getByRole('button',{name:'閉じる'})).toBeFocused();await expect(d.locator('pre')).toBeHidden();expect(await page.evaluate(()=>window.diagnosticReads)).toBe(0);
  await d.getByRole('button',{name:'診断データを表示'}).click();await expect(d.locator('pre')).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(1);await expect(d.locator('button')).toHaveCount(2);
  expect(await d.evaluate(e=>{const r=e.getBoundingClientRect(),x=e.querySelector('.operation-dialog__header button').getBoundingClientRect(),h=e.querySelector('h2').getBoundingClientRect(),p=e.querySelector('pre');return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&x.left>=h.right-1&&x.top<p.getBoundingClientRect().top&&e.scrollWidth<=e.clientWidth+1&&e.querySelector('.operation-dialog__body').scrollHeight>e.querySelector('.operation-dialog__body').clientHeight;})).toBe(true);
  await assertScrollableModal(d);await d.getByRole('button',{name:'診断データをコピー'}).click();await expect(d.getByRole('status')).toHaveText('クリップボードにコピーしました。');expect(await page.evaluate(()=>[window.diagnosticReads,window.diagnosticCopies.length])).toEqual([1,1]);
  await d.getByRole('button',{name:'閉じる'}).click();await expect(d).toHaveCount(0);await expect(page.locator('#trigger')).toBeFocused();
  await page.locator('#trigger').click();await page.keyboard.press('Escape');await expect(d).toHaveCount(0);
  await page.locator('#trigger').click();await d.getByRole('button',{name:'診断データを表示'}).click();await page.evaluate(()=>{window.diagnosticAllowed=false;});await d.getByRole('button',{name:'診断データをコピー'}).click();await expect(d).toHaveCount(0);expect(await page.evaluate(()=>window.diagnosticCopies.length)).toBe(1);
 }
});
// Real Web Locks + strict IndexedDB with a synthetic remote transport only.
test('write lock recovery survives page termination but refuses active and unknown writes',async({page,context})=>{
 const {build}=await import('esbuild');
 const {fileURLToPath}=await import('node:url');
 const bundle=await build({stdin:{contents:"export {PayrollGraph,PAYROLL_WRITE_LOCK_NAME} from './src/cloud/graph.ts'",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,format:'iife',globalName:'LockFixture',write:false,logLevel:'silent'});
 const origin='http://127.0.0.1:4177',docUrl=origin+'/__e2e__/lock.html',jsUrl=origin+'/__e2e__/lock.js';
 const name='payroll-write-lock-v1.bin';let owner=null,serial=0,writes=0,loseWrite=false;
 const reply=(status,body=null)=>({status,body:body===null?null:typeof body==='string'?body:JSON.stringify(body)});
 const meta=()=>({id:owner.id,eTag:owner.etag,name,size:64,'@microsoft.graph.downloadUrl':'https://storage.example.test/'+owner.id});
 const install=async p=>{
  await p.route('**/*',r=>{
   const q=r.request();if(q.method()==='GET'&&q.url()===docUrl&&q.resourceType()==='document')return r.fulfill({contentType:'text/html',body:'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><title>Lock fixture</title>'});
   if(q.method()==='GET'&&q.url()===jsUrl&&q.resourceType()==='script')return r.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
   return r.abort('blockedbyclient');
  });
  await p.exposeFunction('lockFixtureTransport',(raw,method,etag,text)=>{
   const url=new URL(raw),path=url.pathname;
   if(url.origin==='https://storage.example.test'&&method==='GET')return owner&&path==='/'+owner.id?reply(200,owner.text):reply(404);
   if(url.origin!=='https://graph.microsoft.com')throw Error('unexpected synthetic origin');
   if(method==='GET'&&path.endsWith('/special/approot'))return reply(200,{id:'root'});
   if(method==='PUT'&&path.endsWith('/root:/'+name+':/content')){
    expect(url.searchParams.get('@microsoft.graph.conflictBehavior')).toBe('fail');
    if(owner)return reply(409);
    expect(text).toMatch(/^[a-f0-9]{64}$/);owner={id:'lock-'+(++serial),etag:'etag-'+serial,text};return reply(201,meta());
   }
   if(method==='GET'&&path.endsWith('/root:/'+name))return owner?reply(200,meta()):reply(404);
   if(method==='DELETE'&&owner&&path.endsWith('/items/'+owner.id)){
    expect(etag).toBe(owner.etag);owner=null;return reply(204);
   }
   if(method==='POST'&&path.endsWith('/synthetic-write')){expect(owner).not.toBeNull();writes++;if(loseWrite)throw Error('synthetic lost mutation reply');return reply(200,{});}
   throw Error('unexpected synthetic request');
  });
  await p.goto(docUrl);await p.addScriptTag({url:jsUrl});
  await p.evaluate(()=>{
   const graph=new LockFixture.PayrollGraph('synthetic-only',async(url,init={})=>{
    if(String(url).endsWith('/synthetic-write')){
     const receipt=await graph.releaseReceipt(graph.writeOwner);
     if(await graph.checkpointStorage(receipt,'read'))throw Error('recovery marker was not revoked before dispatch');
    }
    const result=await window.lockFixtureTransport(String(url),init.method??'GET',new Headers(init.headers).get('If-Match'),init.body instanceof Uint8Array?new TextDecoder().decode(init.body):null);
    return new Response(result.body,{status:result.status});
   });
   window.tryFixtureWrite=async()=>{try{await graph.withWriteLock(()=>graph.request('/synthetic-write',{method:'POST'}));return 'ok';}catch(error){return error.message;}};
   window.startFixtureCheckpoint=()=>{void graph.withWriteLock(async()=>{window.fixtureCheckpoint=await graph.checkpointStorage(await graph.releaseReceipt(graph.writeOwner),'read');await new Promise(()=>{});}).catch(()=>{window.fixtureCheckpoint=false;});};
  });
 };
 await install(page);await page.evaluate(()=>window.startFixtureCheckpoint());
 await expect.poll(()=>page.evaluate(()=>window.fixtureCheckpoint)).toBe(true);
 const other=await context.newPage();await install(other);
 expect(await other.evaluate(()=>window.tryFixtureWrite())).toMatch(/他の端末/);expect(writes).toBe(0);
 // Destroy the execution context, without allowing the original finally block.
 await page.close();
 await expect.poll(()=>other.evaluate(async()=> (await navigator.locks.query()).held.filter(x=>x.name.startsWith("payroll-settled-lock-v1:")).length)).toBe(0);
 expect(await other.evaluate(()=>window.tryFixtureWrite())).toBe('ok');expect(writes).toBe(1);expect(owner).toBeNull();
 loseWrite=true;expect(await other.evaluate(()=>window.tryFixtureWrite())).toMatch(/ロックが残っている可能性/);expect(writes).toBe(2);expect(owner).not.toBeNull();
 await other.close();
 const reopened=await context.newPage();await install(reopened);loseWrite=false;
 expect(await reopened.evaluate(()=>window.tryFixtureWrite())).toMatch(/他の端末/);expect(writes).toBe(2);expect(owner).not.toBeNull();
 await reopened.close();
});
