import { useId, type CSSProperties, type ReactNode } from 'react';
import './RadioGroup.css';

export interface RadioOption<T> {
  readonly value: T;
  readonly label: ReactNode;
  /** ラベルの下に添える一言。 */
  readonly description?: ReactNode;
  readonly testId?: string;
}

export interface RadioGroupProps<T> {
  readonly legend: string;
  readonly options: readonly RadioOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** `segmented` は横並びの溝（選んだものが反転）、`cards` は説明つきの縦積み。 */
  readonly variant?: 'segmented' | 'cards';
  /** 凡例を画面に出さない（読み上げには残す）。 */
  readonly hideLegend?: boolean;
  readonly className?: string;
  readonly testId?: string;
}

/**
 * ラジオボタンの選択肢（ネイティブの `<input type="radio">`）。
 *
 * 1 つだけを選ぶ設定に使う。矢印キーでの移動・読み上げ（「n 個中 m 個目」）は
 * ブラウザ標準の動きにまかせ、見た目だけをセレクタースイッチにそろえる。
 * `value` は文字列化して照合するので、`null` を含む選択肢（「無限」など）も扱える。
 */
export function RadioGroup<T>({
  legend,
  options,
  value,
  onChange,
  variant = 'segmented',
  hideLegend = false,
  className,
  testId,
}: RadioGroupProps<T>) {
  const name = useId();
  const selectedIndex = options.findIndex((option) => String(option.value) === String(value));
  const style = { '--radio-count': options.length, '--radio-index': Math.max(selectedIndex, 0) } as CSSProperties;
  return (
    <fieldset
      className={`radio-group radio-group--${variant}${className ? ` ${className}` : ''}`}
      data-testid={testId}
      data-has-selection={selectedIndex >= 0}
      style={style}
    >
      <legend className={hideLegend ? 'visually-hidden' : 'radio-group__legend'}>{legend}</legend>
      <div className="radio-group__options">
        {variant === 'segmented' && <span className="radio-group__thumb" aria-hidden="true" />}
        {options.map((option) => {
          const checked = String(option.value) === String(value);
          return (
            <label key={String(option.value)} className="radio-group__option" data-checked={checked}>
              <input
                type="radio"
                name={name}
                className="radio-group__input"
                checked={checked}
                data-testid={option.testId}
                onChange={() => onChange(option.value)}
              />
              <span className="radio-group__mark" aria-hidden="true" />
              <span className="radio-group__text">
                <span className="radio-group__label">{option.label}</span>
                {option.description && (
                  <span className="radio-group__description">{option.description}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
