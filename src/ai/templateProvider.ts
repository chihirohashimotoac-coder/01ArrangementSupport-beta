/**
 * 決定論的な説明 Provider（fallback）。
 *
 * AI モデルが使えないとき（未搭載・読み込み失敗・非対応ブラウザ・タイムアウト・
 * 検証失敗・未対応）でも、ここが必ず説明を返す。モデルは使わない。
 *
 * 文面は Evidence の値と、engine が既存の説明テンプレート（data/explanations.ts）で
 * 組み立てた理由文（`summaryJa`）を並べるだけ。新しい戦術判断・比較・推測は書かない。
 * 同じ Evidence からは常に同じ文面になる。
 */
import type {
  AiProvider,
  AiTextOutput,
  DecisionEvidence,
  GameReviewEvidence,
  RouteEvidence,
  SessionEvidence,
  ThrowEvidence,
  TrainingEvidence,
} from './types';
import { THROW_VERDICTS, THROW_VERDICT_JA } from '../engine/simulation/review';

export const TEMPLATE_PROVIDER_ID = 'template';

/** 1 ルートぶんで並べる理由の数。 */
const REASONS_PER_ROUTE = 3;
/** GAME REVIEW で取り上げる投の数。 */
const THROWS_TO_MENTION = 3;

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return /[。！？]$/u.test(trimmed) ? trimmed : `${trimmed}。`;
}

function gradeLabel(route: RouteEvidence): string {
  return route.isStandard ? `推奨度 ${route.grade}・基準ルート` : `推奨度 ${route.grade}`;
}

function reasonsOf(route: RouteEvidence): { text: string; codes: string[] } {
  const reasons = route.reasons.slice(0, REASONS_PER_ROUTE);
  return {
    text: reasons.map((reason) => sentence(reason.summaryJa)).join(''),
    codes: reasons.map((reason) => reason.code),
  };
}

function otherRoutesOf(routes: readonly RouteEvidence[]): string {
  if (routes.length === 0) return '';
  const listed = routes.map((route) => `${route.routeText}（${gradeLabel(route)}）`).join('、');
  return `ほかの候補: ${listed}。`;
}

export function explainDecisionDeterministically(evidence: DecisionEvidence): AiTextOutput {
  const head = `残り ${evidence.remaining}・${evidence.dartsLeft} 本。`;
  const note = evidence.engineNoteJa ? sentence(evidence.engineNoteJa) : '';

  if (evidence.mode === 'UNAVAILABLE') {
    return { text: `${head}${note}`, citedReasonCodes: [] };
  }

  if (evidence.mode === 'NEXT_VISIT') {
    const [first, ...others] = evidence.nextVisitProposals;
    const route = first.route;
    const reasons = reasonsOf(route);
    const rest = others.length > 0
      ? `ほかの残し方: ${others.map((item) => `${item.route.routeText}（残り ${item.route.leave}）`).join('、')}。`
      : '';
    return {
      text:
        `${head}${note}` +
        `次のラウンドへの残しは、${route.routeText}（${gradeLabel(route)}）で ${route.leave} を残す案が第 1 案です。` +
        `${reasons.text}${rest}`,
      citedReasonCodes: reasons.codes,
    };
  }

  const [top, ...others] = evidence.routes;
  const reasons = reasonsOf(top);
  const body = evidence.mode === 'SETUP'
    ? `アプリの第 1 候補は ${top.routeText}（${gradeLabel(top)}）で、${top.scored} 点を取って ${top.leave} を残します。`
    : `アプリの第 1 候補は ${top.routeText}（${gradeLabel(top)}）です。`;
  const tonTrap = evidence.tonTrapLeave !== null
    ? `とりあえず TON を取ると ${evidence.tonTrapLeave} が残り、ノーテンになる点に注意します。`
    : '';
  return {
    text: `${head}${body}${reasons.text}${tonTrap}${note}${otherRoutesOf(others)}`,
    citedReasonCodes: reasons.codes,
  };
}

function isNegative(item: ThrowEvidence): boolean {
  return item.verdict !== 'GOOD_DECISION' && item.verdict !== 'NOT_EVALUATED';
}

function summarizeGame(evidence: GameReviewEvidence): AiTextOutput {
  const summary = evidence.summary;
  const outcome = summary.checkedOut && summary.checkoutScore !== null && summary.checkoutDarts !== null
    ? `${summary.checkoutScore} を ${summary.checkoutDarts} 本で上がりました。`
    : summary.abandoned
      ? '上限ラウンドで打ち切りました。'
      : 'まだ上がっていません。';
  const breakdown = THROW_VERDICTS
    .filter((verdict) => (evidence.verdictCounts[verdict] ?? 0) > 0)
    .map((verdict) => `${THROW_VERDICT_JA[verdict]} ${evidence.verdictCounts[verdict]}`)
    .join('、');
  const mentions = evidence.throws
    .filter(isNegative)
    .slice(0, THROWS_TO_MENTION)
    .map((item) => {
      const recommended = item.recommendedDartId
        ? `（この場面のアプリの第 1 案は ${item.recommendedDartId}）`
        : '';
      return `残り ${item.leftBefore} で ${item.intendedDartId} を狙った投は「${item.verdictJa}」${recommended}。`;
    })
    .join('');
  return {
    text:
      `${summary.startScore} スタートで ${summary.totalDarts} 本を投げ、${outcome}` +
      `3 ダーツ平均は ${summary.ppr}、BUST は ${summary.bustCount} 回です。` +
      (breakdown.length > 0 ? `判断の内訳: ${breakdown}。` : '') +
      (mentions.length > 0 ? `見直すとよい投: ${mentions}` : ''),
    citedReasonCodes: [],
  };
}

function summarizeTraining(evidence: TrainingEvidence): AiTextOutput {
  const weak = evidence.weakScores.length > 0
    ? `正答率が低い残り: ${evidence.weakScores.join('、')}。`
    : '';
  const recent = evidence.recentMistakes.length > 0
    ? `最近間違えた残り: ${evidence.recentMistakes.join('、')}。`
    : '';
  return {
    text:
      `TRAINING ${evidence.attempts} 問のうち ${evidence.correct} 問が正解（正答率 ${evidence.accuracyPercent}%）、` +
      `最高連続正解は ${evidence.bestStreak} 問です。${weak}${recent}`,
    citedReasonCodes: [],
  };
}

export function summarizeSessionDeterministically(evidence: SessionEvidence): AiTextOutput {
  return evidence.kind === 'game-review' ? summarizeGame(evidence) : summarizeTraining(evidence);
}

/** fallback 用の Provider。モデルを使わず、失敗もしない（Evidence の検証は呼び出し側）。 */
export const templateProvider: AiProvider = {
  id: TEMPLATE_PROVIDER_ID,
  kind: 'deterministic',
  explainDecision: async (evidence) => explainDecisionDeterministically(evidence),
  summarizeSession: async (evidence) => summarizeSessionDeterministically(evidence),
};
