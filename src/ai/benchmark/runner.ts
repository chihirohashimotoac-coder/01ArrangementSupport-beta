/**
 * Benchmark の実行。
 *
 *   読み込み済みの Runtime → ケースごとに同じ prompt で生成 → 自動検証 → 計測値の記録
 *
 * - モデルの取得（download）はここでは始めない。Runtime が読み込み済みであることを前提にし、
 *   読み込みの記録（LoadRecord）は Lab が明示操作で測ったものを受け取る
 * - 1 件の失敗・タイムアウトで全体を止めない（そのケースを error として記録して次へ進む）
 * - 中断（signal）されたら、その時点までの結果を返す
 * - 時刻は `now` から読む（テストでは偽の時計を渡して決定論的にする）
 */
import { BENCHMARK_VALIDATOR_VERSION, inspectOutput } from './checks';
import { fingerprint } from './hash';
import { buildPrompt, PROMPT_VERSION_LABEL } from './prompt';
import type {
  BenchmarkCandidate,
  BenchmarkCase,
  BenchmarkDataset,
  BenchmarkRun,
  BenchmarkRunProfile,
  BenchmarkRuntime,
  CaseResult,
  GenerationRecord,
  GenerationSettings,
  LoadRecord,
} from './types';

/** 01AS の既定。thinking OFF・決定論的なサンプリング・短い出力。 */
export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  thinking: 'off',
  maxTokens: 384,
  temperature: 0,
  seed: 1,
  timeoutMs: 60_000,
};

export interface RunBenchmarkInput {
  readonly runtime: BenchmarkRuntime;
  readonly candidate: BenchmarkCandidate;
  readonly dataset: BenchmarkDataset;
  /** 省略時は dataset の全ケース。 */
  readonly caseIds?: readonly string[];
  readonly settings?: Partial<GenerationSettings>;
  readonly load?: LoadRecord | null;
  readonly modelSizeBytes?: number | null;
  readonly device?: unknown;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /** ISO 時刻。省略時は `new Date(now())`。 */
  readonly clockIso?: () => string;
  /**
   * 実行した Benchmark Profile（`profiles.ts`）の記録。省略時は STANDARD
   * （runner は profile の値を読まない。`settings` は呼び出し側が profile から作って渡す）。
   */
  readonly profile?: BenchmarkRunProfile;
  /** 各ケースの生成を始める直前（crash checkpoint 用。Lab が小さく保存する）。 */
  readonly onCaseStart?: (benchmarkCase: BenchmarkCase, index: number, total: number, runId: string) => void;
  /** 各ケースの生成が返った直後・検証の前（crash checkpoint 用）。 */
  readonly onCaseGenerated?: (benchmarkCase: BenchmarkCase, index: number, total: number, runId: string) => void;
  readonly onCaseComplete?: (result: CaseResult, index: number, total: number) => void;
}

/** profile を渡さない呼び出し（STANDARD と同じ条件）の記録。 */
export const STANDARD_RUN_PROFILE: BenchmarkRunProfile = { id: 'STANDARD', version: 1, contextWindowSize: null, stage: null };

class CaseTimeoutError extends Error {}

export function responseIdOf(runId: string, caseId: string): string {
  return `r-${fingerprint(`${runId}\n${caseId}`)}`;
}

function tokensPerSecondOf(record: GenerationRecord): number | null {
  if (record.runtimeDecodeTokensPerSecond !== null && Number.isFinite(record.runtimeDecodeTokensPerSecond)) {
    return record.runtimeDecodeTokensPerSecond;
  }
  if (record.outputTokens === null || record.outputTokens <= 1) return null;
  const decodeMs = record.generationTimeMs - (record.timeToFirstTokenMs ?? 0);
  return decodeMs > 0 ? ((record.outputTokens - 1) * 1000) / decodeMs : null;
}

function failedResult(
  benchmarkCase: BenchmarkCase,
  promptHash: string,
  responseId: string,
  error: string,
  timedOut: boolean,
): CaseResult {
  return {
    caseId: benchmarkCase.id,
    category: benchmarkCase.category,
    tags: benchmarkCase.tags,
    promptHash,
    responseId,
    text: null,
    rawText: null,
    error,
    timedOut,
    shapeProblem: null,
    unsupportedClaims: [],
    contradictions: [],
    style: null,
    mentionsTopTarget: null,
    validationPassed: false,
    outputLength: null,
    outputTokens: null,
    promptTokens: null,
    timeToFirstTokenMs: null,
    timeToFirstVisibleTokenMs: null,
    generationTimeMs: null,
    tokensPerSecond: null,
    finishReason: null,
    repetition: null,
    outputLimit: null,
    internalCodeLeaks: [],
    failureCodes: [timedOut ? 'TIMEOUT' : 'GENERATION_ERROR'],
  };
}

