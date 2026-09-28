/**
 * 決定論的な baseline（templateProvider）を Benchmark Runtime として動かす。
 *
 * モデルを使わない。アプリの fallback と同じ文面を、実モデルと同じ検証・集計に通すことで、
 *
 *   - 比較の基準線（実モデルがこれより良いか）
 *   - 自動検証の誤検出が無いことの確認（Evidence どおりの文面は必ず合格する）
 *
 * の 2 つに使う。ダウンロード・キャッシュは無い。
 */
import {
  explainDecisionDeterministically,
  summarizeSessionDeterministically,
} from '../../templateProvider';
import type {
  BenchmarkCandidate,
  BenchmarkRuntime,
  GenerationRecord,
  GenerationRequest,
  LoadRecord,
} from '../types';

export const TEMPLATE_RUNTIME_ID = 'template';

export function createTemplateRuntime(now: () => number = () => performance.now()): BenchmarkRuntime {
  return {
    id: TEMPLATE_RUNTIME_ID,
    kind: 'deterministic',
    labelJa: '決定論的な説明（template・モデルなし）',
    supports: (candidate: BenchmarkCandidate) => candidate.runtime === 'deterministic',
    isCached: async () => true,
    load: async (candidate): Promise<LoadRecord> => ({
      candidateId: candidate.id,
      kind: 'already-loaded',
      loadTimeMs: 0,
    }),
    generate: async (request: GenerationRequest): Promise<GenerationRecord> => {
      const started = now();
      const input = request.input;
      const output =
        input.kind === 'decision'
          ? explainDecisionDeterministically(input.decision)
          : summarizeSessionDeterministically(input.review);
      const elapsed = now() - started;
      return {
        rawText: output.text,
        promptTokens: null,
        outputTokens: null,
        timeToFirstTokenMs: elapsed,
        timeToFirstVisibleTokenMs: elapsed,
        generationTimeMs: elapsed,
        runtimeDecodeTokensPerSecond: null,
        finishReason: 'stop',
      };
    },
    unload: async () => {},
    deleteCache: async () => {},
    cachedSizeBytes: async () => 0,
  };
}
