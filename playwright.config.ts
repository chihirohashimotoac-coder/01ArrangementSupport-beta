import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * 実行環境に Playwright 管理外の Chromium が用意されている場合はそれを使う。
 * CI では `npx playwright install --with-deps chromium` で入るものが使われる。
 */
const preinstalledChromium = '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalledChromium) ? preinstalledChromium : undefined;

const PORT = 4173;
const HOST = '127.0.0.1';

export default defineConfig({
  testDir: './e2e',
  // Gate を開いた Pages 用成果物の E2E は別の設定（playwright.gate-open.config.ts）で行う。
  testIgnore: ['**/gate-open/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: 'on-first-retry',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `npm run preview -- --host ${HOST} --port ${PORT} --strictPort`,
    url: `http://${HOST}:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
