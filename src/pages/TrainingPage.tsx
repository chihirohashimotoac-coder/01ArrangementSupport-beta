import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AimAreaCard } from '../components/AimAreaCard';
import { Dartboard } from '../components/Dartboard';
import { RouteCard } from '../components/RouteCard';
import { StatusBar } from '../components/StatusBar';
import { requireDart, type Dart } from '../domain/dart';
import { MAX_CHECKOUT, MAX_SETUP_REMAINING } from '../domain/checkoutRules';
import {
  DEFAULT_TRAINING_SETTINGS,
  canGenerateQuestions,
  type TrainingMode,
  type TrainingQuestion,
  type TrainingSettings,
} from '../engine/training/questions';
import { generateQuestions, recentTailOf } from '../engine/training/sampling';
import { gradeAnswer, type GradeResult } from '../engine/training/grade';
import { buildFeedback, type TrainingFeedback } from '../engine/training/feedback';
import { analyzeAimArea } from '../engine/aimArea/aimArea';
import type { LeaveTier } from '../engine/setup/leaveQuality';
import { trainingCategoryLabel } from '../data/trainingCategoryLabels';
import {
  appendRecord,
  clearHistory,
  computeStats,
  loadHistory,
  reviewTargetsOf,
  type TrainingHistory,
  type TrainingRecord,
} from '../storage/trainingHistory';
import './TrainingPage.css';

const MODE_LABEL: Record<TrainingMode, string> = {
  checkout: 'CHECKOUT',
  setup: 'SETUP',
  recovery: 'RECOVERY',
  mixed: 'MIXED',
};

/** 残り点の質を、結果画面に出す短いラベルへ変換する。 */
const LEAVE_TIER_LABEL: Record<LeaveTier, string> = {
  premium: 'テンパイ（狙って作りたい残り）',
  good: 'テンパイ（2 本でも上がれる）',
  playable: 'テンパイ',
  bogey: 'ノーテン',
  'out-of-range': '170 超え・次のラウンドでは上がれない',
};

const COUNT_OPTIONS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: '10問', value: 10 },
  { label: '30問', value: 30 },
  { label: '無限', value: null },
];

const TIME_OPTIONS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: 'なし', value: null },
  { label: '15秒', value: 15 },
  { label: '30秒', value: 30 },
];

interface SessionState {
  readonly questions: readonly TrainingQuestion[];
  readonly index: number;
  /**
   * このセッションを開始したときの設定のスナップショット。
   * 開始後に画面上の設定を編集しても、進行中のセッションは影響を受けない
   * （出題数・制限時間・追加生成のすべてでこちらを使う）。
   */
  readonly settings: TrainingSettings;
}

