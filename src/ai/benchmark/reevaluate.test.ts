/**
 * validator v2（反復・出力の上限・内部の code）の記録・集計と、保存済み run の再評価のテスト。
 *
 * 実モデルは使わない（Mock Runtime と偽の時計）。
 */
import { describe, expect, it } from 'vitest';
import { suggestFor } from '../../engine/recovery/suggest';
import { buildDecisionEvidence } from '../evidence';
import { BASELINE_CANDIDATE } from './candidates';
import { BENCHMARK_VALIDATOR_VERSION } from './checks';
import { assembleDataset } from './dataset';
import { isCleanResponse, summarizeRun } from './metrics';
import { reevaluateRun, reevaluationBlocker } from './reevaluate';
import { runBenchmark } from './runner';
import { createFakeClock, createMockRuntime, faithfulResponse } from './runtimes/mockRuntime';
import type { BenchmarkCandidate, BenchmarkDataset, BenchmarkRun, CaseResult, GenerationRequest } from './types';

const CANDIDATE: BenchmarkCandidate = {
  ...BASELINE_CANDIDATE,
  id: 'fixture-model',
  runtime: 'webllm',
  runtimeModelId: 'fixture-model-id',
};

function dataset(): BenchmarkDataset {
  return assembleDataset({
    id: 'fixture',
    version: 1,
    labelJa: 'fixture',
    drafts: [
      [170, 3],
      [100, 2],
      [301, 3],
      [169, 3],
    ].map(([left, darts]) => ({
      id: `C-${left}-${darts}`,
      category: left > 170 ? 'SETUP' : left === 169 ? 'NEXT_VISIT' : 'CHECKOUT',
      titleJa: `${left}/${darts}`,
      input: { kind: 'decision', decision: buildDecisionEvidence(suggestFor(left, darts)), previousThrow: null },
    })),
  });
}

const ISO = () => '2026-01-01T00:00:00.000Z';
// Evidence（100・2 本）にある的だけの反復。v1 の unsupported claim では見逃していた形。
const RUNAWAY = Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? 'T20' : 'D20')).join('、');

/** 1 件目は忠実、2 件目は反復、3 件目は内部の code、4 件目は忠実。 */
function respond(request: GenerationRequest): string {
  const text = faithfulResponse(request);
  if (request.input.kind !== 'decision') return text;
  if (request.input.decision.remaining === 100) return `${text}${RUNAWAY}`;
  if (request.input.decision.remaining === 301) return `${text}理由は STANDARD_ROUTE です。`;
  return text;
}

