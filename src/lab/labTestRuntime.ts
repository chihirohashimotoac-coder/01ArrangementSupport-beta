/**
 * E2E 用の Test Runtime（AI MODEL LAB 限定・実モデルなし）。
 *
 * URL に `?ai-lab-test-runtime=mock` などを付けたときだけ、Lab が**動的 import** で読む（通常は読まない・
 * Service Worker の precache にも入れない。`vite.config.ts` の globIgnores・`scripts/check-base-path.mjs`）。
 * 実モデル・WebLLM・WebGPU を使わずに、Pages 用の成果物の上で Profile・段階・crash checkpoint の流れを確かめる。
 *
 * - `mock`: すべての WebLLM 候補を「保存済み」とする Mock Runtime（応答は決定論的な baseline と同じ文面。少し待ってから返す）
 * - `mock-hang`: 同じだが、4 件目の生成が返らない（タブが生成中に終了した状況を、ページの再読み込みで模擬するため）
 */
import { createMockRuntime, faithfulResponse } from '../ai/benchmark/runtimes/mockRuntime';
import { createTemplateRuntime } from '../ai/benchmark/runtimes/templateRuntime';
import type { BenchmarkCandidate, BenchmarkRuntime } from '../ai/benchmark/types';

export const LAB_TEST_RUNTIME_MODES = ['mock', 'mock-hang'] as const;
export type LabTestRuntimeMode = (typeof LAB_TEST_RUNTIME_MODES)[number];

/** `mock-hang` で返らなくなる生成（0 始まり）。 */
export const HANG_AT_GENERATION = 3;

const RESPONSE_DELAY_MS = 20;

export function createLabTestRuntimes(mode: LabTestRuntimeMode, candidates: readonly BenchmarkCandidate[]): BenchmarkRuntime[] {
  let generations = 0;
  const mock = createMockRuntime({
    id: `lab-test-${mode}`,
    cachedCandidateIds: candidates
      .filter((candidate) => candidate.runtime === 'webllm' && candidate.labAvailability === 'RUNNABLE')
      .map((candidate) => candidate.id),
    respond: (request) => {
      const index = generations;
      generations += 1;
      if (mode === 'mock-hang' && index >= HANG_AT_GENERATION) return new Promise<string>(() => {});
      return new Promise<string>((resolve) => setTimeout(() => resolve(faithfulResponse(request)), RESPONSE_DELAY_MS));
    },
  });
  return [createTemplateRuntime(), mock];
}
