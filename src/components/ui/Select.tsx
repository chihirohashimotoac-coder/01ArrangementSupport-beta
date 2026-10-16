import { useId } from 'react';
import './Select.css';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  /** ラベルの下に添える補足。 */
  readonly hint?: string;
  readonly testId?: string;
  readonly className?: string;
}

/**
 * プルダウンメニュー。
 *
 * スマートフォンでは OS 標準の選択 UI（ホイール / シート）が最も速く確実なので、
 * ネイティブの `<select>` をそのまま使い、枠と山形の見た目だけをそろえる。
 */
export function Select({ label, value, options, onChange, hint, testId, className }: SelectProps) {
  const id = useId();
  return (
    <div className={`select${className ? ` ${className}` : ''}`}>
      <label className="select__label" htmlFor={id}>
        {label}
      </label>
      <div className="select__control">
        <select
          id={id}
          className="select__native"
          value={value}
          data-testid={testId}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="select__chevron" aria-hidden="true" />
      </div>
      {hint && (
        <p className="select__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
