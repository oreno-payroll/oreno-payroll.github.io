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
