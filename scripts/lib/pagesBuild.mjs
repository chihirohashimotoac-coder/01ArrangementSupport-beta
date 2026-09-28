/**
 * Beta の GitHub Pages へ出す成果物のビルド設定（唯一の定義）。
 *
 * 01ArrangementSupport-beta は AI 実験用の Beta リポジトリなので、**Pages へ出す成果物に限って**
 * Developer Gate を開く（`VITE_AI_FEATURES=on`）。設定画面から開発者向けの AI MODEL LAB を使える。
 *
 * - 通常の CI（lint / test / build / E2E）は Gate を閉じたまま（`VITE_AI_FEATURES` 未設定）
 * - Production（01ArrangementSupport）には AI は無い（このリポジトリの外）
 * - base path は deploy 時に repository 名から算出する（`.github/workflows/ci-deploy.yml`）。
 *   ここの `DEFAULT_PAGES_BASE` は、ローカル・CI の検証で base を与えなかったときの既定値だけ
 */
import { execFileSync, execSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Pages 用ビルドでだけ開く Developer Gate の値。 */
export const PAGES_AI_FEATURES = 'on';

/** 検証用の既定 base（deploy では使わない。deploy は repository 名から算出する）。 */
export const DEFAULT_PAGES_BASE = '/01ArrangementSupport-beta/';

/** Pages 用ビルドの環境変数。base path と Developer Gate を必ず同時に反映する。 */
export function pagesBuildEnv(base) {
  if (typeof base !== 'string' || !base.startsWith('/') || !base.endsWith('/')) {
    throw new Error(`VITE_BASE_PATH は "/" で始まり "/" で終わる必要があります: ${String(base)}`);
  }
  return { VITE_BASE_PATH: base, VITE_AI_FEATURES: PAGES_AI_FEATURES };
}

/** 型検査なしの vite build ＋ SPA フォールバック（検証用の別ディレクトリへ出すとき）。 */
export function buildInto(root, outDir, env) {
  // Node's execFileSync does not resolve npx.cmd on Windows; invoke the locked local Vite directly.
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/copy-spa-fallback.mjs', outDir], { cwd: root, stdio: 'inherit' });
}

/** deploy と同じ `npm run build`（型検査を含む）を Pages の設定で実行する。 */
export function buildPages(root, base) {
  execSync('npm run build', { cwd: root, env: { ...process.env, ...pagesBuildEnv(base) }, stdio: 'inherit' });
}
