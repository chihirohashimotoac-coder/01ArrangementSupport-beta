/**
 * Structured Evidence Layer。
 *
 * engine の結果から「AI が説明に使ってよい検証済みの事実」だけを取り出す。
 *
 *   Engine result → filter / normalize / serialize → Evidence
 *
 * ここでは**新しい戦術判断をしない**。ランキングの再計算・別ルートの探索・
 * 推奨度の付け直し・並べ替えは行わず、engine が返した値と順序をそのまま写す。
 * 行うのは次だけ。
 *
 *   - filter: 件数の上限で先頭から切り詰める / 採点対象外の投を除く / 内部値（重み・乱数・時刻）を落とす
 *   - normalize: 小数の丸め・割合の百分率化
 *   - serialize: キー順を固定した JSON（`serializeEvidence`）
 *
 * 返す Evidence は engine の値を**複製して凍結**したもの。Provider が書き換えようとしても
 * engine の state・キャッシュには届かない。
 */
import type { RankedCheckoutRoute, RouteReason } from '../engine/ranking/checkoutRanking';
import type { RankedSetupRoute, SetupReason } from '../engine/setup/enumerate';
import type { NextVisitProposal } from '../engine/recovery/nextVisitSelection';
import type { Suggestion } from '../engine/recovery/suggest';
import {
  THROW_VERDICTS,
  THROW_VERDICT_JA,
  type GameReview,
  type ThrowReview,
} from '../engine/simulation/review';
import type { Breakdown, TrainingStats } from '../storage/trainingHistory';
import {
  AI_EVIDENCE_SCHEMA_VERSION,
  type DecisionEvidence,
  type DecisionMode,
  type EvidenceReason,
  type GameReviewEvidence,
  type NextVisitProposalEvidence,
  type RouteEvidence,
  type ThrowEvidence,
  type TrainingBreakdownEvidence,
  type TrainingEvidence,
} from './types';

/** 既定で AI へ渡す候補ルートの数。engine の上位から切り詰めるだけ。 */
export const DEFAULT_MAX_ROUTES = 3;
/** GAME REVIEW で渡す投の上限。 */
export const DEFAULT_MAX_THROWS = 90;
/** TRAINING の苦手スコア・直近ミスで渡す件数の上限。 */
export const DEFAULT_MAX_SCORES = 10;

