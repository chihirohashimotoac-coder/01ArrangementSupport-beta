/**
 * Benchmark Dataset「01AS Core v1」の定義（開発者向け Lab 専用）。
 *
 * 既存の engine（`suggestFor`・SIMULATION・`buildGameReview`）を**呼ぶだけ**で Evidence を作る。
 * 戦術ロジックは書き換えない・足さない。答え（第 1 候補・推奨度・理由）は engine が持っている。
 *
 * - 場面（残り・残り本数・外れ方・seed）はここに固定値で列挙する（決定論的）
 * - 観点タグは Evidence から機械的に導く（`src/ai/benchmark/tags.ts`）。人手で付けない
 * - RECOVERY の「外れ方」は、engine の第 1 候補の 1 投目に対して、同じナンバーのシングル /
 *   隣のナンバー / 盤外 のどれかを当てはめるだけ（残りは着弾の得点を引いた算数）
 * - SIMULATION REVIEW は固定 seed の自動プレイ。狙いは engine の第 1 候補の 1 投目で、
 *   一定の間隔で第 2 候補の 1 投目を狙う（GOOD / BETTER の区別が出るように）
 *
 * 場面の選び方を変えたら `CORE_DATASET_VERSION` を上げ、テストの指紋を更新する。
 */
import { assembleDataset, type CaseDraft } from '../ai/benchmark/dataset';
import type { BenchmarkDataset, PreviousThrowEvidence } from '../ai/benchmark/types';
import { buildDecisionEvidence, buildGameReviewEvidence } from '../ai/evidence';
import { BOARD_NUMBERS } from '../domain/boardNumbers';
import { applyDart } from '../domain/checkoutRules';
import { MISS_DART, OUTER_BULL_DART, requireDart, type Dart } from '../domain/dart';
import { representativeSegmentOf } from '../domain/segments';
import { suggestFor, type Suggestion } from '../engine/recovery/suggest';
import {
  advanceRound,
  createGame,
  currentLeft,
  dartsLeftInRound,
  needsScoreEntry,
  roundScoreOf,
  submitScore,
  throwAt,
  type SimulationGame,
} from '../engine/simulation/game';
import { buildGameReview } from '../engine/simulation/review';

export const CORE_DATASET_ID = '01as-core';
export const CORE_DATASET_VERSION = 1;
export const CORE_DATASET_LABEL = '01AS Core v1';

/** GAME REVIEW の Evidence で渡す投の上限（prompt を context window に収めるため）。 */
export const REVIEW_MAX_THROWS = 12;

// ---------------------------------------------------------------------------
// 場面の定義（残り, 残り本数）
// ---------------------------------------------------------------------------

/** CHECKOUT: 1〜3 本の上がり・低い残り・BULL・複数ルート・推奨度の差を含む。 */
export const CHECKOUT_SCENES: readonly (readonly [number, number])[] = [
  [2, 1], [8, 3], [19, 3], [25, 2], [32, 1], [36, 3], [40, 1], [50, 1],
  [57, 3], [61, 2], [64, 2], [70, 2], [81, 2], [87, 3], [94, 2], [100, 2],
  [99, 3], [103, 3], [107, 3], [110, 2], [110, 3], [116, 3], [121, 3], [131, 3],
  [132, 3], [141, 3], [158, 3], [160, 3], [161, 3], [164, 3], [167, 3], [170, 3],
];

/** SETUP: 171〜350。高い残り・TON の罠・テンパイを作れない場面・S-BULL を含む。 */
export const SETUP_SCENES: readonly (readonly [number, number])[] = [
  [171, 3], [178, 3], [185, 1], [186, 1], [196, 2], [200, 3], [219, 1], [221, 3],
  [231, 2], [240, 3], [250, 3], [259, 3], [262, 3], [263, 3], [265, 2], [271, 3], [281, 3], [301, 2],
  [301, 3], [321, 3], [340, 3], [350, 3],
];

/** NEXT VISIT: 2〜170 だが残り本数では上がれない場面（Bogey を含む）。 */
export const NEXT_VISIT_SCENES: readonly (readonly [number, number])[] = [
  [3, 1], [99, 1], [108, 2], [123, 2], [131, 1], [139, 1], [159, 3], [160, 2],
  [162, 3], [163, 3], [165, 3], [166, 3], [168, 3], [169, 3],
];

export type MissKind = 'single' | 'neighbor-cw' | 'neighbor-ccw' | 'outside';