async function generateWithTimeout(
  runtime: BenchmarkRuntime,
  benchmarkCase: BenchmarkCase,
  messages: ReturnType<typeof buildPrompt>['messages'],
  settings: GenerationSettings,
  outer: AbortSignal | undefined,
): Promise<GenerationRecord> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CaseTimeoutError(`${settings.timeoutMs} ms を超えました。`));
    }, settings.timeoutMs);
  });
  try {
    const pending = Promise.resolve().then(() =>
      runtime.generate({
        messages,
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        seed: settings.seed,
        thinking: settings.thinking,
        signal: controller.signal,
        input: benchmarkCase.input,
      }),
    );
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
}

export async function runBenchmark(input: RunBenchmarkInput): Promise<BenchmarkRun> {
  const now = input.now ?? (() => Date.now());
  const clockIso = input.clockIso ?? (() => new Date(now()).toISOString());
  const settings: GenerationSettings = { ...DEFAULT_GENERATION_SETTINGS, ...input.settings };
  const { runtime, candidate, dataset } = input;
  const selected = input.caseIds
    ? dataset.cases.filter((item) => input.caseIds?.includes(item.id))
    : dataset.cases;

  const startedAt = clockIso();
  const profile = input.profile ?? STANDARD_RUN_PROFILE;
  const profileTag = profile.id === STANDARD_RUN_PROFILE.id ? '' : `|${profile.id}@${profile.version}`;
  const runId = `${candidate.id}|${runtime.id}|thinking-${settings.thinking}${profileTag}|${startedAt}`;
  const results: CaseResult[] = [];
  let aborted = false;

  for (const [index, benchmarkCase] of selected.entries()) {
    if (input.signal?.aborted) {
      aborted = true;
      break;
    }
    const prompt = buildPrompt(benchmarkCase);
    const responseId = responseIdOf(runId, benchmarkCase.id);
    let result: CaseResult;
    input.onCaseStart?.(benchmarkCase, index, selected.length, runId);
    try {
      const record = await generateWithTimeout(runtime, benchmarkCase, prompt.messages, settings, input.signal);
      input.onCaseGenerated?.(benchmarkCase, index, selected.length, runId);
      const evaluation = inspectOutput(record.rawText, benchmarkCase.input, settings.thinking, {
        finishReason: record.finishReason,
        outputTokens: record.outputTokens,
        maxTokens: settings.maxTokens,
      });
      result = {
        caseId: benchmarkCase.id,
        category: benchmarkCase.category,
        tags: benchmarkCase.tags,
        promptHash: prompt.promptHash,
        responseId,
        text: evaluation.text,
        rawText: record.rawText,
        error: null,
        timedOut: false,
        shapeProblem: evaluation.shapeProblem,
        unsupportedClaims: evaluation.unsupportedClaims,
        contradictions: evaluation.contradictions,
        style: evaluation.style,
        mentionsTopTarget: evaluation.mentionsTopTarget,
        validationPassed: evaluation.validationPassed,
        outputLength: evaluation.text.length,
        outputTokens: record.outputTokens,
        promptTokens: record.promptTokens,
        timeToFirstTokenMs: record.timeToFirstTokenMs,
        timeToFirstVisibleTokenMs: record.timeToFirstVisibleTokenMs,
        generationTimeMs: record.generationTimeMs,
        tokensPerSecond: tokensPerSecondOf(record),
        finishReason: record.finishReason,
        repetition: evaluation.repetition,
        outputLimit: evaluation.outputLimit,
        internalCodeLeaks: evaluation.internalCodeLeaks,
        failureCodes: evaluation.failureCodes,
      };
    } catch (error) {
      if (input.signal?.aborted) {
        aborted = true;
        break;
      }
      const timedOut = error instanceof CaseTimeoutError;
      result = failedResult(benchmarkCase, prompt.promptHash, responseId, String(error), timedOut);
    }
    results.push(result);
    input.onCaseComplete?.(result, index, selected.length);
    // 中止を頼まれたあとで生成が普通に返っても（Runtime がすぐ止まらないことがある）、中止として終える
    // （最後のケースで中止した run を、中止されなかった run にしない）。
    if (input.signal?.aborted) {
      aborted = true;
      break;
    }
  }

  return {
    schema: '01as-ai-benchmark-run',
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt: clockIso(),
    candidateId: candidate.id,
    runtimeId: runtime.id,
    runtimeModelId: candidate.runtimeModelId,
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    datasetFingerprint: dataset.fingerprint,
    promptVersion: PROMPT_VERSION_LABEL,
    settings,
    load: input.load ?? null,
    modelSizeBytes: input.modelSizeBytes ?? candidate.downloadSizeBytes,
    estimatedVramBytes: candidate.estimatedVramBytes,
    device: input.device ?? null,
    aborted,
    results,
    validatorVersion: BENCHMARK_VALIDATOR_VERSION,
    profile,
  };
}
