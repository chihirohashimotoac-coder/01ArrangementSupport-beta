/**
 * Benchmark Lab の実行・集計・export・端末判定・Runtime のテスト。
 *
 * **実モデルは取得しない。** Mock Runtime（Fake Model）と偽の時計で決定論的に確かめる。
 * WebLLM の Runtime も偽のモジュールで動かし、実際の WebLLM・WebGPU・通信は使わない。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as webllm from '@mlc-ai/web-llm';
import { suggestFor } from '../../engine/recovery/suggest';
import { buildDecisionEvidence } from '../evidence';
import { BASELINE_CANDIDATE, BENCHMARK_CANDIDATES, WEBLLM_CONFIG_VERSION, candidateById } from './candidates';
import { assembleDataset } from './dataset';
import { judgeCompatibility, probeDevice, type DeviceReport } from './device';
import { buildJsonExport, buildRatingCsv, csvCell, datasetMatchingRun, sanitizeRatings, summarizeRatings } from './export';
import { distributionOf, percentile, summarizeRun } from './metrics';
import { buildPrompt, PROMPT_VERSION_LABEL, SYSTEM_PROMPT } from './prompt';
import { runBenchmark } from './runner';
import { createFakeClock, createMockRuntime, faithfulResponse } from './runtimes/mockRuntime';
import { createTemplateRuntime } from './runtimes/templateRuntime';
import { createWebLlmRuntime, type WebLlmModuleLike } from './runtimes/webllmRuntime';
import type { BenchmarkCandidate, BenchmarkDataset, GenerationRequest } from './types';

const ROOT = resolve(__dirname, '../../..');

const FAKE_CANDIDATE: BenchmarkCandidate = {
  ...BASELINE_CANDIDATE,
  id: 'fixture-model',
  displayName: 'Fixture model',
  runtime: 'webllm',
  runtimeModelId: 'fixture-model-id',
  estimatedVramBytes: 2 * 1024 ** 3,
  downloadSizeBytes: null,
  lowResourceRequired: true,
};

function smallDataset(): BenchmarkDataset {
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

describe('prompt', () => {
  it('同じケースからは同じ messages・同じ指紋になり、版が記録される', () => {
    const [first] = smallDataset().cases;
    const again = smallDataset().cases[0];
    expect(buildPrompt(first)).toEqual(buildPrompt(again));
    expect(buildPrompt(first).promptVersion).toBe(PROMPT_VERSION_LABEL);
    expect(buildPrompt(first).messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
  });

  it('戦術判断をさせない指示と、Evidence だけを含む', () => {
    expect(SYSTEM_PROMPT).toContain('新しいルート、新しい評価、新しい得点、新しい戦術判断を追加してはいけません。');
    expect(SYSTEM_PROMPT).toContain('この Evidence に含まれる情報だけを使用してください。');
    const user = buildPrompt(smallDataset().cases[0]).messages[1].content;
    expect(user).toContain('<evidence>');
    // engine の内部値（重み・スコア）は Evidence に無いので prompt にも無い。
    expect(user).not.toMatch(/tacticalScore|weight|"key"/);
  });

  it('ケースが違えば指紋も違う', () => {
    const hashes = smallDataset().cases.map((item) => buildPrompt(item).promptHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('runner（Mock Runtime）', () => {
  it('忠実な出力はすべて合格し、計測値が決定論的に記録される', async () => {
    const clock = createFakeClock();
    const runtime = createMockRuntime({ clock, cachedCandidateIds: [FAKE_CANDIDATE.id] });
    const load = await runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
    expect(load.kind).toBe('cache-cold');
    const run = await runBenchmark({ runtime, candidate: FAKE_CANDIDATE, dataset: smallDataset(), load, now: clock.now, clockIso: ISO });
    const summary = summarizeRun(run);
    expect(summary.validationPassed).toBe(4);
    expect(summary.engineContradictionRate).toBe(0);
    expect(summary.unsupportedClaimRate).toBe(0);
    expect(summary.timeToFirstTokenMs.mean).toBe(100);
    expect(run.results.every((result) => result.tokensPerSecond !== null && result.tokensPerSecond > 0)).toBe(true);
    expect(run.datasetFingerprint).toBe(smallDataset().fingerprint);
    expect(run.settings.thinking).toBe('off');
    // 同じ入力・同じ時計なら同じ結果。
    const clock2 = createFakeClock();
    const runtime2 = createMockRuntime({ clock: clock2, cachedCandidateIds: [FAKE_CANDIDATE.id] });
    const load2 = await runtime2.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
    const again = await runBenchmark({ runtime: runtime2, candidate: FAKE_CANDIDATE, dataset: smallDataset(), load: load2, now: clock2.now, clockIso: ISO });
    expect(again).toEqual(run);
  });

  it('根拠の無い主張・矛盾・エラー・タイムアウトを数え、1 件の失敗で止まらない', async () => {
    const clock = createFakeClock();
    const respond = (request: GenerationRequest): string | Promise<string> => {
      const id = request.input.kind === 'decision' ? request.input.decision.remaining : 0;
      if (id === 170) return 'T19 → T19 → BULL で上がります。推奨度 C です。';
      if (id === 100) return '第 1 候補は BULL → BULL です。';
      if (id === 301) throw new Error('GPU device lost');
      return new Promise<string>(() => {});
    };
    const runtime = createMockRuntime({ clock, respond, cachedCandidateIds: [FAKE_CANDIDATE.id] });
    await runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
    const run = await runBenchmark({
      runtime,
      candidate: FAKE_CANDIDATE,
      dataset: smallDataset(),
      settings: { timeoutMs: 20 },
      now: clock.now,
      clockIso: ISO,
    });
    const summary = summarizeRun(run);
    expect(run.results).toHaveLength(4);
    expect(summary.withUnsupportedClaims).toBe(1);
    expect(summary.withContradictions).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.timeouts).toBe(1);
    expect(summary.validationPassed).toBe(0);
    expect(summary.validationFailureRate).toBe(1);
    expect(summary.byCategory.CHECKOUT).toMatchObject({ total: 2, withUnsupportedClaims: 1, withContradictions: 1 });
  });

  it('中断するとその時点までの結果を返す', async () => {
    const controller = new AbortController();
    const runtime = createMockRuntime({ cachedCandidateIds: [FAKE_CANDIDATE.id] });
    await runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: controller.signal });
    const run = await runBenchmark({
      runtime,
      candidate: FAKE_CANDIDATE,
      dataset: smallDataset(),
      signal: controller.signal,
      onCaseComplete: (_, index) => {
        if (index === 1) controller.abort();
      },
    });
    expect(run.aborted).toBe(true);
    expect(run.results).toHaveLength(2);
  });

  it('明示操作（allowDownload）なしにモデルを取得しない', async () => {
    const runtime = createMockRuntime();
    await expect(
      runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'not-downloaded' });
    expect(runtime.log).toEqual([]);
    const record = await runtime.load(FAKE_CANDIDATE, { allowDownload: true, signal: new AbortController().signal });
    expect(record.kind).toBe('download');
    await runtime.unload();
    expect((await runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal })).kind).toBe('cache-warm');
  });

  it('決定論的な baseline（template）は全件合格する', async () => {
    const run = await runBenchmark({
      runtime: createTemplateRuntime(() => 0),
      candidate: BASELINE_CANDIDATE,
      dataset: smallDataset(),
      clockIso: ISO,
    });
    expect(summarizeRun(run).validationPassed).toBe(4);
  });
});

describe('集計', () => {
  it('分位点は最近傍順位法', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([], 0.5)).toBeNull();
    expect(distributionOf([3, null, 1, 2])).toEqual({ count: 3, mean: 2, p50: 2, p95: 3, max: 3 });
  });
});

describe('export と人手評価', () => {
  async function sampleRun() {
    const runtime = createMockRuntime({ cachedCandidateIds: [FAKE_CANDIDATE.id], respond: faithfulResponse });
    await runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
    return runBenchmark({ runtime, candidate: FAKE_CANDIDATE, dataset: smallDataset(), clockIso: ISO });
  }

  it('CSV は 1 行 1 応答で、5 項目の評価欄と保存済みの評価を持つ', async () => {
    const run = await sampleRun();
    const first = run.results[0].responseId;
    const csv = buildRatingCsv([run], { [first]: { japaneseNaturalness: 4, clarity: 5, note: 'よい, 短い' } });
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines).toHaveLength(1 + run.results.length);
    expect(lines[0]).toContain('rating_japanese_naturalness,rating_clarity,rating_conciseness,rating_educational_value,rating_darts_player_naturalness,rater_note');
    expect(lines[0]).toContain('candidate_id');
    expect(csv).toContain('"よい, 短い"');
  });

  it('blind ではモデル・Runtime・run を伏せる', async () => {
    const run = await sampleRun();
    const csv = buildRatingCsv([run], {}, { blind: true });
    expect(csv).not.toContain('fixture-model');
    expect(csv).not.toContain('candidate_id');
    expect(csv).not.toContain(run.runId);
  });

  it('CSV のセルは式として解釈されない', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1')).toBe("'-1");
  });

  it('JSON にはデータセット・集計・その run の評価だけを入れる', async () => {
    const run = await sampleRun();
    const dataset = smallDataset();
    const json = buildJsonExport([run], { [run.results[0].responseId]: { clarity: 3 }, other: { clarity: 1 } }, dataset);
    expect(json.dataset?.fingerprint).toBe(dataset.fingerprint);
    expect(json.runs[0].summary.total).toBe(4);
    expect(Object.keys(json.ratings)).toEqual([run.results[0].responseId]);
  });

  it('run と ID・版・指紋が違うデータセットは export に付けない', async () => {
    const run = await sampleRun();
    const other = { ...smallDataset(), fingerprint: 'ffffffffffffffff' };
    expect(datasetMatchingRun(other, run)).toBeNull();
    expect(buildJsonExport([run], {}, other).dataset).toBeNull();
    expect(datasetMatchingRun(smallDataset(), run)?.fingerprint).toBe(run.datasetFingerprint);
  });

  it('壊れた評価は捨て、平均は評価済みだけで出す', async () => {
    const run = await sampleRun();
    const [a, b] = run.results.map((result) => result.responseId);
    const ratings = sanitizeRatings({ [a]: { clarity: 4, conciseness: 9 }, [b]: { clarity: 2 }, x: 'broken' });
    expect(ratings).toEqual({ [a]: { clarity: 4 }, [b]: { clarity: 2 } });
    const summary = summarizeRatings(run.results, ratings);
    expect(summary.ratedResponses).toBe(2);
    expect(summary.means.clarity).toBe(3);
    expect(summary.means.conciseness).toBeNull();
  });
});

describe('端末の確認', () => {
  const available: DeviceReport = {
    userAgent: 'test',
    browserBrands: null,
    platform: null,
    mobile: false,
    webGpuExposed: true,
    adapter: 'available',
    adapterError: null,
    adapterInfo: null,
    isFallbackAdapter: false,
    gpuFeatures: ['shader-f16'],
    gpuLimits: null,
    deviceMemoryGiB: 8,
    hardwareConcurrency: 8,
    storage: null,
  };

  it('WebGPU が無い・adapter が無い・必須 feature が無いなら UNSUPPORTED', () => {
    expect(judgeCompatibility(FAKE_CANDIDATE, { ...available, webGpuExposed: false }).verdict).toBe('UNSUPPORTED');
    expect(judgeCompatibility(FAKE_CANDIDATE, { ...available, adapter: 'unavailable' }).verdict).toBe('UNSUPPORTED');
    expect(
      judgeCompatibility({ ...FAKE_CANDIDATE, requiredGpuFeatures: ['shader-f16'] }, { ...available, gpuFeatures: [] }).verdict,
    ).toBe('UNSUPPORTED');
  });

  it('報告されたメモリより推定 VRAM が大きいなら MAY_BE_TOO_LARGE。8 GiB（上限値）では断定しない', () => {
    expect(judgeCompatibility(FAKE_CANDIDATE, { ...available, deviceMemoryGiB: 1 }).verdict).toBe('MAY_BE_TOO_LARGE');
    const capped = judgeCompatibility({ ...FAKE_CANDIDATE, estimatedVramBytes: 20 * 1024 ** 3 }, available);
    expect(capped.verdict).toBe('CAN_TRY');
    expect(capped.reasonsJa.join('')).toContain('8 GiB 以上');
    expect(judgeCompatibility({ ...FAKE_CANDIDATE, lowResourceRequired: false }, { ...available, mobile: true }).verdict).toBe(
      'MAY_BE_TOO_LARGE',
    );
  });

  it('Lab に組み込んでいない候補・未確認の端末', () => {
    expect(judgeCompatibility(candidateById('gemma-3n-e2b-it')!, available).verdict).toBe('UNSUPPORTED');
    expect(judgeCompatibility(FAKE_CANDIDATE, null).verdict).toBe('UNKNOWN');
  });

  it('probeDevice は API で取れる値だけを記録し、例外を投げない', async () => {
    const report = await probeDevice({
      userAgent: 'UA',
      gpu: {
        requestAdapter: async () => ({
          features: new Set(['shader-f16', 'bgra8unorm-storage']),
          limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 512 },
          info: { vendor: 'v', architecture: 'a' },
        }),
      },
      deviceMemory: 4,
    });
    expect(report).toMatchObject({
      webGpuExposed: true,
      adapter: 'available',
      gpuFeatures: ['bgra8unorm-storage', 'shader-f16'],
      gpuLimits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 512 },
      deviceMemoryGiB: 4,
      adapterInfo: { vendor: 'v', architecture: 'a', device: null, description: null },
    });
    const failing = await probeDevice({ gpu: { requestAdapter: async () => { throw new Error('x'); } } });
    expect(failing.adapter).toBe('error');
    expect((await probeDevice({})).webGpuExposed).toBe(false);
  });
});

describe('候補モデル', () => {
  it('ID が重複せず、採用はまだ決まっていない（すべて NOT_EVALUATED）', () => {
    const ids = BENCHMARK_CANDIDATES.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BENCHMARK_CANDIDATES.every((candidate) => candidate.adoptionStatus === 'NOT_EVALUATED')).toBe(true);
  });

  it('WebLLM の候補は、固定した版の prebuiltAppConfig と値が一致する', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@mlc-ai/web-llm']).toBe(WEBLLM_CONFIG_VERSION);
    const mismatches: string[] = [];
    for (const candidate of BENCHMARK_CANDIDATES.filter((item) => item.runtime === 'webllm')) {
      const record = webllm.prebuiltAppConfig.model_list.find((item) => item.model_id === candidate.runtimeModelId);
      if (!record) {
        mismatches.push(`${candidate.id}: prebuilt に無い`);
        continue;
      }
      const vram = Math.round((record.vram_required_MB ?? 0) * 1024 * 1024);
      if (candidate.estimatedVramBytes !== vram) mismatches.push(`${candidate.id}: vram`);
      if (candidate.lowResourceRequired !== (record.low_resource_required ?? false)) mismatches.push(`${candidate.id}: low_resource`);
      if (JSON.stringify(candidate.requiredGpuFeatures) !== JSON.stringify(record.required_features ?? [])) {
        mismatches.push(`${candidate.id}: required_features`);
      }
      if (candidate.contextWindow !== (record.overrides?.context_window_size ?? null)) mismatches.push(`${candidate.id}: context`);
    }
    expect(mismatches).toEqual([]);
  });

  it('必須候補（Qwen3 0.6 / 1.7 / 4 / 8B）は Lab から実行でき、想定 class は仮説として持つ', () => {
    const qwen3 = BENCHMARK_CANDIDATES.filter((candidate) => candidate.family === 'Qwen3');
    expect(qwen3.map((candidate) => [candidate.runtimeModelId, candidate.provisionalClass, candidate.labAvailability])).toEqual([
      ['Qwen3-0.6B-q4f16_1-MLC', 'ULTRA_LIGHT', 'RUNNABLE'],
      ['Qwen3-1.7B-q4f16_1-MLC', 'LIGHT', 'RUNNABLE'],
      ['Qwen3-4B-q4f16_1-MLC', 'STANDARD', 'RUNNABLE'],
      ['Qwen3-8B-q4f16_1-MLC', 'QUALITY', 'RUNNABLE'],
    ]);
    expect(qwen3.every((candidate) => candidate.supportsThinkingToggle)).toBe(true);
  });
});

describe('WebLLM Runtime（偽のモジュール・実モデルなし）', () => {
  function fakeModule(cached: Set<string>) {
    const calls: string[] = [];
    const requests: Record<string, unknown>[] = [];
    const module: WebLlmModuleLike = {
      prebuiltAppConfig: {
        model_list: [{ model: 'repo/fixture', model_id: 'fixture-model-id', model_lib: 'lib.wasm' }],
      },
      MLCEngine: class {
        chat = {
          completions: {
            create: async (request: Record<string, unknown>) => {
              requests.push(request);
              return (async function* () {
                yield { choices: [{ delta: { content: '<think>\n\n</think>\n\n' } }] };
                yield { choices: [{ delta: { content: 'T20 を狙います。' }, finish_reason: 'stop' }] };
                yield { choices: [], usage: { prompt_tokens: 50, completion_tokens: 8, extra: { decode_tokens_per_s: 42 } } };
              })();
            },
          },
        };
        async reload(modelId: string) {
          calls.push(`reload:${modelId}`);
          cached.add(modelId);
        }
        async unload() {
          calls.push('unload');
        }
        async resetChat() {
          calls.push('reset');
        }
        interruptGenerate() {
          calls.push('interrupt');
        }
        setInitProgressCallback() {}
      },
      hasModelInCache: async (modelId) => cached.has(modelId),
      deleteModelAllInfoInCache: async (modelId) => {
        calls.push(`delete:${modelId}`);
        cached.delete(modelId);
      },
    };
    return { module, calls, requests };
  }

  it('キャッシュに無いモデルは allowDownload なしで読み込まない', async () => {
    const { module, calls } = fakeModule(new Set());
    const runtime = createWebLlmRuntime({ loadModule: async () => module, cacheStorage: null, now: () => 0 });
    await expect(
      runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'not-downloaded' });
    expect(calls).toEqual([]);
    const record = await runtime.load(FAKE_CANDIDATE, { allowDownload: true, signal: new AbortController().signal });
    expect(record.kind).toBe('download');
  });

  it('thinking OFF を extra_body で渡し、毎回会話を reset し、計測値を返す', async () => {
    const { module, calls, requests } = fakeModule(new Set(['fixture-model-id']));
    let tick = 0;
    const runtime = createWebLlmRuntime({ loadModule: async () => module, cacheStorage: null, now: () => (tick += 10) });
    expect((await runtime.load(FAKE_CANDIDATE, { allowDownload: false, signal: new AbortController().signal })).kind).toBe('cache-cold');
    const [benchmarkCase] = smallDataset().cases;
    const record = await runtime.generate({
      messages: buildPrompt(benchmarkCase).messages,
      maxTokens: 64,
      temperature: 0,
      seed: 1,
      thinking: 'off',
      signal: new AbortController().signal,
      input: benchmarkCase.input,
    });
    expect(requests[0]).toMatchObject({ stream: true, temperature: 0, seed: 1, max_tokens: 64, extra_body: { enable_thinking: false } });
    expect(calls).toContain('reset');
    expect(record).toMatchObject({ promptTokens: 50, outputTokens: 8, runtimeDecodeTokensPerSecond: 42, finishReason: 'stop' });
    expect(record.timeToFirstVisibleTokenMs).toBeGreaterThan(record.timeToFirstTokenMs ?? Infinity);
  });

  it('削除は対象モデル単位で、ほかのモデルのキャッシュを消さない', async () => {
    const cached = new Set(['fixture-model-id', 'other-model-id']);
    const { module, calls } = fakeModule(cached);
    const runtime = createWebLlmRuntime({ loadModule: async () => module, cacheStorage: null });
    await runtime.deleteCache(FAKE_CANDIDATE);
    expect(calls).toEqual(['delete:fixture-model-id']);
    expect([...cached]).toEqual(['other-model-id']);
  });

  it('削除は WebLLM のキャッシュ削除だけを呼ぶ（利用者データに触れない）', async () => {
    const { module, calls } = fakeModule(new Set(['fixture-model-id']));
    const runtime = createWebLlmRuntime({ loadModule: async () => module, cacheStorage: null });
    window.localStorage.setItem('01as-beta:oas.trainingHistory.v2', '{"keep":true}');
    await runtime.deleteCache(FAKE_CANDIDATE);
    expect(calls).toEqual(['delete:fixture-model-id']);
    expect(window.localStorage.getItem('01as-beta:oas.trainingHistory.v2')).toBe('{"keep":true}');
    expect(await runtime.isCached(FAKE_CANDIDATE)).toBe(false);
  });

  it('WebLLM の候補ではないものは扱わない', () => {
    const runtime = createWebLlmRuntime({ loadModule: async () => fakeModule(new Set()).module, cacheStorage: null });
    expect(runtime.supports(BASELINE_CANDIDATE)).toBe(false);
    expect(runtime.supports(candidateById('gemma-3n-e2b-it')!)).toBe(false);
  });
});
