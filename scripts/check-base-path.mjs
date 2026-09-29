/**
 * GitHub Pages のサブパス（/01ArrangementSupport-beta/）向けビルドの検証。
 *
 * E2E は base = / のビルドに対して走るため、サブパス配信でだけ壊れる不具合
 * （絶対パスで書かれた asset、base を含まない manifest など）を拾えない。
 * ここではビルド成果物を静的に検査して、次を確認する。
 *
 *   - index.html / 404.html が参照する asset がすべて base 配下であること
 *   - webmanifest の start_url / scope / id が base 配下であること
 *   - Service Worker と precache manifest が base 配下を指していること
 *   - Pages 用の設定（Developer Gate を開く）で、AI MODEL LAB と WebLLM の chunk が別に出力され、
 *     precache に入らず、モデルのファイルが成果物に含まれないこと
 *
 * ビルド設定は deploy と同じ `scripts/lib/pagesBuild.mjs` の定義（base path ＋ VITE_AI_FEATURES=on）を使う。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PAGES_BASE, buildInto, pagesBuildEnv } from './lib/pagesBuild.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const base = process.env.VITE_BASE_PATH ?? DEFAULT_PAGES_BASE;
/*
 * Production は同じ origin の /01ArrangementSupport/ で配信される。
 * Service Worker のスコープは URL の前方一致で決まるため、Beta の base が
 * Production のスコープに含まれてしまうと、Production の Service Worker が
 * Beta のページを制御できてしまう。その逆も同じ。
 */
const PRODUCTION_BASE = '/01ArrangementSupport/';
const BETA_CACHE_ID = '01as-beta';
const outDir = resolve(root, 'dist-base-check');

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

check(
  !base.startsWith(PRODUCTION_BASE) && !PRODUCTION_BASE.startsWith(base),
  `base (${base}) が Production (${PRODUCTION_BASE}) の Service Worker スコープと重なります。`,
);

rmSync(outDir, { recursive: true, force: true });
// deploy と同じ設定（base path ＋ Developer Gate）で、deploy と同じ成果物（404.html を含む）を作る。
buildInto(root, outDir, pagesBuildEnv(base));

