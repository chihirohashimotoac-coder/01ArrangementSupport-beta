import { useId, useState } from 'react';
import type { RouteGrade } from '../data/rankingRules';
import { ROUTE_GRADE_LABEL_JA } from '../data/gradeLabels';
import type { ReasonPolarity } from '../domain/reasonCodes';
import './RouteCard.css';

export interface RouteReasonView {
  readonly code: string;
  readonly polarity: ReasonPolarity;
  readonly label: string;
  readonly summary: string;
  readonly detail: string | null;
}

export interface RouteCardProps {
  /** ルートを構成するセグメント表記。 */
  readonly dartIds: readonly string[];
  readonly grade?: RouteGrade;
  readonly gradeContext?: string;
  /** 見出しのラベル（STANDARD / MY ROUTE など）。 */
  readonly badge?: string;
  readonly isStandard?: boolean;
  readonly reasons: readonly RouteReasonView[];
  /** 人間が書き下ろした説明（あれば要約の先頭に出す）。 */
  readonly curatedExplanation?: string | null;
  /** 補足行（SETUP の「残り 164」など）。 */
  readonly meta?: string | null;
  /** セグメントをタップしたとき（盤面で位置を確認する）。 */
  readonly onDartFocus?: (dartId: string) => void;
  readonly focusedDartId?: string | null;
  readonly defaultOpen?: boolean;
  readonly testId?: string;
  readonly reasonsAlwaysVisible?: boolean;
}

const GRADE_LABEL = ROUTE_GRADE_LABEL_JA;

/**
 * 1 ルートの表示。
 *
 * 理由は「短い要約」→「詳細を開く」の progressive disclosure にする。
 * 長文で画面を埋めない、という UI 方針（31 節）に対応する。
 */
export function RouteCard({
  dartIds,
  grade,
  gradeContext,
  badge,
  isStandard = false,
  reasons,
  curatedExplanation,
  meta,
  onDartFocus,
  focusedDartId,
  defaultOpen = false,
  testId,
  reasonsAlwaysVisible = false,
}: RouteCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();

  const positives = reasons.filter((reason) => reason.polarity === 'positive');
  const negatives = reasons.filter((reason) => reason.polarity === 'negative');
  const headline = curatedExplanation ?? negatives[0]?.summary ?? positives[0]?.summary ?? null;
  const isPrimary = badge === 'STANDARD' || badge === 'BEST';
  const isPersonal = badge === 'MY ROUTE';

  return (
    <article
      className={`route-card${isStandard ? ' route-card--standard' : ''}${isPrimary ? ' route-card--primary' : ''}${isPersonal ? ' route-card--personal' : ''}`}
      data-testid={testId}
      data-grade={grade}
    >
      <header className="route-card__header">
        {badge && <span className="route-card__badge">{badge}</span>}
        {grade && (
          <span className="route-card__grade-group">
            {gradeContext && <span className="route-card__grade-context">基準評価</span>}
            <span className={`route-card__grade route-card__grade--${grade}`}>
              <span aria-hidden="true">{grade}</span>
              <span className="visually-hidden">{`${gradeContext ? '基準評価' : '推奨度'} ${grade}: ${GRADE_LABEL[grade]}`}</span>
            </span>
          </span>
        )}
      </header>

      <ol className="route-card__darts" aria-label="ルート">
        {dartIds.map((dartId, index) => (
          <li key={`${dartId}-${index}`}>
            <button
              type="button"
              className="route-card__dart"
              data-dart={dartId}
              data-active={focusedDartId === dartId ? 'true' : undefined}
              onClick={() => onDartFocus?.(dartId)}
              aria-label={`${index + 1} 投目 ${dartId}。盤面で位置を確認する`}
            >
              {dartId}
            </button>
          </li>
        ))}
      </ol>

      {meta && <p className="route-card__meta">{meta}</p>}

      {headline && !reasonsAlwaysVisible && (
        <p className="route-card__headline" data-testid={testId ? `${testId}-headline` : undefined}>
          {headline}
        </p>
      )}

      {reasons.length > 0 && !reasonsAlwaysVisible && (
        <>
          <button
            type="button"
            className="route-card__toggle"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '理由を閉じる' : '理由を見る'}
          </button>
          <div id={detailsId} className="route-card__reasons" hidden={!open}>
            <ul>
              {reasons.map((reason) => (
                <li key={reason.code} data-polarity={reason.polarity} data-code={reason.code}>
                  <span className="route-card__reason-label">{reason.label}</span>
                  <span className="route-card__reason-summary">{reason.summary}</span>
                  {reason.detail && (
                    <span className="route-card__reason-detail">{reason.detail}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      {reasonsAlwaysVisible && reasons.length > 0 && (
        <ul className="route-card__reasons-inline">
          {reasons.map((reason) => (
            <li key={reason.code} data-code={reason.code}>{reason.summary}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
