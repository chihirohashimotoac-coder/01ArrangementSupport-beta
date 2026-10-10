import { useEffect } from 'react';
import {
  NO_EXTERNAL_WEB_SOURCES_NOTE,
  REFERENCE_ORIGIN_LABEL,
  REFERENCE_ROLE_LABEL,
  REFERENCE_ROLE_NOTE,
  REFERENCE_SECTIONS,
  STANDARD_ROUTE_NOTE,
} from '../data/references';
import './ReferencesPage.css';

export interface ReferencesPageProps {
  /** トップページへ戻る。 */
  readonly onBack: () => void;
}

/**
 * 参考資料・出典。
 *
 * 内容は `src/data/references.ts`（リポジトリ・添付資料・PR 履歴の棚卸し結果）。
 * 「実際に参照したことを確認できるもの」だけを載せ、
 * Source of Truth / Reference / Project Documentation を混ぜない。
 */
export function ReferencesPage({ onBack }: ReferencesPageProps) {
  // 直前の画面のスクロール位置を持ち越さず、先頭から読み始められるようにする。
  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);

  return (
    <div className="references">
      <div className="references__bar">
        <button
          type="button"
          className="references__back"
          data-testid="references-back"
          onClick={onBack}
        >
          トップへ戻る
        </button>
      </div>

      <div className="references__head">
        <h2 className="references__title">参考資料・出典</h2>
        <p className="references__lead">
          このアプリのアレンジ判断・ルートデータ・ルール設計が、何をもとにしているかの一覧です。
        </p>
      </div>

      <section className="references__legend" aria-label="表示の見かた">
        <h3 className="references__legend-title">表示の見かた</h3>
        <dl className="references__legend-list">
          {(['source-of-truth', 'reference', 'project-doc'] as const).map((role) => (
            <div key={role} className="references__legend-item">
              <dt>
                <span className={`references__role references__role--${role}`}>
                  {REFERENCE_ROLE_LABEL[role]}
                </span>
              </dt>
              <dd>{REFERENCE_ROLE_NOTE[role]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="references__note" data-testid="references-standard-note">
        <h3 className="references__note-title">基準ルート（Standard Route）について</h3>
        {STANDARD_ROUTE_NOTE.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </section>

      {REFERENCE_SECTIONS.map((section) => (
        <section key={section.heading} className="references__section">
          <h3 className="references__section-title">{section.heading}</h3>
          <p className="references__section-lead">{section.lead}</p>
          <ul className="references__list" data-testid="references-list">
            {section.entries.map((entry) => (
              <li key={entry.title} className="references__item" data-testid="references-item">
                <div className="references__item-head">
                  <span className={`references__role references__role--${entry.role}`}>
                    {REFERENCE_ROLE_LABEL[entry.role]}
                  </span>
                  <span className="references__origin">
                    {REFERENCE_ORIGIN_LABEL[entry.origin]}
                  </span>
                </div>

                <h4 className="references__item-title">{entry.title}</h4>

                {entry.url !== null && (
                  <a
                    className="references__link"
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer external"
                  >
                    {entry.url}
                    <span className="references__link-hint"> （別のタブで開きます）</span>
                  </a>
                )}

                <dl className="references__fields">
                  <div>
                    <dt>参考にしたこと</dt>
                    <dd>{entry.what}</dd>
                  </div>
                  <div>
                    <dt>関係する機能</dt>
                    <dd>{entry.usedFor}</dd>
                  </div>
                  {entry.since !== null && (
                    <div>
                      <dt>参照時期</dt>
                      <dd>{entry.since}</dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="references__footnote" data-testid="references-no-external">
        {NO_EXTERNAL_WEB_SOURCES_NOTE}
      </p>
    </div>
  );
}
