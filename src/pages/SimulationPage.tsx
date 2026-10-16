import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dartboard, type BoardMarker } from '../components/Dartboard';
import { StatusBar } from '../components/StatusBar';
import { StackedBar } from '../components/ui/Infographic';
import { KineticText } from '../components/ui/Kinetic';
import { ConfirmDialog } from '../components/ui/Modal';
import { toDisplayPoint } from '../engine/simulation/boardGeometry';
import { MAX_PPR } from '../engine/simulation/accuracy';
import {
  AVERAGE_HELP_JA,
  DIRECTION_CRITERION_JA,
  DIRECTION_GUIDE,
  FIRST9_HELP_JA,
  MAX_MISS_CRITERION_JA,
  MAX_MISS_GUIDE,
  PPR_GUIDE_ROWS,
  SETTINGS_HELP_SUMMARY_JA,
} from '../engine/simulation/settingsGuide';
import {
  MAX_START_SCORE,
  MIN_START_SCORE,
  PRESET_START_SCORES,
  advanceRound,
  canUndo,
  createGame,
  dartsLeftInRound,
  describeThrow,
  hasWrongEntry,
  needsScoreEntry,
  submitScore,
  throwAt,
  totalDarts,
  undoLastThrow,
  type SimulationGame,
  type ThrowRecord,
} from '../engine/simulation/game';
import { REVIEW_GLOSSARY_JA } from '../engine/simulation/reviewGlossary';
import {
  IMPROVEMENT_PRIORITY,
  buildReviewHighlights,
  dartsLeftBefore,
  describeGameResultJa,
  suggestionsOf,
  type FocusSuggestions,
  type ThrowFocus,
} from '../engine/simulation/reviewHighlights';
import { createGameSeed } from '../engine/simulation/throwSimulator';
import {
  THROW_VERDICT_HINT_JA,
  THROW_VERDICT_JA,
  THROW_VERDICTS,
  buildGameReview,
  type ThrowVerdict,
} from '../engine/simulation/review';
import {
  loadSimulationPreferences,
  saveSimulationPreferences,
  type SimulationPreferences,
} from '../storage/simulationSettings';
import { usePreferences } from '../hooks/usePreferences';
import './SimulationPage.css';


/** 判断の分類ごとの見た目（既存の推奨度バッジと同じ配色体系に合わせる）。 */
const VERDICT_TONE: Readonly<Record<ThrowVerdict, 'good' | 'warn' | 'bad' | 'plain'>> = {
  GOOD_DECISION: 'good',
  BETTER_OPTION_AVAILABLE: 'warn',
  ARRANGEMENT_MISTAKE: 'bad',
  SETUP_MISTAKE: 'bad',
  BOGEY_CREATED: 'bad',
  SCORING_PHASE: 'plain',
  NOT_EVALUATED: 'plain',
};

type StartMode = 'preset' | 'custom';

function pprLabel(value: number): string {
  return value.toFixed(0);
}

export interface SimulationPageProps {
  /** パンくずリストへ、いまの状況（「501 ゲーム中」「振り返り」）を知らせる。表示専用。 */
  readonly onContextChange?: (label: string | null) => void;
}

