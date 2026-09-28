import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

type User = ReturnType<typeof userEvent.setup>;

async function openCheckoutWith(user: User, value: string) {
  await user.click(screen.getByTestId('nav-checkout'));
  const input = screen.getByTestId('score-input');
  await user.clear(input);
  await user.type(input, value);
}

function standardChips() {
  return within(screen.getByTestId('standard-route'))
    .getAllByRole('button', { name: /投目/ })
    .map((chip) => chip.getAttribute('data-dart'));
}

/** a が b より前（DOM 順）にあるか。 */
function precedes(a: Element, b: Element) {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('CHECKOUT: 盤面の狙い方', () => {
  it('48 は STANDARD の直下に出し、たたんだままでも T16 の BUST が見える', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '48');

    // 基準ルートは変わらない。
    expect(standardChips()).toEqual(['S16', 'D16']);

    const card = screen.getByTestId('aim-area');
    expect(precedes(screen.getByTestId('standard-route'), card)).toBe(true);
    expect(precedes(card, screen.getByTestId('recovery-toggle'))).toBe(true);
    expect(card).toHaveTextContent('16・8 のシングル');
    expect(screen.getByTestId('aim-area-caution')).toHaveTextContent('T16 に入ると BUST');
    expect(screen.getByTestId('aim-area-caution')).toBeVisible();

    // 既定はたたむ。
    const toggle = screen.getByTestId('aim-area-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('aim-area-lead')).not.toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('aim-area-lead')).toBeVisible();
    const s8 = card.querySelector('[data-dart="S8"]');
    expect(s8).toHaveTextContent('残り 40 → 次の 1 本で D20');
    const t16 = card.querySelector('[data-dart="T16"]');
    expect(t16).toHaveAttribute('data-kind', 'bust');
    expect(card.querySelector('[data-dart="S16"]')).toHaveTextContent('基準ルート');
  });

  it('42 / 46 は S6・S10 を並べ、Bust の注意は出さない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '42');
    expect(standardChips()).toEqual(['S10', 'D16']);
    expect(screen.getByTestId('aim-area')).toHaveTextContent('6・10 のシングル');
    expect(screen.queryByTestId('aim-area-caution')).not.toBeInTheDocument();

    await openCheckoutWith(user, '46');
    expect(standardChips()).toEqual(['S6', 'D20']);
    await user.click(screen.getByTestId('aim-area-toggle'));
    const card = screen.getByTestId('aim-area');
    expect(card.querySelector('[data-dart="S6"]')).toHaveTextContent('D20');
    expect(card.querySelector('[data-dart="S10"]')).toHaveTextContent('D18');
  });

  it('39 は 17・3・19・7 を同じ区分で並べ、17 も事実だけを示す。BUST の注意は消さない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '39');
    expect(standardChips()).toEqual(['S7', 'D16']);

    const card = screen.getByTestId('aim-area');
    expect(card).toHaveTextContent('17・3・19・7 のシングル');
    expect(card).not.toHaveTextContent('条件付き');
    expect(screen.getByTestId('aim-area-caution')).toHaveTextContent('T17・T19・D19');

    await user.click(screen.getByTestId('aim-area-toggle'));
    // エリア内の区分は 1 つだけで、17 も 3・19・7 と同じグループに入る。
    expect(card.querySelectorAll('[data-role]')).toHaveLength(2);
    const area = card.querySelector('[data-role="area"]')!;
    expect(
      [...area.querySelectorAll('[data-dart^="S"]')].map((row) => row.getAttribute('data-dart')),
    ).toEqual(['S17', 'S3', 'S19', 'S7']);
    expect(area.querySelector('[data-dart="S17"]')).toHaveTextContent('残り 22 → 次の 1 本で D11');
    expect(area.querySelector('[data-dart="T17"]')).toHaveAttribute('data-kind', 'bust');
    expect(area.querySelector('[data-dart="T19"]')).toHaveAttribute('data-kind', 'bust');
    expect(area.querySelector('[data-dart="D19"]')).toHaveTextContent('残り 1 で BUST');
  });

  it('別の残り点へ変えたら、開いていた詳細は既定（閉）へ戻る', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '39');
    await user.click(screen.getByTestId('aim-area-toggle'));
    expect(screen.getByTestId('aim-area-toggle')).toHaveAttribute('aria-expanded', 'true');

    await openCheckoutWith(user, '42');
    expect(screen.getByTestId('aim-area')).toHaveAttribute('data-left', '42');
    expect(screen.getByTestId('aim-area-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('43 でも出し、対象外の残り点では出さない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '43');
    expect(screen.getByTestId('aim-area')).toHaveTextContent('3・19・7 のシングル');

    for (const value of ['40', '44', '103', '170']) {
      await openCheckoutWith(user, value);
      expect(screen.getByTestId('standard-route')).toBeInTheDocument();
      expect(screen.queryByTestId('aim-area')).not.toBeInTheDocument();
    }
  });

  it('SETUP には出さない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('nav-setup'));
    const input = screen.getByTestId('score-input');
    await user.type(input, '302');
    expect(screen.queryByTestId('aim-area')).not.toBeInTheDocument();
  });

  it('実戦入力で 42 / 2 本になったら、その本数で出し直す', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '81');
    expect(screen.queryByTestId('aim-area')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('recovery-toggle'));
    await user.click(screen.getByTestId('segment-t13'));
    const card = screen.getByTestId('aim-area');
    expect(card).toHaveAttribute('data-left', '42');
    expect(card).toHaveAttribute('data-darts-left', '2');
    expect(screen.getByTestId('aim-area-toggle')).toBeInTheDocument();
  });

  it('残り 1 本の 48 ではチェックアウトの狙いとして出さず、NEXT VISIT を案内する', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '88');
    await user.click(screen.getByTestId('recovery-toggle'));
    // 88 → S20 → 68 → S20 → 48（残り 1 本）
    await user.click(screen.getByTestId('segment-s20-outer'));
    await user.click(screen.getByTestId('segment-s20-outer'));

    const card = screen.getByTestId('aim-area');
    expect(card).toHaveAttribute('data-left', '48');
    expect(card).toHaveAttribute('data-darts-left', '1');
    expect(screen.getByTestId('aim-area-lead')).toHaveTextContent('今回の 3 投では上がれません');
    expect(screen.getByTestId('aim-area-lead')).toHaveTextContent('NEXT VISIT');
    expect(screen.queryByTestId('aim-area-toggle')).not.toBeInTheDocument();
    expect(card.querySelector('[data-kind="finish-next-dart"]')).toBeNull();
    // 盤面のカードより前、NEXT VISIT のあとに置く。
    expect(precedes(screen.getByTestId('next-visit-route'), card)).toBe(true);
  });

  it('得意ダブルは「得意」と注記するだけで、基準ルートは変えない', async () => {
    window.localStorage.setItem(
      '01as-beta:oas.preferences.v1',
      JSON.stringify({ version: 1, preferredDoubles: ['D20'] }),
    );
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '48');
    expect(standardChips()).toEqual(['S16', 'D16']);

    await user.click(screen.getByTestId('aim-area-toggle'));
    const card = screen.getByTestId('aim-area');
    const preferredTags = [...card.querySelectorAll('.aim-area__tag--preferred')];
    expect(preferredTags.map((tag) => tag.closest('[data-dart]')?.getAttribute('data-dart'))).toEqual([
      'S8',
    ]);
  });

  it('得意ダブルが未設定なら「得意」の注記は出ない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCheckoutWith(user, '48');
    await user.click(screen.getByTestId('aim-area-toggle'));
    expect(screen.getByTestId('aim-area').querySelector('.aim-area__tag--preferred')).toBeNull();
  });
});

