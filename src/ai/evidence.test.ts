/**
 * Structured Evidence Layer のテスト。
 *
 * - 同じ engine の結果からは同じ Evidence が生成される（決定性）
 * - Evidence は engine の順序・推奨度をそのまま写し、並べ替えや再評価をしない
 * - Evidence は凍結された複製で、engine の内部値（重み・スコア・乱数・座標）を含まない
 */
import { describe, expect, it } from 'vitest';
import { suggestFor } from '../engine/recovery/suggest';
import { MAX_PPR } from '../engine/simulation/accuracy';
import {
  advanceRound,
  createGame,
  submitScore,
  throwAt,
  type SimulationGame,
  type SimulationSettings,
} from '../engine/simulation/game';
import { buildGameReview } from '../engine/simulation/review';
import { computeStats, type TrainingHistory, type TrainingRecord } from '../storage/trainingHistory';
import {
  DEFAULT_MAX_ROUTES,
  buildDecisionEvidence,
  buildGameReviewEvidence,
  buildTrainingEvidence,
  serializeEvidence,
} from './evidence';
import { AI_EVIDENCE_SCHEMA_VERSION } from './types';

const PERFECT: SimulationSettings = {
  startScore: 501,
  first9Ppr: MAX_PPR,
  averagePpr: MAX_PPR,
  missDirection: 'even',
  maxMiss: 'medium',
};

function throwMany(game: SimulationGame, ids: readonly string[]): SimulationGame {
  return ids.reduce((state, id) => throwAt(state, id), game);
}

function nineDarter(): SimulationGame {
  let game = createGame(PERFECT, 1);
  game = throwMany(game, ['segment-t20', 'segment-t20', 'segment-t20']);
  game = advanceRound(submitScore(game, 180));
  game = throwMany(game, ['segment-t20', 'segment-t20', 'segment-t20']);
  game = advanceRound(submitScore(game, 180));
  game = throwMany(game, ['segment-t20', 'segment-t19', 'segment-d12']);
  return advanceRound(submitScore(game, 141));
}

function trainingRecord(overrides: Partial<TrainingRecord>): TrainingRecord {
  return {
    id: 'r',
    at: 1_700_000_000_000,
    kind: 'checkout',
    format: 'checkout-route',
    problemKey: 'checkout|v2|left=81|darts=3',
    difficulty: 'medium',
    primaryCategory: 'checkout-under-100',
    learningTags: [],
    startRemaining: 81,
    currentRemaining: 81,
    contextualThrows: [],
    dartsAvailable: 3,
    answer: ['T19', 'D12'],
    ruleValid: true,
    learningCorrect: true,
    grade: 'S',
    failureCode: null,
    finishDouble: 'D12',
    elapsedMs: 3000,
    ...overrides,
  };
}

