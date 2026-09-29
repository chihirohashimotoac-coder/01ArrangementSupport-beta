/**
 * Benchmark Profile（AI MODEL LAB 限定の実行条件）。
 *
 * - `STANDARD`: これまでと同じ条件（max_tokens 384・context window は Runtime の既定）。品質の benchmark
 * - `MOBILE_FEASIBILITY`: スマートフォン（iPhone の WebKit など）で、モデルを**安定して読み込み・生成できるか**を確かめる条件。
 *   品質の benchmark ではない。GPU メモリを抑えるため、WebLLM 0.2.85 が公式に上書きを許す
 *   `context_window_size`（KV cache の大きさを決める。`reload(modelId, chatOpts)` で渡す）を小さくし、
 *   max_tokens も短くする
 *
 * **profile が違う run どうしは同じ benchmark として比べない。** run に `profile`（id・version）を記録し、
 * 画面・export でも区別する（`runProfileOf`・`export.ts`）。
 *
 * 値の根拠（docs/AI_MODEL_BENCHMARK.md 10 節）:
 *
 * - context window は、prompt（候補の tokenizer で数えた最大値）＋ max_tokens ＋ 余裕（`PROMPT_TOKEN_SAFETY_MARGIN`）が
 *   収まる値にする（`profileFitsCandidate`）。01AS Core v1 の最大 1659 tokens ＋ 192 ＋ 64 = 1915 ≤ 2048
 * - WebLLM 0.2.85 の KV cache（`create_tir_paged_kv_cache`）は context window 分を**読み込み時に確保**するので、
 *   4096 → 2048 で KV cache は半分になる
 * - `prefill_chunk_size` はモデルの wasm（metadata）で固定され、WebLLM 0.2.85 では上書きできない（使わない）
 * - `sliding_window_size` は上書きできるが、prompt が context に収まるので使う理由が無く、注意の範囲が変わるので使わない
 *
 * ここはモデルの呼び出し・保存をしない（条件と判定の純粋な関数だけ）。
 */
import { classifyModelLoadFailure } from './modelLoadFailure';
import { PROMPT_VERSION_LABEL } from './prompt';
import { DEFAULT_GENERATION_SETTINGS, STANDARD_RUN_PROFILE } from './runner';
import {
  BENCHMARK_CATEGORIES,
  type BenchmarkCandidate,
  type BenchmarkDataset,
  type BenchmarkRun,
  type BenchmarkRunProfile,
  type GenerationSettings,
  type LoadRecord,
} from './types';

export const BENCHMARK_PROFILE_IDS = ['STANDARD', 'MOBILE_FEASIBILITY'] as const;
export type BenchmarkProfileId = (typeof BENCHMARK_PROFILE_IDS)[number];

export interface BenchmarkProfile {
  readonly id: BenchmarkProfileId;
  /** 値を変えたら上げる。版が違う run どうしも比べない。 */
  readonly version: number;
  readonly labelJa: string;
  readonly purposeJa: string;
  /** 品質の比較に使える benchmark か（MOBILE_FEASIBILITY は動作確認で、品質の比較には使わない）。 */
  readonly qualityBenchmark: boolean;
  readonly maxTokens: number;
  /** Runtime に渡す context window。null は Runtime の既定（WebLLM の prebuilt の設定。候補の `contextWindow`）のまま。 */
  readonly contextWindowSize: number | null;
  /** LOAD ONLY → 1 CASE → QUICK 10 → FULL 100 の段階制で実行するか。 */
  readonly staged: boolean;
}

export const STANDARD_PROFILE: BenchmarkProfile = {
  id: 'STANDARD',
  version: STANDARD_RUN_PROFILE.version,
  labelJa: 'STANDARD（これまでと同じ条件・品質の benchmark）',
  purposeJa: '候補モデルの説明の品質を、同じ条件で比べる。',
  qualityBenchmark: true,
  maxTokens: DEFAULT_GENERATION_SETTINGS.maxTokens,
  contextWindowSize: null,
  staged: false,
};