describe('TRAINING: 盤面の狙い方', () => {
  async function startCheckoutTraining(user: User, left: string) {
    await user.click(screen.getByTestId('nav-training'));
    await user.click(screen.getByRole('button', { name: '詳細設定' }));
    const min = screen.getByLabelText('CHECKOUT 最小値');
    const max = screen.getByLabelText('CHECKOUT 最大値');
    await user.clear(max);
    await user.type(max, left);
    await user.clear(min);
    await user.type(min, left);
    await user.click(screen.getByTestId('start-training'));
  }

  it('42 の問題では、回答後にだけ補足を出し、採点は変えない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await startCheckoutTraining(user, '42');

    expect(screen.queryByTestId('training-aim-area')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('segment-s6-outer'));
    await user.click(screen.getByTestId('segment-d18'));
    await user.click(screen.getByTestId('training-submit'));

    // S6 → D18 は合法なので正解（学習上も正解）のまま。
    expect(screen.getByTestId('training-verdict').className).toContain('training__verdict--ok');
    const card = screen.getByTestId('training-aim-area');
    expect(card).toHaveTextContent('6・10 のシングル');
    expect(card).toHaveAttribute('data-left', '42');
  });

  it('対象外の残り点の問題では出さない', async () => {
    const user = userEvent.setup();
    render(<App />);
    await startCheckoutTraining(user, '44');
    await user.click(screen.getByTestId('segment-d20'));
    await user.click(screen.getByTestId('training-submit'));
    expect(screen.getByTestId('training-result')).toBeInTheDocument();
    expect(screen.queryByTestId('training-aim-area')).not.toBeInTheDocument();
  });
});
