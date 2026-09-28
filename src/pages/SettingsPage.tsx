import { usePreferences } from '../hooks/usePreferences';
import { SELECTABLE_FINISH_TARGETS } from '../storage/preferences';
import { DOUBLE_QUALITY } from '../data/rankingRules';
import type { KeyboardEvent } from 'react';
import type { Theme } from '../storage/preferences';
import './SettingsPage.css';

/**
 * MY ROUTE の設定。
 *
 * ここで選んだ得意ダブルは MY ROUTE の並びにだけ反映され、
 * STANDARD（基準ルート）の並びは変わらない。
 */
export interface SettingsPageProps {
  readonly theme: Theme;
  readonly onThemeChange: (theme: Theme) => void;
  /**
   * 開発者向けの AI MODEL LAB を開く。Developer Gate が開いたビルドでだけ渡される
   * （利用者向けの設定ではない。渡されなければ何も表示しない）。
   */
  readonly onOpenAiLab?: () => void;
}

const THEMES: ReadonlyArray<{ id: Theme; label: string; description: string }> = [
  { id: 'light', label: 'Light', description: '明るく端正な表示' },
  { id: 'dark', label: 'Dark', description: '暗所で見やすい表示' },
];

export function SettingsPage({ theme, onThemeChange, onOpenAiLab }: SettingsPageProps) {
  const { preferences, setPreferredDoubles } = usePreferences();
  const selected = preferences.preferredDoubles;

  const toggle = (id: string) => {
    setPreferredDoubles(
      selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id],
    );
  };

  const move = (index: number, delta: number) => {
    const next = [...selected];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setPreferredDoubles(next);
  };

  const moveTheme = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = THEMES[(index + delta + THEMES.length) % THEMES.length];
    onThemeChange(next.id);
    document.getElementById(`theme-${next.id}`)?.focus();
  };

  return (
    <div className="settings">
      <section className="settings__section settings__section--theme">
        <div>
          <h2>APPEARANCE</h2>
          <p className="settings__section-title">テーマ</p>
          <p className="settings__note">利用環境に合わせて画面の明るさを選べます。</p>
        </div>
        <div className="settings__theme" role="radiogroup" aria-label="カラーテーマ">
          {THEMES.map((option, index) => (
            <button
              key={option.id}
              id={`theme-${option.id}`}
              type="button"
              role="radio"
              aria-checked={theme === option.id}
              data-testid={`theme-${option.id}`}
              onClick={() => onThemeChange(option.id)}
              onKeyDown={(event) => moveTheme(event, index)}
            >
              <span className={`settings__theme-swatch settings__theme-swatch--${option.id}`} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <h2>MY ROUTE — 得意ダブル</h2>
        <p className="settings__note">
          得意なダブルを選ぶと、MY ROUTE の候補がその上がりを優先します。
        </p>
        <ul className="settings__note-list" data-testid="preferred-doubles-help">
          <li>
            <strong>既定では何も選ばれていません。</strong>選ぶまで MY ROUTE は出ません。
          </li>
          <li>
            <strong>複数選べます。</strong>並び順がそのまま優先度です（↑ ↓ で並べ替え、× で外す）。
          </li>
          <li>
            <strong>いちばん上の 1 つ</strong>だけは、上がれないときの残し（NEXT VISIT）にも効きます。
          </li>
          <li>STANDARD（基準ルート）の並びは変わりません。BULL 上がりも選べます。</li>
        </ul>

        <ol className="settings__ranked" data-testid="preferred-doubles">
          {selected.length === 0 && <li className="settings__empty">まだ選ばれていません。</li>}
          {selected.map((id, index) => (
            <li key={id}>
              <span className="settings__rank">{index + 1}</span>
              <span className="settings__id">{id}</span>
              <span className="settings__reason">{DOUBLE_QUALITY[id]?.reasonJa ?? ''}</span>
              <span className="settings__move">
                <button
                  type="button"
                  aria-label={`${id} を上へ`}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${id} を下へ`}
                  onClick={() => move(index, 1)}
                  disabled={index === selected.length - 1}
                >
                  ↓
                </button>
                <button type="button" aria-label={`${id} を外す`} onClick={() => toggle(id)}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>

        <h3>選択できる上がり</h3>
        <div className="settings__grid" role="group" aria-label="得意ダブルの選択">
          {SELECTABLE_FINISH_TARGETS.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`select-${id}`}
              aria-pressed={selected.includes(id)}
              onClick={() => toggle(id)}
            >
              {id}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <h2>基準ルートについて</h2>
        <p className="settings__note" data-testid="standard-route-note">
          STANDARD（基準ルート）は、実戦で使われる標準的なアレンジをまとめたものです。
          MY ROUTE では、設定した得意ダブルを考慮した候補を表示します。
        </p>
      </section>

      {onOpenAiLab && (
        <section className="settings__section" data-testid="developer-section">
          <h2>DEVELOPER</h2>
          <p className="settings__note">
            開発者向けのビルド（Developer Gate）でだけ表示されます。ローカル AI モデルの比較評価に使います。
          </p>
          <button type="button" className="settings__developer" data-testid="open-ai-lab" onClick={onOpenAiLab}>
            AI MODEL LAB を開く
          </button>
        </section>
      )}
    </div>
  );
}
