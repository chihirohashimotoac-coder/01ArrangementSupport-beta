import { expect, test, type Page } from '@playwright/test';

/** LEFT を入力する。確定ボタンはないので、入力しただけで反映される。 */
async function setLeft(page: Page, value: number) {
  await page.getByTestId('score-input').fill(String(value));
  // v1.2: 入力したら StatusBar ではなく答え（STANDARD / BEST）が出る。
  await expect(page.getByTestId('standard-route')).toBeVisible();
}

/** 実戦入力（盤面）を開く。v1.2 では通常表示でたたまれている。 */
async function openRecovery(page: Page) {
  await page.getByTestId('recovery-toggle').click();
  await expect(page.getByTestId('dartboard')).toBeVisible();
}

/** CHECKOUT を開いて LEFT を入れる。初期状態は空欄なので毎回必要。 */
async function openCheckout(page: Page, value: number) {
  await page.getByTestId('nav-checkout').click();
  await setLeft(page, value);
}

async function openSetup(page: Page, value: number) {
  await page.getByTestId('nav-setup').click();
  await setLeft(page, value);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('アプリが起動し、4 つのモードが並ぶ', async ({ page }) => {
  await expect(page.getByTestId('app-title')).toBeVisible();
  await expect(page.getByTestId('home-checkout')).toBeVisible();
  await expect(page.getByTestId('home-setup')).toBeVisible();
  await expect(page.getByTestId('home-training')).toBeVisible();
  await expect(page.getByTestId('home-simulation')).toBeVisible();
});

test('CHECKOUT 103 で基準ルートと理由を確認できる', async ({ page }) => {
  await openCheckout(page, 103);

  // 答えより先に盤面を通過させない。
  await expect(page.getByTestId('dartboard')).toHaveCount(0);
  await expect(page.getByTestId('status-bar')).toHaveCount(0);

  const standard = page.getByTestId('standard-route');
  await expect(standard).toContainText('T19');
  await expect(standard).toContainText('S6');
  await expect(standard).toContainText('D20');
  await expect(standard).toContainText('STANDARD');

  // 基準ルートの理由は既定で開いている。
  await expect(standard.locator('button[aria-controls]')).toHaveAttribute('aria-expanded', 'true');
  await expect(standard.locator('li[data-code="STANDARD_ROUTE"]')).toBeVisible();
});

test('OTHER ROUTES の理由は開閉できる（progressive disclosure）', async ({ page }) => {
  await openCheckout(page, 103);
  // 開閉でボタン名が変わるため、カードを固定してからボタンを取る。
  const card = page.getByTestId(/^route-/).first();
  const toggle = card.locator('button[aria-controls]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(card.locator('.route-card__reasons')).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.route-card__reasons')).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('「すべて表示」は 40 件で打ち切らず、ボタンの件数と一致する', async ({ page }) => {
  await openCheckout(page, 130);

  const button = page.getByTestId('show-all-routes');
  const label = (await button.textContent()) ?? '';
  const total = Number(/(\d+)\s*件/.exec(label)?.[1]);
  expect(total).toBeGreaterThan(40);

  await button.click();
  // AUD-P2-001: 以前は 40 件で黙って打ち切られていた。
  expect(await page.getByTestId('other-routes').locator('> *').count()).toBe(total);
  await expect(page.getByTestId('show-all-routes')).toContainText('上位 5 件');
});

test('1 投ごとのリカバリーが追従する', async ({ page }) => {
  await openCheckout(page, 103);
  await openRecovery(page);

  // T19 を狙って S19 に落ちた場合。
  await page.getByTestId('segment-s19-outer').click();
  await expect(page.getByTestId('status-left')).toHaveText('84');
  await expect(page.getByTestId('status-darts')).toHaveText('2');
  await expect(page.getByTestId('thrown-0')).toHaveText('S19');
  // 残り 2 本での候補が出る。
  await expect(page.getByTestId('standard-route')).toBeVisible();
});

test('129を2本から直接参照し、3本へ戻すと上がり候補へ切り替わる', async ({ page }) => {
  await openCheckout(page, 129);
  await page.getByRole('button', { name: '2本' }).click();
  await expect(page.getByTestId('no-routes')).toContainText('残り 2 本では 129 を上がれません');
  await expect(page.getByTestId('next-visit-route')).toBeVisible();
  await expect(page.getByTestId('standard-route')).toHaveCount(0);
  await openRecovery(page);
  await expect(page.getByTestId('status-left')).toHaveText('129');
  await expect(page.getByTestId('status-darts')).toHaveText('2');
  await expect(page.getByTestId('thrown-0')).toHaveText('—');
  await page.getByRole('button', { name: '3本' }).click();
  await expect(page.getByTestId('standard-route')).toBeVisible();
  await expect(page.getByTestId('next-visit-route')).toHaveCount(0);
});

test('最後の1本では実戦推奨を基準例より先に示し、残しを区別する', async ({ page }) => {
  await openSetup(page, 178);
  await page.getByRole('button', { name: '1本' }).click();
  const practical178 = page.getByTestId('practical-last-dart');
  await expect(practical178).toContainText('T18');
  await expect(practical178).toContainText('124');
  await expect(practical178).toContainText('160');
  await expect(practical178).toContainText('次の3本で上がれる');
  await expect(practical178).toContainText('基準例 S18 は通常のルート順位');
  await expect(practical178.locator('.route-card__reasons-inline li')).toHaveCount(2);
  await expect(page.getByTestId('setup-routes')).toContainText('基準評価');
  await expect(page.getByText(/基準評価は通常のSETUP順位/)).toBeVisible();
  const baseline178 = page.getByTestId('standard-route');
  await expect(baseline178).toContainText('基準例');
  await expect(baseline178).toContainText('S18');
  expect(await practical178.evaluate((item, baseline) =>
    Boolean(item.compareDocumentPosition(document.querySelector(baseline)!) & Node.DOCUMENT_POSITION_FOLLOWING),
  '[data-testid="standard-route"]')).toBe(true);

  await openCheckout(page, 99);
  await page.getByRole('button', { name: '1本' }).click();
  const practical99 = page.getByTestId('practical-last-dart');
  await expect(practical99).toBeVisible();
  await expect(practical99).toContainText('残り 39');
  await expect(practical99).toContainText('残り 79');
  await expect(practical99.locator('.route-card__darts [data-dart="T20"]')).toHaveCount(1);
  await expect(page.getByTestId('next-visit-route')).toContainText('基準例');
});

test('320pxでも残りダーツ操作が収まり、押せる幅を保つ', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openCheckout(page, 129);
  const two = page.getByRole('button', { name: '2本' });
  await two.click();
  await expect(two).toHaveAttribute('aria-pressed', 'true');
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
  const box = await two.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test('途中参照の投球・Undo・BUSTでは未知の開始点を復帰点として見せない', async ({ page }) => {
  await openCheckout(page, 40);
  await page.getByRole('button', { name: '1本' }).click();
  await openRecovery(page);
  await page.getByTestId('segment-t20').click();
  await expect(page.getByTestId('status-flag')).toHaveText('BUST');
  await expect(page.getByTestId('status-left')).toHaveText('—');
  await expect(page.getByTestId('next-visit-button')).toBeDisabled();
  await expect(page.getByTestId('recovery-next-message')).toContainText('ラウンド開始時の残り');
  await page.getByTestId('undo-button').click();
  await expect(page.getByTestId('status-left')).toHaveText('40');
  await expect(page.getByTestId('status-darts')).toHaveText('1');
  await page.getByTestId('segment-s1-outer').click();
  await expect(page.getByTestId('status-left')).toHaveText('39');
  await expect(page.getByTestId('next-visit-button')).toBeEnabled();
  await page.getByTestId('next-visit-button').click();
  await expect(page.getByTestId('status-left')).toHaveText('39');
  await expect(page.getByTestId('status-darts')).toHaveText('3');
});

test('未知の BUST 開始点はモードを越えて復元でき、無効値では待機を保つ', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheckout(page, 61);
  await page.getByRole('button', { name: '1本' }).click();
  await openRecovery(page);
  await page.getByTestId('segment-t20').click();
  await expect(page.getByTestId('status-left')).toHaveText('—');
  for (const invalid of ['1', '351', '18.1']) {
    await page.getByTestId('score-input').fill(invalid);
    await page.getByTestId('score-input').press('Enter');
    await expect(page.getByRole('alert')).toContainText('2〜350');
    await expect(page.getByTestId('status-flag')).toHaveText('BUST');
  }
  await page.getByTestId('score-input').fill('181');
  await page.getByTestId('score-input').press('Enter');
  await expect(page.getByTestId('nav-setup')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('score-input')).toHaveValue('181');
  await openRecovery(page);
  await expect(page.getByTestId('status-left')).toHaveText('181');
  await expect(page.getByTestId('status-darts')).toHaveText('3');
  await expect(page.getByTestId('standard-route')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('39 / 2本の未知 BUST と既知の 60 の自動復帰を保つ', async ({ page }) => {
  await openCheckout(page, 39);
  await page.getByRole('button', { name: '2本' }).click();
  await openRecovery(page);
  await page.getByTestId('segment-t17').click();
  await expect(page.getByTestId('status-left')).toHaveText('—');
  await expect(page.getByTestId('recovery-next-message')).toContainText('ラウンド開始時の残り');

  await page.getByTestId('score-input').fill('60');
  await page.getByTestId('score-input').press('Enter');
  await expect(page.getByTestId('standard-route')).toBeVisible();
  await openRecovery(page);
  await page.getByTestId('segment-s12-outer').click();
  await page.getByTestId('segment-t16').click();
  await expect(page.getByTestId('status-flag')).toHaveText('BUST');
  await expect(page.getByTestId('status-left')).toHaveText('60');
  await page.getByTestId('next-visit-button').click();
  await expect(page.getByTestId('status-darts')).toHaveText('3');
});

test('未知 BUST を同じ残り点で復元しても、前の OTHER ROUTE を持ち越さない', async ({ page }) => {
  await openCheckout(page, 39);
  await page.getByRole('button', { name: '2本' }).click();
  const other = page.getByTestId('route-S19-D10');
  await other.getByRole('button', { name: /^1 投目 S19/ }).click();
  await expect(page.getByTestId('segment-s19-outer')).toHaveAttribute('data-highlighted', 'true');

  await page.getByTestId('segment-t17').click();
  await expect(page.getByTestId('status-left')).toHaveText('—');
  await page.getByTestId('score-input').fill('39');
  await page.getByTestId('score-input').press('Enter');
  await openRecovery(page);
  await expect(page.getByTestId('status-left')).toHaveText('39');
  await expect(page.getByTestId('status-darts')).toHaveText('3');
  const standardDarts = await page.getByTestId('standard-route').locator('.route-card__dart').evaluateAll(
    (buttons) => buttons.map((button) => button.getAttribute('data-dart')),
  );
  const highlighted = await page.getByTestId('dartboard').locator('[data-highlighted="true"]').evaluateAll(
    (segments) => [...new Set(segments.map((segment) => segment.getAttribute('data-dart')))],
  );
  expect(highlighted.sort()).toEqual(standardDarts.sort());
});

test('Undo で 1 投戻せる', async ({ page }) => {
  await openCheckout(page, 103);
  await openRecovery(page);
  await page.getByTestId('segment-s19-outer').click();
  await expect(page.getByTestId('status-left')).toHaveText('84');
  await page.getByTestId('undo-button').click();
  await expect(page.getByTestId('status-left')).toHaveText('103');
  await expect(page.getByTestId('status-darts')).toHaveText('3');
});

test('Bust するとビジット開始時の残りへ戻る', async ({ page }) => {
  await openCheckout(page, 103);
  await openRecovery(page);
  await page.getByTestId('segment-t19').click();
  await expect(page.getByTestId('status-left')).toHaveText('46');
  await page.getByTestId('segment-t20').click();

  await expect(page.getByTestId('status-flag')).toHaveText('BUST');
  await expect(page.getByTestId('status-left')).toHaveText('103');
  await expect(page.getByTestId('board-disabled-reason')).toBeVisible();
});

test('122 では T18 始動が基準ルートになる', async ({ page }) => {
  await openCheckout(page, 122);
  const standard = page.getByTestId('standard-route');
  await expect(standard).toContainText('T18');
  await expect(page.getByTestId('standard-route-headline')).toContainText('104');
});

test('Bogey を入れると理由を示して候補を出さない', async ({ page }) => {
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('169');
  await expect(page.getByTestId('no-routes')).toContainText('ノーテン');
});

test('SETUP 305 の第一ターゲットは、狙う得点用トリプル T18 になる（v1.3.7）', async ({ page }) => {
  await openSetup(page, 305);
  await expect(page.getByTestId('score-input')).toHaveValue('305');
  const best = page.getByTestId('standard-route');
  // 1 投目のチップが「狙う的」。T20 はシングルへ落ちると立て直せないので 18 から入る。
  await expect(best.getByRole('button', { name: /^1 投目/ })).toHaveAttribute('data-dart', 'T18');
});

test('SETUP 269 でとりあえず TON の罠を警告する', async ({ page }) => {
  await openSetup(page, 269);
  await expect(page.getByTestId('status-note')).toContainText('169');
});

test('TRAINING で回答し、確定すると採点される', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('start-training').click();

  await page.getByTestId('segment-t20').click();
  await expect(page.getByTestId('answer-0')).toHaveText('T20');

  // 自動確定はしない。
  await expect(page.getByTestId('training-result')).toHaveCount(0);

  await page.getByTestId('training-submit').click();
  await expect(page.getByTestId('training-result')).toBeVisible();
  await expect(page.getByTestId('stat-attempts')).toHaveText('1');
});

test('TRAINING の Undo で 1 投戻せる', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('start-training').click();
  await page.getByTestId('segment-t20').click();
  await page.getByTestId('training-undo').click();
  await expect(page.getByTestId('answer-0')).toHaveText('—');
});

test('学習履歴がリロード後も復元される', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('start-training').click();
  await page.getByTestId('segment-t20').click();
  await page.getByTestId('training-submit').click();
  await expect(page.getByTestId('stat-attempts')).toHaveText('1');

  await page.reload();
  await page.getByTestId('nav-training').click();
  await expect(page.getByTestId('stat-attempts')).toHaveText('1');
});

test('MY ROUTE の設定がリロード後も残る', async ({ page }) => {
  await page.getByTestId('nav-settings').click();
  // 得意ダブルの既定は未設定（v1.3.5）。選んだものが残ることを見る。
  await expect(page.getByTestId('preferred-doubles')).toContainText('まだ選ばれていません');

  await page.getByTestId('select-D16').click();
  await page.getByTestId('select-D20').click();
  await expect(page.getByTestId('preferred-doubles')).toContainText('D16');
  await expect(page.getByTestId('preferred-doubles')).toContainText('D20');

  await page.reload();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('preferred-doubles')).toContainText('D16');
  await expect(page.getByTestId('preferred-doubles')).toContainText('D20');

  // 外すと消える。
  await page.getByTestId('select-D16').click();
  await expect(page.getByTestId('preferred-doubles')).not.toContainText('D16');
});

test('Light / Dark テーマを切り替え、リロード後も復元する', async ({ page }) => {
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#edf4fb');

  for (const destination of ['nav-checkout', 'nav-setup', 'nav-training', 'app-title'] as const) {
    await page.getByTestId(destination).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  }

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#07111f');
});

test('ユーザー向けUIに「ビジット」を表示しない', async ({ page }) => {
  await expect(page.locator('body')).not.toContainText('ビジット');

  await openCheckout(page, 103);
  await openRecovery(page);
  await expect(page.locator('body')).not.toContainText('ビジット');

  await page.getByTestId('nav-setup').click();
  await page.getByTestId('score-input').fill('302');
  await expect(page.locator('body')).not.toContainText('ビジット');

  await page.getByTestId('nav-training').click();
  await expect(page.locator('body')).not.toContainText('ビジット');
  await page.getByTestId('nav-settings').click();
  await expect(page.locator('body')).not.toContainText('ビジット');
});

test('LEFT は空欄から始まり、入力するだけで候補が出る', async ({ page }) => {
  await page.getByTestId('nav-checkout').click();
  await expect(page.getByTestId('score-input')).toHaveValue('');
  await expect(page.getByTestId('practice-idle')).toBeVisible();
  await expect(page.getByTestId('standard-route')).toHaveCount(0);
  // 「セット」ボタンは廃止した。
  await expect(page.getByTestId('score-input-apply')).toHaveCount(0);

  await page.getByTestId('score-input').fill('103');
  await expect(page.getByTestId('standard-route')).toContainText('T19');

  // 空欄へ戻すと未入力状態に戻る。
  await page.getByTestId('score-input').fill('');
  await expect(page.getByTestId('practice-idle')).toBeVisible();
  await expect(page.getByTestId('standard-route')).toHaveCount(0);
});

test('LEFT をタップすると現在値が全選択され、そのまま置き換えられる', async ({ page }) => {
  await openCheckout(page, 103);

  const input = page.getByTestId('score-input');
  await input.blur();
  await input.click();

  // focus した時点で現在値が全選択されている。
  expect(
    await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([0, 3]);

  // Backspace で 3 桁消さずに、次の数字がそのまま置き換わる。
  await page.keyboard.type('61');
  await expect(input).toHaveValue('61');
  await expect(page.getByTestId('standard-route')).toContainText('T15');
});

test('LEFT プリセットは廃止されている（CHECKOUT / SETUP）', async ({ page }) => {
  await page.getByTestId('nav-checkout').click();
  for (const preset of ['170', '167', '164', '161', '160', '122', '103', '61', '46', '40']) {
    await expect(page.getByRole('button', { name: preset, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('.score-input__presets')).toHaveCount(0);

  // プリセットが無くても、直接入力すれば答えが出る。
  await page.getByTestId('score-input').fill('122');
  await expect(page.getByTestId('standard-route')).toContainText('T18');

  await page.getByTestId('nav-setup').click();
  for (const preset of ['350', '340', '309', '305', '302', '275', '271', '269', '235', '231']) {
    await expect(page.getByRole('button', { name: preset, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('.score-input__presets')).toHaveCount(0);

  await page.getByTestId('score-input').fill('302');
  await expect(page.getByTestId('standard-route')).toContainText('S18');
});

test('v1.2: 答えが先、盤面は「実際の着弾を入力」で開く', async ({ page }) => {
  await page.getByTestId('nav-checkout').click();

  // 未入力時はプリセットの無い、入力欄だけのシンプルな画面。
  await expect(page.getByTestId('score-input')).toHaveAttribute('placeholder', '例 103');
  await expect(page.getByText('残り点 LEFT')).toBeVisible();

  await page.getByTestId('score-input').fill('103');
  const standard = page.getByTestId('standard-route');
  await expect(standard).toContainText('T19');
  await expect(page.getByTestId('dartboard')).toHaveCount(0);

  // 答えは盤面を経由せず、スクロールなしで viewport に入る。
  expect(
    await standard.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.top < window.innerHeight;
    }),
  ).toBe(true);

  const toggle = page.getByTestId('recovery-toggle');
  await expect(toggle).toContainText('実際の着弾を入力');
  await toggle.click();
  await expect(page.getByTestId('dartboard')).toBeVisible();

  // 閉じられる。
  await toggle.click();
  await expect(page.getByTestId('dartboard')).toHaveCount(0);
});

test('v1.2: 着弾を入れると盤面の直下に NEXT と 1投戻す が出る', async ({ page }) => {
  await openCheckout(page, 103);
  await openRecovery(page);

  const undo = page.getByTestId('undo-button');
  await expect(undo).toBeDisabled();

  await page.getByTestId('segment-s19-outer').click();

  const next = page.getByTestId('recovery-next');
  await expect(next.getByTestId('next-remaining')).toHaveText('84');
  await expect(next.getByTestId('next-darts')).toHaveText('2');
  await expect(page.getByTestId('recovery-next-route')).toContainText('NEXT');

  // 盤面と NEXT が一緒に見える（大きくスクロールしないと読めない、を防ぐ）。
  const boardBottom = await page
    .getByTestId('dartboard')
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const nextTop = await next.evaluate((el) => el.getBoundingClientRect().top);
  expect(nextTop - boardBottom).toBeLessThan(80);

  // Undo は盤面のそば。押せば 1 投戻る。
  await expect(page.getByRole('button', { name: '1投戻す' })).toHaveCount(1);
  await undo.click();
  await expect(page.getByTestId('status-left')).toHaveText('103');
});

test('v1.2: 入力途中では画面が動かず、Enter で答えへ移動する', async ({ page }) => {
  await page.getByTestId('nav-checkout').click();
  await page.evaluate(() => {
    const w = window as unknown as { __scrolls: number };
    w.__scrolls = 0;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(...args: unknown[]) {
      w.__scrolls += 1;
      return (original as (...a: unknown[]) => void).apply(this, args);
    };
  });

  const input = page.getByTestId('score-input');
  await input.click();
  // 1 → 10 → 103。10 の時点で合法な CHECKOUT 値になるが、画面は動かさない。
  await page.keyboard.type('103');
  await expect(page.getByTestId('standard-route')).toBeVisible();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls)).toBe(0);

  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () => page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls),
      { timeout: 3000 },
    )
    .toBeGreaterThan(0);
});

test('v1.2: 盤面より下のルートチップから開いても、盤面が見える位置へ移動する', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openCheckout(page, 103);

  // OTHER ROUTES は盤面（実戦入力）より下にある。
  const card = page.getByTestId(/^route-/).first();
  await card.scrollIntoViewIfNeeded();
  await card.locator('.route-card__dart').first().click();

  const board = page.getByTestId('dartboard');
  await expect(board).toBeVisible();
  // 開いた盤面が viewport の上へ出てしまっていない。
  expect(
    await board.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    }),
  ).toBe(true);
  await expect(page.locator('[data-focused="true"]').first()).toBeVisible();
});

