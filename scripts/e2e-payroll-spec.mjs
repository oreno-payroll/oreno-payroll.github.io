import { test, expect } from '@playwright/test';

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
  await expect(page.getByRole('heading', { name: '明細をアップロード' })).toBeVisible();
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
  const secret = page.locator('#export-password');
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill('synthetic-only');
  await page.locator('[data-toggle-password="export-password"]').click();
  await expect(secret).toHaveAttribute('type', 'text');
  await page.locator('[data-toggle-password="export-password"]').click();
  await expect(secret).toHaveAttribute('type', 'password');
});

test('upload page displays PDF-only selection and returns home', async ({ page }) => {
  await page.goto('/upload/index.html');
  await expect(page.getByRole('heading', { name: '明細をアップロード' })).toBeVisible();
  const pdfInput = page.locator('input[type="file"]').first();
  await expect(pdfInput).toHaveAttribute('accept', /pdf/i);
  await page.locator('a.header-back').click();
  await expect(page.getByRole('heading', { name: '収入ダッシュボード' })).toBeVisible();
});

test('year-end directory is reachable without any real employee data', async ({ page }) => {
  await page.goto('/year-end-assist/index.html');
  await expect(page.getByRole('heading', { name: '年末調整サポート', exact: true })).toBeVisible();
  await expect(page.locator('#yea-new-name')).toBeVisible();
  await expect(page.locator('#yea-person-create')).toBeVisible();
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


// Browser-side PDF upload/parse is exercised without a real payroll account.
test('synthetic PDF can enter the actual upload analysis UI without connecting to Graph', async ({page}) => {
 await page.goto('/upload/index.html');
 const bytes=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
 await page.locator('input[type="file"]').first().setInputFiles({name:'synthetic-only.pdf',mimeType:'application/pdf',buffer:bytes});
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
 await page.goto('/view/index.html?yearend='+id+'#handoff='+ticket);
 await expect(page.locator('#pdf-status')).toContainText('PDF以外のMIME形式は閲覧できません。', {timeout:15000});
 await expect(page.locator('#pdf-reader')).toBeHidden();
 await expect(page.locator('#pdf-reader')).not.toHaveAttribute('src',/blob:/);
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
    await expect(page.locator('.build-info')).toBeVisible();
    const fit = async () => page.evaluate(() => {
      const footer = document.querySelector('.build-info');
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
test('zero consent rejects stale inputs and never auto-selects itself',async({page})=>{
 await page.goto('/upload/index.html');
 const zero=page.locator('#zero-missing-amounts');
 await expect(zero).not.toBeChecked();
 await expect(page.locator('#zero-approval')).toBeHidden();
 await page.locator('input[type="file"]').first().setInputFiles({
  name:'synthetic-only.pdf',mimeType:'application/pdf',buffer:syntheticOnePagePdf(),
 });
 await expect(page.locator('#review-content')).toBeVisible();
 // The synthetic PDF contains no salary layout, so no kind can be inferred.
 // The opt-in must stay hidden until the user explicitly selects salary/bonus.
 await expect(page.locator('#zero-approval')).toBeHidden();
 await expect(zero).not.toBeChecked();
 // The radio input is a visually hidden 1px control. Click the visible
 // segmented-choice label as a user would, not the hidden input's 1px box.
 // Keep the real pointer hit-test (no force:true / evaluate(click)).
 await expect(page.locator('body > .build-info')).toHaveCSS('pointer-events','none');
 await page.locator('#review-form input[name="job"][value="main"] + span').click();
 await expect(page.locator('#review-form input[name="job"][value="main"]')).toBeChecked();
 await page.locator('#review-form input[name="kind"][value="salary"] + span').click();
 await expect(page.locator('#review-form input[name="kind"][value="salary"]')).toBeChecked();
 await expect(page.locator('#zero-approval')).toBeVisible();
 await expect(zero).not.toBeChecked();
 await page.locator('#review-form input[name="targetMonth"]').fill('2026-11');
 await page.locator('#review-form input[name="paymentDate"]').fill('2026-11-27');
 await page.locator('#review-form input[name="gross"]').fill('250000');
 await page.locator('#review-form input[name="net"]').fill('250000');
 await page.locator('#review-form input[name="taxable"]').fill('250000');
 await page.locator('#review-form input[name="nonTaxable"]').fill('0');
 await page.locator('#validate-button').click();
 await expect(zero).toBeEnabled();
 await zero.check();
 await expect(zero).toBeChecked();
 // Changing just one field invalidates both the per-file review and the global
 // zero-conversion consent. It cannot silently apply to the updated form.
 await page.locator('#review-form input[name="residentTax"]').fill('0');
 await expect(zero).not.toBeChecked();
 await expect(page.locator('#save-all')).toBeDisabled();
 await page.reload();
 await expect(zero).not.toBeChecked();
});
