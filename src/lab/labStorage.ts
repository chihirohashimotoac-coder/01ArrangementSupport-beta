/**
 * AI MODEL LAB の保存（Beta の名前空間だけ）。
 *
 * - キーは必ず `namespacedKey()`（`01as-beta:`）で作り、`storage/localJson.ts` を通す
 * - 保存するのは Benchmark の結果と人手評価、保存容量の診断の結果（数値だけ）。AI モデルのファイル・診断のテストデータは保存しない
 *   （モデルは Runtime の保存領域。既定は OPFS の `tvmjs-opfs-store/webllm/*`。`docs/AI_MODEL_STORAGE.md`）
 * - モデルの削除はこの保存領域に触れない（人手評価・結果は残る）
 * - 利用者データ（設定・TRAINING 履歴・SIMULATION 設定）とは別のキー
 */
import {
  sanitizeRatings,
  type HumanRating,
  type HumanRatings,
} from '../ai/benchmark/export';
import type { BenchmarkRun } from '../ai/benchmark/types';
import { readJson, removeKey, writeJson } from '../storage/localJson';
import { namespacedKey } from '../storage/namespace';
import { DIAGNOSTIC_BACKENDS } from '../storageDiagnostics/constants';
import type { StorageDiagnosticResult } from '../storageDiagnostics/types';

export const BENCHMARK_RATINGS_KEY = namespacedKey('ai.benchmark.ratings.v1');
export const BENCHMARK_RUNS_KEY = namespacedKey('ai.benchmark.runs.v1');

/** localStorage の容量を圧迫しないよう、保存する run は直近のこの件数まで。 */
export const MAX_STORED_RUNS = 5;

function isRun(value: unknown): value is BenchmarkRun {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Partial<BenchmarkRun>;
  return run.schema === '01as-ai-benchmark-run' && run.schemaVersion === 1 &&
    typeof run.runId === 'string' && Array.isArray(run.results);
}

export function loadRatings(): HumanRatings {
  const stored = readJson<unknown>(BENCHMARK_RATINGS_KEY, null);
  if (typeof stored !== 'object' || stored === null || (stored as { version?: unknown }).version !== 1) return {};
  return sanitizeRatings((stored as { ratings?: unknown }).ratings);
}

export function saveRating(responseId: string, rating: HumanRating): HumanRatings {
  const next = sanitizeRatings({ ...loadRatings(), [responseId]: rating });
  writeJson(BENCHMARK_RATINGS_KEY, { version: 1, ratings: next });
  return next;
}

export function loadRuns(): BenchmarkRun[] {
  const stored = readJson<unknown>(BENCHMARK_RUNS_KEY, null);
  if (typeof stored !== 'object' || stored === null || (stored as { version?: unknown }).version !== 1) return [];
  const runs = (stored as { runs?: unknown }).runs;
  return Array.isArray(runs) ? runs.filter(isRun) : [];
}

/** 新しい run を先頭に足して保存する。保存できなかったら false（画面の結果はそのまま使える）。 */
export function saveRun(run: BenchmarkRun): { runs: BenchmarkRun[]; saved: boolean } {
  const runs = [run, ...loadRuns().filter((item) => item.runId !== run.runId)].slice(0, MAX_STORED_RUNS);
  return { runs, saved: writeJson(BENCHMARK_RUNS_KEY, { version: 1, runs }) };
}

export function deleteRun(runId: string): BenchmarkRun[] {
  const runs = loadRuns().filter((run) => run.runId !== runId);
  writeJson(BENCHMARK_RUNS_KEY, { version: 1, runs });
  return runs;
}

// ---------------------------------------------------------------------------
// BROWSER STORAGE DIAGNOSTICS の結果（数値と文字列だけ。テストデータそのものは保存しない）
// ---------------------------------------------------------------------------

/**
 * 診断の結果。ページを再読み込みしてから次の方式を測る手順（削除が usage に反映されないとき）でも
 * 3 方式を比べられるよう、再読み込みをまたいで残す。
 */
export const STORAGE_DIAGNOSTIC_RESULTS_KEY = namespacedKey('ai.storage-diagnostic.results.v1');
export const MAX_STORED_DIAGNOSTIC_RESULTS = 30;

function isDiagnosticResult(value: unknown): value is StorageDiagnosticResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<StorageDiagnosticResult>;
  return (DIAGNOSTIC_BACKENDS as readonly unknown[]).includes(result.backend) &&
    (result.status === 'success' || result.status === 'failed' || result.status === 'aborted') &&
    typeof result.targetBytes === 'number' && typeof result.writtenBytes === 'number' &&
    typeof result.startedAt === 'string' && typeof result.cleanup === 'object' && result.cleanup !== null;
}

export function loadDiagnosticResults(): StorageDiagnosticResult[] {
  const stored = readJson<unknown>(STORAGE_DIAGNOSTIC_RESULTS_KEY, null);
  if (typeof stored !== 'object' || stored === null || (stored as { version?: unknown }).version !== 1) return [];
  const results = (stored as { results?: unknown }).results;
  return Array.isArray(results) ? results.filter(isDiagnosticResult) : [];
}

/** 結果を古い順で保存する（直近 MAX 件）。保存できなかったら false（画面の結果はそのまま使える）。 */
export function saveDiagnosticResults(results: readonly StorageDiagnosticResult[]): boolean {
  return writeJson(STORAGE_DIAGNOSTIC_RESULTS_KEY, { version: 1, results: results.slice(-MAX_STORED_DIAGNOSTIC_RESULTS) });
}

export function clearDiagnosticResults(): void {
  removeKey(STORAGE_DIAGNOSTIC_RESULTS_KEY);
}