test('v1.2: 盤面が開いているときは、チップを押しても画面を動かさない', async ({ page }) => {
  await openCheckout(page, 103);
  await openRecovery(page);
  // Playwright 自身のクリック前スクロールと区別するため、呼び出し回数で見る。
  await page.evaluate(() => {
    const w = window as unknown as { __scrolls: number };
    w.__scrolls = 0;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(...args: unknown[]) {
      w.__scrolls += 1;
      return (original as (...a: unknown[]) => void).apply(this, args);
    };
  });

  await page.getByTestId('standard-route').locator('.route-card__dart').first().click();
  await expect(page.locator('[data-focused="true"]').first()).toBeVisible();
  await page.waitForTimeout(400);

  expect(await page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls)).toBe(0);
});

test('v1.2: LEFT の blur で予約された移動は、実戦入力を開いた時点で取り消す', async ({ page }) => {
  await page.getByTestId('nav-checkout').click();
  await page.evaluate(() => {
    const w = window as unknown as { __scrolls: number };
    w.__scrolls = 0;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(...args: unknown[]) {
      w.__scrolls += 1;
      return (original as (...a: unknown[]) => void).apply(this, args);
    };
  });

  await page.getByTestId('score-input').click();
  await page.keyboard.type('103');
  await expect(page.getByTestId('standard-route')).toBeVisible();

  // 入力欄から実戦入力ボタンへ移ると blur → click の順に起きる。
  await page.getByTestId('recovery-toggle').click();
  await expect(page.getByTestId('dartboard')).toBeVisible();

  // 予約されていた 250ms 後の移動は起きない。
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls)).toBe(0);
  await expect(page.getByTestId('dartboard')).toBeVisible();
});

