/**
 * 保存済みの Benchmark run を、**モデルを再実行せずに**現在の自動検証で評価し直す。
 *
 * - 元の run は書き換えない。評価し直した結果は新しい run（`reevaluation.originalRunId` 付き）として返す
 * - 使うのは run に残っている生の応答（`rawText`）と、run を作ったデータセットの Evidence だけ
 *   （データセットの ID・版・指紋が一致しなければ評価しない。別の Evidence で測り直すことになるため）
 * - finish_reason は PR #5 以前の記録に無い。その場合、出力の上限は出力トークン数と run の max_tokens から
 *   安全側に判断する（`detectOutputLimit` の `token-count`）
 * - 応答が返らなかったケース（エラー・タイムアウト）は、そのまま写す
 * - 応答 ID（responseId）は元の run と同じにする（同じ応答なので人手評価をそのまま使える）
 */
import { BENCHMARK_VALIDATOR_VERSION, inspectOutput } from './checks';
import { datasetMatchingRun } from './export';
import type { BenchmarkDataset, BenchmarkRun, CaseResult } from './types';

export type ReevaluationResult =
  | { readonly ok: true; readonly run: BenchmarkRun; readonly reevaluatedCases: number }
  | { readonly ok: false; readonly reasonJa: string };

/** 再評価できるか（できなければ理由）。 */
export function reevaluationBlocker(run: BenchmarkRun, dataset: BenchmarkDataset | null): string | null {
  if ((run.validatorVersion ?? 1) >= BENCHMARK_VALIDATOR_VERSION) {
    return `この run はすでに現在の検証（validator v${BENCHMARK_VALIDATOR_VERSION}）で評価されています。`;
  }
  if (datasetMatchingRun(dataset, run) === null) {
    return 'この run を作ったデータセット（ID・版・指紋）と、いまのデータセットが一致しません。Evidence が違うので再評価しません。';
  }
  const missing = run.results.filter((result) => result.error === null && !result.timedOut && result.rawText === null);
  if (missing.length > 0) {
    return `生の応答（rawText）が残っていないケースがあります（${missing.length} 件）。`;
  }
  return null;
}

export function reevaluateRun(run: BenchmarkRun, dataset: BenchmarkDataset | null, reevaluatedAt: string): ReevaluationResult {
  const blocker = reevaluationBlocker(run, dataset);
  if (blocker !== null || dataset === null) return { ok: false, reasonJa: blocker ?? 'データセットがありません。' };
  const casesById = new Map(dataset.cases.map((item) => [item.id, item]));
  let reevaluatedCases = 0;
  const results: CaseResult[] = [];
  for (const result of run.results) {
    const benchmarkCase = casesById.get(result.caseId);
    if (result.error !== null || result.timedOut || result.rawText === null) {
      results.push({
        ...result,
        finishReason: result.finishReason ?? null,
        repetition: null,
        outputLimit: null,
        internalCodeLeaks: [],
        failureCodes: [result.timedOut ? 'TIMEOUT' : 'GENERATION_ERROR'],
      });
      continue;
    }
    if (!benchmarkCase) return { ok: false, reasonJa: `データセットにケース ${result.caseId} がありません。` };
    const finishReason = result.finishReason ?? null;
    const evaluation = inspectOutput(result.rawText, benchmarkCase.input, run.settings.thinking, {
      finishReason,
      outputTokens: result.outputTokens,
      maxTokens: run.settings.maxTokens,
    });
    reevaluatedCases += 1;
    results.push({
      ...result,
      text: evaluation.text,
      shapeProblem: evaluation.shapeProblem,
      unsupportedClaims: evaluation.unsupportedClaims,
      contradictions: evaluation.contradictions,
      style: evaluation.style,
      mentionsTopTarget: evaluation.mentionsTopTarget,
      validationPassed: evaluation.validationPassed,
      outputLength: evaluation.text.length,
      finishReason,
      repetition: evaluation.repetition,
      outputLimit: evaluation.outputLimit,
      internalCodeLeaks: evaluation.internalCodeLeaks,
      failureCodes: evaluation.failureCodes,
    });
  }
  const originalValidatorVersion = run.validatorVersion ?? 1;
  return {
    ok: true,
    reevaluatedCases,
    run: {
      ...run,
      runId: `${run.runId}|reeval-v${BENCHMARK_VALIDATOR_VERSION}|${reevaluatedAt}`,
      results,
      validatorVersion: BENCHMARK_VALIDATOR_VERSION,
      reevaluation: { originalRunId: run.runId, originalValidatorVersion, reevaluatedAt },
    },
  };
}
