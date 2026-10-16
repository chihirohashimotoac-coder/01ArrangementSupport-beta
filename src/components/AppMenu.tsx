import type { CSSProperties } from 'react';
import { Modal } from './ui/Modal';
import { RadioGroup } from './ui/RadioGroup';
import type { Theme } from '../storage/preferences';
import './AppMenu.css';

export type MenuDestination =
  | 'home'
  | 'checkout'
  | 'setup'
  | 'training'
  | 'simulation'
  | 'settings'
  | 'history'
  | 'references';

export interface MenuMode {
  readonly id: 'checkout' | 'setup' | 'training' | 'simulation';
  readonly label: string;
  readonly scope: string;
  readonly sub: string;
}

export interface MenuToggleProps {
  readonly open: boolean;
  readonly onClick: () => void;
}

/** ハンバーガーボタン。3 本線が開くと × へ組み変わる。 */
export function MenuToggle({ open, onClick }: MenuToggleProps) {
  return (
    <button
      type="button"
      className="menu-toggle"
      data-testid="menu-toggle"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={open ? 'メニューを閉じる' : 'メニューを開く'}
      data-open={open ? 'true' : 'false'}
      onClick={onClick}
    >
      <span className="menu-toggle__bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="menu-toggle__label" aria-hidden="true">
        MENU
      </span>
    </button>
  );
}

export interface AppMenuProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** いま表示している画面（`aria-current` を付ける）。 */
  readonly current: string;
  readonly modes: readonly MenuMode[];
  readonly onNavigate: (destination: MenuDestination) => void;
  readonly theme: Theme;
  readonly onThemeChange: (theme: Theme) => void;
  /** 下部に小さく出す版の呼称（v1.4.9 など）。 */
  readonly versionLabel: string | null;
  /** リリースチャンネルの札（Beta なら BETA）。無ければ出さない。 */
  readonly channelBadge?: string;
}

const MORE: ReadonlyArray<{ id: MenuDestination; label: string; sub: string; testId: string }> = [
  { id: 'settings', label: '設定', sub: '得意ダブル（MY ROUTE）・テーマ', testId: 'nav-settings' },
  { id: 'history', label: 'バージョン履歴', sub: '主な変更の一覧', testId: 'menu-history' },
  { id: 'references', label: '参考資料・出典', sub: '判断・データの根拠', testId: 'menu-references' },
];

/**
 * ハンバーガーメニュー（右から出るドロワー）。
 *
 * どの画面からでも、ホーム・4 つのモード・設定・バージョン履歴・参考資料へ 1 タップで移れる。
 * テーマ（Dark / Light）もここで切り替えられる（設定画面と同じ値を読み書きする）。
 */
export function AppMenu({
  open,
  onClose,
  current,
  modes,
  onNavigate,
  theme,
  onThemeChange,
  versionLabel,
  channelBadge,
}: AppMenuProps) {
  // 上から順に少しずつ遅れて滑り込む（行の通し番号）。
  const delay = (index: number) => ({ '--menu-i': index }) as CSSProperties;
  const moreStart = 3 + modes.length;

  return (
    <Modal open={open} onClose={onClose} title="メニュー" eyebrow="MENU" variant="drawer" testId="app-menu">
      <nav className="app-menu" aria-label="メニュー">
        <button
          type="button"
          className="app-menu__home"
          data-testid="menu-home"
          aria-current={current === 'home' ? 'page' : undefined}
          style={delay(0)}
          onClick={() => onNavigate('home')}
        >
          <span className="app-menu__mark" aria-hidden="true">
            01
          </span>
          <span>ホーム</span>
        </button>

        <h3 className="app-menu__group" style={delay(1)}>
          モード
        </h3>
        <ul className="app-menu__modes">
          {modes.map((mode, index) => (
            <li key={mode.id} style={delay(2 + index)}>
              <button
                type="button"
                data-testid={`menu-${mode.id}`}
                aria-current={current === mode.id ? 'page' : undefined}
                onClick={() => onNavigate(mode.id)}
              >
                <span className="app-menu__mode-label">{mode.label}</span>
                <span className="app-menu__mode-scope">{mode.scope}</span>
                <span className="app-menu__mode-sub">{mode.sub}</span>
              </button>
            </li>
          ))}
        </ul>

        <h3 className="app-menu__group" style={delay(moreStart - 1)}>
          その他
        </h3>
        <ul className="app-menu__more">
          {MORE.map((item, index) => (
            <li key={item.id} style={delay(moreStart + index)}>
              <button
                type="button"
                data-testid={item.testId}
                aria-current={current === item.id || (item.id === 'settings' && current === 'ai-lab') ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <span className="app-menu__more-label">{item.label}</span>
                <span className="app-menu__more-sub">{item.sub}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="app-menu__theme" style={delay(moreStart + MORE.length)}>
          <RadioGroup<Theme>
            legend="表示テーマ"
            value={theme}
            onChange={onThemeChange}
            options={[
              { value: 'dark', label: 'Dark', testId: 'menu-theme-dark' },
              { value: 'light', label: 'Light', testId: 'menu-theme-light' },
            ]}
          />
        </div>

        <p className="app-menu__version" style={delay(moreStart + MORE.length + 1)}>
          01 Arrangement Support {channelBadge && <span>{channelBadge}</span>}
          {versionLabel && <span>{versionLabel}</span>}
        </p>
      </nav>
    </Modal>
  );
}
