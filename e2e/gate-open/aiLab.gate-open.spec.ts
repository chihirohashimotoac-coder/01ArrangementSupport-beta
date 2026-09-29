import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/*
 * Gate を開いた Beta の Pages 用成果物（base path ＋ VITE_AI_FEATURES=on）の E2E。
 * `npm run test:e2e:gate-open` が GitHub Pages へ出すのと同じ設定でビルドし、その base path で配信する。
 *
 * **実モデルは取得しない。** ページの外（配信元以外）への通信はすべて遮断し、試みがあれば記録して失敗させる。
 * Benchmark は決定論的な baseline（モデルなしの template Runtime）で流れだけを確かめる。
 */
const DIST = process.env.E2E_GATE_OPEN_DIST ?? 'dist-gate-open';

interface Traffic {
  /** 配信元以外への通信（Hugging Face・GitHub の model library など）。すべて遮断する。 */
  readonly external: string[];
  /** 配信元から読んだ JS。 */
  readonly scripts: string[];
}

async function watchTraffic(page: Page): Promise<Traffic> {
  const traffic: Traffic = { external: [], scripts: [] };
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      traffic.external.push(url.toString());
      return route.abort();
    }
    if (url.pathname.endsWith('.js')) traffic.scripts.push(url.pathname);
    return route.continue();
  });
  return traffic;
}

/**
 * WebLLM が OPFS に保存するファイル（`tvmjs-opfs-store/` 以下）の数。ディレクトリが無ければ 0。
 * 調べるだけで、作成・削除はしない。
 */
async function opfsModelFiles(page: Page): Promise<number> {
  return page.evaluate(async () => {
    type Dir = { values(): AsyncIterable<{ kind: string; name: string; getDirectoryHandle?: unknown }> };
    const root = (await navigator.storage.getDirectory()) as unknown as Dir & { getDirectoryHandle(name: string): Promise<Dir> };
    let store: Dir;
    try {
      store = await root.getDirectoryHandle('tvmjs-opfs-store');
    } catch {
      return 0;
    }
    const count = async (dir: Dir): Promise<number> => {
      let files = 0;
      for await (const entry of dir.values()) {
        files += entry.kind === 'file' ? 1 : await count(entry as unknown as Dir);
      }
      return files;
    };
    return count(store);
  });
}

const loaded = (traffic: Traffic, pattern: RegExp) => traffic.scripts.some((path) => pattern.test(path));
const LAB_CHUNK = /\/AiModelLabPage-[^/]+\.js$/;
const WEBLLM_CHUNK = /\/ai-runtime-webllm-[^/]+\.js$/;

/** WebGPU の adapter を持つ端末のふりをする（CI の headless には adapter が無い）。モデルは取得しない。 */
async function fakeWebGpu(page: Page) {
  await page.addInitScript(() => {
    const adapter = {
      features: new Set(['shader-f16']),
      limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30 },
      info: { vendor: 'e2e-fake', architecture: 'fake' },
      isFallbackAdapter: false,
      requestDevice: () => Promise.reject(new Error('fake adapter: requestDevice はテストで使わない')),
    };
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => adapter },
    });
  });
}

async function webLlmCacheEntries(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let count = 0;
    for (const name of await caches.keys()) {
      if (!name.startsWith('webllm/')) continue;
      count += (await (await caches.open(name)).keys()).length;
    }
    return count;
  });
}

test('ページの起動だけではモデルも Lab も WebLLM も読まず、通常の 01AS が動く', async ({ page }) => {
  const traffic = await watchTraffic(page);
  await page.goto('./');
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('170');
  await expect(page.getByText('T20 → T20 → BULL').first()).toBeVisible();

  expect(loaded(traffic, LAB_CHUNK)).toBe(false);
  expect(loaded(traffic, WEBLLM_CHUNK)).toBe(false);
  expect(traffic.external).toEqual([]);
});