export function SimulationPage({ onContextChange }: SimulationPageProps = {}) {
  const { preferences } = usePreferences();
  const [form, setForm] = useState<SimulationPreferences>(() => loadSimulationPreferences());
  const [startMode, setStartMode] = useState<StartMode>(() =>
    PRESET_START_SCORES.includes(loadSimulationPreferences().startScore) ? 'preset' : 'custom',
  );
  const [customDraft, setCustomDraft] = useState(() =>
    String(loadSimulationPreferences().startScore),
  );
  const [game, setGame] = useState<SimulationGame | null>(null);
  const [scoreDraft, setScoreDraft] = useState('');
  /** 「中断する」の確認ダイアログ。押し間違いで進行中のゲームを失わないため。 */
  const [confirmQuit, setConfirmQuit] = useState(false);

  const contextLabel =
    game === null ? null : game.phase === 'finished' ? '振り返り' : `${game.settings.startScore} ゲーム中`;
  useEffect(() => {
    onContextChange?.(contextLabel);
  }, [contextLabel, onContextChange]);
  useEffect(() => () => onContextChange?.(null), [onContextChange]);

  // 設定は入力のたびに端末へ保存し、次回の SIMULATION へ引き継ぐ。
  useEffect(() => {
    saveSimulationPreferences(form);
  }, [form]);

  const start = useCallback(() => {
    setGame(
      createGame(
        {
          startScore: form.startScore,
          first9Ppr: form.first9Ppr,
          averagePpr: form.averagePpr,
          missDirection: form.missDirection,
          maxMiss: form.maxMiss,
        },
        createGameSeed(),
      ),
    );
    setScoreDraft('');
  }, [form]);

  /** 終わったゲームと同じ設定で、新しい seed のゲームを始める（別の着弾列になる）。 */
  const retry = useCallback(() => {
    if (game === null) return;
    setGame(createGame(game.settings, createGameSeed()));
    setScoreDraft('');
  }, [game]);

  const round = game?.current ?? null;
  const entry = round?.entry ?? null;
  const awaitingEntry = game?.phase === 'score-entry' && needsScoreEntry(round);
  const wrongEntry = hasWrongEntry(round);
  /** 「次のラウンドへ」を出す状態（Enter でも進めるようにフォーカスする）。 */
  const readyForNext = game?.phase === 'score-entry' && round !== null && !needsScoreEntry(round);

  /*
   * 画面上部の LEFT は **ビジット開始時の残りで固定**する。
   *
   * 投げるたびに減らすと、残り点の暗算をアプリが肩代わりしてしまう。
   * 残りを自分で数えるところまでが SIMULATION の練習なので、表示は
   * 「次のビジットへ進んだとき」だけ新しい値へ変える。
   *
   * これは **表示だけ**の仕様。内部の残り（`ThrowRecord.leftAfter` /
   * `currentLeft`）は従来どおり 1 投ごとに更新していて、BUST・Checkout・
   * Double Out・履歴・GAME REVIEW はすべてそちらを見ている。
   */
  const displayLeft = game === null ? form.startScore : (round?.leftBefore ?? game.left);
  /** このビジットの直前の 1 投（盤面の直後に狙いと着弾を出す）。 */
  const lastThrow = round === null ? null : (round.throws[round.throws.length - 1] ?? null);

  const markers = useMemo<readonly BoardMarker[]>(() => {
    if (round === null || round.throws.length === 0) return [];
    const list: BoardMarker[] = [];
    round.throws.forEach((record, index) => {
      const isLast = index === round.throws.length - 1;
      const hit = toDisplayPoint(record.actualPoint);
      if (isLast) {
        const aim = toDisplayPoint(record.intendedPoint);
        const described = describeThrow(record);
        list.push({
          id: `aim-${record.dartIndex}`,
          x: aim.x,
          y: aim.y,
          kind: 'aim',
          label: `狙い ${described.intended}`,
        });
        list.push({
          id: `hit-${record.dartIndex}`,
          x: hit.x,
          y: hit.y,
          kind: 'hit',
          label: `着弾 ${described.actual}`,
        });
        return;
      }
      list.push({ id: `hit-${record.dartIndex}`, x: hit.x, y: hit.y, kind: 'past' });
    });
    return list;
  }, [round]);

  /** 振り返りの判定へ渡すユーザー設定（得意ダブル・SETUP の主目標）。 */
  const reviewOptions = useMemo(
    () => ({
      preferredDoubles: preferences.preferredDoubles,
      mainTarget: preferences.setupMainTarget,
    }),
    [preferences.preferredDoubles, preferences.setupMainTarget],
  );

  const review = useMemo(() => {
    if (game === null || game.phase !== 'finished') return null;
    return buildGameReview(game, reviewOptions);
  }, [game, reviewOptions]);

  const highlights = useMemo(
    () => (review === null ? null : buildReviewHighlights(review)),
    [review],
  );

  /*
   * 3 投目が確定した瞬間に、得点入力欄へ自動でフォーカスする。
   *
   * - PC: そのまま数字キーを打って Enter で確定できる（欄を押す必要がない）。
   * - スマホ / タブレット: `inputMode="numeric"` の欄にフォーカスが移るので、
   *   数字キーボードがそのまま開く。
   *
   * `useLayoutEffect` を使うのは、盤面のタップという **ユーザー操作と同じ処理の
   * 流れの中で** focus を呼ぶため。描画が終わったあとの非同期処理から呼ぶと、
   * iOS Safari はソフトウェアキーボードを開いてくれない。
   *
   * `preventScroll` を付けて、フォーカスによる自動スクロールで盤面が飛ぶのを
   * 防ぐ。そのうえで入力欄が画面外にあるときだけ `block: 'nearest'` で最小限
   * 動かす（見えているときは何も起きない）。スマホでキーボードが せり上がる
   * ぶんの調整は、ブラウザ側が従来どおり面倒を見る。
   */
  const scoreInputRef = useRef<HTMLInputElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const entryRef = useRef<HTMLElement>(null);

  /** 間違えた回数。ここが増えたら入力欄へフォーカスを戻す。 */
  const wrongCount = round?.wrongEntries.length ?? 0;

  useLayoutEffect(() => {
    if (!awaitingEntry) return;
    const input = scoreInputRef.current;
    if (input === null) return;
    input.focus({ preventScroll: true });
    entryRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [awaitingEntry, wrongCount]);

  /*
   * 「次のラウンドへ」もキーボードだけで進めるようにする。
   * ボタンへフォーカスを当てておけば、Enter / Space がそのまま押下になる
   * （独自のキー処理を足さずに済み、読み上げの操作とも食い違わない）。
   */
  useLayoutEffect(() => {
    if (!readyForNext) return;
    nextButtonRef.current?.focus({ preventScroll: true });
    entryRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [readyForNext]);

  const handleSubmitScore = () => {
    if (game === null) return;
    const parsed = Number(scoreDraft.trim());
    if (!/^\d+$/.test(scoreDraft.trim()) || !Number.isInteger(parsed)) return;
    setGame(submitScore(game, parsed));
    // 間違っていたら打ち直してもらうので、いずれにせよ欄は空にする。
    setScoreDraft('');
  };

  const next = () => {
    if (game === null) return;
    setGame(advanceRound(game));
    setScoreDraft('');
  };

  return (
    <div className="simulation">
      {game === null && (
        <section className="simulation__settings" aria-label="SIMULATION の設定">
          <p className="simulation__lead">
            301 / 501 / 701 を、1 投ずつ自分で狙って上がりきるモードです。
            ゲーム中はアレンジの答えを一切出しません。3 投ごとの得点も自分で暗算して入力します。
            終わってから、狙いの良し悪しをまとめて振り返ります。
          </p>

          <fieldset className="simulation__field">
            <legend>開始点数</legend>
            <div className="simulation__choices">
              {PRESET_START_SCORES.map((score) => (
                <button
                  key={score}
                  type="button"
                  data-testid={`sim-start-${score}`}
                  aria-pressed={startMode === 'preset' && form.startScore === score}
                  onClick={() => {
                    setStartMode('preset');
                    setForm((value) => ({ ...value, startScore: score }));
                    setCustomDraft(String(score));
                  }}
                >
                  {score}
                </button>
              ))}
              <button
                type="button"
                data-testid="sim-start-custom"
                aria-pressed={startMode === 'custom'}
                onClick={() => setStartMode('custom')}
              >
                CUSTOM
              </button>
            </div>
            {startMode === 'custom' && (
              <label className="simulation__custom">
                <span>任意の開始点数（{MIN_START_SCORE}〜{MAX_START_SCORE}）</span>
                {/*
                  入力途中の値をそのまま持つ（1 文字ごとに丸めない）。
                  打っている最中に "1" を下限の "2" へ丸めてしまうと、
                  そこから先の桁がすべてずれる。範囲へ収めるのは入力を終えたとき。
                */}
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  autoComplete="off"
                  data-testid="sim-start-custom-input"
                  value={customDraft}
                  onChange={(event) => {
                    const raw = event.target.value.replace(/\D/g, '').slice(0, 4);
                    setCustomDraft(raw);
                    const parsed = Number(raw);
                    if (raw !== '' && parsed >= MIN_START_SCORE && parsed <= MAX_START_SCORE) {
                      setForm((value) => ({ ...value, startScore: parsed }));
                    }
                  }}
                  onBlur={() => setCustomDraft(String(form.startScore))}
                />
              </label>
            )}
          </fieldset>

          <fieldset className="simulation__field">
            <legend>プレイヤー能力（501 基準の実戦 PPR）</legend>
            <label className="simulation__slider">
              <span>
                FIRST 9 PPR
                <strong data-testid="sim-first9-value">{pprLabel(form.first9Ppr)}</strong>
              </span>
              <input
                type="range"
                min={0}
                max={MAX_PPR}
                step={1}
                data-testid="sim-first9"
                value={form.first9Ppr}
                onChange={(event) =>
                  setForm((value) => ({ ...value, first9Ppr: Number(event.target.value) }))
                }
              />
            </label>
            <label className="simulation__slider">
              <span>
                AVERAGE PPR
                <strong data-testid="sim-average-value">{pprLabel(form.averagePpr)}</strong>
              </span>
              <input
                type="range"
                min={0}
                max={MAX_PPR}
                step={1}
                data-testid="sim-average"
                value={form.averagePpr}
                onChange={(event) =>
                  setForm((value) => ({ ...value, averagePpr: Number(event.target.value) }))
                }
              />
            </label>
            <p className="simulation__hint">
              501 を 9 ダーツで上がると 501 ÷ 9 × 3 = {MAX_PPR} なので、上限は {MAX_PPR} です。
              AVERAGE を {MAX_PPR} にしたときだけ、狙った的へ 100% 入ります。
              開始点数を変えても、この設定の意味は 501 基準のままです。
            </p>
            <details className="simulation__help" data-testid="sim-help-ppr">
              <summary>{SETTINGS_HELP_SUMMARY_JA}</summary>
              <dl className="simulation__help-list">
                <dt>{FIRST9_HELP_JA.title}</dt>
                <dd>
                  {FIRST9_HELP_JA.meaning}
                  {FIRST9_HELP_JA.detail}
                </dd>
                <dt>{AVERAGE_HELP_JA.title}</dt>
                <dd>
                  {AVERAGE_HELP_JA.meaning}
                  {AVERAGE_HELP_JA.detail}
                </dd>
              </dl>
              <p className="simulation__help-criterion">
                <strong>設定目安</strong>: ふだん 501 が何投で終わるかで選びます
                （PPR = 501 ÷ 投数 × 3）。
              </p>
              <ul className="simulation__help-rows" data-testid="sim-help-ppr-rows">
                {PPR_GUIDE_ROWS.map((row) => (
                  <li key={row.ppr}>
                    <strong>{row.ppr}</strong>
                    <span>501 を約 {row.darts} 投</span>
                  </li>
                ))}
              </ul>
            </details>
          </fieldset>

          <fieldset className="simulation__field">
            <legend>ブレ方向</legend>
            <div className="simulation__choices">
              {DIRECTION_GUIDE.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`sim-direction-${option.value}`}
                  aria-pressed={form.missDirection === option.value}
                  onClick={() => setForm((value) => ({ ...value, missDirection: option.value }))}
                >
                  <span>{option.label}</span>
                  <small>{option.hint}</small>
                </button>
              ))}
            </div>
            <details className="simulation__help" data-testid="sim-help-direction">
              <summary>{SETTINGS_HELP_SUMMARY_JA}</summary>
              <dl className="simulation__help-list">
                {DIRECTION_GUIDE.map((option) => (
                  <Fragment key={option.value}>
                    <dt>{option.label}</dt>
                    <dd>{option.detail}</dd>
                  </Fragment>
                ))}
              </dl>
              <p className="simulation__help-criterion">
                <strong>設定目安</strong>: {DIRECTION_CRITERION_JA}
              </p>
            </details>
          </fieldset>

          <fieldset className="simulation__field">
            <legend>最大ブレ</legend>
            <div className="simulation__choices">
              {MAX_MISS_GUIDE.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`sim-maxmiss-${option.value}`}
                  aria-pressed={form.maxMiss === option.value}
                  onClick={() => setForm((value) => ({ ...value, maxMiss: option.value }))}
                >
                  <span>{option.label}</span>
                  <small>{option.hint}</small>
                </button>
              ))}
            </div>
            <details className="simulation__help" data-testid="sim-help-maxmiss">
              <summary>{SETTINGS_HELP_SUMMARY_JA}</summary>
              <dl className="simulation__help-list">
                {MAX_MISS_GUIDE.map((option) => (
                  <Fragment key={option.value}>
                    <dt>{option.label}</dt>
                    <dd>{option.detail}</dd>
                  </Fragment>
                ))}
              </dl>
              <p className="simulation__help-criterion">
                <strong>設定目安</strong>: {MAX_MISS_CRITERION_JA}
              </p>
            </details>
          </fieldset>

          <button
            type="button"
            className="simulation__start"
            data-testid="start-simulation"
            onClick={start}
          >
            {form.startScore} で始める
          </button>
        </section>
      )}

      {game !== null && game.phase !== 'finished' && round !== null && (
        <section className="simulation__play" aria-label="SIMULATION プレイ中">
          <StatusBar
            remaining={displayLeft}
            dartsLeft={dartsLeftInRound(round)}
            status={round.bust ? 'bust' : round.checkout ? 'checkout' : 'in-progress'}
            note={
              round.bust
                ? 'このラウンドは無効です。残り点はラウンド開始時へ戻ります。'
                : round.checkout
                  ? '上がりました。'
                  : null
            }
          />

          <p className="simulation__progress" data-testid="sim-progress">
            ROUND {round.round} ／ DART {Math.min(round.throws.length + 1, 3)} of 3 ／ 通算{' '}
            {totalDarts(game)} 投
          </p>

          {/*
            盤面と「直前の 1 投」「1投戻す」を 1 つの塊にする。
            押し間違えたとき、スマホ縦画面でも視線と指を大きく動かさずに直せるよう、
            取り消しは盤面の直後の決まった位置へ置く（投擲の一覧より前）。
          */}
          <div className="simulation__board-area">
            <Dartboard
              onSelect={(segment) => {
                if (game.phase !== 'aiming') return;
                setGame(throwAt(game, segment.id));
              }}
              markers={markers}
              disabled={game.phase !== 'aiming'}
              disabledReason={
                awaitingEntry ? '3 投の合計を入力してください。' : 'このラウンドは終わりました。'
              }
              ariaLabel="ダーツボード。狙う場所をタップすると、その狙いに対する着弾が決まります。"
            />

            <div className="simulation__last" data-testid="sim-last-bar">
              <p className="simulation__last-throw" data-testid="sim-last-throw" aria-live="polite">
                {lastThrow === null ? (
                  <span className="simulation__last-empty">
                    盤面をタップして {round.throws.length + 1} 投目の狙いを決めます。外周の MISS 部分は狙えません。
                  </span>
                ) : (
                  <>
                    <span className="simulation__last-caption">直前 {lastThrow.dartNumber}投目</span>
                    <span className="simulation__last-aim">狙い {describeThrow(lastThrow).intended}</span>
                    <span className="simulation__last-hit">着弾 {describeThrow(lastThrow).actual}</span>
                  </>
                )}
              </p>
              <button
                type="button"
                className="simulation__undo"
                data-testid="sim-undo"
                aria-label="直前の 1 投を取り消す"
                disabled={!canUndo(game)}
                onClick={() => setGame(undoLastThrow(game))}
              >
                1投戻す
              </button>
            </div>
          </div>

          <ol className="simulation__throws" aria-label="このラウンドの投擲">
            {round.throws.map((record) => (
              <ThrowRow key={record.dartIndex} record={record} />
            ))}
          </ol>

          <div className="simulation__actions">
            <button
              type="button"
              className="simulation__quit"
              data-testid="sim-quit"
              onClick={() => setConfirmQuit(true)}
            >
              中断する
            </button>
          </div>

          <ConfirmDialog
            open={confirmQuit}
            title="ゲームを中断しますか？"
            confirmLabel="中断する"
            cancelLabel="続ける"
            tone="danger"
            testId="confirm-quit"
            onCancel={() => setConfirmQuit(false)}
            onConfirm={() => {
              setConfirmQuit(false);
              setGame(null);
              setScoreDraft('');
            }}
          >
            <p>ここまでの投球は振り返りに残らず、設定の画面へ戻ります。</p>
          </ConfirmDialog>

          {game.phase === 'score-entry' && (
            <section
              className="simulation__entry"
              data-testid="sim-entry"
              aria-live="polite"
              ref={entryRef}
            >
              {round.bust ? (
                <>
                  <p className="simulation__entry-title">BUST</p>
                  <p className="simulation__entry-note">
                    {bustNoteJa(round.bustReason)}
                    このラウンドは 0 点です。残り {round.leftBefore} へ戻ります。
                  </p>
                  <p className="simulation__entry-undo" data-testid="sim-entry-undo-hint">
                    狙いを押し間違えていたら、次へ進む前に盤面の下の「1投戻す」で直せます。
                  </p>
                  <button
                    ref={nextButtonRef}
                    type="button"
                    data-testid="sim-next-round"
                    onClick={next}
                  >
                    次のラウンドへ
                  </button>
                </>
              ) : entry === null ? (
                <>
                  {wrongEntry ? (
                    <>
                      <p
                        className="simulation__entry-title simulation__entry-title--ng"
                        data-testid="sim-entry-verdict"
                      >
                        計算ミス
                      </p>
                      <p className="simulation__entry-note" data-testid="sim-entry-detail">
                        計算が間違っています。もう一度、この {round.throws.length} 投の合計を
                        計算してください（入力 {round.wrongEntries.join(' / ')}）。
                        正しい合計を入れるまで次のラウンドへは進みません。
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="simulation__entry-title">
                        この {round.throws.length} 投の合計は？
                      </p>
                      <p className="simulation__entry-note">
                        自分で暗算して入力してください。正しい得点はまだ出しません。
                      </p>
                    </>
                  )}
                  <div className="simulation__entry-field">
                    <input
                      ref={scoreInputRef}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={3}
                      autoComplete="off"
                      enterKeyHint="done"
                      data-testid="sim-score-input"
                      aria-label="この 3 投の合計得点"
                      value={scoreDraft}
                      onChange={(event) => setScoreDraft(event.target.value.replace(/\D/g, ''))}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        handleSubmitScore();
                      }}
                    />
                    <button
                      type="button"
                      data-testid="sim-score-submit"
                      disabled={scoreDraft.trim() === ''}
                      onClick={handleSubmitScore}
                    >
                      確定
                    </button>
                  </div>
                  <p className="simulation__entry-undo" data-testid="sim-entry-undo-hint">
                    狙いを押し間違えていたら、確定する前に盤面の下の「1投戻す」で直せます。
                    合計を確定したあとは戻せません。
                  </p>
                </>
              ) : (
                <>
                  <p
                    className="simulation__entry-title simulation__entry-title--ok"
                    data-testid="sim-entry-verdict"
                  >
                    正解
                  </p>
                  <p className="simulation__entry-note" data-testid="sim-entry-detail">
                    {entry.actual} 点。残り {round.leftBefore - entry.actual} です。
                    {entry.miss &&
                      `（計算ミス ${entry.wrongEntries.length} 回: ${entry.wrongEntries.join(' / ')}）`}
                  </p>
                  {/* Enter / Space でそのまま進めるよう、自動でフォーカスを当てている。 */}
                  <button
                    ref={nextButtonRef}
                    type="button"
                    data-testid="sim-next-round"
                    onClick={next}
                  >
                    {round.checkout ? 'ゲームを終える' : '次のラウンドへ'}
                  </button>
                </>
              )}
            </section>
          )}
        </section>
      )}

      {game !== null && game.phase === 'finished' && review !== null && highlights !== null && (
        <section className="simulation__review" data-testid="sim-review" aria-label="ゲームの振り返り">
          <h2 className="simulation__review-title">ゲームの振り返り</h2>
          {/* 上がったゲームだけ、題字が 1 字ずつ跳ね上がる（飾り。結果は下の文で読める）。 */}
          {review.summary.checkedOut && !review.summary.abandoned && (
            <div className="simulation__gameshot" aria-hidden="true">
              <KineticText lines={['GAME SHOT']} stagger={55} />
            </div>
          )}

          {/* --- 最重要: 結果と主要な記録 ------------------------------------ */}
          <div className="simulation__result" data-testid="sim-summary">
            <p
              className="simulation__review-status"
              data-testid="sim-summary-status"
              data-abandoned={review.summary.abandoned ? 'true' : undefined}
            >
              <strong data-testid="sim-summary-start">{review.summary.startScore}</strong>{' '}
              から開始し、{describeGameResultJa(review.summary)}
            </p>
            {review.summary.checkedOut && (
              <p className="simulation__result-checkout" data-testid="sim-summary-checkout">
                上がりのビジット: 開始{' '}
                <strong data-testid="sim-summary-checkout-score">
                  {review.summary.checkoutScore}
                </strong>{' '}
                点から{' '}
                <strong data-testid="sim-summary-checkout-darts">
                  {review.summary.checkoutDarts}
                </strong>{' '}
                投
              </p>
            )}
            <dl className="simulation__summary">
              <div>
                <dt>総投数</dt>
                <dd data-testid="sim-summary-darts">{review.summary.totalDarts}</dd>
              </div>
              <div>
                <dt>PPR（3投平均）</dt>
                <dd data-testid="sim-summary-ppr">{review.summary.ppr.toFixed(2)}</dd>
              </div>
              <div>
                <dt>BUST（0点のビジット）</dt>
                <dd data-testid="sim-summary-bust">{review.summary.bustCount} 回</dd>
              </div>
              <div>
                <dt>計算ミス</dt>
                <dd data-testid="sim-summary-miss">{review.summary.calculationMissCount} 回</dd>
              </div>
            </dl>
            <p className="simulation__result-sub">
              最初の9投のPPR{' '}
              <strong data-testid="sim-summary-first9">{review.summary.first9Ppr.toFixed(2)}</strong>
              {review.summary.totalDarts < 9 && `（${review.summary.totalDarts} 投で平均）`}
            </p>
          </div>

          {/* --- 最重要: 良かった判断 / 改善ポイント / 次に意識すること ------ */}
          <section
            className="simulation__highlight"
            data-tone="good"
            data-testid="sim-highlight-good"
            aria-label="良かった判断"
          >
            <h3>良かった判断</h3>
            {highlights.good === null ? (
              <p className="simulation__highlight-empty">評価できた良い判断はありません。</p>
            ) : (
              <HighlightThrow focus={highlights.good} showAlternative={false} />
            )}
          </section>

          <section
            className="simulation__highlight"
            data-tone={highlights.improvement === null ? 'plain' : VERDICT_TONE[highlights.improvement.review.verdict]}
            data-testid="sim-highlight-improve"
            aria-label="改善ポイント"
          >
            <h3>改善ポイント</h3>
            {highlights.improvement === null ? (
              <p className="simulation__highlight-empty">
                なし（採点できた狙いの範囲。腕前やゲーム全体を保証するものではありません）。
              </p>
            ) : (
              <HighlightThrow focus={highlights.improvement} showAlternative />
            )}
          </section>

          <p className="simulation__next-focus" data-testid="sim-next-focus">
            <strong>次のゲームで意識すること</strong>
            {highlights.nextFocusJa}
          </p>

          <div className="simulation__review-actions">
            <button
              type="button"
              className="simulation__start"
              data-testid="sim-retry"
              onClick={retry}
            >
              同じ条件でもう一度
            </button>
            <button
              type="button"
              className="simulation__secondary"
              data-testid="sim-restart"
              onClick={() => {
                setGame(null);
                setScoreDraft('');
              }}
            >
              設定へ戻る
            </button>
          </div>

          <p className="simulation__review-note">
            評価しているのは <strong>狙い</strong> だけです。狙いが妥当なら、そこから外れた着弾は
            判断ミスとして数えません。
          </p>

          {/* --- 詳細: 内訳 / 改善候補 / 全投 ----------------------------- */}
          <section className="simulation__help" data-testid="sim-verdict-breakdown">
            <h3 className="simulation__section-heading">判断の内訳</h3>
            <div className="simulation__detail-body">
              <p className="simulation__review-note" data-testid="sim-evaluated-note">
                採点した狙い {highlights.evaluatedCount} 投のうち、良い判断{' '}
                {highlights.goodCount} 投・見直し候補 {highlights.improvementCount} 投。
                得点を伸ばす場面 {highlights.scoringCount} 投と判定対象外{' '}
                {highlights.notEvaluatedCount} 投は、どちらにも数えていません。
              </p>
              <StackedBar
                legend={false}
                testId="sim-verdict-bar"
                segments={THROW_VERDICTS.map((verdict) => ({
                  key: verdict,
                  label: THROW_VERDICT_JA[verdict],
                  count: review.verdictCounts[verdict],
                  tone: VERDICT_TONE[verdict],
                }))}
              />
              <ul className="simulation__verdict-counts" aria-label="判断の分類ごとの件数">
                {THROW_VERDICTS.filter((verdict) => review.verdictCounts[verdict] > 0).map(
                  (verdict) => (
                    <li key={verdict} data-tone={VERDICT_TONE[verdict]}>
                      <span>{THROW_VERDICT_JA[verdict]}</span>
                      <strong data-testid={`sim-count-${verdict}`}>
                        {review.verdictCounts[verdict]}
                      </strong>
                    </li>
                  ),
                )}
              </ul>
            </div>
          </section>

          {highlights.improvements.length > 0 && (
            <details className="simulation__help" data-testid="sim-improvements">
              <summary>見直し候補をすべて見る（{highlights.improvements.length} 件）</summary>
              <ol className="simulation__detail-body simulation__focus-list">
                {highlights.improvements.map((focus) => (
                  <li
                    key={focus.review.record.dartIndex}
                    data-tone={VERDICT_TONE[focus.review.verdict]}
                    data-testid={`sim-improvement-${focus.review.record.dartIndex}`}
                  >
                    <HighlightThrow focus={focus} showAlternative />
                  </li>
                ))}
              </ol>
            </details>
          )}

          <section className="simulation__help" data-testid="sim-all-throws">
            <h3 className="simulation__section-heading">全投（{review.summary.totalDarts} 投）</h3>
            <div className="simulation__detail-body">
              {highlights.scoringCount > 0 && (
                <p className="simulation__review-note">
                  得点を伸ばす場面（残り 351 以上）の投は採点していないため、1 投ごとの説明を省いています。
                </p>
              )}
              <ol className="simulation__rounds">
                {review.rounds.map((item) => (
                  <li
                    key={item.round}
                    className="simulation__round"
                    data-testid={`sim-round-${item.round}`}
                  >
                    <h3>
                      {item.round} ビジット目
                      <span className="simulation__round-left">開始 {item.leftBefore} 点</span>
                      <span className="simulation__round-scored">
                        {item.bust ? 'BUST（0点）' : `${item.scored} 点`}
                      </span>
                    </h3>

                    {item.entry?.miss === true && (
                      <p
                        className="simulation__round-miss"
                        data-testid={`sim-round-miss-${item.round}`}
                      >
                        計算ミス {item.entry.wrongEntries.length} 回 — 入力{' '}
                        {item.entry.wrongEntries.join(' / ')} ／ 正しくは {item.entry.actual}
                      </p>
                    )}

                    <ol className="simulation__review-throws">
                      {item.throws.map((throwReview) => {
                        const described = describeThrow(throwReview.record);
                        return (
                          <li
                            key={throwReview.record.dartIndex}
                            data-tone={VERDICT_TONE[throwReview.verdict]}
                            data-testid={`sim-throw-${throwReview.record.dartIndex}`}
                          >
                            <div className="simulation__review-head">
                              <span className="simulation__review-dart">
                                {throwReview.record.dartNumber}投目
                              </span>
                              <span className="simulation__review-left">
                                残り {throwReview.record.leftBefore}
                              </span>
                              <span
                                className="simulation__review-verdict"
                                data-testid={`sim-verdict-${throwReview.record.dartIndex}`}
                              >
                                {THROW_VERDICT_JA[throwReview.verdict]}
                              </span>
                            </div>
                            <p className="simulation__review-aim">
                              狙い {described.intended} ／ 着弾 {described.actual}
                              {throwReview.record.bust && '（BUST）'}
                              {throwReview.record.checkout && '（CHECKOUT）'}
                            </p>
                            {throwReview.verdict !== 'SCORING_PHASE' && (
                              <p className="simulation__review-explain">{throwReview.noteJa}</p>
                            )}
                            {IMPROVEMENT_PRIORITY[throwReview.verdict] !== undefined && (
                              <ReviewSuggestions
                                suggestions={suggestionsOf(throwReview)}
                                testId={`sim-suggest-${throwReview.record.dartIndex}`}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <details className="simulation__help" data-testid="sim-review-glossary">
            <summary>判断の分類と用語の意味</summary>
            <dl className="simulation__help-list simulation__help-list--stacked">
              {THROW_VERDICTS.map((verdict) => (
                <Fragment key={verdict}>
                  <dt>{THROW_VERDICT_JA[verdict]}</dt>
                  <dd>{THROW_VERDICT_HINT_JA[verdict]}</dd>
                </Fragment>
              ))}
              {REVIEW_GLOSSARY_JA.map((item) => (
                <Fragment key={item.term}>
                  <dt>{item.term}</dt>
                  <dd>{item.meaning}</dd>
                </Fragment>
              ))}
            </dl>
          </details>
        </section>
      )}
    </div>
  );
}

/**
 * 振り返りで取り上げる 1 投。
 *
 * **狙い通りに入った場合の残り**と**実際の着弾**を分けて書く（判断の評価に使うのは狙いだけ）。
 * 代案は、その投を投げる直前の残りと本数で求めた既存のおすすめだけを出し、
 * 無いときに作らない（食い違う場合の扱いは `reviewHighlights.ts`）。
 */
function HighlightThrow({
  focus,
  showAlternative,
}: {
  focus: ThrowFocus;
  showAlternative: boolean;
}) {
  const { round, review } = focus;
  const { record } = review;
  const described = describeThrow(record);
  const testId = `sim-focus-${record.dartIndex}`;
  return (
    <div className="simulation__focus" data-testid={testId}>
      <p className="simulation__focus-head">
        <span className="simulation__focus-where">
          {round.round} ビジット目・{record.dartNumber}投目（残り {record.leftBefore}・
          この投を含めて {dartsLeftBefore(review)} 本）
        </span>
        <span className="simulation__review-verdict">{THROW_VERDICT_JA[review.verdict]}</span>
      </p>
      <p className="simulation__focus-aim">
        狙い {described.intended}
        {review.intendedLeave === null
          ? '（狙い通りに入ると BUST）'
          : review.intendedLeave === 0
            ? '（狙い通りに入ると上がり）'
            : `（狙い通りなら残り ${review.intendedLeave}）`}
        <span className="simulation__focus-hit">
          実際の着弾 {described.actual}（判断の評価には使っていません）
        </span>
      </p>
      <p className="simulation__review-explain">{review.noteJa}</p>
      {showAlternative && focus.suggestions !== null && (
        <ReviewSuggestions suggestions={focus.suggestions} testId={`${testId}-alt`} />
      )}
    </div>
  );
}

/**
 * 「振り返りが比べた代案」と「この場面のアプリの第 1 案」を分けて出す（v1.4.8）。
 * 文言は `data/explanations.ts`、中身は判定の構造化データ（`reviewHighlights.ts`）。
 */
function ReviewSuggestions({
  suggestions,
  testId,
}: {
  suggestions: FocusSuggestions;
  testId: string;
}) {
  return (
    <div className="simulation__focus-alt" data-testid={testId}>
      <p data-testid={`${testId}-compare`}>{suggestions.comparisonLineJa}</p>
      {suggestions.appFirstLineJa !== null && (
        <p
          className="simulation__focus-app"
          data-testid={`${testId}-app`}
          data-relation={suggestions.appFirstRelation ?? undefined}
        >
          {suggestions.appFirstLineJa}
        </p>
      )}
    </div>
  );
}

/**
 * 1 投の記録。
 *
 * **得点は出さない。** 合計はもちろん、1 投ごとの点数も出してしまうと
 * 暗算がただの足し算の読み上げになる。出すのは狙いと着弾だけ。
 */
function ThrowRow({ record }: { record: ThrowRecord }) {
  const described = describeThrow(record);
  return (
    <li data-testid={`sim-throw-row-${record.dartNumber}`}>
      <span className="simulation__throw-dart">D{record.dartNumber}</span>
      <span className="simulation__throw-aim">狙い {described.intended}</span>
      <span className="simulation__throw-hit">着弾 {described.actual}</span>
      {(record.bust || record.checkout) && (
        <span className="simulation__throw-flag">{record.bust ? 'BUST' : 'CHECKOUT'}</span>
      )}
    </li>
  );
}

function bustNoteJa(reason: string | null): string {
  switch (reason) {
    case 'BELOW_ZERO':
      return '残り点を超えました。';
    case 'LEFT_ONE':
      return '残り 1 になりました。';
    case 'NOT_DOUBLE_FINISH':
      return '0 になりましたが、最後のダーツがダブルではありません。';
    default:
      return '';
  }
}