try {
  // index.html と、GitHub Pages の SPA フォールバックである 404.html の両方を見る。
  // 404.html は深いパスで配信されるため、base を含まない参照があると壊れる。
  for (const page of ['index.html', '404.html']) {
    const file = join(outDir, page);
    check(existsSync(file), `${page} が出力されていません。`);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');

    // 参照するローカル資源はすべて base 配下でなければならない。
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    check(refs.length > 0, `${page} が asset を参照していません。`);
    for (const ref of refs) {
      if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
      // 文書相対（./…）は index.html なら解決できるが、深いパスで返る 404.html では壊れる。
      check(
        ref.startsWith(base),
        `${page} の参照 "${ref}" が base (${base}) 配下ではありません。`,
      );
    }
    check(
      html.includes(`${base}manifest.webmanifest`),
      `${page} の manifest link が base を含みません。`,
    );
    check(html.includes('<div id="root">'), `${page} にアプリのマウント先がありません。`);

    // アプリの起動に必要な JS が実際に出力されているか。
    const scripts = refs.filter((ref) => ref.startsWith(base) && ref.endsWith('.js'));
    check(scripts.length > 0, `${page} から読み込む JS がありません。`);
    for (const script of scripts) {
      check(
        existsSync(join(outDir, script.slice(base.length))),
        `${script} に対応するファイルが出力されていません。`,
      );
    }
  }

  const manifestName = readdirSync(outDir).find((name) => name.endsWith('.webmanifest'));
  check(manifestName !== undefined, 'webmanifest が出力されていません。');
  if (manifestName) {
    const manifest = JSON.parse(readFileSync(join(outDir, manifestName), 'utf8'));
    for (const key of ['start_url', 'scope', 'id']) {
      check(
        typeof manifest[key] === 'string' && manifest[key].startsWith(base),
        `manifest.${key} が base (${base}) 配下ではありません: ${manifest[key]}`,
      );
    }
    // Production と取り違えないよう、Beta と分かる名前でインストールされる。
    check(
      typeof manifest.name === 'string' && manifest.name.includes('Beta'),
      `manifest.name が Beta 版と識別できません: ${manifest.name}`,
    );
    check(
      typeof manifest.short_name === 'string' && manifest.short_name.includes('Beta'),
      `manifest.short_name が Beta 版と識別できません: ${manifest.short_name}`,
    );
    for (const icon of manifest.icons ?? []) {
      const path = icon.src.startsWith(base) ? icon.src.slice(base.length) : icon.src;
      check(existsSync(join(outDir, path)), `manifest のアイコン ${icon.src} が見つかりません。`);
    }
  }

  const sw = join(outDir, 'sw.js');
  check(existsSync(sw), 'sw.js が出力されていません。');
  if (existsSync(sw)) {
    const swSource = readFileSync(sw, 'utf8');
    // precache のエントリは SW スコープからの相対 URL でなければならない。
    // ルート絶対パスが混ざると、サブパス配信でキャッシュが 404 になる。
    const entries = [...swSource.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);
    check(entries.length > 0, 'sw.js に precache のエントリがありません。');
    check(entries.includes('index.html'), 'sw.js が index.html を precache していません。');
    for (const entry of entries) {
      check(
        !entry.startsWith('/'),
        `sw.js の precache エントリ "${entry}" がルート絶対パスです（サブパスで 404 になります）。`,
      );
    }

    /*
     * 更新は「新しいバージョンがあります。」のお知らせでユーザーへ尋ねる。
     * そのためには新しい Service Worker が待機したままでなければならない。
     * workbox の skipWaiting: true を戻すと sw.js が無条件で self.skipWaiting()
     * を呼び、お知らせを出す間もなく差し替わる（更新ボタンが無意味になる）。
     * ここでは「SKIP_WAITING メッセージを受けたときだけ呼ぶ」形を固定する。
     */
    check(
      swSource.includes('SKIP_WAITING'),
      'sw.js が SKIP_WAITING メッセージを受け付けません（更新ボタンが効かなくなります）。',
    );
    const skipWaitingCalls = (swSource.match(/skipWaiting\(\)/g) ?? []).length;
    check(
      skipWaitingCalls === 1,
      `sw.js の skipWaiting() が ${skipWaitingCalls} 回あります（メッセージ受信時の 1 回だけにしてください）。`,
    );
    // Cache Storage の名前を Production と分ける（workbox の cacheId）。
    check(
      swSource.includes(`setCacheNameDetails({prefix:"${BETA_CACHE_ID}"})`),
      `sw.js が Beta 専用の cacheId (${BETA_CACHE_ID}) を使っていません。`,
    );
    check(
      swSource.includes('clientsClaim()'),
      'sw.js が clientsClaim() を呼びません（初回訪問がオフラインで動かなくなります）。',
    );
  }

  /*
   * Pages 用の成果物は Developer Gate を開く。AI MODEL LAB と推論ライブラリ（WebLLM）は
   * 遅延読み込みの別 chunk として出力され、Service Worker の precache に入らないこと。
   * モデルのファイル（重み・model library）は成果物に含めない（利用者の明示操作で配布元から取得する）。
   */
  const assetNames = readdirSync(join(outDir, 'assets'));
  const labChunk = assetNames.find((name) => /^AiModelLabPage-.*\.js$/.test(name));
  const runtimeChunk = assetNames.find((name) => /^ai-runtime-webllm-.*\.js$/.test(name));
  check(labChunk !== undefined, 'AI MODEL LAB の chunk（AiModelLabPage-*.js）が出力されていません。');
  check(runtimeChunk !== undefined, 'WebLLM の chunk（ai-runtime-webllm-*.js）が出力されていません。');
  // E2E 用の Test Runtime（Mock）は Lab から動的 import する別 chunk で、precache しない。
  const testRuntimeChunk = assetNames.find((name) => /^labTestRuntime-.*\.js$/.test(name));
  check(testRuntimeChunk !== undefined, 'E2E 用の Test Runtime の chunk（labTestRuntime-*.js）が出力されていません。');
  if (existsSync(sw)) {
    const swSource = readFileSync(sw, 'utf8');
    for (const name of [labChunk, runtimeChunk, testRuntimeChunk].filter(Boolean)) {
      check(!swSource.includes(name), `sw.js が ${name} を precache しています。`);
    }
    check(!/\.(wasm|bin|onnx|gguf|safetensors)"/.test(swSource), 'sw.js がモデルのファイルを precache しています。');
  }
  const modelFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (/\.(wasm|bin|onnx|gguf|safetensors|mlc)$/i.test(name.name)) modelFiles.push(path);
    }
  };
  walk(outDir);
  check(modelFiles.length === 0, `成果物にモデルのファイルがあります: ${modelFiles.join(', ')}`);
  const entry = readFileSync(join(outDir, 'index.html'), 'utf8').match(/src="[^"]*\/assets\/(index-[^"]+\.js)"/)?.[1];
  check(entry !== undefined, 'index.html から入口の JS が見つかりません。');
  if (entry && runtimeChunk) {
    // 入口の bundle は WebLLM を静的に読み込まない（Lab を開き、WebLLM の候補を選んだときだけ読む）。
    const entrySource = readFileSync(join(outDir, 'assets', entry), 'utf8');
    check(!new RegExp(`import[^;]*${runtimeChunk.replace(/\./g, '\\.')}`).test(entrySource.split('import(')[0]),
      '入口の bundle が WebLLM を静的に import しています。');
  }

  // Service Worker の登録先も base 配下でなければならない。
  const bundles = readdirSync(join(outDir, 'assets'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(outDir, 'assets', name), 'utf8'));
  check(
    bundles.some((source) => source.includes(`${base}sw.js`)),
    `Service Worker の登録先が base (${base}) 配下ではありません。`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`GitHub Pages base path (${base}) のビルド検証に失敗しました:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`GitHub Pages base path (${base}) のビルド検証に成功しました。`);
