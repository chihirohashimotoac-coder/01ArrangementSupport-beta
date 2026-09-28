import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/*
 * BROWSER STORAGE DIAGNOSTICS の E2E（Gate を開いた Pages 用成果物・実ブラウザの OPFS / IndexedDB / Cache API）。
 *
 * **CI のディスクを使わないよう、test mode（`?storage-diagnostic-test-mode=1`）で 4 MiB だけを書く。**
 * 1 GiB の書き込みは CI では行わない（実機で手動。docs/BROWSER_STORAGE_DIAGNOSTICS.md）。
 *
 * あらかじめ WebLLM のモデル（`webllm/model` cache・`tvmjs-opfs-store/`・`webllm/model` データベース）と
 * 01AS の利用者データ（localStorage）を置き、診断のあとも**そのまま残っている**こと、
 * 診断用のデータ（`01as-beta-storage-diagnostic`）だけが消えていることを確かめる。
 * WebLLM・モデル・外部の通信は使わない（配信元以外への通信は遮断して検出する）。
 */
const DIAG = '01as-beta-storage-diagnostic';
const USER_KEY = '01as-beta:oas.e2e-user-data';
const USER_VALUE = '{"version":1,"e2e":true}';
/** 診断の結果（Lab 専用のキー）。利用者データではない。 */
const RESULTS_KEY = '01as-beta:ai.storage-diagnostic.results.v1';

