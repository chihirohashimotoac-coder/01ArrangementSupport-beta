import './Breadcrumbs.css';

export interface BreadcrumbItem {
  readonly label: string;
  /** 押したときの移動先。無ければ現在地（押せない）。 */
  readonly onSelect?: () => void;
  readonly testId?: string;
}

export interface BreadcrumbsProps {
  readonly items: readonly BreadcrumbItem[];
}

/**
 * パンくずリスト。
 *
 * いまどこにいるか（ホーム › モード › 状況）を 1 行で示し、上の階層へ 1 タップで戻れるようにする。
 * 最後の項目は現在地として `aria-current="page"` を付け、ボタンにしない。
 * 狭い画面であふれたときは横へスクロールさせ、ページ全体の横はみ出しは起こさない。
 */
export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (items.length === 0) return null;
  return (
    <nav className="breadcrumbs" aria-label="現在地" data-testid="breadcrumbs">
      <ol className="breadcrumbs__list">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li
              key={`${index}-${item.label}`}
              className="breadcrumbs__item"
              style={{ animationDelay: `${index * 60}ms` }}
            >
              {last || item.onSelect === undefined ? (
                <span
                  className="breadcrumbs__current"
                  aria-current={last ? 'page' : undefined}
                  data-testid={item.testId}
                >
                  {item.label}
                </span>
              ) : (
                <button
                  type="button"
                  className="breadcrumbs__link"
                  data-testid={item.testId}
                  onClick={item.onSelect}
                >
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
