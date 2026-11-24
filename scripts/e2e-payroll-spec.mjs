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
});

test('upload page displays PDF-only selection and returns home', async ({ page }) => {
  await page.goto('/upload/index.html');
  await expect(page.getByRole('heading', { name: 'PDFを追加', exact: true, level: 1 })).toBeVisible();
  const pdfInput = page.locator('input[type="file"]').first();
  await expect(pdfInput).toHaveAttribute('accept', /pdf/i);
  await expect(page.locator('.eyebrow,.section-kicker,.notice--privacy')).toHaveCount(0);
  await expect(page.locator('#drop-heading')).toHaveText('PDFを追加する');
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
 await expect(page.locator('#employer-load')).toHaveText('勤務先を選択する');
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

// Actual nested modal over the PDF diagnostic: cancellation must never reveal the raw text.
test('PDF diagnostic requires explicit shared-dialog consent to reveal original text',async({page})=>{
 await page.goto('/upload/index.html');
 await (await readyUploadInput(page)).setInputFiles({
  name:'synthetic-dialog.pdf',mimeType:'application/pdf',buffer:syntheticOnePagePdf(),
 });
 await expect(page.locator('#review-content')).toBeVisible();
 await page.locator('.upload-troubleshooting > summary').click();
 await page.locator('#diagnostic-button').click();
 const outer=page.locator('#diagnostic-dialog');
 const original=outer.locator('#diagnostic-view-original');
 const shared=outer.locator('#diagnostic-shared');
 await expect(original).toBeEnabled();
 await expect(shared).toHaveValue(/\[マスク済み\]/);
 await original.click();
 const confirm=page.getByRole('dialog',{name:'PDF診断の原文を表示',exact:true});
 await expect(confirm).toBeVisible();
 await expect(confirm.getByRole('button',{name:'キャンセル',exact:true})).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(confirm).toHaveCount(0);
 await expect(outer).toBeVisible();
 await expect(shared).not.toHaveValue(/"synthetic"/);
 await original.click();
 await confirm.getByRole('button',{name:'キャンセル',exact:true}).click();
 await expect(shared).not.toHaveValue(/"synthetic"/);
 await original.click();
 await confirm.getByRole('button',{name:'原文を表示',exact:true}).click();
 await expect(shared).toHaveValue(/"synthetic"/);
 await outer.locator('#diagnostic-redact').click();
 await expect(shared).not.toHaveValue(/"synthetic"/);
 await outer.locator('#diagnostic-copy-original').click();
 const copy=page.getByRole('dialog',{name:'PDF診断の原文をコピー',exact:true});
 await expect(copy).toBeVisible();
 await copy.getByRole('button',{name:'キャンセル',exact:true}).click();
 await expect(copy).toHaveCount(0);
 await outer.locator('#diagnostic-close').click();
 await expect(outer).toBeHidden();
 await expect(shared).toHaveValue('');
});

// No account or real data. The actual settings migration action is cancelled before any read/write.
test('settings migration confirmation cancels without opening the vault',async({page})=>{
 await page.goto('/backup/index.html');
 await page.getByRole('button',{name:/^Microsoft接続・認証/}).click();
 await expect(page.locator('#backup-cloud-status')).toContainText('Client ID未設定');
 await page.getByRole('button',{name:/^メンテナンス/}).click();
 const migrate=page.locator('#migrate-legacy-cloud');
 const dialog=page.getByRole('dialog',{name:'旧ブラウザ保存データを移行',exact:true});
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
});

// Real category navigation, no account or backup operations are invoked.
test('settings overview separates categories and retains only in-page drafts',async({page})=>{
 await page.goto('/backup/index.html');
 const menu=page.locator('#settings-menu');
 const version=page.locator('#settings-version');
 await expect(version).toBeVisible();
 await expect(version.locator('[data-build-version]')).toHaveText(/^v\d+\.\d+\.\d+ · .+ · (?:[a-f0-9]{4,64}|local)$/);
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
 await expect(page.locator('#restore-add-ack')).toBeDisabled();
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
 await expect(page.locator('#settings-personal-panel')).toBeVisible();
 await expect(menu.locator('button')).toHaveCount(4);
 await menu.getByRole('button',{name:/^勤務先管理/}).click();
 await expect(page.locator('#settings-backup-panel')).toBeHidden();
 await expect(page.locator('#settings-employers-panel')).toBeVisible();
 await expect(page.locator('#employer-directory-load')).toBeEnabled();
 await expect(page.locator('#employer-directory-form')).toBeHidden();
 await expect(page.locator('#employer-directory-save')).toBeDisabled();
 await expect(page.locator('#employer-bulk-panel')).toBeHidden();
 await expect(page.locator('#employer-bulk-save')).toBeDisabled();
 await expect(page.locator('#payroll-cloud-gate')).toHaveCount(0);
 await menu.getByRole('button',{name:/^メンテナンス/}).click();
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
   expect(edit.download).toBe(edit.original);expect(edit.download).toBe(edit.remove);
   expect(edit.width).toBe(edit.download);expect(edit.icon).toEqual([19,19]);expect(edit.overflow).toBe(0);
   expect(edit.downloadStyle).toEqual(edit.originalStyle);
   expect(edit.removeStyle.slice(1,4)).toEqual(edit.originalStyle.slice(1,4));
   expect(edit.removeStyle[0]).not.toBe(edit.originalStyle[0]);
   await page.addStyleTag({content:'.saved-file__actions .btn { transition: none !important; }'});
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
   document.querySelector('#employer-bulk-panel').hidden=false;
   const a=document.querySelector('.employer-settings'),b=document.querySelector('#employer-bulk-panel');
   return {gap:b.getBoundingClientRect().top-a.getBoundingClientRect().bottom,radius:getComputedStyle(a).borderRadius,
    menuRadius:getComputedStyle(document.querySelector('#settings-menu')).borderRadius,
    overflow:document.documentElement.scrollWidth-innerWidth};
  },theme);
  expect(settings.gap).toBe(18);expect(settings.radius).toBe('9px');expect(settings.menuRadius).toBe(settings.radius);expect(settings.overflow).toBe(0);
  for(const id of ['settings-backup-panel','settings-details-panel','settings-auth-panel']){
   await page.evaluate(id=>{for(const s of document.querySelectorAll('main>.settings-group'))s.hidden=s.id!==id;},id);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
  }
 }
});