export interface DecisionEvidenceOptions {
  readonly maxRoutes?: number;
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** Evidence を再帰的に凍結する（Provider からの書き換えを防ぐ）。 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function reasonOf(reason: RouteReason | SetupReason): EvidenceReason {
  return {
    code: reason.code,
    polarity: reason.polarity,
    label: reason.label,
    summaryJa: reason.summary,
  };
}

function checkoutRouteOf(route: RankedCheckoutRoute, index: number): RouteEvidence {
  return {
    rank: index + 1,
    dartIds: route.darts.map((dart) => dart.id),
    routeText: route.routeText,
    grade: route.grade,
    isStandard: route.isStandard,
    scored: null,
    leave: 0,
    reasons: route.reasons.map(reasonOf),
  };
}

function setupRouteOf(route: RankedSetupRoute, index: number): RouteEvidence {
  return {
    rank: index + 1,
    dartIds: route.darts.map((dart) => dart.id),
    routeText: route.routeText,
    grade: route.grade,
    isStandard: null,
    scored: route.scored,
    leave: route.leave,
    reasons: route.reasons.map(reasonOf),
  };
}

function proposalOf(proposal: NextVisitProposal, index: number): NextVisitProposalEvidence {
  return {
    kind: proposal.kind,
    finishDoubleId: proposal.finishDoubleId,
    sameTarget: proposal.sameTarget,
    route: setupRouteOf(proposal.route, index),
  };
}

function modeOf(suggestion: Suggestion): DecisionMode {
  if (suggestion.mode === 'setup') return 'SETUP';
  if (suggestion.mode === 'unavailable') return 'UNAVAILABLE';
  // CHECKOUT 範囲で上がれるルートが無いとき、engine は NEXT VISIT の提案を返す。
  return suggestion.checkoutRoutes.length > 0 ? 'CHECKOUT' : 'NEXT_VISIT';
}

function limitOf(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

// ---------------------------------------------------------------------------
// CHECKOUT / SETUP の 1 場面
// ---------------------------------------------------------------------------

/** `suggestFor` の結果から Evidence を作る。engine を呼び直さない。 */
export function buildDecisionEvidence(
  suggestion: Suggestion,
  options: DecisionEvidenceOptions = {},
): DecisionEvidence {
  const maxRoutes = limitOf(options.maxRoutes, DEFAULT_MAX_ROUTES);
  const mode = modeOf(suggestion);
  const routes =
    mode === 'CHECKOUT'
      ? suggestion.checkoutRoutes.slice(0, maxRoutes).map(checkoutRouteOf)
      : mode === 'SETUP'
        ? suggestion.setupRoutes.slice(0, maxRoutes).map(setupRouteOf)
        : [];
  const totalRouteCount =
    mode === 'CHECKOUT'
      ? suggestion.checkoutRoutes.length
      : mode === 'SETUP'
        ? suggestion.setupRoutes.length
        : 0;

  return deepFreeze({
    schemaVersion: AI_EVIDENCE_SCHEMA_VERSION,
    kind: 'decision',
    mode,
    remaining: suggestion.remaining,
    dartsLeft: suggestion.dartsLeft,
    isBogey: suggestion.isBogey,
    canReachTenpai: suggestion.canReachTenpai,
    tonTrapLeave: suggestion.tonTrapLeave,
    engineNoteJa: suggestion.unavailableReason,
    practicalLastDartId: suggestion.practicalLastDart?.dartId ?? null,
    totalRouteCount,
    routes,
    nextVisitProposals: suggestion.nextVisitProposals.map(proposalOf),
  });
}

// ---------------------------------------------------------------------------
// GAME REVIEW
// ---------------------------------------------------------------------------

function throwOf(item: ThrowReview): ThrowEvidence {
  const record = item.record;
  return {
    round: record.round,
    dartNumber: record.dartNumber,
    leftBefore: record.leftBefore,
    intendedDartId: record.intendedDartId,
    actualDartId: record.actualDartId,
    leftAfter: record.leftAfter,
    bust: record.bust,
    checkout: record.checkout,
    verdict: item.verdict,
    verdictJa: THROW_VERDICT_JA[item.verdict],
    grade: item.grade,
    recommendedDartId: item.recommendedDartId,
    reasonCode: item.reason?.code ?? null,
  };
}

function roundTo1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

/**
 * `buildGameReview` の結果から Evidence を作る。
 *
 * 着弾座標・乱数の消費回数・暗算の入力値は渡さない（説明に不要）。
 * 残り 351 以上の投（SCORING_PHASE）は採点対象外なので除く。
 */
export function buildGameReviewEvidence(
  review: GameReview,
  options: { readonly maxThrows?: number } = {},
): GameReviewEvidence {
  const maxThrows = limitOf(options.maxThrows, DEFAULT_MAX_THROWS);
  const evaluated = review.rounds
    .flatMap((round) => round.throws)
    .filter((item) => item.verdict !== 'SCORING_PHASE');
  const throws = evaluated.slice(0, maxThrows).map(throwOf);
  const summary = review.summary;
  const verdictCounts = Object.fromEntries(
    THROW_VERDICTS.map((verdict) => [verdict, review.verdictCounts[verdict] ?? 0]),
  ) as GameReviewEvidence['verdictCounts'];

  return deepFreeze({
    schemaVersion: AI_EVIDENCE_SCHEMA_VERSION,
    kind: 'game-review',
    summary: {
      startScore: summary.startScore,
      totalDarts: summary.totalDarts,
      ppr: roundTo1(summary.ppr),
      first9Ppr: roundTo1(summary.first9Ppr),
      bustCount: summary.bustCount,
      calculationMissCount: summary.calculationMissCount,
      checkedOut: summary.checkedOut,
      checkoutDarts: summary.checkoutDarts,
      checkoutScore: summary.checkoutScore,
      abandoned: summary.abandoned,
    },
    verdictCounts,
    throws,
    omittedThrowCount: evaluated.length - throws.length,
  });
}

// ---------------------------------------------------------------------------
// TRAINING の履歴
// ---------------------------------------------------------------------------

function percentOf(ratio: number): number {
  return Number.isFinite(ratio) ? Math.round(ratio * 100) : 0;
}

function breakdownOf(item: Breakdown): TrainingBreakdownEvidence {
  return {
    key: item.key,
    attempts: item.attempts,
    correct: item.correct,
    accuracyPercent: percentOf(item.accuracy),
  };
}

/**
 * `computeStats` の集計から Evidence を作る。
 *
 * 個々の記録（回答時刻・ID・回答内容）は渡さない。集計値だけを渡す。
 */
export function buildTrainingEvidence(
  stats: TrainingStats,
  options: { readonly maxScores?: number } = {},
): TrainingEvidence {
  const maxScores = limitOf(options.maxScores, DEFAULT_MAX_SCORES);
  return deepFreeze({
    schemaVersion: AI_EVIDENCE_SCHEMA_VERSION,
    kind: 'training',
    attempts: stats.attempts,
    correct: stats.correct,
    accuracyPercent: percentOf(stats.accuracy),
    currentStreak: stats.currentStreak,
    bestStreak: stats.bestStreak,
    discouragedChoices: stats.discouragedChoices,
    byGrade: { ...stats.byGrade },
    byCategory: stats.byCategory.map(breakdownOf),
    weakScores: stats.weakScores.slice(0, maxScores),
    recentMistakes: stats.recentMistakes.slice(0, maxScores),
  });
}

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * キー順を固定した JSON。同じ Evidence からは常に同じ文字列になる。
 * Provider へのプロンプト・キャッシュキー・評価ログに使う。
 */
export function serializeEvidence(evidence: unknown): string {
  return JSON.stringify(sortKeys(evidence));
}