test('設定画面に Lab の入口があり、開くと Lab だけを遅延読み込みする（WebLLM・モデルは読まない）', async ({ page }) => {
  const traffic = await watchTraffic(page);
  await page.goto('./');
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('developer-section')).toBeVisible();
  expect(loaded(traffic, LAB_CHUNK)).toBe(false);

  await page.getByTestId('open-ai-lab').click();
  await expect(page.getByTestId('ai-model-lab')).toBeVisible();
  await expect(page.getByTestId('lab-experimental-notice')).toContainText('開発者向けの実験機能');
  await expect(page.getByTestId('lab-experimental-notice')).toContainText('大容量のデータ');
  await expect(page.getByTestId('lab-experimental-notice')).toContainText('まだ決まっていません');
  await expect(page.getByTestId('lab-cases')).toHaveText('100', { timeout: 30_000 });
  expect(loaded(traffic, LAB_CHUNK)).toBe(true);
  // モデルの保存方式は OPFS が既定。origin の usage / quota / persisted を表示する（取得はしない）。
  await expect(page.getByTestId('storage-backend')).toContainText('OPFS');
  await expect(page.getByTestId('lab-storage-backend-select')).toHaveValue('opfs');
  await expect(page.getByTestId('storage-persistent')).toHaveText(/^(yes|no|unknown)$/);
  await expect(page.getByTestId('storage-quota')).not.toHaveText('');
  // 既定の候補は baseline（モデルなし）。WebLLM はまだ読まない。
  expect(loaded(traffic, WEBLLM_CHUNK)).toBe(false);

  // モデルなしの baseline で Benchmark の流れを確かめる（クイック 10 件）。
  await page.getByTestId('lab-scope').selectOption('quick');
  await page.getByTestId('lab-run').click();
  await expect(page.getByTestId('metric-validation')).toContainText('10 / 10', { timeout: 30_000 });
  await expect(page.getByTestId('metric-contradiction')).toContainText('0 / 10');

  expect(loaded(traffic, WEBLLM_CHUNK)).toBe(false);
  expect(traffic.external).toEqual([]);
  expect(await webLlmCacheEntries(page)).toBe(0);
  expect(await opfsModelFiles(page)).toBe(0);
});

test('モデルを選んでも、確認して「ダウンロードを開始」を押すまでモデルを取得せず、保存領域（Cache API・OPFS）も作らない', async ({ page }) => {
  await fakeWebGpu(page);
  const traffic = await watchTraffic(page);
  await page.goto('./');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('open-ai-lab').click();
  await expect(page.getByTestId('device-adapter')).toContainText('available');

  await expect(page.getByTestId('storage-backend')).toContainText('OPFS');

  await page.getByTestId('lab-model-select').selectOption('webllm-qwen3-1.7b');
  await expect(page.getByTestId('lab-model-status')).toHaveText('未ダウンロード', { timeout: 30_000 });
  // 方式ごとの保存状況を、保存領域を作らずに確かめる。どの方式にも WebLLM の保存領域が無いので、
  // WebLLM のライブラリも読まずに「なし」と分かる（WebLLM を読むのは保存領域があるときと Download / Load のとき）。
  await expect(page.getByTestId('lab-model-storage-presence')).toHaveText('OPFS: なし / IndexedDB: なし / Cache API: なし', {
    timeout: 30_000,
  });
  expect(loaded(traffic, WEBLLM_CHUNK)).toBe(false);
  await expect(page.getByTestId('lab-compatibility')).toContainText('CAN_TRY');

  await page.getByTestId('lab-download').click();
  const confirm = page.getByTestId('lab-download-confirm');
  await expect(confirm).toContainText('Qwen3-1.7B-q4f16_1-MLC');
  await expect(confirm).toContainText('Download size');
  await expect(confirm).toContainText('Estimated memory');
  await expect(confirm).toContainText('1.99 GiB');
  await expect(confirm).toContainText('WebLLM');
  await expect(confirm).toContainText('Apache-2.0');
  await expect(page.getByTestId('lab-download-confirm-storage')).toHaveText('OPFS');
  // 「ダウンロードを開始」は押さない（CI で実モデルを取得しない）。
  await confirm.getByText('キャンセル').click();
  await expect(confirm).toHaveCount(0);

  // Benchmark はモデルが無いと実行できない（取得を始めない）。
  await expect(page.getByTestId('lab-run')).toBeDisabled();
  expect(traffic.external).toEqual([]);
  expect(await webLlmCacheEntries(page)).toBe(0);
  // OPFS にも何も書いていない（確認処理で保存領域のディレクトリも作らない）。
  expect(await opfsModelFiles(page)).toBe(0);
  expect(await page.evaluate(async () => {
    const root = (await navigator.storage.getDirectory()) as unknown as { getDirectoryHandle(name: string): Promise<unknown> };
    return root.getDirectoryHandle('tvmjs-opfs-store').then(() => true, () => false);
  })).toBe(false);
});

test('Service Worker は Lab・WebLLM・モデルを precache しない（chunk は生成されている）', async ({ page, request }) => {
  const assets = readdirSync(join(DIST, 'assets'));
  const lab = assets.find((name) => /^AiModelLabPage-.*\.js$/.test(name));
  const webllm = assets.find((name) => /^ai-runtime-webllm-.*\.js$/.test(name));
  expect(lab).toBeDefined();
  expect(webllm).toBeDefined();

  await page.goto('./');
  const serviceWorker = await request.get(new URL('sw.js', page.url()).toString());
  expect(serviceWorker.ok()).toBe(true);
  const body = await serviceWorker.text();
  expect(body).toBe(readFileSync(join(DIST, 'sw.js'), 'utf8'));
  expect(body).not.toContain(lab!);
  expect(body).not.toContain(webllm!);
  expect(body).not.toMatch(/\.(wasm|bin|onnx|gguf|safetensors)"/);
});