async function loadedRuntime(options: Parameters<typeof createMockRuntime>[0] = {}) {
  const runtime = createMockRuntime({ clock: createFakeClock(), cachedCandidateIds: [CANDIDATE.id], respond, ...options });
  await runtime.load(CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
  return runtime;
}

describe('validator v2 の記録と集計', () => {
  it('runner は finish_reason・反復・内部の code・失敗の区分・validator の版・profile を記録する', async () => {
    const run = await runBenchmark({ runtime: await loadedRuntime(), candidate: CANDIDATE, dataset: dataset(), clockIso: ISO });
    expect(run.validatorVersion).toBe(BENCHMARK_VALIDATOR_VERSION);
    expect(run.profile).toEqual({ id: 'STANDARD', version: 1, contextWindowSize: null, stage: null });
    const [first, second, third] = run.results;
    expect(first.finishReason).toBe('stop');
    expect(first.failureCodes).toEqual([]);
    expect(second.failureCodes).toContain('REPETITION');
    expect(second.repetition).not.toBeNull();
    expect(third.failureCodes).toContain('INTERNAL_CODE_LEAK');
    expect(third.internalCodeLeaks).toEqual(['STANDARD_ROUTE']);
  });

  it('Runtime が finish_reason: length を返したら OUTPUT_LIMIT_REACHED（validation pass にしない）', async () => {
    const runtime = await loadedRuntime({ respond: faithfulResponse, finishReason: () => 'length' });
    const run = await runBenchmark({ runtime, candidate: CANDIDATE, dataset: dataset(), clockIso: ISO });
    expect(run.results.every((result) => result.failureCodes?.includes('OUTPUT_LIMIT_REACHED'))).toBe(true);
    expect(run.results.every((result) => !result.validationPassed)).toBe(true);
    expect(summarizeRun(run).withOutputLimit).toBe(4);
  });

  it('集計は各指標を個別に数え、Clean response はすべてを満たすものだけ', async () => {
    const run = await runBenchmark({ runtime: await loadedRuntime(), candidate: CANDIDATE, dataset: dataset(), clockIso: ISO });
    const summary = summarizeRun(run);
    expect(summary.withRepetition).toBe(1);
    expect(summary.withInternalCodeLeak).toBe(1);
    expect(summary.withOutputLimit).toBe(0);
    expect(summary.cleanResponses).toBe(2);
    expect(summary.cleanResponseRate).toBe(0.5);
    expect(summary.failureCodeCounts?.REPETITION).toBe(1);
    expect(summary.failureCodeCounts?.INTERNAL_CODE_LEAK).toBe(1);
    // Clean なら、矛盾・根拠の無い主張・不合格・反復・上限・漏れのどれも無い。
    const clean = run.results.filter((result) => isCleanResponse(result));
    expect(clean.every((result) =>
      result.contradictions.length === 0 && result.unsupportedClaims.length === 0 && result.validationPassed &&
      result.repetition === null && result.outputLimit === null && result.internalCodeLeaks?.length === 0,
    )).toBe(true);
  });

  it('v1 の記録（新しい項目が無い）は、新しい指標を未計測（null）として扱う', async () => {
    const run = await runBenchmark({ runtime: await loadedRuntime(), candidate: CANDIDATE, dataset: dataset(), clockIso: ISO });
    const legacy = asLegacyRun(run);
    const summary = summarizeRun(legacy);
    expect(summary.withRepetition).toBeNull();
    expect(summary.cleanResponses).toBeNull();
    expect(isCleanResponse(legacy.results[0])).toBeNull();
    // 既存の指標は変わらない（v1 は反復・漏れを数えていなかったので、合格は 4 件）。
    expect(summary.validationPassed).toBe(4);
  });
});

/** PR #5 以前の形（validator v1・profile なし・finish_reason なし）に戻した run。 */
function asLegacyRun(run: BenchmarkRun): BenchmarkRun {
  const results = run.results.map((result): CaseResult => {
    const { finishReason: _f, repetition: _r, outputLimit: _o, internalCodeLeaks: _i, failureCodes: _c, ...rest } = result;
    return { ...rest, validationPassed: result.error === null && result.unsupportedClaims.length === 0 && result.contradictions.length === 0 };
  });
  const { validatorVersion: _v, profile: _p, ...rest } = run;
  return { ...rest, results };
}

describe('保存済み run の再評価（モデルを再実行しない）', () => {
  it('rawText から現在の検証で評価し直し、元の run は書き換えない', async () => {
    const ds = dataset();
    const original = asLegacyRun(
      await runBenchmark({ runtime: await loadedRuntime(), candidate: CANDIDATE, dataset: ds, clockIso: ISO }),
    );
    const frozen = JSON.stringify(original);
    const result = reevaluateRun(original, ds, '2026-02-01T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(original)).toBe(frozen);
    expect(result.run.runId).not.toBe(original.runId);
    expect(result.run.validatorVersion).toBe(BENCHMARK_VALIDATOR_VERSION);
    expect(result.run.reevaluation).toEqual({
      originalRunId: original.runId,
      originalValidatorVersion: 1,
      reevaluatedAt: '2026-02-01T00:00:00.000Z',
    });
    // 同じ応答なので応答 ID（人手評価の鍵）は同じ。
    expect(result.run.results.map((item) => item.responseId)).toEqual(original.results.map((item) => item.responseId));
    const summary = summarizeRun(result.run);
    expect(summary.withRepetition).toBe(1);
    expect(summary.withInternalCodeLeak).toBe(1);
    expect(summary.validationPassed).toBe(2);
  });

  it('finish_reason の無い古い記録は、出力トークン数から安全側に上限到達を判断する', async () => {
    const ds = dataset();
    const run = asLegacyRun(
      await runBenchmark({ runtime: await loadedRuntime({ respond: faithfulResponse }), candidate: CANDIDATE, dataset: ds, clockIso: ISO }),
    );
    const truncated: BenchmarkRun = {
      ...run,
      results: run.results.map((item, index) => (index === 0 ? { ...item, outputTokens: 380 } : item)),
    };
    const result = reevaluateRun(truncated, ds, ISO());
    expect(result.ok && result.run.results[0].outputLimit).toEqual({ basis: 'token-count', outputTokens: 380, maxTokens: 384 });
    expect(result.ok && result.run.results[1].outputLimit).toBeNull();
  });

  it('データセットが違う・すでに現在の版・rawText が無いときは再評価しない', async () => {
    const ds = dataset();
    const current = await runBenchmark({ runtime: await loadedRuntime(), candidate: CANDIDATE, dataset: ds, clockIso: ISO });
    expect(reevaluationBlocker(current, ds)).toMatch(/すでに現在の検証/);
    const legacy = asLegacyRun(current);
    expect(reevaluationBlocker(legacy, { ...ds, fingerprint: 'other' })).toMatch(/一致しません/);
    const stripped: BenchmarkRun = { ...legacy, results: legacy.results.map((item) => ({ ...item, rawText: null })) };
    expect(reevaluationBlocker(stripped, ds)).toMatch(/rawText/);
    expect(reevaluateRun(stripped, ds, ISO()).ok).toBe(false);
  });

  it('エラー・タイムアウトのケースはそのまま写す', async () => {
    const ds = dataset();
    const runtime = await loadedRuntime({
      respond: (request) => {
        if (request.input.kind === 'decision' && request.input.decision.remaining === 100) throw new Error('boom');
        return faithfulResponse(request);
      },
    });
    const legacy = asLegacyRun(await runBenchmark({ runtime, candidate: CANDIDATE, dataset: ds, clockIso: ISO }));
    const result = reevaluateRun(legacy, ds, ISO());
    expect(result.ok && result.run.results[1]).toMatchObject({ error: expect.stringContaining('boom'), failureCodes: ['GENERATION_ERROR'] });
  });
});
