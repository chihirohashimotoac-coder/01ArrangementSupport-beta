import { useEffect, useState, type CSSProperties } from 'react';
import { Carousel, type CarouselSlide } from '../components/ui/Carousel';
import { KineticText } from '../components/ui/Kinetic';
import { ScoreMap } from '../components/ui/Infographic';
import { Accordion } from '../components/ui/Accordion';
import { MAX_CHECKOUT, MAX_SETUP_REMAINING } from '../domain/checkoutRules';
import { ROUTE_GRADE_LABEL_JA } from '../data/gradeLabels';
import type { RouteGrade } from '../data/rankingRules';
import { rankCheckoutRoutes } from '../engine/ranking/checkoutRanking';
import './HomePage.css';

export type HomeDestination =
  | 'checkout'
  | 'setup'
  | 'training'
  | 'simulation'
  | 'history'
  | 'references';

export interface HomeMode {
  readonly id: 'checkout' | 'setup' | 'training' | 'simulation';
  readonly label: string;
  readonly scope: string;
  readonly sub: string;
}

export interface HomePageProps {
  readonly modes: readonly HomeMode[];
  readonly onSelect: (destination: HomeDestination) => void;
  /** 例題から、その残り点を入れた状態で CHECKOUT を開く。 */
  readonly onOpenCheckout: (remaining: number) => void;
}

/**
 * 例題に出す残り点（表示の選び方だけで、戦術データではない）。
 * 答えはその場で既存の engine（`rankCheckoutRoutes`）から読み、ここでは何も決めない。
 */
const EXAMPLE_LEFTS: readonly number[] = [MAX_CHECKOUT, 121, 103, 81, 60, 40];

interface ExampleRoute {
  readonly left: number;
  readonly dartIds: readonly string[];
  readonly grade: RouteGrade | null;
}

/** 例題の基準ルートを engine から読む（3 投・既定の設定。CHECKOUT 画面の STANDARD と同じ）。 */
function readExamples(): readonly ExampleRoute[] {
  return EXAMPLE_LEFTS.flatMap((left) => {
    const routes = rankCheckoutRoutes(left, 3);
    const standard = routes.find((route) => route.isStandard) ?? routes[0];
    if (standard === undefined) return [];
    return [{ left, dartIds: standard.darts.map((dart) => dart.id), grade: standard.grade ?? null }];
  });
}

/**
 * 例題は初回表示を遅らせないよう、手が空いたときに読む。
 * 計算は CHECKOUT 画面と同じ engine 関数を呼ぶだけで、結果を書き換えない。
 */
function useIdleExamples() {
  const [examples, setExamples] = useState<readonly ExampleRoute[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) setExamples(readExamples());
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(run, { timeout: 600 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(handle);
      };
    }
    const handle = window.setTimeout(run, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, []);
  return examples;
}

const FAQ = [
  {
    id: 'grade',
    title: '推奨度 S / A / B / C の意味',
    content: (
      <dl className="home__grades">
        {(['S', 'A', 'B', 'C'] as const).map((grade) => (
          <div key={grade} data-tone={grade}>
            <dt>{grade}</dt>
            <dd>{ROUTE_GRADE_LABEL_JA[grade]}</dd>
          </div>
        ))}
      </dl>
    ),
  },
  {
    id: 'recovery',
    title: '外したら、次はどこを狙う？',
    content: (
      <p>
        CHECKOUT / SETUP の画面で「実際の着弾を入力」を開き、刺さった場所を盤面でタップします。
        残り点と残り本数から、次に狙う所をその場で出し直します。
      </p>
    ),
  },
  {
    id: 'my-route',
    title: '得意なダブルを反映したい',
    content: (
      <p>
        メニューの「設定」で得意ダブルを登録すると、MY ROUTE の候補がその上がりを優先します。
        STANDARD（基準ルート）の並びは変わりません。
      </p>
    ),
  },
  {
    id: 'offline',
    title: 'オフラインでも使える？',
    content: (
      <p>
        使えます。すべての判断は端末の中の決定論的な rule based engine で行い、通信を必要としません。
      </p>
    ),
  },
];

