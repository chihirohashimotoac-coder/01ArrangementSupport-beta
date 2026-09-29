import { expect, test, type Page } from '@playwright/test';

/*
 * MOBILE_FEASIBILITY（Benchmark Profile・段階制）と crash checkpoint の E2E（Gate を開いた Pages 用成果物）。
 *
 * **実モデルは取得しない。** `?ai-lab-test-runtime=mock` のときだけ Lab が動的 import する Test Runtime（Mock）を使い、
 * WebLLM・WebGPU・モデル配布元は使わない。配信元以外への通信はすべて遮断し、試みがあれば失敗させる。
 */

interface Traffic {
  readonly external: string[];
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

/** WebGPU の adapter を持つ端末のふりをする（Compatibility の表示のためだけ。requestDevice は使わない）。 */
async function fakeWebGpu(page: Page) {
  await page.addInitScript(() => {
    const adapter = {
      features: new Set<string>(),
      limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 },
      info: { vendor: 'apple', architecture: 'common-3' },
      isFallbackAdapter: false,
      requestDevice: () => Promise.reject(new Error('fake adapter: requestDevice はテストで使わない')),
    };
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => adapter } });
  });
}

const CHECKPOINT_KEY = '01as-beta:ai.benchmark.checkpoint.v1';
const WEBLLM_CHUNK = /\/ai-runtime-webllm-[^/]+\.js$/;
const TEST_RUNTIME_CHUNK = /\/labTestRuntime-[^/]+\.js$/;

async function openLab(page: Page, mode: 'mock' | 'mock-hang') {
  await page.goto(`./?ai-lab-test-runtime=${mode}`);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('open-ai-lab').click();
  await expect(page.getByTestId('lab-test-runtime')).toContainText(`TEST RUNTIME（${mode}）`);
  await expect(page.getByTestId('lab-cases')).toHaveText('100', { timeout: 30_000 });
  await page.getByTestId('lab-model-select').selectOption('webllm-qwen3-1.7b');
  await expect(page.getByTestId('lab-model-status')).toContainText('ダウンロード済み');
}

async function readCheckpoint(page: Page): Promise<{ phase: string; caseIndex: number | null; stage: string | null } | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, CHECKPOINT_KEY);
}

test('Profile を選び、LOAD ONLY → 1 CASE → QUICK 10 を段階的に実行する（実モデル・外部通信なし）', async ({ page }) => {
  await fakeWebGpu(page);
  const traffic = await watchTraffic(page);
  await openLab(page, 'mock');

  // STANDARD が既定。MOBILE_FEASIBILITY を選ぶと context 2048・max_tokens 192 になり、Run Benchmark ではなく段階を出す。
  await expect(page.getByTestId('lab-profile')).toHaveText('STANDARD v1');
  await page.getByTestId('lab-profile-select').selectOption('MOBILE_FEASIBILITY');
  await expect(page.getByTestId('lab-profile-context')).toContainText('2048');
  await expect(page.getByTestId('lab-profile-max-tokens')).toHaveText('192');
  await expect(page.getByTestId('lab-profile-warning')).toContainText('品質の benchmark ではありません');
  await expect(page.getByTestId('lab-run')).toHaveCount(0);
  await expect(page.getByTestId('lab-stage-run-ONE_CASE')).toContainText('非推奨');

  await page.getByTestId('lab-stage-run-LOAD_ONLY').click();
  await expect(page.getByTestId('lab-stage-last-LOAD_ONLY')).toContainText('前回: 成功');
  await expect(page.getByTestId('lab-stage-run-ONE_CASE')).not.toContainText('非推奨');

  await page.getByTestId('lab-stage-run-ONE_CASE').click();
  await expect(page.getByTestId('lab-stage-last-ONE_CASE')).toContainText('1 / 1 件', { timeout: 30_000 });
  await expect(page.getByTestId('result-profile')).toContainText('MOBILE_FEASIBILITY v1 / context 2048 / max_tokens 192 / ONE_CASE');
  await expect(page.getByTestId('result-profile-warning')).toBeVisible();

  await page.getByTestId('lab-stage-run-QUICK_10').click();
  await expect(page.getByTestId('lab-stage-last-QUICK_10')).toContainText('10 / 10 件', { timeout: 30_000 });
  await expect(page.getByTestId('metric-validation')).toContainText('10 / 10');
  await expect(page.getByTestId('metric-clean')).toContainText('10 / 10');
  await expect(page.getByTestId('lab-stage-run-FULL_100')).not.toContainText('非推奨');

  // 正常終了したので checkpoint は残らない。
  expect(await readCheckpoint(page)).toBeNull();
  expect(traffic.scripts.some((path) => TEST_RUNTIME_CHUNK.test(path))).toBe(true);
  expect(traffic.scripts.some((path) => WEBLLM_CHUNK.test(path))).toBe(false);
  expect(traffic.external).toEqual([]);
});

