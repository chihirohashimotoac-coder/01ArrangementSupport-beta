/**
 * AI MODEL LAB の入口は Developer Gate（`VITE_AI_FEATURES=on`）のビルドでだけ現れる。
 *
 * 既定（Gate が閉）では設定画面に開発者向けの項目を出さず、一般ユーザーの画面は Production と同じ。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function renderApp() {
  vi.resetModules();
  const { default: App } = await import('./App');
  render(<App />);
}

describe('AI MODEL LAB の入口', () => {
  it('Developer Gate が閉じていれば、設定画面に開発者向けの項目を出さない', async () => {
    vi.stubEnv('VITE_AI_FEATURES', '');
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByTestId('nav-settings'));
    expect(screen.queryByTestId('developer-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-ai-lab')).not.toBeInTheDocument();
  });

  it('Developer Gate が開いたビルドでは、設定画面から Lab を開ける（モデルは取得しない）', async () => {
    vi.stubEnv('VITE_AI_FEATURES', 'on');
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByTestId('nav-settings'));
    await user.click(screen.getByTestId('open-ai-lab'));
    expect(await screen.findByTestId('ai-model-lab', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText('AI MODEL LAB')).toBeInTheDocument();
  }, 20_000);
});