test('v1.2: TRAINING は採点後にだけ結果の直下へ「次の問題」を出す', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('start-training').click();

  await expect(page.getByTestId('training-next')).toHaveCount(0);

  await page.getByTestId('segment-t20').click();
  await page.getByTestId('training-submit').click();

  await expect(page.getByTestId('training-result')).toBeVisible();
  await expect(page.getByRole('button', { name: '次の問題' })).toHaveCount(1);

  const resultBottom = await page
    .getByTestId('training-result')
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const nextTop = await page
    .getByTestId('training-next')
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(nextTop - resultBottom).toBeLessThan(40);
});

test('CHECKOUT の LEFT を SETUP へ持ち越さない', async ({ page }) => {
  await openCheckout(page, 103);
  await page.getByTestId('nav-setup').click();
  await expect(page.getByTestId('score-input')).toHaveValue('');
  await expect(page.getByTestId('practice-idle')).toBeVisible();
});

test('Safe Area の余白は通常ブラウザの見た目を変えない', async ({ page }) => {
  const app = page.locator('.app');

  // env(safe-area-inset-*) は通常ブラウザで 0px。従来どおり 0.75rem / 1.5rem になる。
  const padding = await app.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
  });
  expect(padding).toEqual(['12px', '12px', '24px', '12px']);

  // 縦・横どちらでも横スクロールを生まないこと（横画面のノッチ対応で崩れないかの確認）。
  // 320px は小さめの iPhone SE 相当。v1.2 のレイアウトはここでも崩さない。
  for (const size of [
    { width: 393, height: 852 },
    { width: 852, height: 393 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(size);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, `${size.width}x${size.height} で横スクロールが出ている`).toBe(false);
  }
});