export const MOBILE_FEASIBILITY_PROFILE: BenchmarkProfile = {
  id: 'MOBILE_FEASIBILITY',
  version: 1,
  labelJa: 'MOBILE_FEASIBILITY（スマートフォンでの動作確認・品質の benchmark ではない）',
  purposeJa:
    'スマートフォンで、モデルを安定して読み込み・生成できるかを確かめる。context window と出力の上限を小さくして GPU メモリを抑える。結果は STANDARD と直接比べない。',
  qualityBenchmark: false,
  maxTokens: 192,
  contextWindowSize: 2048,
  staged: true,
};

export const BENCHMARK_PROFILES: readonly BenchmarkProfile[] = [STANDARD_PROFILE, MOBILE_FEASIBILITY_PROFILE];

export function profileById(id: string): BenchmarkProfile | null {
  return BENCHMARK_PROFILES.find((profile) => profile.id === id) ?? null;
}

/** context window に、prompt ＋ 出力のほかに残す余裕（chat template の差・計測のずれ）。 */
export const PROMPT_TOKEN_SAFETY_MARGIN = 64;

/** profile から生成の設定を作る（thinking などは呼び出し側が重ねる）。 */
export function profileGenerationSettings(profile: BenchmarkProfile): Partial<GenerationSettings> {
  return { maxTokens: profile.maxTokens };
}

/** run に記録する profile。 */
export function runProfile(profile: BenchmarkProfile, stage: FeasibilityStage | null): BenchmarkRunProfile {
  return { id: profile.id, version: profile.version, contextWindowSize: profile.contextWindowSize, stage };
}

/**
 * run の profile。PR #5 以前の run は profile を記録していないが、STANDARD と同じ条件（max_tokens 384・
 * context window は既定）で実行したので STANDARD v1 として扱い、`recorded: false` を付ける。
 */
export function runProfileOf(run: BenchmarkRun): BenchmarkRunProfile & { readonly recorded: boolean } {
  return run.profile ? { ...run.profile, recorded: true } : { ...STANDARD_RUN_PROFILE, recorded: false };
}

export function profileKey(profile: Pick<BenchmarkRunProfile, 'id' | 'version'>): string {
  return `${profile.id}@${profile.version}`;
}

/** run の profile の表示（例: `MOBILE_FEASIBILITY v1 / context 2048 / QUICK_10`）。 */
export function describeRunProfile(run: BenchmarkRun): string {
  const profile = runProfileOf(run);
  return [
    `${profile.id} v${profile.version}`,
    `context ${profile.contextWindowSize ?? '既定'}`,
    `max_tokens ${run.settings.maxTokens}`,
    ...(profile.stage ? [profile.stage] : []),
    ...(profile.recorded ? [] : ['profile の記録なし（PR #5 以前の run。STANDARD と同じ条件）']),
  ].join(' / ');
}

/** 同じ benchmark として比べてよいか（profile の id と version が同じ）。 */
export function sameBenchmarkProfile(runs: readonly BenchmarkRun[]): boolean {
  return new Set(runs.map((run) => profileKey(runProfileOf(run)))).size <= 1;
}

export type ProfileFit = { readonly ok: true } | { readonly ok: false; readonly reasonJa: string };

/**
 * その候補に profile を使えるか。context window を小さくする profile では、候補の tokenizer で数えた
 * prompt の最大 token 数 ＋ max_tokens ＋ 余裕が context window に収まることを確かめる（context 不足で失敗させない）。
 */
