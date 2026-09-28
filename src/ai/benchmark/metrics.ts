/**
 * Benchmark の集計。
 *
 * 01AS の優先順（contradiction → unsupported claim → validation failure → 日本語の質 → latency）で並べる。
 * 率の分母は「応答が返ったケース」（エラー・タイムアウトを除く）。エラー件数は別に数える。
 */
import {
  BENCHMARK_CATEGORIES,
  type BenchmarkCategory,
  type BenchmarkRun,
  type CaseResult,
  type StyleFlags,
} from './types';

export interface Distribution {
  readonly count: number;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export interface CategorySummary {
  readonly total: number;
  readonly completed: number;
  readonly validationPassed: number;
  readonly withUnsupportedClaims: number;
  readonly withContradictions: number;
}

export interface RunSummary {
  readonly total: number;
  /** 応答が返ったケース（エラー・タイムアウト以外）。 */
  readonly completed: number;
  readonly errors: number;
  readonly timeouts: number;

  // 1. Engine contradiction
  readonly withContradictions: number;
  readonly contradictionTotal: number;
  readonly engineContradictionRate: number | null;
  // 2. Unsupported claim
  readonly withUnsupportedClaims: number;
  readonly unsupportedClaimTotal: number;
  readonly unsupportedClaimRate: number | null;
  // 3. Validation
  readonly validationPassed: number;
  /** 不合格（エラー・タイムアウトを含む）/ 全ケース。 */
  readonly validationFailureRate: number | null;
  readonly shapeProblems: number;
  // 4. 日本語の体裁（自動の目安）
  readonly styleFlagCounts: Readonly<Record<keyof StyleFlags, number>>;
  readonly mentionsTopTarget: number;
  readonly decisionCases: number;
  // 5. Latency・出力量
  readonly timeToFirstTokenMs: Distribution;
  readonly timeToFirstVisibleTokenMs: Distribution;
  readonly generationTimeMs: Distribution;
  readonly tokensPerSecond: Distribution;
  readonly outputTokens: Distribution;
  readonly outputLength: Distribution;

  readonly byCategory: Readonly<Record<BenchmarkCategory, CategorySummary>>;
}

/** 最近傍順位法の分位点（p は 0〜1）。 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function distributionOf(values: readonly (number | null)[]): Distribution {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const sorted = [...present].sort((a, b) => a - b);
  return {
    count: sorted.length,
    mean: sorted.length === 0 ? null : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

const STYLE_KEYS: readonly (keyof StyleFlags)[] = [
  'tooLong',
  'tooShort',
  'lowJapaneseRatio',
  'markdown',
  'englishSentence',
  'thinkingLeak',
];

function isCompleted(result: CaseResult): boolean {
  return result.error === null && !result.timedOut && result.text !== null;
}

export function summarizeResults(results: readonly CaseResult[]): RunSummary {
  const completed = results.filter(isCompleted);
  const styleFlagCounts = Object.fromEntries(
    STYLE_KEYS.map((key) => [key, completed.filter((result) => result.style?.[key]).length]),
  ) as Record<keyof StyleFlags, number>;
  const byCategory = Object.fromEntries(
    BENCHMARK_CATEGORIES.map((category) => {
      const items = results.filter((result) => result.category === category);
      const done = items.filter(isCompleted);
      return [category, {
        total: items.length,
        completed: done.length,
        validationPassed: items.filter((result) => result.validationPassed).length,
        withUnsupportedClaims: done.filter((result) => result.unsupportedClaims.length > 0).length,
        withContradictions: done.filter((result) => result.contradictions.length > 0).length,
      }];
    }),
  ) as Record<BenchmarkCategory, CategorySummary>;

  const withContradictions = completed.filter((result) => result.contradictions.length > 0).length;
  const withUnsupportedClaims = completed.filter((result) => result.unsupportedClaims.length > 0).length;
  const validationPassed = results.filter((result) => result.validationPassed).length;
  const decision = completed.filter((result) => result.mentionsTopTarget !== null);

  return {
    total: results.length,
    completed: completed.length,
    errors: results.filter((result) => result.error !== null && !result.timedOut).length,
    timeouts: results.filter((result) => result.timedOut).length,
    withContradictions,
    contradictionTotal: completed.reduce((sum, result) => sum + result.contradictions.length, 0),
    engineContradictionRate: rate(withContradictions, completed.length),
    withUnsupportedClaims,
    unsupportedClaimTotal: completed.reduce((sum, result) => sum + result.unsupportedClaims.length, 0),
    unsupportedClaimRate: rate(withUnsupportedClaims, completed.length),
    validationPassed,
    validationFailureRate: rate(results.length - validationPassed, results.length),
    shapeProblems: completed.filter((result) => result.shapeProblem !== null).length,
    styleFlagCounts,
    mentionsTopTarget: decision.filter((result) => result.mentionsTopTarget).length,
    decisionCases: decision.length,
    timeToFirstTokenMs: distributionOf(completed.map((result) => result.timeToFirstTokenMs)),
    timeToFirstVisibleTokenMs: distributionOf(completed.map((result) => result.timeToFirstVisibleTokenMs)),
    generationTimeMs: distributionOf(completed.map((result) => result.generationTimeMs)),
    tokensPerSecond: distributionOf(completed.map((result) => result.tokensPerSecond)),
    outputTokens: distributionOf(completed.map((result) => result.outputTokens)),
    outputLength: distributionOf(completed.map((result) => result.outputLength)),
    byCategory,
  };
}

export function summarizeRun(run: BenchmarkRun): RunSummary {
  return summarizeResults(run.results);
}
