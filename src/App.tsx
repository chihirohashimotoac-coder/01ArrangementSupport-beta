import { useCallback, useEffect, useState } from 'react';
import { PracticePage } from './pages/PracticePage';
import { TrainingPage } from './pages/TrainingPage';
import { SimulationPage } from './pages/SimulationPage';
import { SettingsPage } from './pages/SettingsPage';
import { VersionHistoryPage } from './pages/VersionHistoryPage';
import { ReferencesPage } from './pages/ReferencesPage';
import { UpdateBanner } from './components/UpdateBanner';
import { scoringTripleFirstSequenceTables, sequenceTable } from './engine/setup/sequences';
import { DEFAULT_SETUP_MAIN_TARGET } from './data/rankingRules';
import { usePreferences } from './hooks/usePreferences';
import type { Theme } from './storage/preferences';
import { CHANNEL_BADGE } from './config/releaseChannel';
import './App.css';

type Tab =
  | 'home'
  | 'checkout'
  | 'setup'
  | 'training'
  | 'simulation'
  | 'settings'
  | 'history'
  | 'references';

const TABS: ReadonlyArray<{ id: Tab; label: string; sub: string }> = [
  { id: 'checkout', label: 'CHECKOUT', sub: '2〜170・この3投で上がる' },
  { id: 'setup', label: 'SETUP', sub: '171〜350・次の3投に向けて整える' },
  { id: 'training', label: 'TRAINING', sub: '反復練習で判断を磨く' },
  { id: 'simulation', label: 'SIMULATION', sub: '1ゲーム通して自力でプレイする' },
];

const THEME_COLOR: Record<Theme, string> = {
  dark: '#07111f',
  light: '#edf4fb',
};

function HomePage({ onSelect }: { onSelect: (tab: Tab) => void }) {
  return (
    <div className="home">
      <p className="home__lead">
        01 のアレンジを「答えを覚える」のではなく「判断の規則を身につける」ためのアプリです。
        なぜそのナンバーなのか、外したらどうなるかまで表示します。
      </p>
      <div className="home__modes">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={`home-${tab.id}`}
            onClick={() => onSelect(tab.id)}
          >
            <span className="home__mode-label">{tab.label}</span>
            <span className="home__mode-sub">{tab.sub}</span>
          </button>
        ))}
      </div>
      <ul className="home__points">
        <li>すべての判断は決定論的な rule based engine で、オフラインでも動きます。</li>
        <li>1 投ごとに実際の着弾を入れると、残り本数から候補を再計算します。</li>
        <li>成立するルートを不正解にはせず、推奨度（S / A / B / C）と理由を示します。</li>
      </ul>
      {/*
        トップページの下部・右寄せに、控えめな導線だけを置く。
        固定表示にはしない（盤面へ重ねない / モバイルの操作とセーフエリアを塞がない）。
      */}
      <div className="home__more">
        <button
          type="button"
          className="home__history"
          data-testid="home-version-history"
          onClick={() => onSelect('history')}
        >
          バージョン履歴
        </button>
        <button
          type="button"
          className="home__history"
          data-testid="home-references"
          onClick={() => onSelect('references')}
        >
          参考資料・出典
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [practiceSession, setPracticeSession] = useState(0);
  const { preferences, setTheme } = usePreferences();

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.style.colorScheme = preferences.theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', THEME_COLOR[preferences.theme]);
  }, [preferences.theme]);

  // SETUP の探索表は初回だけ構築コストがかかるため、余裕のあるうちに温めておく。
  useEffect(() => {
    const warm = () => {
      sequenceTable(3, DEFAULT_SETUP_MAIN_TARGET);
      // 第一ターゲット用の表も同じ桁の構築コストがかかる（v1.3.7）。
      scoringTripleFirstSequenceTables(3, DEFAULT_SETUP_MAIN_TARGET);
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(warm, 400);
    return () => window.clearTimeout(handle);
  }, []);

  // バージョン履歴・参考資料のスクロール位置をトップページへ持ち越さない。
  const backToHome = useCallback(() => {
    setTab('home');
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);

  return (
    <div className="app" data-theme={preferences.theme}>
      {/* 更新が待機しているときだけ出る。どの画面でも、いちばん上。 */}
      <UpdateBanner />

      <header className="app__header">
        <button
          type="button"
          className="app__title"
          data-testid="app-title"
          onClick={() => setTab('home')}
        >
          01 Arrangement Support
          <span className="app__channel" data-testid="channel-badge">
            {CHANNEL_BADGE}
          </span>
        </button>
        <button
          type="button"
          className="app__settings"
          data-testid="nav-settings"
          aria-pressed={tab === 'settings'}
          onClick={() => setTab('settings')}
        >
          設定
        </button>
      </header>

      <nav className="app__nav" aria-label="モード">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`nav-${item.id}`}
            aria-pressed={tab === item.id}
            onClick={() => {
              if ((tab === 'checkout' || tab === 'setup') &&
                (item.id === 'checkout' || item.id === 'setup') && tab !== item.id) {
                setPracticeSession((value) => value + 1);
              }
              setTab(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="app__main">
        {tab === 'home' && <HomePage onSelect={setTab} />}
        {(tab === 'checkout' || tab === 'setup') && (
          <PracticePage key={practiceSession} mode={tab} onModeChange={setTab} />
        )}
        {tab === 'training' && <TrainingPage />}
        {tab === 'simulation' && <SimulationPage />}
        {tab === 'settings' && (
          <SettingsPage theme={preferences.theme} onThemeChange={setTheme} />
        )}
        {tab === 'history' && <VersionHistoryPage onBack={backToHome} />}
        {tab === 'references' && <ReferencesPage onBack={backToHome} />}
      </main>

      <footer className="app__footer">
        <p>&copy; 2026 Chihiro Hashimoto</p>
      </footer>
    </div>
  );
}
