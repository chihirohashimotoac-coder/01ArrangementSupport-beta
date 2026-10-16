import type { CSSProperties, ReactNode } from 'react';
import { useInView } from './motion';
import './Infographic.css';

/**
 * インフォグラフィック（表示専用）。
 *
 * 数値はすべて呼び出し側が持つ確定値を受け取り、ここでは図に変換するだけ。
 * 図は `aria-hidden` にし、同じ数値は必ず文字でも画面に置く（色・長さだけで伝えない）。
 * 画面に入ったときに一度だけ伸びる（`useInView`）。
 */

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0);

export interface RingGaugeProps {
  /** 0〜1。 */
  readonly value: number;
  /** 輪の中央に置く内容（数字など）。 */
  readonly children?: ReactNode;
  readonly caption?: string;
  readonly testId?: string;
}

/** 円環のゲージ。輪が 0 から値まで描かれていく。 */
export function RingGauge({ value, children, caption, testId }: RingGaugeProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const ratio = clamp01(value);
  return (
    <div
      ref={ref}
      className="ring-gauge"
      data-inview={inView ? 'true' : 'false'}
      data-empty={ratio === 0 ? 'true' : undefined}
      data-testid={testId}
      style={{ '--ring-value': ratio } as CSSProperties}
    >
      <svg viewBox="0 0 120 120" aria-hidden="true" className="ring-gauge__svg">
        <circle className="ring-gauge__track" cx="60" cy="60" r="52" pathLength={100} />
        {/* 目盛り（10% ごと）。計器の文字盤として置く。 */}
        {Array.from({ length: 10 }, (_, index) => (
          <line
            key={index}
            className="ring-gauge__tick"
            x1="60"
            y1="2"
            x2="60"
            y2="7"
            transform={`rotate(${index * 36} 60 60)`}
          />
        ))}
        <circle className="ring-gauge__value" cx="60" cy="60" r="52" pathLength={100} />
      </svg>
      <div className="ring-gauge__center">
        {children}
        {caption && <span className="ring-gauge__caption">{caption}</span>}
      </div>
    </div>
  );
}

export interface MeterProps {
  /** 0〜1。 */
  readonly value: number;
  /** 何番目の行か（伸び始めを少しずつずらす）。 */
  readonly index?: number;
  readonly tone?: 'default' | 'good' | 'warn' | 'bad';
}

/** 表の中に置く細い横棒。 */
export function Meter({ value, index = 0, tone = 'default' }: MeterProps) {
  return (
    <span
      className="meter"
      data-tone={tone}
      aria-hidden="true"
      style={{ '--meter-value': clamp01(value), '--meter-i': index } as CSSProperties}
    >
      <span className="meter__fill" />
    </span>
  );
}

export interface StackedBarSegment {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: string;
}

export interface StackedBarProps {
  readonly segments: readonly StackedBarSegment[];
  /** 凡例（項目名・件数・割合）を出すか。同じ件数を別の一覧で出している画面では false。 */
  readonly legend?: boolean;
  readonly testId?: string;
}

/** 内訳の帯（合計を 100% とした積み上げ）。凡例に件数を文字で添える。 */
export function StackedBar({ segments, legend = true, testId }: StackedBarProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return null;
  const visible = segments.filter((segment) => segment.count > 0);
  return (
    <div ref={ref} className="stacked-bar" data-inview={inView ? 'true' : 'false'} data-testid={testId}>
      <div className="stacked-bar__track" aria-hidden="true">
        {visible.map((segment, index) => (
          <span
            key={segment.key}
            className="stacked-bar__segment"
            data-tone={segment.tone}
            style={{ '--seg-share': segment.count / total, '--seg-i': index } as CSSProperties}
          />
        ))}
      </div>
      {legend && (
        <ul className="stacked-bar__legend">
          {segments.map((segment) => (
            <li key={segment.key} data-tone={segment.tone} data-empty={segment.count === 0 ? 'true' : undefined}>
              <span className="stacked-bar__swatch" aria-hidden="true" />
              <span className="stacked-bar__label">{segment.label}</span>
              <span className="stacked-bar__count">{segment.count}</span>
              <span className="stacked-bar__share">{Math.round((segment.count / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ScoreBand {
  readonly key: string;
  readonly label: string;
  readonly from: number;
  readonly to: number;
}

export interface ScoreMapProps {
  readonly max: number;
  readonly bands: readonly ScoreBand[];
  readonly ticks: readonly number[];
  readonly caption?: string;
}

/**
 * 残り点の地図。0〜max の数直線に、各モードが扱う範囲の帯を重ねる。
 * 帯は左から順に伸び、目盛りの数字が後から現れる。
 */
export function ScoreMap({ max, bands, ticks, caption }: ScoreMapProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const at = (value: number) => `${(value / max) * 100}%`;
  return (
    <figure ref={ref} className="score-map" data-inview={inView ? 'true' : 'false'} data-testid="score-map">
      <div className="score-map__bands">
        {bands.map((band, index) => (
          <div
            key={band.key}
            className="score-map__band"
            data-band={band.key}
            style={
              {
                '--band-left': at(band.from),
                '--band-width': at(band.to - band.from),
                '--band-i': index,
              } as CSSProperties
            }
          >
            <span className="score-map__band-bar" aria-hidden="true" />
            <span className="score-map__band-label">
              <strong>{band.label}</strong>
              <span>
                {band.from}–{band.to}
              </span>
            </span>
          </div>
        ))}
      </div>
      <div className="score-map__axis" aria-hidden="true">
        {ticks.map((tick, index) => (
          <span
            key={tick}
            className="score-map__tick"
            style={{ '--tick-left': at(tick), '--tick-i': index } as CSSProperties}
          >
            {tick}
          </span>
        ))}
      </div>
      {caption && <figcaption className="score-map__caption">{caption}</figcaption>}
    </figure>
  );
}