export function TrainingPage() {
  const [settings, setSettings] = useState<TrainingSettings>(DEFAULT_TRAINING_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [answer, setAnswer] = useState<Dart[]>([]);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [feedback, setFeedback] = useState<TrainingFeedback | null>(null);
  const [history, setHistory] = useState<TrainingHistory>(() => loadHistory());
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const startedAt = useRef<number>(0);

  const stats = useMemo(() => computeStats(history), [history]);
  const question = session ? (session.questions[session.index] ?? null) : null;
  /*
   * 回答後に添える「盤面の狙い方」（CHECKOUT / RECOVERY の 42 / 46 / 48 / 39 / 43 だけ）。
   * 出題・採点・履歴には関与しない読み取り専用の補足。
   */
  const aimArea = useMemo(() => {
    if (question === null || question.kind === 'setup') return null;
    const analysis = analyzeAimArea(question.currentRemaining, question.dartsAvailable);
    return analysis?.canFinishThisVisit ? analysis : null;
  }, [question]);

  /*
   * SETUP の回答は「どのナンバーを狙うか」なので、盤面の 62 セグメントではなく
   * 1 ナンバーぶんのウェッジをそのままタップさせる（v1.3.5）。
   * 内部では代表するセグメントを 1 つ持つ。
   *   - 1 投調整   … シングル面（S18 など）。実際の採点はウェッジ全体で行う
   *   - 1 投目の選択 … 得点用のトリプル（T19 など）
   */
  const usesNumberPicker =
    question?.format === 'setup-adjustment' || question?.format === 'setup-first-dart';
  const aimNumberPrefix = question?.format === 'setup-first-dart' ? 'T' : 'S';

  const startSession = useCallback((nextSettings: TrainingSettings) => {
    const questions = generateQuestions({
      settings: nextSettings,
      seed: Date.now() % 2147483647,
      reviewTargets: reviewTargetsOf(computeStats(loadHistory())),
      count: nextSettings.questionCount ?? 10,
    });
    setSession({ questions, index: 0, settings: nextSettings });
    setAnswer([]);
    setResult(null);
    setFeedback(null);
    startedAt.current = performance.now();
    setRemainingSeconds(nextSettings.timeLimitSeconds);
  }, []);

  const submit = useCallback(() => {
    if (!question || result !== null) return;
    const graded = gradeAnswer(question, answer);
    setResult(graded);
    setFeedback(buildFeedback(question, answer, graded));
    const record: TrainingRecord = {
      id: `${question.id}-${Date.now()}`,
      at: Date.now(),
      kind: question.kind,
      format: question.format,
      problemKey: question.problemKey,
      difficulty: question.difficulty,
      primaryCategory: question.primaryCategory,
      learningTags: question.learningTags,
      startRemaining: question.startRemaining,
      currentRemaining: question.currentRemaining,
      contextualThrows: question.contextualThrows,
      dartsAvailable: question.dartsAvailable,
      answer: answer.map((dart) => dart.id),
      ruleValid: graded.ruleValid,
      learningCorrect: graded.learningCorrect,
      grade: graded.grade,
      failureCode: graded.failureCode,
      finishDouble: graded.finishDouble,
      elapsedMs: Math.round(performance.now() - startedAt.current),
    };
    setHistory(appendRecord(record));
  }, [question, answer, result]);

  /**
   * 制限時間のカウントダウン。0 になった時点の回答で自動確定する。
   * 状態更新はタイマーのコールバック内で行い、effect 本体からは呼ばない。
   */
  useEffect(() => {
    if (remainingSeconds === null || remainingSeconds <= 0) return;
    if (result !== null || question === null) return;
    const timer = window.setTimeout(() => {
      if (remainingSeconds <= 1) {
        setRemainingSeconds(0);
        submit();
      } else {
        setRemainingSeconds(remainingSeconds - 1);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remainingSeconds, result, question, submit]);

  const goNext = useCallback(() => {
    setSession((current) => {
      if (!current) return current;
      const nextIndex = current.index + 1;
      if (nextIndex < current.questions.length) return { ...current, index: nextIndex };
      // 無限モードでは追加生成する（開始時の設定で生成する）。
      // 直前 chunk の末尾 5 問を渡し、chunk 境界で同じ問題が続かないようにする。
      if (current.settings.questionCount === null) {
        const more = generateQuestions({
          settings: current.settings,
          seed: Date.now() % 2147483647,
          reviewTargets: reviewTargetsOf(computeStats(loadHistory())),
          count: 10,
          recentHistory: recentTailOf(current.questions, 5),
        });
        return { ...current, questions: [...current.questions, ...more], index: nextIndex };
      }
      return { ...current, index: nextIndex };
    });
    setAnswer([]);
    setResult(null);
    setFeedback(null);
    startedAt.current = performance.now();
    setRemainingSeconds(session?.settings.timeLimitSeconds ?? null);
  }, [session]);

  const finished = session !== null && question === null && session.questions.length > 0;
  // 出題できない設定（例: RECOVERY で 2〜3 の範囲）を、開始前に伝える。
  const unusableSettings = !canGenerateQuestions(settings);
  const emptySession = session !== null && session.questions.length === 0;

  return (
    <div className="training">
      <section className="training__setup" aria-label="トレーニング設定">
        <div className="training__modes" role="group" aria-label="モード">
          {(Object.keys(MODE_LABEL) as TrainingMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`training-mode-${mode}`}
              aria-pressed={settings.mode === mode}
              onClick={() => setSettings((value) => ({ ...value, mode }))}
            >
              {MODE_LABEL[mode]}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="training__settings-toggle"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((value) => !value)}
        >
          {settingsOpen ? '詳細設定を閉じる' : '詳細設定'}
        </button>

        {settingsOpen && (
          <div className="training__settings" data-testid="training-settings">
            <label>
              <span>CHECKOUT 出題範囲</span>
              <span className="training__range">
                <input
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={MAX_CHECKOUT}
                  value={settings.checkoutRange.min}
                  aria-label="CHECKOUT 最小値"
                  onChange={(event) =>
                    setSettings((value) => ({
                      ...value,
                      checkoutRange: { ...value.checkoutRange, min: Number(event.target.value) },
                    }))
                  }
                />
                <span aria-hidden="true">〜</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={MAX_CHECKOUT}
                  value={settings.checkoutRange.max}
                  aria-label="CHECKOUT 最大値"
                  onChange={(event) =>
                    setSettings((value) => ({
                      ...value,
                      checkoutRange: { ...value.checkoutRange, max: Number(event.target.value) },
                    }))
                  }
                />
              </span>
            </label>

            <label>
              <span>SETUP 出題範囲</span>
              <span className="training__range">
                <input
                  type="number"
                  inputMode="numeric"
                  min={171}
                  max={MAX_SETUP_REMAINING}
                  value={settings.setupRange.min}
                  aria-label="SETUP 最小値"
                  onChange={(event) =>
                    setSettings((value) => ({
                      ...value,
                      setupRange: { ...value.setupRange, min: Number(event.target.value) },
                    }))
                  }
                />
                <span aria-hidden="true">〜</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={171}
                  max={MAX_SETUP_REMAINING}
                  value={settings.setupRange.max}
                  aria-label="SETUP 最大値"
                  onChange={(event) =>
                    setSettings((value) => ({
                      ...value,
                      setupRange: { ...value.setupRange, max: Number(event.target.value) },
                    }))
                  }
                />
              </span>
            </label>

            <fieldset>
              <legend>出題数</legend>
              {COUNT_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={settings.questionCount === option.value}
                  onClick={() => setSettings((value) => ({ ...value, questionCount: option.value }))}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>

            <fieldset>
              <legend>制限時間</legend>
              {TIME_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={settings.timeLimitSeconds === option.value}
                  onClick={() =>
                    setSettings((value) => ({ ...value, timeLimitSeconds: option.value }))
                  }
                >
                  {option.label}
                </button>
              ))}
            </fieldset>

            <label className="training__checkbox">
              <input
                type="checkbox"
                checked={settings.reviewWeakFirst}
                onChange={(event) =>
                  setSettings((value) => ({ ...value, reviewWeakFirst: event.target.checked }))
                }
              />
              <span>苦手・間違えた問題を重点的に出題する</span>
            </label>
          </div>
        )}

        {unusableSettings && (
          <p className="training__unusable" data-testid="training-unusable" role="alert">
            この設定では出題できる問題がありません。出題範囲を広げてください。
          </p>
        )}

        <button
          type="button"
          className="training__start"
          data-testid="start-training"
          onClick={() => startSession(settings)}
          disabled={unusableSettings}
        >
          {session === null ? 'トレーニングを始める' : 'この設定でやり直す'}
        </button>
      </section>

      {question && (
        /*
         * 出題中のまとまり。狭い画面では上から順に、広い画面では盤面を左、
         * 状況・回答・採点を右に置く（TrainingPage.css）。DOM の順序は変えない。
         */
        <div className="training__stage">
          <StatusBar
            remaining={question.currentRemaining}
            dartsLeft={question.visitDartsAvailable}
            note={question.promptJa}
          />

          {question.format === 'setup-first-dart' && (
            <p
              className="training__format-note"
              data-testid="training-first-dart-note"
            >
              SETUP / FIRST DART — このラウンドの 1 投目だけを選びます。
            </p>
          )}

          {question.format === 'setup-adjustment' && (
            <p
              className="training__format-note"
              data-testid="training-adjustment-note"
            >
              SETUP / LAST DART — 最後の 1 投で狙うナンバーを選びます。
            </p>
          )}

          {question.contextualThrows.length > 0 && (
            <section
              className="training__context"
              data-testid="training-context"
              aria-label="ここまでの状況"
            >
              <dl>
                <div>
                  <dt>開始</dt>
                  <dd data-testid="training-context-start">{question.startRemaining}</dd>
                </div>
                <div>
                  <dt>ここまで（実際に入った的）</dt>
                  <dd data-testid="training-context-throws">
                    {question.contextualThrows.map((item) => item.actualDartId).join(' → ')}
                  </dd>
                </div>
                <div>
                  <dt>現在</dt>
                  <dd data-testid="training-context-current">{question.currentRemaining}</dd>
                </div>
                <div>
                  <dt>残り</dt>
                  <dd data-testid="training-context-darts">{question.dartsAvailable} 投</dd>
                </div>
              </dl>
              <p className="training__context-note">
                ここまでの結果は「実際に入った的」です。回答ではありません。
              </p>
            </section>
          )}

          {remainingSeconds !== null && (
            <p className="training__timer" data-testid="training-timer" role="timer">
              残り {Math.max(remainingSeconds, 0)} 秒
            </p>
          )}

          <p className="training__progress" data-testid="training-progress">
            {session!.settings.questionCount === null
              ? `${session!.index + 1} 問目`
              : `${session!.index + 1} / ${session!.settings.questionCount} 問目`}
          </p>

          <p className="training__hint">
            {question.format === 'setup-first-dart'
              ? '1 投目に狙うナンバーのエリアをタップしてください。狙いどおりトリプルに入った場合と、同じナンバーのシングルへ落ちた場合の両方で採点します。'
              : question.format === 'setup-adjustment'
                ? '最後の 1 投で狙うナンバーのエリアをタップしてください。トリプルに入った場合と、シングルに入った場合の両方で採点します。'
                : '狙う場所を順にタップしてください（「そこへ刺さった」ではなく「そこを狙う」という回答です）。'}
          </p>

          <div className="training__board">
            {usesNumberPicker ? (
              <Dartboard
                wedgeSelection={{
                  selected: answer[0]?.baseNumber ?? null,
                  onSelect: (aimNumber) => {
                    if (result !== null) return;
                    setAnswer([requireDart(`${aimNumberPrefix}${aimNumber}`)]);
                  },
                  ariaLabelOf: (aimNumber) => `${aimNumber} を狙う`,
                }}
                disabled={result !== null}
                disabledReason="採点済みです。"
                ariaLabel="ダーツボード。狙うナンバーのエリアを 1 つ選んでください。"
              />
            ) : (
              <Dartboard
                onSelect={(segment) => {
                  if (result !== null) return;
                  if (answer.length >= question.dartsAvailable) return;
                  setAnswer((current) => [...current, segment.dart]);
                }}
                highlightedDartIds={answer.map((dart) => dart.id)}
                disabled={result !== null || answer.length >= question.dartsAvailable}
                disabledReason={
                  result !== null ? '採点済みです。' : '本数を使い切りました。回答するか、戻してください。'
                }
                ariaLabel="ダーツボード。狙う場所を順に選んでください。"
              />
            )}
          </div>

          <ol className="training__answer" aria-label="あなたの回答">
            {Array.from({ length: question.dartsAvailable }, (_, index) => (
              <li key={index} data-testid={`answer-${index}`}>
                {usesNumberPicker
                  ? (answer[index]?.baseNumber ?? '—')
                  : (answer[index]?.id ?? '—')}
              </li>
            ))}
          </ol>

          <div className="training__actions">
            <button
              type="button"
              data-testid="training-undo"
              onClick={() => setAnswer((current) => current.slice(0, -1))}
              disabled={answer.length === 0 || result !== null}
            >
              1投戻す
            </button>
            {/*
              「次の問題」は採点結果の直下だけに置く（v1.2）。
              回答前から押せる場所に同じボタンがあると、結果を読み終えたあとに
              どちらを押すのか迷ううえ、上下に離れた 2 か所を探すことになる。
            */}
            <button
              type="button"
              className="training__submit"
              data-testid="training-submit"
              onClick={submit}
              disabled={result !== null || answer.length === 0}
            >
              回答する
            </button>
          </div>

          {result && feedback && (
            <section className="training__result" data-testid="training-result" aria-live="polite">
              {/* 1. 判定 */}
              <p
                className={`training__verdict training__verdict--${
                  feedback.learningCorrect ? 'ok' : 'ng'
                }`}
                data-testid="training-verdict"
              >
                {feedback.verdictJa}
              </p>

              {/* 2. あなたの回答 / 3. その結果 */}
              <div className="training__compare">
                <div className="training__compare-item" data-testid="training-your-answer">
                  <span className="training__compare-label">あなたの回答</span>
                  <span className="training__compare-route">{feedback.answerText}</span>
                  <span className="training__compare-outcome">{feedback.answerOutcomeJa}</span>
                </div>

                {/* 4. おすすめ回答 / 5. その結果 */}
                <div className="training__compare-item" data-testid="training-recommended">
                  <span className="training__compare-label">おすすめ</span>
                  <span className="training__compare-route">{feedback.recommendedText}</span>
                  <span className="training__compare-outcome">
                    {feedback.recommendedOutcomeJa}
                  </span>
                </div>
              </div>

              {/* 6. 違いの理由 */}
              <p className="training__difference" data-testid="training-difference">
                {feedback.differenceJa}
              </p>

              {/* 7. 他の成立回答（必要な場合のみ） */}
              {feedback.alternativeTexts.length > 0 && (
                <details className="training__alternatives" data-testid="training-alternatives">
                  <summary>他にも成立する回答</summary>
                  <ul>
                    {feedback.alternativeTexts.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                </details>
              )}

              {aimArea && question && (
                <AimAreaCard key={question.id} analysis={aimArea} testId="training-aim-area" />
              )}

              {result.checkoutEvaluation && (
                <RouteCard
                  testId="training-answer-route"
                  badge="あなたの回答"
                  grade={result.checkoutEvaluation.grade}
                  dartIds={result.checkoutEvaluation.darts.map((dart) => dart.id)}
                  reasons={result.checkoutEvaluation.reasons.map((reason) => ({ ...reason }))}
                />
              )}
              {result.setupEvaluation && (
                <RouteCard
                  testId="training-answer-route"
                  badge="あなたの回答"
                  grade={result.setupEvaluation.grade}
                  dartIds={result.setupEvaluation.darts.map((dart) => dart.id)}
                  meta={`取得 ${result.setupEvaluation.scored} 点 → 残り ${result.setupEvaluation.leave}（${
                    LEAVE_TIER_LABEL[result.setupEvaluation.leaveTier]
                  }）`}
                  reasons={result.setupEvaluation.reasons.map((reason) => ({ ...reason }))}
                />
              )}

              {result.bestCheckout && result.bestCheckout.key !== result.checkoutEvaluation?.key && (
                <RouteCard
                  testId="training-best-route"
                  badge="おすすめの理由"
                  isStandard={result.bestCheckout.isStandard}
                  grade={result.bestCheckout.grade}
                  dartIds={result.bestCheckout.darts.map((dart) => dart.id)}
                  reasons={result.bestCheckout.reasons.map((reason) => ({ ...reason }))}
                />
              )}
              {result.bestSetup && result.bestSetup.key !== result.setupEvaluation?.key && (
                <RouteCard
                  testId="training-best-route"
                  badge="おすすめの理由"
                  grade={result.bestSetup.grade}
                  dartIds={result.bestSetup.darts.map((dart) => dart.id)}
                  meta={`取得 ${result.bestSetup.scored} 点 → 残り ${result.bestSetup.leave}`}
                  reasons={result.bestSetup.reasons.map((reason) => ({ ...reason }))}
                />
              )}
            </section>
          )}

          {/* 結果を読み終えた位置から、探さずに次へ進める。 */}
          {result && (
            <button
              type="button"
              className="training__next"
              data-testid="training-next"
              onClick={goNext}
            >
              次の問題
            </button>
          )}
        </div>
      )}

      {finished && (
        <p className="training__finished" data-testid="training-finished">
          このセットは終わりです。おつかれさまでした。
        </p>
      )}

      {emptySession && (
        <p className="training__finished" data-testid="training-empty-session" role="alert">
          この設定では出題できる問題がありませんでした。出題範囲を広げてから、もう一度始めてください。
        </p>
      )}

      <section className="training__stats" aria-label="学習履歴">
        <h2>学習履歴</h2>
        <dl data-testid="training-stats">
          <div>
            <dt>回答数</dt>
            <dd data-testid="stat-attempts">{stats.attempts}</dd>
          </div>
          <div>
            <dt>正答率</dt>
            <dd data-testid="stat-accuracy">{Math.round(stats.accuracy * 100)}%</dd>
          </div>
          <div>
            <dt>平均回答時間</dt>
            <dd>{(stats.averageMs / 1000).toFixed(1)} 秒</dd>
          </div>
          <div>
            <dt>連続正解</dt>
            <dd>
              {stats.currentStreak}（最高 {stats.bestStreak}）
            </dd>
          </div>
          <div>
            <dt>非推奨ルート選択</dt>
            <dd>{stats.discouragedChoices} 回</dd>
          </div>
        </dl>

        {stats.byGrade && (
          <p className="training__grades">
            S {stats.byGrade.S} / A {stats.byGrade.A} / B {stats.byGrade.B} / C {stats.byGrade.C} /
            不成立 {stats.byGrade.invalid}
          </p>
        )}

        {stats.weakScores.length > 0 && (
          <p className="training__weak">
            苦手スコア: {stats.weakScores.slice(0, 8).join(', ')}
          </p>
        )}

        {stats.byCategory.length > 0 && (
          <table className="training__table" data-testid="training-by-category">
            <caption>学習カテゴリ別</caption>
            <thead>
              <tr>
                <th scope="col">カテゴリ</th>
                <th scope="col">回答</th>
                <th scope="col">正答率</th>
              </tr>
            </thead>
            <tbody>
              {stats.byCategory.map((item) => (
                <tr key={item.key}>
                  <th scope="row">{trainingCategoryLabel(item.key)}</th>
                  <td>{item.attempts}</td>
                  <td>{Math.round(item.accuracy * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {stats.byScoreBand.length > 0 && (
          <table className="training__table">
            <caption>スコア帯別</caption>
            <thead>
              <tr>
                <th scope="col">帯</th>
                <th scope="col">回答</th>
                <th scope="col">正答率</th>
              </tr>
            </thead>
            <tbody>
              {stats.byScoreBand.map((item) => (
                <tr key={item.key}>
                  <th scope="row">{item.key}</th>
                  <td>{item.attempts}</td>
                  <td>{Math.round(item.accuracy * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {stats.byFinishDouble.length > 0 && (
          <table className="training__table">
            <caption>上がりダブル別</caption>
            <thead>
              <tr>
                <th scope="col">ダブル</th>
                <th scope="col">回答</th>
                <th scope="col">正答率</th>
              </tr>
            </thead>
            <tbody>
              {stats.byFinishDouble.map((item) => (
                <tr key={item.key}>
                  <th scope="row">{item.key}</th>
                  <td>{item.attempts}</td>
                  <td>{Math.round(item.accuracy * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {stats.migrationSkippedCount > 0 && (
          <p className="training__migration" data-testid="training-migration-skipped">
            読み取れなかった古い記録 {stats.migrationSkippedCount} 件は、正答率の集計から除いています。
          </p>
        )}

        <button
          type="button"
          className="training__clear"
          data-testid="clear-history"
          onClick={() => {
            clearHistory();
            setHistory(loadHistory());
          }}
        >
          学習履歴を消去
        </button>
      </section>
    </div>
  );
}
