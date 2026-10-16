import { useId, useState, type ReactNode } from 'react';
import './Accordion.css';

export interface AccordionItem {
  readonly id: string;
  readonly title: ReactNode;
  /** 見出しの右に添える短い値（件数・日付など）。 */
  readonly meta?: ReactNode;
  readonly content: ReactNode;
  readonly testId?: string;
}

export interface AccordionProps {
  readonly items: readonly AccordionItem[];
  /** 最初から開いておく項目。 */
  readonly defaultOpenIds?: readonly string[];
  /** 複数を同時に開けるか。false なら 1 つ開くと他は閉じる。 */
  readonly multiple?: boolean;
  /** 見出しのレベル（文書構造に合わせる）。 */
  readonly headingLevel?: 2 | 3 | 4;
  readonly className?: string;
  readonly testId?: string;
  /** 外から開く項目を指定したいとき（プルダウンでの移動など）。 */
  readonly openIds?: readonly string[];
  readonly onOpenIdsChange?: (ids: readonly string[]) => void;
}

/**
 * アコーディオン（WAI-ARIA Accordion Pattern）。
 *
 * 見出しの中のボタンが `aria-expanded` / `aria-controls` で領域と結ばれる。
 * 閉じた領域は高さ 0 へ縮めて `inert` にする（フォーカス・読み上げの対象から外す）。
 * DOM には残すので、ページ内検索や印刷の対象から内容が消えることはない。
 */
export function Accordion({
  items,
  defaultOpenIds = [],
  multiple = true,
  headingLevel = 3,
  className,
  testId,
  openIds: controlledOpenIds,
  onOpenIdsChange,
}: AccordionProps) {
  const baseId = useId();
  const [uncontrolled, setUncontrolled] = useState<readonly string[]>(defaultOpenIds);
  const openIds = controlledOpenIds ?? uncontrolled;
  const Heading = `h${headingLevel}` as const;

  const toggle = (id: string) => {
    const isOpen = openIds.includes(id);
    const next = isOpen
      ? openIds.filter((value) => value !== id)
      : multiple
        ? [...openIds, id]
        : [id];
    if (controlledOpenIds === undefined) setUncontrolled(next);
    onOpenIdsChange?.(next);
  };

  return (
    <div className={`accordion${className ? ` ${className}` : ''}`} data-testid={testId}>
      {items.map((item, index) => {
        const open = openIds.includes(item.id);
        // DOM の id は位置で作る（item.id に空白や記号が入っても IDREF が壊れない）。
        const buttonId = `${baseId}-${index}-button`;
        const panelId = `${baseId}-${index}-panel`;
        return (
          <div
            key={item.id}
            className="accordion__item"
            data-open={open ? 'true' : 'false'}
            data-testid={item.testId}
            data-accordion-id={item.id}
          >
            <Heading className="accordion__heading">
              <button
                type="button"
                id={buttonId}
                className="accordion__trigger"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
              >
                <span className="accordion__title">{item.title}</span>
                {item.meta !== undefined && <span className="accordion__meta">{item.meta}</span>}
                <span className="accordion__chevron" aria-hidden="true" />
              </button>
            </Heading>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              className="accordion__panel"
              inert={!open}
            >
              <div className="accordion__inner">
                <div className="accordion__content">{item.content}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
