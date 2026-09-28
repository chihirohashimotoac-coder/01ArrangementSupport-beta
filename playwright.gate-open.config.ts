import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Gate を開いた Beta の Pages 用成果物（`npm run test:e2e:gate-open` が dist-gate-open/ へビルド）の E2E。
 *
 * 通常の E2E（playwright.config.ts）は Gate を閉じたビルドに対して行う。こちらは GitHub Pages へ
 * 実際に出すのと同じ設定（base path ＋ VITE_AI_FEATURES=on）の成果物を、その base path で配信して確かめる。
 */
const preinstalledChromium = '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalledChromium) ? preinstalledChromium : undefined;

const PORT = 4174;
const HOST = '127.0.0.1';
// base path と出力先は scripts/e2e-gate-open.mjs が渡す（ここで repository 名を書かない）。
const base = process.env.VITE_BASE_PATH ?? '/';
const outDir = process.env.E2E_GATE_OPEN_DIST ?? 'dist-gate-open';

export default defineConfig({
  testDir: './e2e/gate-open',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-gate-open' }]] : [['list']],
  use: {
    baseURL: `http://${HOST}:${PORT}${base}`,
    trace: 'on-first-retry',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --outDir ${outDir} --host ${HOST} --port ${PORT} --strictPort`,
    url: `http://${HOST}:${PORT}${base}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