test('320px でも CHECKOUT / SETUP の主要部が横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });

  for (const [nav, value] of [
    ['nav-checkout', '103'],
    ['nav-setup', '302'],
  ] as const) {
    await page.getByTestId(nav).click();
    await page.getByTestId('score-input').fill(value);
    await expect(page.getByTestId('standard-route')).toBeVisible();
    await page.getByTestId('recovery-toggle').click();
    await expect(page.getByTestId('dartboard')).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, `${nav} の 320px で横スクロールが出ている`).toBe(false);
  }
});

test('footer は Copyright 表記だけ', async ({ page }) => {
  const footer = page.locator('.app__footer');
  await expect(footer).toHaveText('© 2026 Chihiro Hashimoto');
  await expect(footer).not.toContainText('添付資料');
});

test('設定画面は基準ルートをユーザー向けの言葉で説明する', async ({ page }) => {
  await page.getByTestId('nav-settings').click();
  await expect(page.getByRole('heading', { name: '基準ルートについて' })).toBeVisible();
  await expect(page.getByTestId('standard-route-note')).toContainText(
    '実戦で使われる標準的なアレンジ',
  );
  const settings = page.locator('.settings');
  await expect(settings).not.toContainText('添付');
  await expect(settings).not.toContainText('human-approved-v1');
  // APPROVALS.md A-1: 一次資料が確認できていないため、出典は主張しない。
  await expect(settings).not.toContainText('PDC');
});

// ---------------------------------------------------------------------------
// v1.3 TRAINING 教育設計
// ---------------------------------------------------------------------------

/** SETUP TRAINING を開き、1 投調整の問題まで進める。 */
async function openSetupAdjustment(page: Page) {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('training-mode-setup').click();
  await page.getByTestId('start-training').click();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await page.getByTestId('training-context').count()) > 0) return;
    await page.getByTestId('wedge-20').click();
    await page.getByTestId('training-submit').click();
    await page.getByTestId('training-next').click();
  }
  throw new Error('SETUP の 1 投調整問題が出題されませんでした');
}

test('TRAINING: SETUP は開始残り・ここまでの結果・現在の残り・残り 1 投を出す', async ({ page }) => {
  await openSetupAdjustment(page);

  await expect(page.getByTestId('training-context')).toBeVisible();
  const start = Number(await page.getByTestId('training-context-start').textContent());
  const current = Number(await page.getByTestId('training-context-current').textContent());
  expect(start).toBeGreaterThanOrEqual(171);
  expect(current).toBeLessThan(start);
  await expect(page.getByTestId('training-context-throws')).toContainText('→');
  await expect(page.getByTestId('training-context-darts')).toHaveText('1 投');
  await expect(page.getByTestId('status-left')).toHaveText(String(current));
  await expect(page.getByTestId('answer-0')).toHaveText('—');
});

test('TRAINING: SETUP の 1 投調整は自動確定せず、Undo できる', async ({ page }) => {
  await openSetupAdjustment(page);

  // v1.3.5: 62 区画ではなく、1 ナンバーぶんのエリアをタップして答える。
  await expect(page.getByTestId('training-adjustment-note')).toContainText('ナンバー');
  await expect(page.getByTestId('dartboard')).toHaveAttribute('data-mode', 'wedge');
  await expect(page.getByTestId('wedge-20')).toHaveAttribute('role', 'button');

  await page.getByTestId('wedge-20').click();
  await expect(page.getByTestId('answer-0')).toHaveText('20');
  await expect(page.getByTestId('answer-1')).toHaveCount(0);
  await expect(page.getByTestId('training-result')).toHaveCount(0);

  await page.getByTestId('training-undo').click();
  await expect(page.getByTestId('answer-0')).toHaveText('—');

  await page.getByTestId('wedge-19').click();
  await page.getByTestId('training-submit').click();
  await expect(page.getByTestId('training-result')).toBeVisible();
});

