import type { CSSProperties, ElementType } from 'react';
import './Kinetic.css';

export interface KineticTextProps {
  /** 1 行ずつの文字列。行ごとに改行して組む。 */
  readonly lines: readonly string[];
  readonly as?: ElementType;
  readonly className?: string;
  /** 最初の文字が動き出すまでの待ち時間（ms）。 */
  readonly delay?: number;
  /** 1 文字ごとの遅れ（ms）。 */
  readonly stagger?: number;
  /** 強調する文字列（その部分だけ反転した札にする）。 */
  readonly emphasis?: string;
  readonly testId?: string;
}

/**
 * キネティックタイポグラフィ（文字が 1 字ずつ下からせり上がる見出し）。
 *
 * 読み上げには分割していない文をそのまま渡し、分割した文字は `aria-hidden` にする
 * （1 字ずつ読み上げられることを防ぐ）。
 */
export function KineticText({
  lines,
  as: Tag = 'p',
  className,
  delay = 0,
  stagger = 34,
  emphasis,
  testId,
}: KineticTextProps) {
  // 行をまたいで通し番号で遅らせる（2 行目は 1 行目の続きから動き出す）。
  const lineOffsets = lines.map((_, index) =>
    lines.slice(0, index).reduce((total, line) => total + Array.from(line).length, 0),
  );
  return (
    <Tag className={`kinetic${className ? ` ${className}` : ''}`} data-testid={testId}>
      <span className="visually-hidden">{lines.join('')}</span>
      <span aria-hidden="true" className="kinetic__lines">
        {lines.map((line, lineIndex) => {
          const emphasisStart = emphasis ? line.indexOf(emphasis) : -1;
          const chars = Array.from(line);
          return (
            <span key={`${lineIndex}-${line}`} className="kinetic__line">
              {chars.map((char, charIndex) => {
                const order = lineOffsets[lineIndex] + charIndex;
                const style = { '--k-delay': `${delay + order * stagger}ms` } as CSSProperties;
                const emphasized =
                  emphasisStart >= 0 &&
                  charIndex >= emphasisStart &&
                  charIndex < emphasisStart + Array.from(emphasis ?? '').length;
                return (
                  <span
                    key={charIndex}
                    className={`kinetic__char${emphasized ? ' kinetic__char--em' : ''}`}
                    style={style}
                  >
                    {char === ' ' ? ' ' : char}
                  </span>
                );
              })}
            </span>
          );
        })}
      </span>
    </Tag>
  );
}

export interface RollingNumberProps {
  readonly value: number | string;
  readonly className?: string;
  readonly testId?: string;
}

/**
 * 値が変わった桁だけが下から転がり込む数字（オドメーター）。
 *
 * テキストは常に最終値そのもの（途中の数字を DOM に出さない）。読み上げ・コピー・
 * テストで読む値は変わらず、見た目だけが動く。
 */
export function RollingNumber({ value, className, testId }: RollingNumberProps) {
  const chars = Array.from(String(value));
  return (
    <span className={`rolling${className ? ` ${className}` : ''}`} data-testid={testId}>
      {chars.map((char, index) => {
        // 右から数えた桁の位置で key を作る。同じ桁で同じ数字なら再生しない。
        const place = chars.length - index;
        return (
          <span key={`${place}-${char}`} className="rolling__digit" style={{ '--r-i': index } as CSSProperties}>
            {char}
          </span>
        );
      })}
    </span>
  );
}