/** Evidence 全体に含まれるキー名。 */
function keysOf(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, keys));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      keysOf(child, keys);
    }
  }
  return keys;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('Evidence の決定性', () => {
  it('同じ engine の結果からは、何度作っても同じ Evidence になる', () => {
    const scenes = [[116, 3], [103, 3], [150, 1], [119, 2], [301, 3], [159, 3], [171, 1], [400, 3]];
    const differences: string[] = [];
    for (const [left, darts] of scenes) {
      const suggestion = suggestFor(left, darts);
      const first = serializeEvidence(buildDecisionEvidence(suggestion));
      const second = serializeEvidence(buildDecisionEvidence(suggestion));
      // engine を呼び直した結果からも同じになる（時刻・乱数に依存しない）。
      const again = serializeEvidence(buildDecisionEvidence(suggestFor(left, darts)));
      if (first !== second || first !== again) differences.push(`${left}/${darts}`);
    }
    expect(differences).toEqual([]);
  });

  it('serializeEvidence はキーの順序に依存しない', () => {
    expect(serializeEvidence({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(
      serializeEvidence({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }),
    );
  });

  it('GAME REVIEW と TRAINING の Evidence も決定的', () => {
    const review = buildGameReview(nineDarter());
    expect(serializeEvidence(buildGameReviewEvidence(review))).toBe(
      serializeEvidence(buildGameReviewEvidence(buildGameReview(nineDarter()))),
    );
    const history: TrainingHistory = {
      version: 2,
      records: [trainingRecord({ id: 'a' }), trainingRecord({ id: 'b', learningCorrect: false })],
      migrationSkippedCount: 0,
    };
    expect(serializeEvidence(buildTrainingEvidence(computeStats(history)))).toBe(
      serializeEvidence(buildTrainingEvidence(computeStats(history))),
    );
  });
});

describe('Evidence は engine の結果を写すだけ', () => {
  it('CHECKOUT: engine の順序・推奨度・基準ルート・理由コードをそのまま写す', () => {
    const suggestion = suggestFor(116, 3);
    const evidence = buildDecisionEvidence(suggestion);

    expect(evidence.schemaVersion).toBe(AI_EVIDENCE_SCHEMA_VERSION);
    expect(evidence.mode).toBe('CHECKOUT');
    expect(evidence.remaining).toBe(116);
    expect(evidence.dartsLeft).toBe(3);
    expect(evidence.totalRouteCount).toBe(suggestion.checkoutRoutes.length);
    expect(evidence.routes).toHaveLength(Math.min(DEFAULT_MAX_ROUTES, suggestion.checkoutRoutes.length));
    evidence.routes.forEach((route, index) => {
      const engine = suggestion.checkoutRoutes[index];
      expect(route.rank).toBe(index + 1);
      expect(route.dartIds).toEqual(engine.darts.map((dart) => dart.id));
      expect(route.routeText).toBe(engine.routeText);
      expect(route.grade).toBe(engine.grade);
      expect(route.isStandard).toBe(engine.isStandard);
      expect(route.leave).toBe(0);
      expect(route.reasons.map((reason) => reason.code)).toEqual(
        engine.reasons.map((reason) => reason.code),
      );
      expect(route.reasons.map((reason) => reason.summaryJa)).toEqual(
        engine.reasons.map((reason) => reason.summary),
      );
    });
  });

  it('SETUP: 取得点と残りは engine の値を使う', () => {
    const suggestion = suggestFor(301, 3);
    const evidence = buildDecisionEvidence(suggestion);
    expect(evidence.mode).toBe('SETUP');
    expect(evidence.canReachTenpai).toBe(suggestion.canReachTenpai);
    expect(evidence.routes[0].scored).toBe(suggestion.setupRoutes[0].scored);
    expect(evidence.routes[0].leave).toBe(suggestion.setupRoutes[0].leave);
    expect(evidence.routes[0].grade).toBe(suggestion.setupRoutes[0].grade);
  });

  it('上がれない場面は NEXT VISIT の提案を engine の順で写す', () => {
    const suggestion = suggestFor(119, 2);
    const evidence = buildDecisionEvidence(suggestion);
    expect(evidence.mode).toBe('NEXT_VISIT');
    expect(evidence.routes).toEqual([]);
    expect(evidence.engineNoteJa).toBe(suggestion.unavailableReason);
    expect(evidence.nextVisitProposals.map((item) => item.route.dartIds)).toEqual(
      suggestion.nextVisitProposals.map((item) => item.route.darts.map((dart) => dart.id)),
    );
    expect(evidence.nextVisitProposals.map((item) => item.kind)).toEqual(
      suggestion.nextVisitProposals.map((item) => item.kind),
    );
  });

  it('Bogey・対象外の場面も engine の判定をそのまま写す', () => {
    expect(buildDecisionEvidence(suggestFor(159, 3)).isBogey).toBe(true);
    const outside = buildDecisionEvidence(suggestFor(400, 3));
    expect(outside.mode).toBe('UNAVAILABLE');
    expect(outside.engineNoteJa).toBe(suggestFor(400, 3).unavailableReason);
  });

  it('候補は engine の上位から切り詰めるだけ（並べ替えない）', () => {
    const suggestion = suggestFor(100, 3);
    const evidence = buildDecisionEvidence(suggestion, { maxRoutes: 10 });
    expect(evidence.routes.map((route) => route.dartIds.join(' '))).toEqual(
      suggestion.checkoutRoutes.slice(0, 10).map((route) => route.darts.map((d) => d.id).join(' ')),
    );
    expect(buildDecisionEvidence(suggestion, { maxRoutes: 0 }).routes).toEqual([]);
  });

  it('engine の内部値（重み・スコア）を AI へ渡さない', () => {
    const keys = keysOf(buildDecisionEvidence(suggestFor(116, 3)));
    for (const forbidden of ['weight', 'score', 'tacticalScore', 'darts', 'key', 'detail']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it('Evidence は凍結されている', () => {
    expect(isDeepFrozen(buildDecisionEvidence(suggestFor(116, 3)))).toBe(true);
    expect(isDeepFrozen(buildGameReviewEvidence(buildGameReview(nineDarter())))).toBe(true);
  });
});

describe('GAME REVIEW の Evidence', () => {
  it('集計と判定を写し、座標・乱数・暗算の入力値を渡さない', () => {
    const review = buildGameReview(nineDarter());
    const evidence = buildGameReviewEvidence(review);

    expect(evidence.kind).toBe('game-review');
    expect(evidence.summary.totalDarts).toBe(9);
    expect(evidence.summary.checkedOut).toBe(true);
    expect(evidence.summary.checkoutScore).toBe(141);
    expect(evidence.summary.ppr).toBe(Math.round(review.summary.ppr * 10) / 10);
    expect(evidence.verdictCounts).toEqual(review.verdictCounts);

    const evaluated = review.rounds
      .flatMap((round) => round.throws)
      .filter((item) => item.verdict !== 'SCORING_PHASE');
    expect(evidence.throws.map((item) => item.verdict)).toEqual(evaluated.map((item) => item.verdict));
    expect(evidence.throws.map((item) => item.grade)).toEqual(evaluated.map((item) => item.grade));

    const keys = keysOf(evidence);
    for (const forbidden of ['intendedPoint', 'actualPoint', 'drawsBefore', 'entry', 'seed']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });
});

describe('TRAINING の Evidence', () => {
  it('集計値だけを渡し、記録の時刻・ID・回答内容を渡さない', () => {
    const history: TrainingHistory = {
      version: 2,
      records: [
        trainingRecord({ id: 'a' }),
        trainingRecord({ id: 'b', learningCorrect: false, startRemaining: 103 }),
        trainingRecord({ id: 'c' }),
      ],
      migrationSkippedCount: 0,
    };
    const stats = computeStats(history);
    const evidence = buildTrainingEvidence(stats);
    expect(evidence.attempts).toBe(3);
    expect(evidence.correct).toBe(2);
    expect(evidence.accuracyPercent).toBe(67);
    expect(evidence.weakScores).toEqual(stats.weakScores);
    expect(evidence.recentMistakes).toEqual(stats.recentMistakes);

    const keys = keysOf(evidence);
    for (const forbidden of ['at', 'id', 'answer', 'records', 'recentMistakeRecords', 'elapsedMs']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });
});