test('TRAINING: SETUP の結果は「あなたの回答」と「おすすめ」を並べて見せる', async ({ page }) => {
  await openSetupAdjustment(page);

  await page.getByTestId('wedge-20').click();
  await page.getByTestId('training-submit').click();

  await expect(page.getByTestId('training-verdict')).toBeVisible();
  await expect(page.getByTestId('training-your-answer')).toContainText('S20');
  await expect(page.getByTestId('training-recommended')).toContainText('おすすめ');
  await expect(page.getByTestId('training-difference')).toBeVisible();
  expect((await page.getByTestId('training-difference').textContent())?.length ?? 0).toBeGreaterThan(
    0,
  );
});

test('TRAINING: CHECKOUT で成立しない回答をしても、おすすめの上がり方を出す', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('start-training').click();

  await page.getByTestId('segment-s1-outer').click();
  await page.getByTestId('training-submit').click();

  await expect(page.getByTestId('training-recommended')).toBeVisible();
  await expect(page.getByTestId('training-difference')).toContainText('上がれます');
});

test('TRAINING: RECOVERY でも不成立の回答におすすめを出す', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('training-mode-recovery').click();
  await page.getByTestId('start-training').click();

  await expect(page.getByTestId('status-darts')).toHaveText('2');
  await page.getByTestId('segment-s1-outer').click();
  await page.getByTestId('training-submit').click();

  await expect(page.getByTestId('training-recommended')).toBeVisible();
  await expect(page.getByTestId('training-difference')).toContainText('上がれます');
});

/**
 * その問題の入力方法で 1 つだけ答える。
 *
 * SETUP はナンバー選択（v1.3.5）、CHECKOUT / RECOVERY は盤面。
 */
async function answerOne(page: Page) {
  if ((await page.getByTestId('wedge-20').count()) > 0) {
    await page.getByTestId('wedge-20').click();
    return;
  }
  await page.getByTestId('segment-t20').click();
}

test('TRAINING: MIXED で 10 問を終えられる', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('training-mode-mixed').click();
  await page.getByTestId('start-training').click();

  for (let i = 0; i < 10; i += 1) {
    await expect(page.getByTestId('training-progress')).toHaveText(`${i + 1} / 10 問目`);
    await answerOne(page);
    await page.getByTestId('training-submit').click();
    await expect(page.getByTestId('training-result')).toBeVisible();
    await page.getByTestId('training-next').click();
  }

  await expect(page.getByTestId('training-finished')).toBeVisible();
  await expect(page.getByTestId('stat-attempts')).toHaveText('10');
});

test('TRAINING: 無限モードは 10 問を超えても続く', async ({ page }) => {
  await page.getByTestId('nav-training').click();
  await page.getByRole('button', { name: '詳細設定' }).click();
  await page.getByRole('button', { name: '無限' }).click();
  await page.getByTestId('start-training').click();

  for (let i = 0; i < 11; i += 1) {
    await expect(page.getByTestId('training-progress')).toHaveText(`${i + 1} 問目`);
    await answerOne(page);
    await page.getByTestId('training-submit').click();
    await page.getByTestId('training-next').click();
  }
  await expect(page.getByTestId('training-progress')).toHaveText('12 問目');
});

test('TRAINING: 読み取れない古い履歴を正答率へ混ぜない', async ({ page }) => {
  await page.evaluate(() => {
    window.localStorage.setItem(
      '01as-beta:oas.training.v1',
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'ok',
            at: 1,
            kind: 'checkout',
            remaining: 103,
            dartsAvailable: 3,
            answer: ['T19', 'S6', 'D20'],
            valid: true,
            grade: 'S',
            finishDouble: 'D20',
            elapsedMs: 3000,
          },
          null,
          { kind: 'setup', remaining: 302, dartsAvailable: 3, answer: ['ZZ'], valid: true },
        ],
      }),
    );
  });
  await page.reload();
  await page.getByTestId('nav-training').click();

  await expect(page.getByTestId('stat-attempts')).toHaveText('1');
  await expect(page.getByTestId('stat-accuracy')).toHaveText('100%');
  await expect(page.getByTestId('training-migration-skipped')).toContainText('2 件');
});

test('TRAINING: 保存済みV2履歴のカテゴリは日本語表示だけを変え、集計を保つ', async ({ page }) => {
  await page.evaluate(() => {
    const record = {
      id: 'known',
      at: 1,
      kind: 'checkout',
      format: 'checkout-route',
      problemKey: 'checkout|v2|left=103|darts=3',
      difficulty: 'medium',
      primaryCategory: 'checkout-100-119',
      learningTags: [],
      startRemaining: 103,
      currentRemaining: 103,
      contextualThrows: [],
      dartsAvailable: 3,
      answer: ['T19', 'S6', 'D20'],
      ruleValid: true,
      learningCorrect: true,
      grade: 'S',
      failureCode: null,
      finishDouble: 'D20',
      elapsedMs: 3000,
    };
    window.localStorage.setItem(
      '01as-beta:oas.training.v1',
      JSON.stringify({
        version: 2,
        records: [
          record,
          {
            ...record,
            id: 'unknown',
            primaryCategory: 'legacy-unknown',
            learningCorrect: false,
            grade: 'C',
          },
        ],
        migrationSkippedCount: 0,
      }),
    );
  });
  await page.reload();
  await page.getByTestId('nav-training').click();

  await expect(page.getByTestId('stat-attempts')).toHaveText('2');
  await expect(page.getByTestId('stat-accuracy')).toHaveText('50%');
  await expect(page.getByTestId('training-by-category')).toContainText('100〜119点の上がり');
  await expect(page.getByTestId('training-by-category')).toContainText('その他');
  await expect(page.getByTestId('training-by-category')).not.toContainText('checkout-100-119');
});

test('バージョン履歴: トップから開き、「トップへ戻る」で戻れる', async ({ page }) => {
  await page.getByTestId('home-version-history').click();

  await expect(page.getByRole('heading', { name: 'バージョン履歴' })).toBeVisible();
  const items = page.getByTestId('version-history-item');
  await expect(items.first()).toContainText('現在');
  /*
   * 版の呼称は更新のたびに変わるので、形だけを見る。
   * 呼称を持たない更新もあるため（存在しない版番号は作らない方針）、
   * ここで見るのは「日付が入っていること」にする。
   */
  await expect(items.first().locator('time')).toContainText(/^\d{4}-\d{2}-\d{2}$/);
  expect(await items.count()).toBeGreaterThan(1);
  // どの版にも呼称か日付のどちらかは必ずある。
  await expect(items.first().locator('.version-history__label')).not.toBeEmpty();

  // トップページのボタンは、この画面では出さない。
  await expect(page.getByTestId('home-version-history')).toHaveCount(0);

  // 下までスクロールしても「トップへ戻る」は画面上部に残る。
  const back = page.getByTestId('version-history-back');
  await items.last().scrollIntoViewIfNeeded();
  await expect(back).toBeInViewport();

  await back.click();
  await expect(page.getByTestId('home-checkout')).toBeVisible();
  await expect(page.getByTestId('version-history-list')).toHaveCount(0);
  // 履歴のスクロール位置を持ち越さない。
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
});

