/**
 * ケースの観点タグを Evidence から機械的に導く。
 *
 * 人手でタグを付けると、Evidence とタグが食い違っても気づけない。ここでは Evidence に
 * 書かれた値（mode・推奨度・reason code・Bogey 判定など）だけを見てタグを決める。
 * **戦術判断はしない**（engine が付けた reason code の有無を読むだけ）。
 */
import type { RouteEvidence } from '../types';
import { BENCHMARK_TAGS, type BenchmarkInput, type BenchmarkTag } from './types';

const SINGLE_MISS_CODES = new Set([
  'SINGLE_MISS_SAFE',
  'SINGLE_MISS_LOSES_CHECKOUT',
  'SINGLE_MISS_LEAVES_BOGEY',
  'SETUP_SINGLE_MISS_TENPAI_SAFE',
  'SETUP_SINGLE_MISS_DEAD_END',
]);
const NEIGHBOR_CODES = new Set(['NEIGHBOR_SAFE', 'NEIGHBOR_RISK']);
const BOGEY_CODES = new Set(['LEAVES_BOGEY', 'SINGLE_MISS_LEAVES_BOGEY', 'SETUP_TON_TRAP']);

/** low-score-checkout の上限（この残り以下の CHECKOUT）。 */
export const LOW_SCORE_CHECKOUT_MAX = 60;
/** high-score-setup の下限（この残り以上の SETUP）。 */
export const HIGH_SCORE_SETUP_MIN = 250;

function codesOf(routes: readonly RouteEvidence[]): Set<string> {
  return new Set(routes.flatMap((route) => route.reasons.map((reason) => reason.code)));
}

export function deriveTags(input: BenchmarkInput): BenchmarkTag[] {
  const tags = new Set<BenchmarkTag>();

  if (input.kind === 'game-review') {
    const counts = input.review.verdictCounts;
    if (counts.GOOD_DECISION > 0 && counts.BETTER_OPTION_AVAILABLE > 0) {
      tags.add('good-better-distinction');
    }
    if (counts.BOGEY_CREATED > 0) tags.add('bogey-avoidance');
    return BENCHMARK_TAGS.filter((tag) => tags.has(tag));
  }

  const evidence = input.decision;
  const routes =
    evidence.mode === 'NEXT_VISIT'
      ? evidence.nextVisitProposals.map((proposal) => proposal.route)
      : evidence.routes;
  const top = routes[0];
  const codes = codesOf(routes);

  if (evidence.mode === 'CHECKOUT' && top) {
    const darts = top.dartIds.length;
    if (darts === 1) tags.add('one-dart-checkout');
    if (darts === 2) tags.add('two-dart-checkout');
    if (darts === 3) tags.add('three-dart-checkout');
    if (evidence.remaining <= LOW_SCORE_CHECKOUT_MAX) tags.add('low-score-checkout');
    if (top.dartIds[top.dartIds.length - 1] === 'BULL') tags.add('bull-finish');
  }
  if (evidence.mode === 'SETUP' && evidence.remaining >= HIGH_SCORE_SETUP_MIN) {
    tags.add('high-score-setup');
  }
  if ([...codes].some((code) => SINGLE_MISS_CODES.has(code))) tags.add('single-miss-safety');
  if ([...codes].some((code) => NEIGHBOR_CODES.has(code))) tags.add('neighbor-safety');
  if (
    evidence.isBogey ||
    evidence.tonTrapLeave !== null ||
    [...codes].some((code) => BOGEY_CODES.has(code))
  ) {
    tags.add('bogey-avoidance');
  }
  if (evidence.tonTrapLeave !== null) tags.add('ton-trap');
  if (routes.length >= 2) tags.add('multiple-valid-routes');
  if (new Set(routes.map((route) => route.grade)).size >= 2) tags.add('good-better-distinction');
  if (input.previousThrow !== null) tags.add('miss-recovery');

  return BENCHMARK_TAGS.filter((tag) => tags.has(tag));
}
