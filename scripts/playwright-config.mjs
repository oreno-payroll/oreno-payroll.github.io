import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4177';

export default defineConfig({
  testDir: '.',
  testMatch: '**/e2e-payroll-spec.mjs',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../node_modules/.cache/payroll-playwright',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium', headless: true } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], browserName: 'chromium', headless: true } },
  ],
  webServer: {
    command: 'python3 -m http.server 4177 --bind 127.0.0.1 --directory dist',
    url: baseURL + '/index.html',
    cwd: '..',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
