/**
 * 操作部品（ハンバーガーメニュー・パンくずリスト・カルーセル・モーダル・アコーディオン・
 * ラジオボタン・プルダウン）の回帰テスト。
 *
 * どれも表示と操作の部品で、候補の計算・採点・保存の結果を変えないことも合わせて確かめる。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { rankCheckoutRoutes } from './engine/ranking/checkoutRanking';
import { VERSION_HISTORY } from './data/versionHistory';

type User = ReturnType<typeof userEvent.setup>;

function chips(card: HTMLElement) {
  return [...card.querySelectorAll<HTMLElement>('.route-card__dart')].map((chip) => chip.textContent);
}

async function openMenu(user: User) {
  await user.click(screen.getByTestId('menu-toggle'));
  return screen.getByTestId('app-menu');
}

describe('ハンバーガーメニュー', () => {
  it('開くとダイアログになり、Esc で閉じてボタンへフォーカスが戻る', async () => {
    const user = userEvent.setup();
    render(<App />);
    const toggle = screen.getByTestId('menu-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    const menu = await openMenu(user);
    expect(menu).toHaveAttribute('role', 'dialog');
    expect(menu).toHaveAttribute('aria-modal', 'true');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // ホーム・4 モード・設定・履歴・参考資料へ移れる。
    for (const id of ['menu-home', 'menu-checkout', 'menu-setup', 'menu-training', 'menu-simulation', 'nav-settings', 'menu-history', 'menu-references']) {
      expect(within(menu).getByTestId(id)).toBeInTheDocument();
    }
    expect(within(menu).getByTestId('menu-home')).toHaveAttribute('aria-current', 'page');

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('app-menu')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('どの画面からでもバージョン履歴・参考資料・設定へ移れる', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('nav-training'));

    await openMenu(user);
    await user.click(screen.getByTestId('menu-history'));
    expect(screen.getByTestId('version-history-list')).toBeInTheDocument();
    expect(screen.queryByTestId('app-menu')).not.toBeInTheDocument();

    await openMenu(user);
    await user.click(screen.getByTestId('menu-references'));
    expect(screen.getAllByTestId('references-item').length).toBeGreaterThan(0);

    await openMenu(user);
    await user.click(screen.getByTestId('nav-settings'));
    expect(screen.getByTestId('preferred-doubles')).toBeInTheDocument();
  });

  it('メニューのテーマ（ラジオボタン）は設定画面と同じ値を切り替える', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openMenu(user);
    expect(screen.getByTestId('menu-theme-dark')).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(screen.getByTestId('menu-theme-light')).toBeChecked();

    await user.click(screen.getByTestId('nav-settings'));
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('パンくずリスト', () => {
  it('ホームには出さず、各画面では現在地と状況を示す', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByTestId('breadcrumbs')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('nav-checkout'));
    const crumbs = screen.getByTestId('breadcrumbs');
    expect(crumbs).toHaveAttribute('aria-label', '現在地');
    expect(within(crumbs).getByTestId('crumb-section')).toHaveTextContent('CHECKOUT');
    expect(within(crumbs).getByTestId('crumb-section')).toHaveAttribute('aria-current', 'page');

    await user.type(screen.getByTestId('score-input'), '103');
    expect(within(crumbs).getByTestId('crumb-context')).toHaveTextContent('残り 103');
    expect(within(crumbs).getByTestId('crumb-context')).toHaveAttribute('aria-current', 'page');

    // モード名へ戻ると、入力前の CHECKOUT に戻る。
    await user.click(within(crumbs).getByTestId('crumb-section'));
    expect(screen.getByTestId('score-input')).toHaveValue('');
    expect(screen.queryByTestId('crumb-context')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('crumb-home'));
    expect(screen.getByTestId('home-checkout')).toBeInTheDocument();
  });

  it('TRAINING では出題の進み具合を示す', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('nav-training'));
    await user.click(screen.getByTestId('start-training'));
    expect(screen.getByTestId('crumb-context')).toHaveTextContent('1 / 10 問目');
  });
});

describe('ホームのカルーセル（例題）', () => {
  it('例題は engine の基準ルートそのままで、押すとその残り点で CHECKOUT を開く', async () => {
    const user = userEvent.setup();
    render(<App />);
    const carousel = await screen.findByTestId('home-examples');
    expect(carousel).toHaveAttribute('aria-roledescription', 'carousel');

    const slides = within(carousel).getAllByRole('group');
    expect(slides.length).toBeGreaterThan(1);
    // 見えているスライドは 1 枚だけ。残りは inert。
    expect(slides.filter((slide) => !slide.hasAttribute('inert'))).toHaveLength(1);

    await user.click(within(carousel).getByTestId('home-examples-next'));
    expect(slides[1]).not.toHaveAttribute('inert');
    await user.click(within(carousel).getByTestId('home-examples-prev'));
    expect(slides[0]).not.toHaveAttribute('inert');

    await user.click(screen.getByTestId('home-example-open-103'));
    expect(screen.getByTestId('nav-checkout')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('score-input')).toHaveValue('103');

    // 打ち込んだときと同じ答え（engine の基準ルート）。
    const expected = rankCheckoutRoutes(103, 3).find((route) => route.isStandard);
    expect(chips(screen.getByTestId('standard-route'))).toEqual(expected?.darts.map((dart) => dart.id));
  });
});

describe('アコーディオン', () => {
  it('ホームのヒントは 1 つずつ開閉でき、aria-expanded が連動する', async () => {
    const user = userEvent.setup();
    render(<App />);
    const faq = screen.getByTestId('home-faq');
    const [first, second] = within(faq).getAllByRole('button');
    expect(first).toHaveAttribute('aria-expanded', 'false');

    await user.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    await user.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'true');
    // 1 つ開くと他は閉じる。
    expect(first).toHaveAttribute('aria-expanded', 'false');
    const panel = document.getElementById(first.getAttribute('aria-controls') ?? '');
    expect(panel).toHaveAttribute('inert');
  });

  it('バージョン履歴は現在の版だけを開き、プルダウンで選んだ版を開く', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('home-version-history'));

    const items = screen.getAllByTestId('version-history-item');
    expect(items[0].querySelector('button')).toHaveAttribute('aria-expanded', 'true');
    expect(items[1].querySelector('button')).toHaveAttribute('aria-expanded', 'false');

    const target = VERSION_HISTORY[2];
    await user.selectOptions(screen.getByTestId('version-history-jump'), target.label);
    expect(items[2].querySelector('button')).toHaveAttribute('aria-expanded', 'true');
    expect(items[0].querySelector('button')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('TRAINING の詳細設定（ラジオボタン・プルダウン）', () => {
  it('出題数と制限時間はラジオボタンで 1 つだけ選べる', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('nav-training'));
    await user.click(screen.getByRole('button', { name: '詳細設定' }));

    const count = within(screen.getByTestId('training-count'));
    expect(count.getByRole('radio', { name: '10問' })).toBeChecked();
    await user.click(count.getByRole('radio', { name: '無限' }));
    expect(count.getByRole('radio', { name: '無限' })).toBeChecked();
    expect(count.getByRole('radio', { name: '10問' })).not.toBeChecked();

    const time = within(screen.getByTestId('training-time'));
    expect(time.getByRole('radio', { name: 'なし' })).toBeChecked();
    await user.click(time.getByRole('radio', { name: '15秒' }));

    await user.click(screen.getByTestId('start-training'));
    expect(screen.getByTestId('training-progress')).toHaveTextContent('1 問目');
    expect(screen.getByTestId('training-timer')).toHaveTextContent('残り 15 秒');
  });

  it('出題範囲のプルダウンは、選んだ範囲を最小値・最大値の欄へ入れるだけ', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('nav-training'));
    await user.click(screen.getByRole('button', { name: '詳細設定' }));

    const preset = screen.getByTestId('training-checkout-preset');
    expect(preset).toHaveValue('all');
    await user.selectOptions(preset, '2-40');
    expect(screen.getByLabelText('CHECKOUT 最小値')).toHaveValue(2);
    expect(screen.getByLabelText('CHECKOUT 最大値')).toHaveValue(40);

    // 欄を手で書き換えると「カスタム」になる。
    await user.clear(screen.getByLabelText('CHECKOUT 最大値'));
    await user.type(screen.getByLabelText('CHECKOUT 最大値'), '39');
    expect(preset).toHaveValue('custom');

    await user.selectOptions(screen.getByTestId('training-setup-preset'), '171-250');
    expect(screen.getByLabelText('SETUP 最小値')).toHaveValue(171);
    expect(screen.getByLabelText('SETUP 最大値')).toHaveValue(250);
  });
});

describe('モーダル（確認ダイアログ）', () => {
  it('SIMULATION の「中断する」は確認してから中断する', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('nav-simulation'));
    await user.click(screen.getByTestId('start-simulation'));
    await user.click(screen.getByTestId('sim-quit'));

    const dialog = screen.getByTestId('confirm-quit');
    expect(dialog).toHaveAttribute('role', 'dialog');
    // 既定のフォーカスは取り消し側。
    expect(screen.getByTestId('confirm-quit-cancel')).toHaveFocus();
    await user.click(screen.getByTestId('confirm-quit-cancel'));
    expect(screen.getByTestId('sim-quit')).toBeInTheDocument();

    await user.click(screen.getByTestId('sim-quit'));
    await user.click(screen.getByTestId('confirm-quit-confirm'));
    await waitFor(() => expect(screen.queryByTestId('sim-quit')).not.toBeInTheDocument());
    expect(screen.getByTestId('start-simulation')).toBeInTheDocument();
  });
});
