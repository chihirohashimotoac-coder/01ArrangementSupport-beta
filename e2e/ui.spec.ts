import { expect, test, type Page } from '@playwright/test';

/** ページ全体の横はみ出し（スクロール幅が画面幅を超えていないか）。 */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('ホーム: 320px でも題字・例題のカルーセル・残り点の地図が横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByTestId('home-headline')).toBeVisible();
  const carousel = page.getByTestId('home-examples');
  await expect(carousel).toBeVisible();
  await page.getByTestId('score-map').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('score-map')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // 次へ送ると、2 枚目が見える 1 枚になる。
  await carousel.getByTestId('home-examples-next').click();
  await expect(carousel.locator('[aria-roledescription="slide"]:not([inert])')).toHaveCount(1);
  await expect(carousel.locator('[aria-roledescription="slide"]').nth(1)).not.toHaveAttribute('inert', '');
});

test('ホーム: 例題から開くと、その残り点の答えがすぐに出る', async ({ page }) => {
  const carousel = page.getByTestId('home-examples');
  await expect(carousel).toBeVisible();
  // 自動送りに左右されないよう、止めてから 1 枚目を開く。
  const play = carousel.getByTestId('home-examples-play');
  if ((await play.getAttribute('aria-label')) === '自動送りを止める') await play.click();
  const open = carousel.locator('[aria-roledescription="slide"]:not([inert]) button').first();
  const label = (await open.textContent()) ?? '';
  const left = label.match(/^\d+/)?.[0];
  expect(left).toBeDefined();
  await open.click();
  await expect(page.getByTestId('score-input')).toHaveValue(left!);
  await expect(page.getByTestId('standard-route')).toBeVisible();
  await expect(page.getByTestId('crumb-context')).toHaveText(`残り ${left}`);
});

test('ハンバーガーメニュー: 右から開き、Esc・背景のタップで閉じる', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const toggle = page.getByTestId('menu-toggle');
  await toggle.click();
  const menu = page.getByTestId('app-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toBeInViewport();
  await expect(page.getByTestId('menu-references')).toBeVisible();
  // 開いているあいだは背面をスクロールさせない。
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(toggle).toBeFocused();

  await toggle.click();
  await expect(menu).toBeVisible();
  // 背景（パネルの外）を押すと閉じる。
  await page.mouse.click(10, 360);
  await expect(menu).toHaveCount(0);
});

test('ハンバーガーメニュー: 画面を選ぶと移動し、パンくずが現在地を示す', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-history').click();
  await expect(page.getByTestId('version-history-list')).toBeVisible();
  const crumbs = page.getByTestId('breadcrumbs');
  await expect(crumbs).toContainText('ホーム');
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('バージョン履歴');
  await page.getByTestId('crumb-home').click();
  await expect(page.getByTestId('home-checkout')).toBeVisible();
});

test('TRAINING: 学習履歴の消去は確認ダイアログを経る', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('start-training').click();
  await page.getByTestId('segment-t20').click();
  await page.getByTestId('training-submit').click();
  await expect(page.getByTestId('stat-attempts')).toHaveText('1');
  await expect(page.getByTestId('training-accuracy-ring')).toBeVisible();

  await page.getByTestId('clear-history').click();
  await expect(page.getByTestId('confirm-clear-history')).toBeVisible();
  await expect(page.getByTestId('confirm-clear-history-cancel')).toBeFocused();
  await page.getByTestId('confirm-clear-history-cancel').click();
  await expect(page.getByTestId('stat-attempts')).toHaveText('1');

  await page.getByTestId('clear-history').click();
  await page.getByTestId('confirm-clear-history-confirm').click();
  await expect(page.getByTestId('stat-attempts')).toHaveText('0');
});

test.describe('動きを減らす設定', () => {
  test('文字・帯は待たずに最終形で表示し、カルーセルは自動送りしない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    // 題字の最後の文字（いちばん遅れて動く文字）も、すぐに不透明になっている。
    const lastChar = page.locator('.home__headline .kinetic__char').last();
    await expect(lastChar).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('home-examples-play')).toHaveAttribute('aria-label', '自動送りを再開する');
    await page.getByTestId('menu-toggle').click();
    await expect(page.getByTestId('app-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('app-menu')).toHaveCount(0);
  });
});

test('バージョン履歴: プルダウンで選んだ版は、上の版が縮み終えてから見出しの位置へ移動する', async ({ page }) => {
  await page.getByTestId('home-version-history').click();
  const items = page.getByTestId('version-history-item');
  // 現在の版（本文が長い）は開いている。その下の版を選ぶと、上の版が縮む。
  await expect(items.first().locator('button').first()).toHaveAttribute('aria-expanded', 'true');
  const target = items.nth(3);
  const label = (await target.getAttribute('data-accordion-id')) ?? '';
  await page.getByTestId('version-history-jump').selectOption(label);

  await expect(target.locator('button').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(items.first().locator('button').first()).toHaveAttribute('aria-expanded', 'false');
  // 移動が止まったあと、選んだ版の見出しが画面に入っている（上へ外れていない）。
  const heading = target.locator('.accordion__trigger');
  await expect(heading).toBeInViewport();
  await expect
    .poll(async () => heading.evaluate((el) => Math.round(el.getBoundingClientRect().top)), { timeout: 3000 })
    .toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(900);
  const top = await heading.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(page.viewportSize()!.height / 2);
});
