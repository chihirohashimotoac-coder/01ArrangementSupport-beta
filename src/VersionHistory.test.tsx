import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { VERSION_HISTORY } from './data/versionHistory';

type User = ReturnType<typeof userEvent.setup>;

async function openVersionHistory(user: User) {
  await user.click(screen.getByTestId('home-version-history'));
}

describe('バージョン履歴', () => {
  it('トップページに「バージョン履歴」ボタンがある', () => {
    render(<App />);
    const button = screen.getByTestId('home-version-history');
    expect(button).toBeInTheDocument();
    expect(button).toHaveAccessibleName('バージョン履歴');

    // トップページの説明・カードより後ろ、フッターより前に置く。
    const modes = screen.getByTestId('home-training');
    const footer = document.querySelector('.app__footer');
    expect(footer).not.toBeNull();
    expect(modes.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('他の画面では「バージョン履歴」ボタンを出さない', async () => {
    const user = userEvent.setup();
    render(<App />);
    for (const id of ['nav-checkout', 'nav-setup', 'nav-training', 'nav-settings']) {
      // 設定はハンバーガーメニューの中にある。
      if (id === 'nav-settings') await user.click(screen.getByTestId('menu-toggle'));
      await user.click(screen.getByTestId(id));
      expect(screen.queryByTestId('home-version-history')).not.toBeInTheDocument();
    }
    // バージョン履歴ページ自身にも出さない。
    await user.click(screen.getByTestId('app-title'));
    await openVersionHistory(user);
    expect(screen.queryByTestId('home-version-history')).not.toBeInTheDocument();
  });

  it('ボタンを押すと見出しと複数の履歴が並ぶ', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    expect(screen.getByRole('heading', { name: 'バージョン履歴' })).toBeInTheDocument();
    const items = screen.getAllByTestId('version-history-item');
    expect(items.length).toBe(VERSION_HISTORY.length);
    expect(items.length).toBeGreaterThan(1);
  });

  it('最新の履歴は v1.4.9（実戦推奨と振り返りの整合）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen.getAllByTestId('version-history-item')[0];
    expect(latest).toHaveTextContent('v1.4.9');
    expect(latest).toHaveTextContent('現在');
    expect(latest.textContent ?? '').toMatch(/実戦推奨 T18/);
    expect(latest.textContent ?? '').toMatch(/残りダーツ数/);
  });

  it('v1.4.7 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('v1.4.7'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    expect(latest.textContent ?? '').toMatch(/CHECKOUT \/ SETUP \/ NEXT VISIT \/ TRAINING の推奨・採点/);
    // 77 の T15 の実例と、得意ダブルが代案側なら従来どおりであること。
    expect(latest.textContent ?? '').toMatch(/77/);
    expect(latest.textContent ?? '').toMatch(/32（D16）/);
    expect(latest.textContent ?? '').toMatch(/交換条件/);
    expect(latest.textContent ?? '').toMatch(/代案側のダブル/);
  });

  it('v1.4.6 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('v1.4.6'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    expect(latest.textContent ?? '').toMatch(/CHECKOUT \/ SETUP \/ NEXT VISIT \/ TRAINING の推奨・採点/);
    // 122 の T15 の実例と、提案に入っているだけでは良い判断にしないこと。
    expect(latest.textContent ?? '').toMatch(/122/);
    expect(latest.textContent ?? '').toMatch(/T15 → T15/);
    expect(latest.textContent ?? '').toMatch(/提案に入っているだけでは/);
  });

  it('v1.4.5 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('v1.4.5'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    expect(latest.textContent ?? '').toMatch(/CHECKOUT \/ SETUP \/ NEXT VISIT \/ TRAINING の推奨・採点/);
    // 41 の S1 → D20 の実例と、合法なだけでは良い判断にしないこと。
    expect(latest.textContent ?? '').toMatch(/41/);
    expect(latest.textContent ?? '').toMatch(/S1 → D20/);
    expect(latest.textContent ?? '').toMatch(/上がれるルートがあるだけでは/);
  });

  it('v1.4.4 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('v1.4.4'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    // 既存モードの推奨・採点を変えていないことを、いちばん先に伝える。
    expect(latest.textContent ?? '').toMatch(/CHECKOUT \/ SETUP \/ NEXT VISIT \/ TRAINING の推奨・採点/);
    // 129 の T20 の実例と、次の投の続け方。
    expect(latest.textContent ?? '').toMatch(/129/);
    expect(latest.textContent ?? '').toMatch(/T20 → T15/);
    expect(latest.textContent ?? '').toMatch(/別の 1 投目を示せるときだけ/);
  });

  it('v1.4.3 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('v1.4.3'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    // 既存モードの推奨・採点を変えていないことを、いちばん先に伝える。
    expect(latest.textContent ?? '').toMatch(/CHECKOUT \/ SETUP \/ TRAINING の推奨・採点/);
    // 243 の T20（S20 → 223）と、116 の S16 → 100 の実例。
    expect(latest.textContent ?? '').toMatch(/243/);
    expect(latest.textContent ?? '').toMatch(/223/);
    expect(latest.textContent ?? '').toMatch(/116/);
    expect(latest.textContent ?? '').toMatch(/S16 → 100/);
    // NEXT VISIT の提案と食い違う場面があることも隠さない。
    expect(latest.textContent ?? '').toMatch(/NEXT VISIT の提案そのものは変えていません/);
  });

  it('SIMULATION の振り返りと入力の見直しの履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('SIMULATION の振り返りと入力の見直し'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    // 判定を変えていないことを、いちばん先に伝える。
    expect(latest.textContent ?? '').toMatch(/狙いの判定・着弾のモデル・アレンジの推奨は変更していません/);
    expect(latest.textContent ?? '').toMatch(/1投戻す/);
    expect(latest.textContent ?? '').toMatch(/未完了/);
  });

  it('盤面の狙い方（42 / 46 / 48 / 39 / 43）の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('盤面の狙い方（42'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    // 既存の判定を変えていないこと、48 の T16 BUST と残り 1 本の扱い。
    expect(latest.textContent ?? '').toMatch(/基準ルート・候補の並び・TRAINING の採点は変更していません/);
    expect(latest.textContent ?? '').toMatch(/T16/);
    expect(latest.textContent ?? '').toMatch(/NEXT VISIT/);
  });

  it('アレンジ理論の照合と回帰テストの追加の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const latest = screen
      .getAllByTestId('version-history-item')
      .find((item) => (item.textContent ?? '').includes('アレンジ理論の照合と回帰テストの追加'));
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(latest.querySelector('.version-history__badge')).toBeNull();
    // 画面の動作を変えていないことを、いちばん先に伝える。
    expect(latest.textContent ?? '').toMatch(/画面の動作・アレンジの判定は変更していません/);
    // 照合したケースと、基準ルートを変えなかったこと。
    expect(latest.textContent ?? '').toMatch(/303/);
    expect(latest.textContent ?? '').toMatch(/T15 → D8/);
    expect(latest.textContent ?? '').toMatch(/T11 → D14/);
  });

  /*
   * 更新のお知らせ（UpdateBanner）はユーザー向け履歴へ載せない方針
   * （オーナー判断 2026-09-22: サイレントアップデートで構わない）。
   * 履歴の先頭が「更新のお知らせ」へ差し替わっていないことも、ここで担保される。
   */
  it('更新のお知らせの追加は、バージョン履歴へ載せない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const labels = screen
      .getAllByTestId('version-history-item')
      .map((item) => item.querySelector('.version-history__label')?.textContent ?? '');
    expect(labels.some((label) => label.includes('更新のお知らせ'))).toBe(false);
  });

  it('v1.4.2 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.4.2'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/SIMULATION/);
    // 178 の S18 / T18 の実例と、シングル狙いを一律に下げないこと。
    expect(previous!.textContent ?? '').toMatch(/178/);
    expect(previous!.textContent ?? '').toMatch(/S18/);
    expect(previous!.textContent ?? '').toMatch(/T18/);
    expect(previous!.textContent ?? '').toMatch(/悪手にはしません/);
    // 既存モードを変えていないことも明示する。
    expect(previous!.textContent ?? '').toMatch(/変更していません/);
    expect(previous!.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.4.1 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.4.1'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/設定目安|意味と設定目安/);
    expect(previous!.textContent ?? '').toMatch(/159/);
    expect(previous!.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.4.0 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.4.0'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/CALCULATION MISS/);
    expect(previous!.textContent ?? '').toMatch(/GAME REVIEW/);
    expect(previous!.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.3.7 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.3.7'));
    expect(previous).toBeDefined();
    expect(previous?.textContent ?? '').toMatch(/299/);
    expect(previous?.textContent ?? '').toMatch(/T19/);
    expect(previous?.textContent ?? '').toMatch(/参考資料・出典/);
    expect(previous?.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.3.6 の履歴は残っている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.3.6'));
    expect(previous).toBeDefined();
    expect(previous?.textContent ?? '').toMatch(/130/);
    expect(previous?.textContent ?? '').toMatch(/得意ダブル/);
    expect(previous?.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.3.5 の履歴は残っている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.3.5'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/ナンバー/);
    expect(previous!.textContent ?? '').toMatch(/TRAINING/);
    expect(previous!.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.3.4 の履歴は残っている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.3.4'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/シングル/);
    expect(previous!.textContent ?? '').toMatch(/299/);
    expect(previous!.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.3.3 の履歴は残っている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.3.3'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/MY ROUTE/);
    expect(previous!.textContent ?? '').toMatch(/OTHER ROUTES/);
  });

  it('v1.3.2 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.3.2'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/NEXT VISIT/);
    expect(previous!.querySelector('.version-history__badge')).toBeNull();
  });

  it('v1.3.1 の履歴は残り、現在版ではなくなっている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const previous = items.find((item) => (item.textContent ?? '').includes('v1.3.1'));
    expect(previous).toBeDefined();
    expect(previous!.textContent ?? '').toMatch(/ノーテン/);
    // 「現在」バッジは最新版だけに付く（本文中の「現在」と混同しない）。
    expect(previous!.querySelector('.version-history__badge')).toBeNull();
    expect(items[0].querySelector('.version-history__badge')?.textContent).toBe('現在');
  });

  it('TRAINING v1.3 の履歴は残っている', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    const items = screen.getAllByTestId('version-history-item');
    const training = items.find((item) => (item.textContent ?? '').includes('TRAINING 教育設計'));
    expect(training).toBeDefined();
    expect(training!.textContent ?? '').toMatch(/1 投調整/);
    // 現在版ではなくなっている。
    expect(training!.textContent ?? '').not.toMatch(/現在/);
  });

  it('「トップへ戻る」でトップページへ戻れる', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    await user.click(screen.getByTestId('version-history-back'));
    expect(screen.getByTestId('home-checkout')).toBeInTheDocument();
    expect(screen.queryByTestId('version-history-list')).not.toBeInTheDocument();
    // 戻ったときにスクロール位置を持ち越さない。
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('バージョン履歴を開いても既存のナビゲーションは動く', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openVersionHistory(user);

    await user.click(screen.getByTestId('nav-training'));
    expect(screen.getByTestId('start-training')).toBeInTheDocument();
    expect(screen.queryByTestId('version-history-list')).not.toBeInTheDocument();
  });

  it('履歴データは新しい順で、現在版は 1 件だけ', () => {
    const dates = VERSION_HISTORY.map((entry) => entry.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(VERSION_HISTORY.filter((entry) => entry.current)).toHaveLength(1);
    expect(VERSION_HISTORY[0].current).toBe(true);
    // 名称・要約・変更点が欠けている項目を出さない。
    const broken = VERSION_HISTORY.filter(
      (entry) => !entry.label || !entry.summary || entry.changes.length === 0,
    );
    expect(broken).toEqual([]);
  });
});
