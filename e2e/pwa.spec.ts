import { expect, test } from '@playwright/test';

test('manifest と Service Worker が配信される', async ({ page, request }) => {
  await page.goto('/');

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBeTruthy();

  const manifest = await request.get(new URL(manifestHref!, page.url()).toString());
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as {
    name: string;
    short_name: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  // Beta 版として Production と見分けられる名前でインストールされる。
  expect(body.name).toBe('01 Arrangement Support Beta');
  expect(body.short_name).toBe('01AS Beta');
  expect(body.display).toBe('standalone');
  expect(body.icons.some((icon) => icon.sizes === '512x512')).toBe(true);
  expect(body.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);

  // manifest・favicon・apple-touch-icon が指すアイコンが実際に配信される。
  const linkedIcons = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  expect(linkedIcons.length).toBeGreaterThan(0);
  const manifestUrl = new URL(manifestHref!, page.url());
  const iconUrls = [
    ...linkedIcons,
    ...body.icons.map((icon) => new URL(icon.src, manifestUrl).toString()),
  ];
  for (const url of iconUrls) {
    const icon = await request.get(url);
    expect(icon.ok(), url).toBe(true);
    expect(icon.headers()['content-type'], url).toContain('image/png');
  }

  const serviceWorker = await request.get(new URL('sw.js', page.url()).toString());
  expect(serviceWorker.ok()).toBe(true);
});

/*
 * 更新は「新しいバージョンがあります。」のお知らせでユーザーへ尋ねる（registerType: 'prompt'）。
 * 新しい Service Worker が待機したままになることが前提なので、配信される sw.js の
 * 形を確認する。待機の検出からお知らせの表示・更新ボタンの動きまでは
 * src/UpdateBanner.test.tsx が受け持つ。
 */
test('配信される Service Worker は、待機して更新の合図を待つ', async ({ page, request }) => {
  await page.goto('/');
  const response = await request.get(new URL('sw.js', page.url()).toString());
  expect(response.ok()).toBe(true);
  const source = await response.text();

  // 更新ボタンから送る SKIP_WAITING を受け付ける。
  expect(source).toContain('SKIP_WAITING');
  // 無条件の self.skipWaiting() は無い（あると尋ねる間もなく差し替わる）。
  expect(source.match(/skipWaiting\(\)/g) ?? []).toHaveLength(1);
  // 初回訪問がオフラインで動くよう、制御の引き取りは従来どおり行う。
  expect(source).toContain('clientsClaim()');
});

test('更新が無いあいだは、お知らせを出さない', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-title')).toBeVisible();
  await expect(page.getByTestId('update-banner')).toHaveCount(0);

  // 画面を移っても出ない。
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('103');
  await expect(page.getByTestId('standard-route')).toBeVisible();
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
});

test('SPA フォールバック（404.html）が用意されている', async ({ page, request }) => {
  await page.goto('/');
  const fallback = await request.get(new URL('404.html', page.url()).toString());
  expect(fallback.ok()).toBe(true);
  expect(await fallback.text()).toContain('<div id="root">');
});

test('Service Worker が登録され、オフラインでも表示できる', async ({ page, context }) => {
  await page.goto('/');
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('103');
  await expect(page.getByTestId('standard-route')).toContainText('T19');

  // Service Worker のプリキャッシュが終わるまで待つ。
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller !== null,
    undefined,
    { timeout: 20_000 },
  );

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('app-title')).toBeVisible();
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('103');
  await expect(page.getByTestId('standard-route')).toContainText('T19');
  await context.setOffline(false);
});

test('主要な操作対象にアクセシブルな名前がある', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('103');
  // v1.2: 盤面は「実際の着弾を入力」で開く。
  await page.getByTestId('recovery-toggle').click();

  await expect(page.getByRole('group', { name: /ダーツボード/ })).toBeVisible();
  await expect(page.getByTestId('segment-t20')).toHaveAttribute('aria-label', /トリプル20/);
  await expect(page.getByTestId('segment-inner-bull')).toHaveAttribute('aria-label', /ブル/);
});

test('キーボードだけで盤面を操作できる', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('103');
  await page.getByTestId('recovery-toggle').click();

  await page.getByTestId('segment-s19-outer').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('status-left')).toHaveText('84');
});

/*
 * Beta と Production は同じ origin を共有するので localStorage も共有される。
 * Production の保存データがある端末で Beta を使っても、Beta はそれを
 * 読まない・書き換えない・消さない（src/storage/betaIsolation.test.ts の実ブラウザ版）。
 */
test('Beta は Production の保存データを読まず、書き換えも削除もしない', async ({ page }) => {
  const production = {
    'oas.preferences.v1': JSON.stringify({
      version: 1,
      preferredDoubles: ['D16'],
      setupMainTarget: 'T19',
      theme: 'light',
    }),
    'oas.training.v1': JSON.stringify({ version: 2, records: [], migrationSkippedCount: 0 }),
    'oas.simulation.v1': JSON.stringify({ version: 1, startScore: 301 }),
  };
  await page.goto('/');
  await page.evaluate((entries) => {
    window.localStorage.clear();
    for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
  }, production);
  await page.reload();

  // Production の Light テーマを読んでいない（Beta の既定 Dark のまま）。
  await expect(page.getByTestId('channel-badge')).toHaveText('BETA');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Beta で設定を変えると、Beta のキーにだけ保存される。
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const stored = await page.evaluate(() => {
    const all: Record<string, string | null> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)!;
      all[key] = window.localStorage.getItem(key);
    }
    return all;
  });
  for (const [key, value] of Object.entries(production)) expect(stored[key], key).toBe(value);
  expect(JSON.parse(stored['01as-beta:oas.preferences.v1'] ?? '{}').theme).toBe('light');
  // Beta が作ったキーはすべて Beta の名前空間にある。
  for (const key of Object.keys(stored)) {
    if (key in production) continue;
    expect(key.startsWith('01as-beta:'), key).toBe(true);
  }
});
