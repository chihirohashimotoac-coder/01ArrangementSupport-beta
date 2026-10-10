import './StatusBar.css';

export interface StatusBarProps {
  readonly remaining: number | null;
  readonly dartsLeft: number;
  /** 状況の見出し（BUST / CHECKOUT など）。 */
  readonly status?: 'in-progress' | 'checkout' | 'bust';
  /** 補足メッセージ。 */
  readonly note?: string | null;
  readonly tone?: 'default' | 'warn' | 'good';
}

const STATUS_LABEL = {
  'in-progress': null,
  checkout: 'CHECKOUT!',
  bust: 'BUST',
} as const;

/** 残り点と残り本数を、離れていても読める大きさで示すヘッダー。 */
export function StatusBar({
  remaining,
  dartsLeft,
  status = 'in-progress',
  note,
  tone = 'default',
}: StatusBarProps) {
  const statusLabel = STATUS_LABEL[status];
  return (
    <div className={`status-bar status-bar--${tone}`} data-testid="status-bar" data-status={status}>
      <div className="status-bar__main">
        <div className="status-bar__left">
          <span className="status-bar__caption">LEFT</span>
          <span className="status-bar__value" data-testid="status-left">
            {remaining ?? '—'}
          </span>
        </div>
        <div className="status-bar__darts">
          <span className="status-bar__caption">DARTS</span>
          <span className="status-bar__value status-bar__value--small" data-testid="status-darts">
            {dartsLeft}
          </span>
          <span className="status-bar__pips" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <span key={index} data-filled={index < dartsLeft ? 'true' : undefined} />
            ))}
          </span>
        </div>
      </div>
      {statusLabel && (
        <p className="status-bar__status" data-testid="status-flag">
          {statusLabel}
        </p>
      )}
      {note && (
        <p className="status-bar__note" data-testid="status-note">
          {note}
        </p>
      )}
    </div>
  );
}
