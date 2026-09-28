/**
 * Gate を開いた Beta の Pages 用成果物に対する E2E。
 *
 *   npm run test:e2e:gate-open
 *
 * GitHub Pages へ実際に出すのと同じ設定（base path ＋ VITE_AI_FEATURES=on）で
 * dist-gate-open/ へビルドし、その成果物を配信して `e2e/gate-open/` を実行する。
 * 実モデルは取得しない（配布元への通信はテスト側で遮断・検出する）。
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PAGES_BASE, buildInto, pagesBuildEnv } from './lib/pagesBuild.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.VITE_BASE_PATH ?? DEFAULT_PAGES_BASE;
const outDir = resolve(root, 'dist-gate-open');
const env = pagesBuildEnv(base);

rmSync(outDir, { recursive: true, force: true });
buildInto(root, outDir, env);
try {
  execFileSync(process.execPath, [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.gate-open.config.ts', ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, ...env, E2E_GATE_OPEN_DIST: outDir },
    stdio: 'inherit',
  });
} catch {
  process.exitCode = 1;
}