export function HomePage({ modes, onSelect, onOpenCheckout }: HomePageProps) {
  const examples = useIdleExamples();

  const slides: CarouselSlide[] = (examples ?? []).map((example) => ({
    id: String(example.left),
    label: `残り ${example.left}`,
    content: (
      <article className="home-example">
        <div className="home-example__left">
          <span className="home-example__caption">LEFT</span>
          <span className="home-example__value">{example.left}</span>
        </div>
        <div className="home-example__route">
          <span className="home-example__caption">STANDARD</span>
          <ol className="home-example__darts" aria-label="基準ルート">
            {example.dartIds.map((dartId, index) => (
              <li key={`${dartId}-${index}`} style={{ '--chip-i': index } as CSSProperties}>
                {dartId}
              </li>
            ))}
          </ol>
          {example.grade && (
            <span className="home-example__grade" data-tone={example.grade}>
              {example.grade}
              <span>{ROUTE_GRADE_LABEL_JA[example.grade]}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          className="home-example__open"
          data-testid={`home-example-open-${example.left}`}
          onClick={() => onOpenCheckout(example.left)}
        >
          {example.left} を CHECKOUT で開く
          <span aria-hidden="true" className="home-example__arrow" />
        </button>
      </article>
    ),
  }));

  return (
    <div className="home">
      <section className="home__hero" aria-labelledby="home-headline">
        <p className="home__eyebrow" aria-hidden="true">
          <span>STEEL DARTS</span>
          <span>01 ARRANGEMENT</span>
        </p>
        <KineticText
          as="h1"
          className="home__headline"
          lines={['答えを覚えるより、', '判断の規則を身につける。']}
          emphasis="判断の規則"
          delay={120}
          testId="home-headline"
        />
        <p className="home__lead">
          01 のアレンジを「答えを覚える」のではなく「判断の規則を身につける」ためのアプリです。
          なぜそのナンバーなのか、外したらどうなるかまで表示します。
        </p>
        {/* ホームの題字の飾り。スコアボードの数字札が並ぶだけの装飾。 */}
        <div className="home__ticker" aria-hidden="true">
          {['501', '321', '170', '40', '0'].map((value, index) => (
            <span key={value} style={{ '--tick-i': index } as CSSProperties}>
              {value}
            </span>
          ))}
        </div>
      </section>

      {/*
        モードの一覧。カードを並べるのではなく、罫線で区切った 1 枚の表として置く。
        右側の数字は、そのモードが扱う範囲（残り点・開始点数）。
      */}
      <div className="home__modes">
        {modes.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            data-testid={`home-${tab.id}`}
            style={{ '--mode-i': index } as CSSProperties}
            onClick={() => onSelect(tab.id)}
          >
            <span className="home__mode-index" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="home__mode-label">{tab.label}</span>
            <span className="home__mode-scope">{tab.scope}</span>
            <span className="home__mode-sub">{tab.sub}</span>
            <span className="home__mode-arrow" aria-hidden="true" />
          </button>
        ))}
      </div>

      <section className="home__section" aria-labelledby="home-examples-title">
        <div className="home__section-head">
          <h2 id="home-examples-title">例題で見る</h2>
          <p>よく出る残り点の基準ルート。スワイプか矢印で切り替え、そのまま CHECKOUT で開けます。</p>
        </div>
        {examples === null ? (
          <div className="home__examples-loading" aria-hidden="true" />
        ) : (
          <Carousel label="例題" slides={slides} autoPlayMs={5200} testId="home-examples" />
        )}
      </section>

      <section className="home__section" aria-labelledby="home-map-title">
        <div className="home__section-head">
          <h2 id="home-map-title">残り点の地図</h2>
          <p>どの残り点を、どのモードで扱うか。</p>
        </div>
        <ScoreMap
          max={MAX_SETUP_REMAINING}
          bands={[
            { key: 'checkout', label: 'CHECKOUT', from: 2, to: MAX_CHECKOUT },
            { key: 'setup', label: 'SETUP', from: MAX_CHECKOUT + 1, to: MAX_SETUP_REMAINING },
            { key: 'training', label: 'TRAINING', from: 2, to: MAX_SETUP_REMAINING },
          ]}
          ticks={[0, 40, 100, MAX_CHECKOUT, 250, MAX_SETUP_REMAINING]}
          caption={`${MAX_CHECKOUT} 以下はこの 3 投で上がりを狙い、${MAX_CHECKOUT + 1} 以上は次の 3 投に向けて整えます。SIMULATION は 301 / 501 / 701 などの開始点から 0 まで通して投げます。`}
        />
      </section>

      <ul className="home__points">
        <li>すべての判断は決定論的な rule based engine で、オフラインでも動きます。</li>
        <li>1 投ごとに実際の着弾を入れると、残り本数から候補を再計算します。</li>
        <li>成立するルートを不正解にはせず、推奨度（S / A / B / C）と理由を示します。</li>
      </ul>

      <section className="home__section" aria-labelledby="home-faq-title">
        <div className="home__section-head">
          <h2 id="home-faq-title">使い方のヒント</h2>
        </div>
        <Accordion items={FAQ} headingLevel={3} multiple={false} testId="home-faq" />
      </section>

      {/*
        トップページの下部に、控えめな導線だけを置く。
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
