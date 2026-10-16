import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { REFERENCE_SECTIONS } from './data/references';

type User = ReturnType<typeof userEvent.setup>;

async function openReferences(user: User) {
  await user.click(screen.getByTestId('home-references'));
}

const ALL_ENTRIES = REFERENCE_SECTIONS.flatMap((section) => section.entries);

describe('参考資料・出典', () => {
  it('トップページに「参考資料・出典」ボタンがある', () => {
    render(<App />);
    const button = screen.getByTestId('home-references');
    expect(button).toBeInTheDocument();
    expect(button).toHaveAccessibleName('参考資料・出典');

    // モードのカードより後ろ、フッターより前（トップページ下部）に置く。
    const modes = screen.getByTestId('home-training');
    const footer = document.querySelector('.app__footer');
    expect(footer).not.toBeNull();
    expect(modes.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('既存の「バージョン履歴」と同じ並びに置き、導線を増やしすぎない', () => {
    render(<App />);
    const history = screen.getByTestId('home-version-history');
    const references = screen.getByTestId('home-references');
    expect(history.parentElement).toBe(references.parentElement);
    // トップページ下部の補助リンクはこの 2 つだけ。
    expect(history.parentElement?.children).toHaveLength(2);
  });

  it('他の画面では「参考資料・出典」ボタンを出さない', async () => {
    const user = userEvent.setup();
    render(<App />);
    for (const id of ['nav-checkout', 'nav-setup', 'nav-training', 'nav-settings']) {
      // 設定はハンバーガーメニューの中にある。
      if (id === 'nav-settings') await user.click(screen.getByTestId('menu-toggle'));
      await user.click(screen.getByTestId(id));
      expect(screen.queryByTestId('home-references')).not.toBeInTheDocument();
    }
    // 参考資料ページ自身にも出さない。
    await user.click(screen.getByTestId('app-title'));
    await openReferences(user);
    expect(screen.queryByTestId('home-references')).not.toBeInTheDocument();
  });

  it('押すと参考資料ページが開き、分類ごとに並ぶ', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    expect(screen.getByRole('heading', { name: '参考資料・出典' })).toBeInTheDocument();
    for (const section of REFERENCE_SECTIONS) {
      expect(screen.getByRole('heading', { name: section.heading })).toBeInTheDocument();
    }
    expect(screen.getAllByTestId('references-item')).toHaveLength(ALL_ENTRIES.length);
  });

  it('「トップへ戻る」でトップページへ戻れる', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    await user.click(screen.getByTestId('references-back'));
    expect(screen.getByTestId('home-checkout')).toBeInTheDocument();
    expect(screen.queryAllByTestId('references-item')).toHaveLength(0);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('参考資料を開いても既存のナビゲーションは動く', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    await user.click(screen.getByTestId('nav-training'));
    expect(screen.getByTestId('start-training')).toBeInTheDocument();
    expect(screen.queryAllByTestId('references-item')).toHaveLength(0);
  });

  it('基準ルートの Source of Truth を説明している', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    const note = screen.getByTestId('references-standard-note');
    expect(note).toHaveTextContent('checkout_table_added_routes_final.xlsx');
    expect(note).toHaveTextContent('123');
    expect(note).toHaveTextContent('Source of Truth');
    expect(note).toHaveTextContent('基準ルート');
  });

  it('「PDC 公式」と誤認させる書き方をしない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    const text = document.body.textContent ?? '';
    // PDC への言及は「公式と確認できていない」という一文だけに限る。
    expect(text).toMatch(/一次資料は確認できていません/);
    expect(text).not.toMatch(/PDC\s*公式/);
    expect(text).not.toMatch(/公式ルート/);
    expect(text).not.toMatch(/公式認定/);
    expect(text).not.toMatch(/完全一致/);
  });

  it('外部リンクは別タブで開き、rel 属性を付ける', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', expect.stringMatching(/^https:\/\//));
      expect(link).toHaveAttribute('target', '_blank');
      const rel = link.getAttribute('rel') ?? '';
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    }
    // URL を持つ項目の数とリンクの数が一致する（表示漏れを作らない）。
    expect(links).toHaveLength(ALL_ENTRIES.filter((entry) => entry.url !== null).length);
  });

  it('Source of Truth / Reference / Project Documentation を区別して表示する', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    for (const item of screen.getAllByTestId('references-item')) {
      const badges = item.querySelectorAll('.references__role');
      // 1 項目につき役割バッジはちょうど 1 つ。
      expect(badges).toHaveLength(1);
    }

    const excel = screen
      .getAllByTestId('references-item')
      .find((item) => (item.textContent ?? '').includes('checkout_table_added_routes_final.xlsx'));
    expect(excel).toBeDefined();
    expect(within(excel!).getByText('Source of Truth')).toBeInTheDocument();

    const spec = screen
      .getAllByTestId('references-item')
      .find((item) => (item.textContent ?? '').includes('SPEC.md'));
    expect(spec).toBeDefined();
    expect(within(spec!).getByText('Project Documentation')).toBeInTheDocument();
  });

  it('外部 Web サイトの参照履歴が無いことを明示する', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openReferences(user);

    const note = screen.getByTestId('references-no-external');
    expect(note.textContent ?? '').toMatch(/外部の Web サイトを参照した記録はありません/);
    expect(note.textContent ?? '').toMatch(/確認できないもの/);
  });

  it('各項目に、何を参考にしたかと関係する機能が揃っている', () => {
    const broken = ALL_ENTRIES.filter(
      (entry) => !entry.title || !entry.what || !entry.usedFor,
    );
    expect(broken).toEqual([]);

    // URL があるものは https で、タイトルの重複は作らない。
    for (const entry of ALL_ENTRIES) {
      if (entry.url !== null) expect(entry.url.startsWith('https://')).toBe(true);
    }
    const titles = ALL_ENTRIES.map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