test('バージョン履歴: 320px 幅でも横へはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByTestId('home-version-history').click();
  await expect(page.getByTestId('version-history-list')).toBeVisible();

  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const targets = document.querySelectorAll(
      '.version-history, .version-history *, .app__header, .app__nav',
    );
    return [...targets]
      .map((el) => ({ cls: el.className.toString(), right: el.getBoundingClientRect().right }))
      .filter((box) => box.right > width + 1);
  });
  expect(overflow).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('v1.3.1: 上がれない残りでは NEXT VISIT が盤面より先に出る', async ({ page }) => {
  await page.getByTestId('nav-checkout').click();
  await page.getByTestId('score-input').fill('169');

  const empty = page.getByTestId('no-routes');
  const card = page.getByTestId('next-visit-route');
  await expect(empty).toContainText('ノーテン');
  await expect(card).toBeVisible();
  await expect(card).toContainText('取得');
  await expect(card).toContainText('残り');

  // 「上がれません」→ NEXT VISIT →「実際の着弾を入力」の順で読める。
  const order = await page.evaluate(() => {
    const ids = ['no-routes', 'next-visit-route', 'recovery-toggle'];
    return ids.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? el.getBoundingClientRect().top : Number.NaN;
    });
  });
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
});

test('v1.3.1: 320px でも TIP と NEXT VISIT が横へはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByTestId('nav-checkout').click();

  // 未入力の余白に TIP が出る。
  await expect(page.getByTestId('practice-tip')).toBeVisible();
  let overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows, 'TIP 表示中の 320px で横スクロールが出ている').toBe(false);

  // 入力したら TIP は消え、上がれない残りでは NEXT VISIT が出る。
  await page.getByTestId('score-input').fill('169');
  await expect(page.getByTestId('practice-tip')).toHaveCount(0);
  await expect(page.getByTestId('next-visit-route')).toBeVisible();
  await page.getByTestId('recovery-toggle').click();
  await expect(page.getByTestId('dartboard')).toBeVisible();

  overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows, 'NEXT VISIT 表示中の 320px で横スクロールが出ている').toBe(false);
});

test('v1.3.1: 上がれる残りでは TIP も NEXT VISIT も出さない', async ({ page }) => {
  await openCheckout(page, 103);
  await expect(page.getByTestId('practice-tip')).toHaveCount(0);
  await expect(page.getByTestId('next-visit-route')).toHaveCount(0);

  // SETUP では MY ROUTE の TIP を出さない。
  await page.getByTestId('nav-setup').click();
  await expect(page.getByTestId('practice-idle')).toBeVisible();
  await expect(page.getByTestId('practice-tip')).toHaveCount(0);
});

test('v1.3.2: 134 から T5 を刺した 119 / 2 本で、40 残しを案内する', async ({ page }) => {
  // 実機で見つかった事故の再現。モバイル相当の幅で確認する。
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheckout(page, 134);
  await openRecovery(page);

  // 実際の着弾は T5（15 点）。134 - 15 = 119、残り 2 本。
  await page.getByTestId('segment-t5').click();
  await expect(page.getByTestId('status-bar')).toContainText('119');

  const card = page.getByTestId('next-visit-route');
  await expect(card).toBeVisible();
  await expect(card).toContainText('T20');
  await expect(card).toContainText('S19');
  await expect(card).toContainText('取得 79 点 → 残り 40');

  // 候補を並べて選ばせない。NEXT VISIT は常に 1 件だけ。
  await expect(page.getByTestId('next-visit-route')).toHaveCount(1);

  // 横スクロールを増やさない。
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows, 'NEXT VISIT 表示中に横スクロールが出ている').toBe(false);
});

test('v1.3.2: 119 / 2 本では、警告・NEXT VISIT・実戦入力が近い位置に並ぶ', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheckout(page, 134);
  await openRecovery(page);
  await page.getByTestId('segment-t5').click();
  // 盤面をたたんで、通常の読み順（警告 → 答え → 実戦入力）へ戻す。
  await page.getByTestId('recovery-toggle').click();
  await expect(page.getByTestId('dartboard')).toHaveCount(0);

  const notice = page.getByTestId('no-routes');
  await expect(notice).toContainText('上がれません');
  await expect(page.getByTestId('next-visit-route')).toBeVisible();

  // 警告 → NEXT VISIT →「実際の着弾を入力」の順で、過度なスクロールなしに読める。
  const tops = await page.evaluate(() => {
    const ids = ['no-routes', 'next-visit-route', 'recovery-toggle'];
    return ids.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? el.getBoundingClientRect().top : Number.NaN;
    });
  });
  expect(tops[0]).toBeLessThan(tops[1]);
  expect(tops[1]).toBeLessThan(tops[2]);
  // 3 つとも 1 画面（844px）に収まる。
  expect(tops[2]).toBeLessThan(844);
});

/*
 * v1.3.3: 選んだルートを実戦入力へ引き継ぐ。
 * 実機相当（iPhone 幅 390x844）で、追加操作なしに追従することを確かめる。
 */
/** 得意ダブルを指定した状態でアプリを読み込み直す。 */
async function withPreferredDoubles(page: Page, doubles: readonly string[]) {
  await page.addInitScript((ids) => {
    window.localStorage.setItem(
      '01as-beta:oas.preferences.v1',
      JSON.stringify({ version: 1, preferredDoubles: ids, setupMainTarget: 'T20', theme: 'dark' }),
    );
  }, doubles);
  await page.reload();
}

test('v1.3.3: MY ROUTE のチップをタップするだけで、そのルートを追従する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  // 得意ダブルを D20 だけにすると、122 の MY ROUTE は T18 → D14 → D20 になる。
  await withPreferredDoubles(page, ['D20']);

  await openCheckout(page, 122);
  const myRoute = page.getByTestId('my-route');
  await expect(myRoute).toContainText('T18');
  await expect(myRoute).toContainText('D14');

  // チップを押すだけで盤面が開く。新しいボタンも確認も挟まらない。
  await myRoute.getByRole('button', { name: /^1 投目/ }).click();
  await expect(page.getByTestId('dartboard')).toBeVisible();

  // 予定どおり T18 → 選んだ MY ROUTE の続き（D14 → D20）を案内する。
  await page.getByTestId('segment-t18').click();
  await expect(page.getByTestId('status-bar')).toContainText('68');
  const next = page.getByTestId('recovery-next-route');
  await expect(next).toContainText('D14');
  await expect(next).toContainText('D20');

  await page.getByTestId('segment-d14').click();
  await expect(page.getByTestId('status-bar')).toContainText('40');
  await expect(next).toContainText('D20');

  // 横スクロールを増やさない。
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows, 'ルート追従中に横スクロールが出ている').toBe(false);
});

test('v1.3.3: OTHER ROUTE を外したら、追加操作なしで STANDARD へ戻る', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheckout(page, 117);

  const other = page.getByTestId('route-T19-T12-D12');
  await other.getByRole('button', { name: /^1 投目/ }).click();
  await expect(page.getByTestId('dartboard')).toBeVisible();

  // T19 の予定に対して T20。117 - 60 = 57 / 2 本。
  await page.getByTestId('segment-t20').click();
  await expect(page.getByTestId('status-bar')).toContainText('57');

  // 57 / 2 本の STANDARD（S17 → D20）へ、操作なしで戻る。
  const next = page.getByTestId('recovery-next-route');
  await expect(next).toContainText('S17');
  await expect(next).toContainText('D20');
});