/** RECOVERY: 第 1 候補の 1 投目がこの外れ方をしたあとの場面。 */
export const RECOVERY_SCENES: readonly { readonly left: number; readonly darts: number; readonly miss: MissKind }[] = [
  { left: 170, darts: 3, miss: 'single' },
  { left: 167, darts: 3, miss: 'single' },
  { left: 161, darts: 3, miss: 'neighbor-cw' },
  { left: 141, darts: 3, miss: 'single' },
  { left: 124, darts: 3, miss: 'neighbor-ccw' },
  { left: 121, darts: 3, miss: 'single' },
  { left: 100, darts: 3, miss: 'single' },
  { left: 96, darts: 3, miss: 'neighbor-cw' },
  { left: 81, darts: 3, miss: 'single' },
  { left: 110, darts: 2, miss: 'single' },
  { left: 60, darts: 2, miss: 'neighbor-ccw' },
  { left: 40, darts: 2, miss: 'outside' },
  { left: 40, darts: 2, miss: 'single' },
  { left: 36, darts: 2, miss: 'single' },
  { left: 32, darts: 2, miss: 'neighbor-cw' },
  { left: 301, darts: 3, miss: 'single' },
  { left: 301, darts: 3, miss: 'neighbor-ccw' },
  { left: 250, darts: 3, miss: 'single' },
  { left: 200, darts: 3, miss: 'neighbor-cw' },
  { left: 180, darts: 3, miss: 'single' },
];

/** SIMULATION REVIEW: 固定 seed の自動プレイ。 */
export const REVIEW_SCENES: readonly { readonly startScore: number; readonly ppr: number; readonly seed: number }[] = [
  { startScore: 170, ppr: 60, seed: 1 },
  { startScore: 170, ppr: 90, seed: 2 },
  { startScore: 170, ppr: 45, seed: 3 },
  { startScore: 301, ppr: 60, seed: 4 },
  { startScore: 301, ppr: 80, seed: 5 },
  { startScore: 301, ppr: 45, seed: 6 },
  { startScore: 301, ppr: 100, seed: 7 },
  { startScore: 501, ppr: 60, seed: 8 },
  { startScore: 501, ppr: 80, seed: 9 },
  { startScore: 501, ppr: 100, seed: 10 },
  { startScore: 501, ppr: 45, seed: 11 },
  { startScore: 501, ppr: 70, seed: 12 },
];

/** 自動プレイで、この本数ごとに 1 回は第 2 候補の 1 投目を狙う。 */
const DEVIATE_EVERY = 4;

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

function firstDartsOf(suggestion: Suggestion): Dart[] {
  const routes =
    suggestion.checkoutRoutes.length > 0
      ? suggestion.checkoutRoutes
      : suggestion.mode === 'setup'
        ? suggestion.setupRoutes
        : suggestion.nextVisitProposals.map((proposal) => proposal.route);
  return routes.map((route) => route.darts[0]).filter((dart): dart is Dart => dart !== undefined);
}

function neighborOf(baseNumber: number, direction: 1 | -1): number {
  const index = BOARD_NUMBERS.indexOf(baseNumber as (typeof BOARD_NUMBERS)[number]);
  return BOARD_NUMBERS[(index + direction + BOARD_NUMBERS.length) % BOARD_NUMBERS.length];
}

/** 狙いに対して、定義どおりの外れ方をした着弾。成り立たない組み合わせは例外（定義の誤り）。 */
export function missedDartOf(intended: Dart, miss: MissKind): { dart: Dart; kind: PreviousThrowEvidence['missKind'] } {
  if (miss === 'outside') return { dart: MISS_DART, kind: 'outside' };
  if (intended.baseNumber === null) {
    if (miss === 'single' && intended.id === 'BULL') return { dart: OUTER_BULL_DART, kind: 'single' };
    throw new Error(`${intended.id} に ${miss} の外れ方は定義できません。`);
  }
  if (miss === 'single') {
    if (intended.kind === 'single') throw new Error(`${intended.id} はすでにシングルです。`);
    return { dart: requireDart(`S${intended.baseNumber}`), kind: 'single' };
  }
  const prefix = intended.id.charAt(0);
  const neighbor = neighborOf(intended.baseNumber, miss === 'neighbor-cw' ? 1 : -1);
  return { dart: requireDart(`${prefix}${neighbor}`), kind: 'neighbor' };
}

function decisionDraft(
  id: string,
  category: 'CHECKOUT' | 'SETUP' | 'NEXT_VISIT',
  left: number,
  darts: number,
): CaseDraft {
  const decision = buildDecisionEvidence(suggestFor(left, darts));
  const expected = category === 'NEXT_VISIT' ? 'NEXT_VISIT' : category;
  if (decision.mode !== expected) {
    throw new Error(`${id}: engine の mode は ${decision.mode}（定義は ${expected}）`);
  }
  const label = category === 'NEXT_VISIT' ? 'NEXT VISIT' : category;
  return {
    id,
    category,
    titleJa: `${label} 残り ${left}・${darts} 本`,
    input: { kind: 'decision', decision, previousThrow: null },
  };
}

