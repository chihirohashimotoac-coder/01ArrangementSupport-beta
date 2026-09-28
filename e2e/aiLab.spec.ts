import { expect, test } from '@playwright/test';

/*
 * AI MODEL LAB は Developer Gate（VITE_AI_FEATURES=on）のビルドでだけ入口が出る開発者向けの画面。
 * CI の E2E は通常のビルド（Gate 閉）に対して行うので、ここでは
 *
 *   - 一般ユーザーの画面に Lab の入口が出ない
 *   - Lab と推論ライブラリ（WebLLM）のコードを Service Worker が precache しない
 *   - 画面を操作してもモデル配布元・推論ライブラリへの通信が起きない
 *
 * を確かめる。Lab の画面そのものは Mock Runtime を使う unit test（src/lab/AiModelLabPage.test.tsx）で検査し、
 * 実モデルの Benchmark は手動で行う（CI で数 GB のモデルを取得しない）。
 */
test('通常のビルドでは Lab の入口を出さず、Lab・推論ライブラリを precache しない', async ({ page, request }) => {
  const modelRequests: string[] = [];
  page.on('request', (item) => {
    const url = item.url();
    if (/huggingface\.co|raw\.githubusercontent\.com|ai-runtime-webllm|AiModelLabPage/.test(url)) modelRequests.push(url);
  });

  await page.goto('/');
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('standard-route-note')).toBeVisible();
  await expect(page.getByTestId('developer-section')).toHaveCount(0);
  await expect(page.getByTestId('open-ai-lab')).toHaveCount(0);

  const serviceWorker = await request.get(new URL('sw.js', page.url()).toString());
  expect(serviceWorker.ok()).toBe(true);
  const body = await serviceWorker.text();
  expect(body).not.toContain('AiModelLabPage');
  expect(body).not.toContain('ai-runtime-webllm');

  expect(modelRequests).toEqual([]);
});