test('生成中にページが終わると checkpoint が残り、次に開いたとき「正常終了しませんでした」と示す', async ({ page }) => {
  await fakeWebGpu(page);
  const traffic = await watchTraffic(page);
  await openLab(page, 'mock-hang');
  await page.getByTestId('lab-profile-select').selectOption('MOBILE_FEASIBILITY');
  await page.getByTestId('lab-stage-run-LOAD_ONLY').click();
  await expect(page.getByTestId('lab-stage-last-LOAD_ONLY')).toContainText('前回: 成功');
  await page.getByTestId('lab-stage-run-ONE_CASE').click();
  await expect(page.getByTestId('lab-stage-last-ONE_CASE')).toContainText('1 / 1 件', { timeout: 30_000 });

  // QUICK 10 は 1 CASE の成功後に推奨される。Test Runtime（mock-hang）は 4 回目の生成（QUICK 10 の 3 件目）で返らない。
  await page.getByTestId('lab-stage-run-QUICK_10').click();
  await expect.poll(async () => (await readCheckpoint(page))?.caseIndex ?? null, { timeout: 30_000 }).toBe(2);
  expect(await readCheckpoint(page)).toMatchObject({ phase: 'generating', stage: 'QUICK_10' });

  // タブの終了の代わりに、生成が返らないままページを読み込み直す。
  await page.reload();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('open-ai-lab').click();
  const banner = page.getByTestId('lab-stale-checkpoint');
  await expect(banner).toContainText('前回のBenchmarkは正常終了しませんでした。');
  await expect(page.getByTestId('checkpoint-model')).toHaveText('Qwen3 1.7B');
  await expect(page.getByTestId('checkpoint-phase')).toContainText('generating');
  await expect(page.getByTestId('checkpoint-case')).toHaveText('3 / 10');
  await expect(banner).toContainText('原因（メモリ不足など）は断定できません');

  // その段階は「正常終了しなかった」と記録され、次の段階へ進むことを推奨しない。
  await page.getByTestId('lab-model-select').selectOption('webllm-qwen3-1.7b');
  await expect(page.getByTestId('lab-stage-last-QUICK_10')).toContainText('正常終了しなかった');
  await expect(page.getByTestId('lab-stage-run-FULL_100')).toContainText('非推奨');
  await page.getByTestId('lab-stage-run-FULL_100').click();
  await expect(page.getByTestId('lab-stage-confirm')).toContainText('推奨されていません');
  await page.getByTestId('lab-stage-confirm-cancel').click();

  // 「確認した」で表示を閉じる（checkpoint を消す。段階の記録は残る）。
  await page.getByTestId('checkpoint-dismiss').click();
  await expect(banner).toHaveCount(0);
  expect(await readCheckpoint(page)).toBeNull();
  await expect(page.getByTestId('lab-stage-run-FULL_100')).toContainText('非推奨');
  expect(traffic.external).toEqual([]);
});