async function blockExternal(page: Page): Promise<{ external: string[]; scripts: string[] }> {
  const traffic = { external: [] as string[], scripts: [] as string[] };
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

/** WebLLM のモデルと利用者データがあるふりをする（中身は小さな偽物）。 */
async function seedForeignStorage(page: Page): Promise<void> {
  await page.evaluate(
    async ({ userKey, userValue }) => {
      localStorage.setItem(userKey, userValue);
      await (await caches.open('webllm/model')).put(`${location.origin}/e2e-fake-model/params_shard_0.bin`, new Response(new Uint8Array(1024)));
      type Dir = FileSystemDirectoryHandle;
      const root = (await navigator.storage.getDirectory()) as Dir;
      const store = await root.getDirectoryHandle('tvmjs-opfs-store', { create: true });
      const model = await (await store.getDirectoryHandle('webllm', { create: true })).getDirectoryHandle('model', { create: true });
      const file = await model.getFileHandle('e2e-fake.bin', { create: true });
      const writable = await file.createWritable();
      await writable.write(new Uint8Array(2048));
      await writable.close();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('webllm/model', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('urls', { keyPath: 'url' });
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('urls', 'readwrite');
          tx.objectStore('urls').put({ url: 'e2e-fake', data: new ArrayBuffer(512) });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    },
    { userKey: USER_KEY, userValue: USER_VALUE },
  );
}

interface StorageSnapshot {
  readonly user: string | null;
  readonly webllmCache: string[];
  readonly webllmOpfsSize: number | null;
  readonly webllmIdbRecords: number | null;
  readonly diagnosticCache: boolean;
  readonly diagnosticOpfs: boolean;
  readonly diagnosticIdb: boolean;
}

async function snapshot(page: Page): Promise<StorageSnapshot> {
  return page.evaluate(
    async ({ userKey, diag }) => {
      const root = await navigator.storage.getDirectory();
      const webllmOpfsSize = await root
        .getDirectoryHandle('tvmjs-opfs-store')
        .then((store) => store.getDirectoryHandle('webllm'))
        .then((dir) => dir.getDirectoryHandle('model'))
        .then((dir) => dir.getFileHandle('e2e-fake.bin'))
        .then((handle) => handle.getFile())
        .then((file) => file.size)
        .catch(() => null);
      const webllmIdbRecords = (await indexedDB.databases()).some((item) => item.name === 'webllm/model')
        ? await new Promise<number | null>((resolve) => {
            const request = indexedDB.open('webllm/model');
            request.onsuccess = () => {
              const db = request.result;
              const count = db.transaction('urls', 'readonly').objectStore('urls').count();
              count.onsuccess = () => {
                db.close();
                resolve(count.result);
              };
              count.onerror = () => resolve(null);
            };
            request.onerror = () => resolve(null);
          })
        : null;
      return {
        user: localStorage.getItem(userKey),
        webllmCache: (await (await caches.open('webllm/model')).keys()).map((request) => new URL(request.url).pathname),
        webllmOpfsSize,
        webllmIdbRecords,
        diagnosticCache: await caches.has(diag),
        diagnosticOpfs: await root.getDirectoryHandle(diag).then(
          () => true,
          () => false,
        ),
        diagnosticIdb: (await indexedDB.databases()).some((item) => item.name === diag),
      };
    },
    { userKey: USER_KEY, diag: DIAG },
  );
}

const SEEDED = {
  user: USER_VALUE,
  webllmCache: ['/e2e-fake-model/params_shard_0.bin'],
  webllmOpfsSize: 2048,
  webllmIdbRecords: 1,
  diagnosticCache: false,
  diagnosticOpfs: false,
  diagnosticIdb: false,
};

async function openLab(page: Page, query = ''): Promise<void> {
  await page.goto(`./${query}`);
  await seedForeignStorage(page);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('open-ai-lab').click();
  await expect(page.getByTestId('lab-storage-diagnostics')).toBeVisible();
}

test('開いただけでは書かない。既定は 1 GiB、2 GiB は Advanced、Persistent を表示する', async ({ page }) => {
  const traffic = await blockExternal(page);
  await openLab(page);
  const section = page.getByTestId('lab-storage-diagnostics');
  await expect(section.getByRole('heading', { name: 'BROWSER STORAGE DIAGNOSTICS' })).toBeVisible();
  await expect(page.getByTestId('diag-persistent')).toHaveText(/^(Yes|No|unknown)$/);
  await expect(page.getByTestId('diag-origin-quota')).not.toHaveText('unknown');
  await expect(page.getByTestId('diag-size')).toHaveValue('1GiB');
  await expect(page.getByTestId('diag-start-opfs')).toHaveText('1 GiBテスト');
  await expect(page.getByTestId('diag-status-opfs')).toHaveText('Status: Not Tested');
  await expect(page.getByTestId('diag-leftovers')).toHaveText('OPFS: なし / IndexedDB: なし / Cache API: なし');
  await expect(page.locator('[data-testid="diag-size"] option')).toHaveText(['256 MiB', '512 MiB', '1 GiB']);
  await page.getByTestId('diag-advanced').check();
  await expect(page.locator('[data-testid="diag-size"] option')).toHaveText(['256 MiB', '512 MiB', '1 GiB', '2 GiB（Advanced）']);

  // ボタンを押していないので、診断用の保存領域は作られていない。
  expect(await snapshot(page)).toEqual(SEEDED);
  expect(traffic.external).toEqual([]);
});

test('test mode（4 MiB）で 3 方式を実測し、WebLLM・利用者データに触れずに診断用のデータだけを削除し、JSON で保存できる', async ({ page }) => {
  const traffic = await blockExternal(page);
  await openLab(page, '?storage-diagnostic-test-mode=1');
  await expect(page.getByTestId('storage-diagnostics-test-mode')).toBeVisible();
  await expect(page.getByTestId('diag-size')).toHaveValue('4MiB');

  // 3 方式を順に測る。削除が usage に反映されない方式があると（Chromium の Cache API・一時プロファイルの
  // IndexedDB）、そこで止まり、再読み込みを求める。そのときは再読み込みして、まだ測っていない方式を 1 つずつ測る。
  await page.getByTestId('diag-start-all').click();
  const done = page.getByTestId('diag-comparison-case');
  const blocked = page.getByTestId('diag-unreclaimed');
  await expect(done.or(blocked).first()).toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 3 && !(await done.isVisible()); attempt += 1) {
    await page.reload();
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('open-ai-lab').click();
    const remaining: string[] = [];
    for (const backend of ['opfs', 'indexeddb', 'cache']) {
      if ((await page.getByTestId(`diag-status-${backend}`).innerText()).includes('Not Tested')) remaining.push(backend);
    }
    expect(remaining.length).toBeGreaterThan(0);
    await page.getByTestId(`diag-start-${remaining[0]}`).click();
    await expect(page.getByTestId(`diag-status-${remaining[0]}`)).toContainText('書き込み成功', { timeout: 30_000 });
  }

  await expect(done).toContainText('Case A');
  await expect(page.getByTestId('diag-status-opfs')).toContainText('OPFS 4 MiB書き込み成功');
  await expect(page.getByTestId('diag-status-indexeddb')).toContainText('IndexedDB 4 MiB書き込み成功');
  await expect(page.getByTestId('diag-status-cache')).toContainText('Cache API 4 MiB書き込み成功');
  await expect(page.locator('[data-testid^="diag-cleanup-failed-"]')).toHaveCount(0);
  await expect(page.getByTestId('diag-leftovers')).toHaveText('OPFS: なし / IndexedDB: なし / Cache API: なし');

  // WebLLM のモデル（偽物）と利用者データは残り、診断用のデータは残っていない。
  expect(await snapshot(page)).toEqual(SEEDED);
  // 結果（数値だけ）は Lab 専用のキーに残る（再読み込みをまたいで比べるため）。
  expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), RESULTS_KEY)) ?? '{}').results).toHaveLength(3);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('diag-export').click()]);
  const report = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    schema: string;
    schemaVersion: number;
    testMode: boolean;
    results: { backend: string; status: string; targetBytes: number; writtenBytes: number; errorName: string | null; cleanup: { status: string } }[];
    comparison: { case: string } | null;
  };
  expect(report.schema).toBe('01as-browser-storage-diagnostic');
  expect(report.schemaVersion).toBe(1);
  expect(report.testMode).toBe(true);
  expect(
    report.results
      .map((item) => [item.backend, item.status, item.targetBytes, item.writtenBytes, item.errorName, item.cleanup.status])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    ['cache', 'success', 4 * 1024 ** 2, 4 * 1024 ** 2, null, 'ok'],
    ['indexeddb', 'success', 4 * 1024 ** 2, 4 * 1024 ** 2, null, 'ok'],
    ['opfs', 'success', 4 * 1024 ** 2, 4 * 1024 ** 2, null, 'ok'],
  ]);
  expect(report.comparison?.case).toBe('A');

  // WebLLM を読まず、外部へ通信していない。
  expect(traffic.scripts.some((path) => /\/ai-runtime-webllm-[^/]+\.js$/.test(path))).toBe(false);
  expect(traffic.external).toEqual([]);
});

test('前回のテストの残りを検出し、「診断用のデータを削除」で診断用のデータだけを消す', async ({ page }) => {
  await blockExternal(page);
  await page.goto('./?storage-diagnostic-test-mode=1');
  await seedForeignStorage(page);
  // 途中でページを閉じた想定の残り（3 方式とも）。
  await page.evaluate(async (diag) => {
    await (await caches.open(diag)).put(`${location.origin}/${diag}/chunk-000000.bin`, new Response(new Uint8Array(1024)));
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(diag, { create: true });
    await dir.getFileHandle('opfs-test.bin', { create: true });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(diag, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('chunks');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }, DIAG);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('open-ai-lab').click();
  await expect(page.getByTestId('diag-leftovers')).toHaveText('OPFS: あり / IndexedDB: あり / Cache API: あり');

  await page.getByTestId('diag-cleanup').click();
  await expect(page.getByTestId('diag-cleanup-message')).toContainText('診断用のデータを削除しました');
  await expect(page.getByTestId('diag-leftovers')).toHaveText('OPFS: なし / IndexedDB: なし / Cache API: なし');
  expect(await snapshot(page)).toEqual(SEEDED);
});