test('v1.3.3: ルートを選んでも、ボタンも答えの位置も増えない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withPreferredDoubles(page, ['D20']);
  await openCheckout(page, 122);
  await openRecovery(page);

  // 位置はページ先頭からの絶対位置で測る（チップから盤面へ動く既存のスクロールと切り分ける）。
  const measure = () =>
    page.evaluate(() => {
      const card = document.querySelector('[data-testid="standard-route"]');
      return {
        buttons: document.querySelectorAll('button').length,
        standardTop: card ? card.getBoundingClientRect().top + window.scrollY : Number.NaN,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });

  const before = await measure();
  await page.getByTestId('my-route').getByRole('button', { name: /^1 投目/ }).click();
  const after = await measure();

  // 新しい常設 UI は追加していない。
  expect(after.buttons).toBe(before.buttons);
  // 答え（STANDARD）が下へ押し下げられていない。
  expect(after.standardTop).toBe(before.standardTop);
  // スクロール量も増えていない。
  expect(after.scrollHeight).toBe(before.scrollHeight);
});

// ---------------------------------------------------------------------------
// v1.3.4
// ---------------------------------------------------------------------------

test('v1.3.4: 130 から S5 を刺した 125 / 2 本で、T20 始動を案内する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheckout(page, 130);
  await openRecovery(page);

  // 実際の着弾は S5。130 - 5 = 125、残り 2 本。
  await page.getByTestId('segment-s5-outer').click();
  await expect(page.getByTestId('status-bar')).toContainText('125');

  const card = page.getByTestId('next-visit-route');
  await expect(card).toBeVisible();
  // T11 → T20 ではなく T20 → T11。取得点も残しも同じなら主目標から入る。
  await expect(card).toContainText('T20');
  await expect(card).toContainText('T11');
  await expect(card).toContainText('取得 93 点 → 残り 32');
  const routeText = (await card.textContent()) ?? '';
  expect(routeText.indexOf('T20')).toBeLessThan(routeText.indexOf('T11'));
});

test('v1.3.5 / v1.3.6: 135 から S5 の 130 / 2 本。未設定なら候補 2 件、得意ダブルを選ぶと 3 件', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  /*
   * 得意ダブルの既定は「未設定」（v1.3.5）。
   * 何も選んでいない状態では、残しの質だけで T20 → T18（16 残し）になる。
   */
  await openCheckout(page, 135);
  await openRecovery(page);
  await page.getByTestId('segment-s5-outer').click();
  await expect(page.getByTestId('status-bar')).toContainText('130');

  const card = page.getByTestId('next-visit-route');
  await expect(card).toBeVisible();
  await expect(card).toContainText('T20');
  await expect(card).toContainText('T18');
  // 130 - 60 - 54 = 16。次ラウンドは D8 の 1 投上がり。
  await expect(card).toContainText('取得 114 点 → 残り 16');

  /*
   * v1.3.6: 盤面直下にも、投げたあとの残り点つきで候補を出す。
   * 得意ダブル未設定なら「考慮した場合」の案は出ない。
   */
  await expect(page.getByTestId('recovery-next-visit')).toBeVisible();
  await expect(page.getByTestId('recovery-next-visit-leave-quality')).toContainText('T20 → T18');
  await expect(page.getByTestId('recovery-next-visit-leave-quality')).toContainText('16');
  await expect(page.getByTestId('recovery-next-visit-alternative')).toContainText('T19 → T19');
  await expect(page.getByTestId('recovery-next-visit-preferred-double')).toHaveCount(0);
  // 上がれない場面では、これまでの 1 行表示は出さない。
  await expect(page.getByTestId('recovery-next-route')).toHaveCount(0);

  // 横スクロールを増やさない。
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows, 'NEXT VISIT の候補表示で横スクロールが出ている').toBe(false);

  // 得意ダブルを複数選ぶと、「考慮した場合」の案が 2 件目に並ぶ。
  await page.getByTestId('nav-settings').click();
  for (const id of ['D16', 'D20', 'D8']) {
    await page.getByTestId(`select-${id}`).click();
  }
  await expect(page.getByTestId('preferred-doubles')).toContainText('D20');

  await openCheckout(page, 135);
  await openRecovery(page);
  await page.getByTestId('segment-s5-outer').click();
  await expect(page.getByTestId('recovery-next-visit-leave-quality')).toContainText('T20 → T18');
  await expect(page.getByTestId('recovery-next-visit-preferred-double')).toContainText('T20 → T10');
  await expect(page.getByTestId('recovery-next-visit-preferred-double')).toContainText('40');
  await expect(page.getByTestId('recovery-next-visit-alternative')).toContainText('T19 → T19');

  // 並び順が優先度。D20 を第 1 希望にすると、第 1 候補が 40 残しになる。
  await page.getByTestId('nav-settings').click();
  await page.getByRole('button', { name: 'D20 を上へ' }).click();
  await openCheckout(page, 135);
  await openRecovery(page);
  await page.getByTestId('segment-s5-outer').click();
  await expect(page.getByTestId('next-visit-route')).toContainText('残り 40');
  await expect(page.getByTestId('recovery-next-visit-leave-quality')).toContainText('T20 → T10');
});

test('v1.3.7: SETUP 299 は T19 を「狙う」（S19 はその実着弾）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSetup(page, 299);

  const best = page.getByTestId('standard-route');
  await expect(best).toBeVisible();
  // 第一ターゲットは得点用トリプル。T20 始動は S20 へ落ちるとテンパイを作れなくなる。
  await expect(best.getByRole('button', { name: /^1 投目/ })).toHaveAttribute('data-dart', 'T19');
  // 狙いどおり入れば、次ラウンドで上がれる残りになる。
  await expect(best).toContainText('残り');
  // なぜそうなのかと、シングルへ落ちたときの残りが理由として出る。
  await expect(best).toContainText('シングル落ち');
  await expect(best).toContainText('S19 へ落ちても 280');
});

test('v1.3.7: 299 で T19 を狙って S19 に落ちたら、280 / 2 本から組み直す', async ({ page }) => {
  await openSetup(page, 299);
  await openRecovery(page);

  // 実際の着弾を S19（狙った T19 の同ナンバーシングル）で入れる。
  await page.getByTestId('segment-s19-outer').click();
  await expect(page.getByTestId('status-left')).toContainText('280');

  // 固定ルートではなく、280 / 2 本として計算し直した案内になる。
  const next = page.getByTestId('recovery-next-route');
  await expect(next).toContainText('T20');
});

/** SETUP / FIRST DART の問題が出るまで進める。 */
async function openSetupFirstDart(page: Page) {
  await page.getByTestId('nav-training').click();
  await page.getByTestId('training-mode-setup').click();
  await page.getByTestId('start-training').click();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await page.getByTestId('training-first-dart-note').count()) > 0) return;
    await page.getByTestId('wedge-20').click();
    await page.getByTestId('training-submit').click();
    await page.getByTestId('training-next').click();
  }
  throw new Error('SETUP / FIRST DART の問題が出題されませんでした');
}

test('v1.3.4: TRAINING の SETUP で 1 投目だけを答える問題が出る', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSetupFirstDart(page);

  await expect(page.getByTestId('training-first-dart-note')).toContainText('FIRST DART');
  // このラウンドは 3 投あるが、回答は 1 投だけ。
  await expect(page.getByTestId('status-darts')).toHaveText('3');
  await expect(page.getByTestId('answer-0')).toHaveText('—');
  await expect(page.getByTestId('answer-1')).toHaveCount(0);
  // ここまでの投球は無い（ラウンドの 1 投目なので）。
  await expect(page.getByTestId('training-context')).toHaveCount(0);

  const left = Number(await page.getByTestId('status-left').textContent());
  expect(left).toBeGreaterThanOrEqual(171);
});