export function profileFitsCandidate(
  profile: BenchmarkProfile,
  candidate: BenchmarkCandidate,
  dataset: Pick<BenchmarkDataset, 'fingerprint'> | null,
): ProfileFit {
  if (profile.contextWindowSize === null || candidate.runtime === 'deterministic') return { ok: true };
  const measurement = candidate.promptTokenMeasurement;
  if (!measurement) {
    return { ok: false, reasonJa: `${candidate.displayName} の prompt token 数は未計測のため、context window を小さくする profile は使えません。` };
  }
  if (measurement.promptVersion !== PROMPT_VERSION_LABEL ||
    (dataset !== null && measurement.datasetFingerprint !== dataset.fingerprint)) {
    return { ok: false, reasonJa: 'prompt token 数を数えたときと、データセット・prompt の版が違います。数え直すまで使えません。' };
  }
  const needed = measurement.maxTokens + profile.maxTokens + PROMPT_TOKEN_SAFETY_MARGIN;
  if (needed > profile.contextWindowSize) {
    return {
      ok: false,
      reasonJa: `prompt の最大 ${measurement.maxTokens} tokens ＋ 出力 ${profile.maxTokens} ＋ 余裕 ${PROMPT_TOKEN_SAFETY_MARGIN} が context window ${profile.contextWindowSize} に収まりません。`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MOBILE_FEASIBILITY の段階制
// ---------------------------------------------------------------------------

/** LOAD ONLY → 1 CASE → QUICK 10 → FULL 100。いきなり 100 件を走らせない。 */
export const FEASIBILITY_STAGES = ['LOAD_ONLY', 'ONE_CASE', 'QUICK_10', 'FULL_100'] as const;
export type FeasibilityStage = (typeof FEASIBILITY_STAGES)[number];

export const FEASIBILITY_STAGE_LABEL: Readonly<Record<FeasibilityStage, string>> = {
  LOAD_ONLY: 'LOAD ONLY',
  ONE_CASE: '1 CASE',
  QUICK_10: 'QUICK 10 CASES',
  FULL_100: 'FULL 100',
};

/** 各カテゴリの先頭 2 件（計 10 件）。 */
export function quickCaseIds(dataset: BenchmarkDataset): string[] {
  return BENCHMARK_CATEGORIES.flatMap((category) =>
    dataset.cases.filter((item) => item.category === category).slice(0, 2).map((item) => item.id),
  );
}

/** 段階で実行するケース。LOAD ONLY は生成しない（空）。1 CASE はクイックの 1 件目。 */
export function stageCaseIds(stage: FeasibilityStage, dataset: BenchmarkDataset): string[] {
  switch (stage) {
    case 'LOAD_ONLY':
      return [];
    case 'ONE_CASE':
      return quickCaseIds(dataset).slice(0, 1);
    case 'QUICK_10':
      return quickCaseIds(dataset);
    case 'FULL_100':
      return dataset.cases.map((item) => item.id);
  }
}

/**
 * 段階の結果（Lab に小さく保存する）。
 *
 * - `success`: 読み込み（と生成）が最後まで返った。生成したケースにエラー・タイムアウトが無い（品質の合否は問わない）
 * - `failed`: 読み込みの失敗・生成のエラー / タイムアウトがあった
 * - `aborted`: 利用者が中止した
 * - `incomplete`: 前回の実行が正常終了しなかった（crash checkpoint が残っていた）。**原因は断定しない**
 */
export interface StageRecord {
  readonly stage: FeasibilityStage;
  readonly status: 'success' | 'failed' | 'aborted' | 'incomplete';
  readonly at: string;
  readonly loadKind: LoadRecord['kind'] | null;
  readonly loadTimeMs: number | null;
  readonly casesTotal: number;
  readonly casesCompleted: number;
  readonly errors: number;
  readonly timeouts: number;
  /** GPU の失敗（device lost・WebGPU のエラー）と分類した失敗があったか。 */
  readonly gpuError: boolean;
  readonly detail: string | null;
  readonly runId: string | null;
}

function isGpuFailure(message: string): boolean {
  return classifyModelLoadFailure({ message }, { backend: null, aborted: false }) === 'gpu-load-failed';
}

/** 読み込み（LOAD ONLY、または段階の最初の読み込み）の失敗から記録を作る。 */
export function stageRecordFromLoadFailure(
  stage: FeasibilityStage,
  error: { readonly failureClass: string; readonly message: string },
  at: string,
  aborted: boolean,
): StageRecord {
  return {
    stage,
    status: aborted ? 'aborted' : 'failed',
    at,
    loadKind: null,
    loadTimeMs: null,
    casesTotal: 0,
    casesCompleted: 0,
    errors: 0,
    timeouts: 0,
    gpuError: error.failureClass === 'gpu-load-failed',
    detail: `${error.failureClass}: ${error.message}`,
    runId: null,
  };
}

/** LOAD ONLY の成功。 */
export function stageRecordFromLoad(load: LoadRecord, at: string): StageRecord {
  return {
    stage: 'LOAD_ONLY',
    status: 'success',
    at,
    loadKind: load.kind,
    loadTimeMs: load.loadTimeMs,
    casesTotal: 0,
    casesCompleted: 0,
    errors: 0,
    timeouts: 0,
    gpuError: false,
    detail: null,
    runId: null,
  };
}

/**
 * 生成を伴う段階（1 CASE / QUICK 10 / FULL 100）の結果。
 * `plannedCases` はその段階で実行する予定だったケース数（`stageCaseIds(stage, dataset).length`）。
 * 中止すると run には終わったケースだけが入るので、合計は予定の数で記録する（例: 3 / 10 件）。
 */
export function stageRecordFromRun(stage: FeasibilityStage, run: BenchmarkRun, at: string, plannedCases: number): StageRecord {
  const errors = run.results.filter((result) => result.error !== null && !result.timedOut);
  const timeouts = run.results.filter((result) => result.timedOut).length;
  const failed = errors.length > 0 || timeouts > 0 || run.results.length < plannedCases;
  return {
    stage,
    status: run.aborted ? 'aborted' : failed ? 'failed' : 'success',
    at,
    loadKind: run.load?.kind ?? null,
    loadTimeMs: run.load?.loadTimeMs ?? null,
    casesTotal: plannedCases,
    casesCompleted: run.results.filter((result) => result.error === null && !result.timedOut).length,
    errors: errors.length,
    timeouts,
    gpuError: errors.some((result) => isGpuFailure(result.error ?? '')),
    detail: errors[0]?.error ?? (timeouts > 0 ? `${timeouts} 件がタイムアウト` : null),
    runId: run.runId,
  };
}

export interface StageAdvice {
  readonly stage: FeasibilityStage;
  /** 実行を推奨するか。false でも実行はできるが、確認を挟む。 */
  readonly recommended: boolean;
  readonly reasonsJa: readonly string[];
  readonly last: StageRecord | null;
}

const STATUS_LABEL: Readonly<Record<StageRecord['status'], string>> = {
  success: '成功',
  failed: '失敗',
  aborted: '中止',
  incomplete: '正常終了しなかった',
};

/**
 * 各段階を推奨するか。次のどれかがあれば、次の段階へ進むことを推奨しない（実行は確認を挟めばできる）。
 *
 * - 前の段階が未実施・失敗・中止・正常終了しなかった（読み込みの失敗・1 件の失敗を含む）
 * - 前回の run の checkpoint が正常終了せずに残っている
 * - device lost・GPU の失敗を記録している
 */
export function adviseStages(records: readonly StageRecord[], staleCheckpoint: boolean): StageAdvice[] {
  const lastOf = (stage: FeasibilityStage): StageRecord | null =>
    [...records].reverse().find((record) => record.stage === stage) ?? null;
  const global: string[] = [];
  if (staleCheckpoint) global.push('前回の Benchmark が正常終了せず、checkpoint が残っています（先に内容を確認してください）。');
  if (records.some((record) => record.gpuError)) global.push('device lost・GPU の失敗を記録しています。');
  return FEASIBILITY_STAGES.map((stage, index) => {
    const reasonsJa = [...global];
    if (index > 0) {
      const previous = FEASIBILITY_STAGES[index - 1];
      const before = lastOf(previous);
      if (before === null) reasonsJa.push(`${FEASIBILITY_STAGE_LABEL[previous]} がまだ成功していません。`);
      else if (before.status !== 'success') {
        reasonsJa.push(`直前の ${FEASIBILITY_STAGE_LABEL[previous]} の結果が「${STATUS_LABEL[before.status]}」です。`);
      }
    }
    return { stage, recommended: reasonsJa.length === 0, reasonsJa, last: lastOf(stage) };
  });
}

export function stageStatusLabel(status: StageRecord['status']): string {
  return STATUS_LABEL[status];
}
