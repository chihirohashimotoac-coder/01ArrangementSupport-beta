/**
 * GitHub Pages（Beta）へ出す成果物を作る。
 *
 *   VITE_BASE_PATH=/<repository>/ npm run build:pages
 *
 * base path は呼び出し側（deploy workflow）が repository 名から算出して渡す。
 * Developer Gate は `scripts/lib/pagesBuild.mjs` の定義どおり開く。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPages } from './lib/pagesBuild.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.VITE_BASE_PATH;
if (!base) {
  console.error('VITE_BASE_PATH が未設定です（deploy では repository 名から算出して渡します）。');
  process.exit(1);
}
try {
  buildPages(root, base);
} catch {
  // 失敗の詳細は npm run build の出力に出ている。
  process.exit(1);
}