function recoveryDraft(scene: (typeof RECOVERY_SCENES)[number]): CaseDraft {
  const intended = firstDartsOf(suggestFor(scene.left, scene.darts))[0];
  if (!intended) throw new Error(`RECOVERY ${scene.left}/${scene.darts}: 第 1 候補がありません。`);
  const missed = missedDartOf(intended, scene.miss);
  const result = applyDart(scene.left, missed.dart);
  if (result.outcome !== 'continue' || scene.darts < 2) {
    throw new Error(`RECOVERY ${scene.left}/${scene.darts}/${scene.miss}: 続きの場面になりません（${result.outcome}）。`);
  }
  const leftAfter = result.remainingAfter;
  const dartsAfter = scene.darts - 1;
  const previousThrow: PreviousThrowEvidence = {
    leftBefore: scene.left,
    dartsLeftBefore: scene.darts,
    intendedDartId: intended.id,
    actualDartId: missed.dart.id,
    missKind: missed.kind,
    leftAfter,
  };
  return {
    id: `RC-${scene.left}-${scene.darts}-${scene.miss}`,
    category: 'RECOVERY',
    titleJa: `RECOVERY 残り ${scene.left}・${scene.darts} 本で ${intended.id} を狙い ${missed.dart.id}（残り ${leftAfter}・${dartsAfter} 本）`,
    input: {
      kind: 'decision',
      decision: buildDecisionEvidence(suggestFor(leftAfter, dartsAfter)),
      previousThrow,
    },
  };
}

function aimOf(left: number, dartsLeft: number, deviate: boolean): string {
  if (left > 350) return 'T20';
  const firsts = firstDartsOf(suggestFor(left, dartsLeft));
  const chosen = deviate && firsts[1] ? firsts[1] : firsts[0];
  return chosen?.id ?? 'T20';
}

/** 固定 seed の自動プレイ（決定論的）。 */
export function autoPlay(scene: (typeof REVIEW_SCENES)[number]): SimulationGame {
  let game = createGame(
    { startScore: scene.startScore, first9Ppr: scene.ppr, averagePpr: scene.ppr, missDirection: 'even', maxMiss: 'medium' },
    scene.seed,
  );
  let thrown = 0;
  // MAX_ROUNDS で必ず終わるが、定義の誤りで無限に回らないよう上限を置く。
  for (let step = 0; step < 2000 && game.phase !== 'finished'; step += 1) {
    if (game.phase === 'aiming') {
      const target = aimOf(currentLeft(game), dartsLeftInRound(game.current), thrown % DEVIATE_EVERY === DEVIATE_EVERY - 1);
      const segment = representativeSegmentOf(target);
      if (!segment) throw new Error(`${target} の区画がありません。`);
      game = throwAt(game, segment.id);
      thrown += 1;
    } else if (game.current !== null) {
      if (needsScoreEntry(game.current)) game = submitScore(game, roundScoreOf(game.current));
      game = advanceRound(game);
    }
  }
  if (game.phase !== 'finished') throw new Error(`自動プレイが終わりません: ${JSON.stringify(scene)}`);
  return game;
}

function reviewDraft(scene: (typeof REVIEW_SCENES)[number]): CaseDraft {
  const review = buildGameReview(autoPlay(scene));
  return {
    id: `SR-${scene.startScore}-ppr${scene.ppr}-s${scene.seed}`,
    category: 'SIMULATION_REVIEW',
    titleJa: `GAME REVIEW ${scene.startScore} スタート・PPR ${scene.ppr}・seed ${scene.seed}`,
    input: { kind: 'game-review', review: buildGameReviewEvidence(review, { maxThrows: REVIEW_MAX_THROWS }) },
  };
}

export function buildCoreDatasetDrafts(): CaseDraft[] {
  return [
    ...CHECKOUT_SCENES.map(([left, darts]) => decisionDraft(`CO-${left}-${darts}`, 'CHECKOUT', left, darts)),
    ...SETUP_SCENES.map(([left, darts]) => decisionDraft(`SU-${left}-${darts}`, 'SETUP', left, darts)),
    ...NEXT_VISIT_SCENES.map(([left, darts]) => decisionDraft(`NV-${left}-${darts}`, 'NEXT_VISIT', left, darts)),
    ...RECOVERY_SCENES.map(recoveryDraft),
    ...REVIEW_SCENES.map(reviewDraft),
  ];
}

let cached: BenchmarkDataset | null = null;

/** 01AS Core v1。初回だけ engine を呼んで組み立て、以降は同じ（凍結済みの）値を返す。 */
export function coreDataset(): BenchmarkDataset {
  cached ??= assembleDataset({
    id: CORE_DATASET_ID,
    version: CORE_DATASET_VERSION,
    labelJa: CORE_DATASET_LABEL,
    drafts: buildCoreDatasetDrafts(),
  });
  return cached;
}