test('v1.3.4: 1 投目問題の feedback に「シングルへ落ちた場合」が出る', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSetupFirstDart(page);

  await page.getByTestId('wedge-20').click();
  await expect(page.getByTestId('answer-0')).toHaveText('20');
  await page.getByTestId('training-submit').click();

  await expect(page.getByTestId('training-result')).toBeVisible();
  // あなたの回答・おすすめのどちらにも「S◯◯ へ落ちると …」が出る。
  await expect(page.getByTestId('training-your-answer')).toContainText('へ落ちると');
  await expect(page.getByTestId('training-recommended')).toContainText('へ落ちると');
  await expect(page.getByTestId('training-difference')).toBeVisible();

  // 横スクロールを増やさない。
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows, '1 投目問題で横スクロールが出ている').toBe(false);
});


// ---------------------------------------------------------------------------
// v1.3.7 参考資料・出典
// ---------------------------------------------------------------------------

test('トップページから参考資料・出典を開き、トップへ戻れる', async ({ page }) => {
  const button = page.getByTestId('home-references');
  await expect(button).toBeVisible();

  await button.click();
  await expect(page.getByRole('heading', { name: '参考資料・出典' })).toBeVisible();
  await expect(page.getByTestId('references-item').first()).toBeVisible();

  await page.getByTestId('references-back').click();
  await expect(page.getByTestId('home-checkout')).toBeVisible();
  await expect(page.getByTestId('references-item')).toHaveCount(0);
});

test('参考資料・出典のボタンは、他の画面には増やさない', async ({ page }) => {
  for (const nav of ['nav-checkout', 'nav-setup', 'nav-training', 'nav-settings'] as const) {
    await page.getByTestId(nav).click();
    await expect(page.getByTestId('home-references')).toHaveCount(0);
  }
  // 参考資料ページ自身にも出さない。
  await page.getByTestId('app-title').click();
  await page.getByTestId('home-references').click();
  await expect(page.getByTestId('home-references')).toHaveCount(0);
});

test('参考資料・出典は基準ルートの Source of Truth を説明する', async ({ page }) => {
  await page.getByTestId('home-references').click();

  const note = page.getByTestId('references-standard-note');
  await expect(note).toContainText('checkout_table_added_routes_final.xlsx');
  await expect(note).toContainText('123');
  await expect(note).toContainText('Source of Truth');

  // 公式認定と誤解させる書き方をしない。
  const page_ = page.locator('.references');
  await expect(page_).not.toContainText('公式ルート');
  await expect(page_).not.toContainText('PDC公式');
  await expect(page_).not.toContainText('PDC 公式');
  await expect(page_).toContainText('一次資料は確認できていません');
});

test('参考資料・出典の外部 URL はリンクとして開ける', async ({ page }) => {
  await page.getByTestId('home-references').click();

  const links = page.locator('.references__link');
  expect(await links.count()).toBeGreaterThan(0);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('href', /^https:\/\//);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }
});

test('参考資料・出典は 320px でも横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByTestId('home-references').click();
  await expect(page.getByTestId('references-item').first()).toBeVisible();

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows, '参考資料・出典の 320px で横スクロールが出ている').toBe(false);

  // 長い URL がカードの外へはみ出していない。
  const linkOverflow = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.references__item'));
    return cards.some((card) => card.scrollWidth > card.clientWidth + 1);
  });
  expect(linkOverflow, 'URL がカードからはみ出している').toBe(false);
});

/*
 * 動画「アレンジディスカッション#1」12:10–13:38 の 121。
 * 出典: https://www.youtube.com/watch?v=687FgfVnINs
 * 記録: docs/VIDEO_ARRANGEMENT_DISCUSSION_01.md
 *
 * 主表示（STANDARD T20 → S11 → BULL）は変えない。
 * 動画の T20 → T11 → D14 を選んだときの追従と、外したときの再計算だけを確認する。
 */
test('動画ケース: 121 の T20 → T11 → D14 を選ぶと追従し、S20 なら計算し直す', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheckout(page, 121);

  // 基準ルートは変わらない。
  await expect(page.getByTestId('standard-route')).toContainText('BULL');

  // 動画のルートは上位 5 件には出ないので「すべて表示」を通る。
  await page.getByTestId('show-all-routes').click();
  const other = page.getByTestId('route-T20-T11-D14');
  await other.getByRole('button', { name: /^1 投目/ }).click();
  await expect(page.getByTestId('dartboard')).toBeVisible();

  // 予定どおり T20 → 選んだ続き（T11 → D14）。
  await page.getByTestId('segment-t20').click();
  await expect(page.getByTestId('status-bar')).toContainText('61');
  const next = page.getByTestId('recovery-next-route');
  await expect(next).toContainText('T11');
  await expect(next).toContainText('D14');

  // Undo して S20 を入れると、101 / 2 本の答え（T17 → BULL）へ戻る。
  await page.getByTestId('undo-button').click();
  await page.getByTestId('segment-s20-outer').click();
  await expect(page.getByTestId('status-bar')).toContainText('101');
  await expect(next).toContainText('T17');
  await expect(next).toContainText('BULL');
});

test('盤面の狙い方: 48 は STANDARD 直下にたたんで置き、T16 の BUST だけは常に見える', async ({ page }) => {
  await openCheckout(page, 48);
  await expect(page.getByTestId('standard-route')).toContainText('S16');

  const card = page.getByTestId('aim-area');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('aim-area-caution')).toBeVisible();
  await expect(page.getByTestId('aim-area-caution')).toContainText('T16 に入ると BUST');
  await expect(page.getByTestId('aim-area-lead')).toBeHidden();

  await page.getByTestId('aim-area-toggle').click();
  await expect(page.getByTestId('aim-area-lead')).toBeVisible();
  await expect(card.locator('[data-dart="S8"]')).toContainText('残り 40 → 次の 1 本で D20');
  await expect(card.locator('[data-dart="T16"]')).toContainText('BUST');
});

test('盤面の狙い方: 39 / 42 / 43 / 46 / 48 を開いても、320px とPC幅で文字がはみ出さない', async ({ page }) => {
  for (const size of [
    { width: 320, height: 568 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    for (const value of [39, 42, 43, 46, 48]) {
      await openCheckout(page, value);
      await page.getByTestId('aim-area-toggle').click();
      await expect(page.getByTestId('aim-area-lead')).toBeVisible();

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows, `${value} / ${size.width}px で横スクロールが出ている`).toBe(false);

      // 各行の「S6 → 残り 36 → 次の 1 本で D18」がカードの枠内に収まる。
      const clipped = await page.getByTestId('aim-area').evaluate((card) => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll('.aim-area__landing')]
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.right > box.right + 0.5 || row.scrollWidth > row.clientWidth + 1;
          })
          .map((row) => row.getAttribute('data-dart'));
      });
      expect(clipped, `${value} / ${size.width}px`).toEqual([]);
    }
  }
});

test('盤面の狙い方: 対象外の残り点・SETUP には出さない', async ({ page }) => {
  await openCheckout(page, 103);
  await expect(page.getByTestId('aim-area')).toHaveCount(0);
  await openSetup(page, 302);
  await expect(page.getByTestId('aim-area')).toHaveCount(0);
});
