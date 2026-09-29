/**
 * Benchmark Profile（STANDARD / MOBILE_FEASIBILITY）・段階制・WebLLM Runtime のメモリの扱いのテスト。
 *
 * 実モデル・WebGPU は使わない（Mock Runtime・偽の WebLLM モジュール）。
 */
import { describe, expect, it } from 'vitest';
import { suggestFor } from '../../engine/recovery/suggest';
import { buildDecisionEvidence } from '../evidence';
import { BASELINE_CANDIDATE, BENCHMARK_CANDIDATES } from './candidates';
import { assembleDataset } from './dataset';
import { buildJsonExport, buildRatingCsv, BenchmarkProfileMixError } from './export';
import {
  FEASIBILITY_STAGES,
  MOBILE_FEASIBILITY_PROFILE,
  PROMPT_TOKEN_SAFETY_MARGIN,
  STANDARD_PROFILE,
  adviseStages,
  describeRunProfile,
  profileFitsCandidate,
  profileGenerationSettings,
  quickCaseIds,
  runProfile,
  runProfileOf,
  sameBenchmarkProfile,
  stageCaseIds,
  stageRecordFromLoad,
  stageRecordFromLoadFailure,
  stageRecordFromRun,
  type StageRecord,
} from './profiles';
import { PROMPT_VERSION_LABEL } from './prompt';
import { DEFAULT_GENERATION_SETTINGS, runBenchmark } from './runner';
import { createFakeClock, createMockRuntime } from './runtimes/mockRuntime';
import { fakeStorage } from './runtimes/fakeStorage';
import { createWebLlmRuntime, type ChatOptionsLike, type WebLlmModuleLike } from './runtimes/webllmRuntime';
import { BENCHMARK_CATEGORIES, type BenchmarkCandidate, type BenchmarkDataset, type BenchmarkRun } from './types';

const CORE_FINGERPRINT = 'd8bcc5db4101150e';

const CANDIDATE: BenchmarkCandidate = {
  ...BASELINE_CANDIDATE,
  id: 'fixture-model',
  displayName: 'Fixture model',
  runtime: 'webllm',
  runtimeModelId: 'fixture-model-id',
  promptTokenMeasurement: {
    datasetFingerprint: 'fixture-fingerprint',
    promptVersion: PROMPT_VERSION_LABEL,
    cases: 10,
    meanTokens: 1000,
    p95Tokens: 1500,
    maxTokens: 1659,
    maxCaseId: 'X',
    tokenizerJa: 'fixture',
  },
};

function dataset(): BenchmarkDataset {
  const drafts = BENCHMARK_CATEGORIES.flatMap((category, index) =>
    [0, 1, 2].map((offset) => {
      const left = 40 + index * 10 + offset;
      return {
        id: `${category}-${offset}`,
        category,
        titleJa: `${left}`,
        input: { kind: 'decision' as const, decision: buildDecisionEvidence(suggestFor(left, 3)), previousThrow: null },
      };
    }),
  );
  return { ...assembleDataset({ id: 'fixture', version: 1, labelJa: 'fixture', drafts }), fingerprint: 'fixture-fingerprint' };
}

const ISO = () => '2026-01-01T00:00:00.000Z';

describe('Profile の定義', () => {
  it('STANDARD はこれまでと同じ条件（max_tokens 384・context window は Runtime の既定）', () => {
    expect(STANDARD_PROFILE).toMatchObject({ id: 'STANDARD', version: 1, maxTokens: 384, contextWindowSize: null, staged: false, qualityBenchmark: true });
    expect(STANDARD_PROFILE.maxTokens).toBe(DEFAULT_GENERATION_SETTINGS.maxTokens);
    expect(profileGenerationSettings(STANDARD_PROFILE)).toEqual({ maxTokens: 384 });
  });

  it('MOBILE_FEASIBILITY は context window 2048・max_tokens 192・段階制・品質の benchmark ではない', () => {
    expect(MOBILE_FEASIBILITY_PROFILE).toMatchObject({
      id: 'MOBILE_FEASIBILITY',
      version: 1,
      maxTokens: 192,
      contextWindowSize: 2048,
      staged: true,
      qualityBenchmark: false,
    });
    expect(PROMPT_TOKEN_SAFETY_MARGIN).toBe(64);
  });

  it('01AS Core v1 の最大 prompt（1659 tokens）＋ 出力 192 ＋ 余裕 64 が context window 2048 に収まる', () => {
    const measured = BENCHMARK_CANDIDATES.filter((candidate) => candidate.promptTokenMeasurement);
    expect(measured.map((candidate) => candidate.id)).toEqual([
      'webllm-qwen3-0.6b',
      'webllm-qwen3-1.7b',
      'webllm-qwen3-4b',
      'webllm-qwen3-8b',
    ]);
    const core = { fingerprint: CORE_FINGERPRINT };
    for (const candidate of measured) {
      expect(candidate.promptTokenMeasurement).toMatchObject({ datasetFingerprint: CORE_FINGERPRINT, promptVersion: PROMPT_VERSION_LABEL, maxTokens: 1659 });
      expect(profileFitsCandidate(MOBILE_FEASIBILITY_PROFILE, candidate, core)).toEqual({ ok: true });
    }
    expect(1659 + 192 + 64).toBeLessThanOrEqual(2048);
  });

  it('prompt token 数が未計測・計測時とデータセットが違う・収まらない候補には使わない（context 不足で失敗させない）', () => {
    const unmeasured = BENCHMARK_CANDIDATES.find((candidate) => candidate.id === 'webllm-llama-3.2-1b-instruct')!;
    expect(profileFitsCandidate(MOBILE_FEASIBILITY_PROFILE, unmeasured, { fingerprint: CORE_FINGERPRINT }).ok).toBe(false);
    expect(profileFitsCandidate(MOBILE_FEASIBILITY_PROFILE, CANDIDATE, { fingerprint: 'other' }).ok).toBe(false);
    const tooLong = { ...CANDIDATE, promptTokenMeasurement: { ...CANDIDATE.promptTokenMeasurement!, maxTokens: 1800 } };
    expect(profileFitsCandidate(MOBILE_FEASIBILITY_PROFILE, tooLong, { fingerprint: 'fixture-fingerprint' })).toMatchObject({ ok: false });
    // STANDARD（既定の context）と baseline はいつでも使える。
    expect(profileFitsCandidate(STANDARD_PROFILE, unmeasured, null)).toEqual({ ok: true });
    expect(profileFitsCandidate(MOBILE_FEASIBILITY_PROFILE, BASELINE_CANDIDATE, null)).toEqual({ ok: true });
  });
});

describe('run の profile の記録と区別', () => {
  async function runWith(profile = MOBILE_FEASIBILITY_PROFILE, stage: (typeof FEASIBILITY_STAGES)[number] | null = 'ONE_CASE') {
    const runtime = createMockRuntime({ clock: createFakeClock(), cachedCandidateIds: [CANDIDATE.id] });
    await runtime.load(CANDIDATE, { allowDownload: false, signal: new AbortController().signal, contextWindowSize: profile.contextWindowSize });
    return runBenchmark({
      runtime,
      candidate: CANDIDATE,
      dataset: dataset(),
      caseIds: stage ? stageCaseIds(stage, dataset()) : undefined,
      settings: profileGenerationSettings(profile),
      profile: runProfile(profile, stage),
      clockIso: ISO,
    });
  }

  it('profileId・version・context window・段階を run に保存し、max_tokens を profile から取る', async () => {
    const run = await runWith();
    expect(run.profile).toEqual({ id: 'MOBILE_FEASIBILITY', version: 1, contextWindowSize: 2048, stage: 'ONE_CASE' });
    expect(run.settings.maxTokens).toBe(192);
    expect(run.runId).toContain('MOBILE_FEASIBILITY@1');
    expect(describeRunProfile(run)).toBe('MOBILE_FEASIBILITY v1 / context 2048 / max_tokens 192 / ONE_CASE');
  });

  it('profile の記録が無い古い run は STANDARD v1（記録なし）として扱う', async () => {
    const run = await runWith(STANDARD_PROFILE, null);
    const { profile: _profile, ...legacy } = run;
    expect(runProfileOf(legacy as BenchmarkRun)).toEqual({ id: 'STANDARD', version: 1, contextWindowSize: null, stage: null, recorded: false });
    expect(describeRunProfile(legacy as BenchmarkRun)).toContain('profile の記録なし');
  });

  it('profile が違う run は同じ benchmark として混ぜない（export・評価シートが拒否する）', async () => {
    const mobile = await runWith();
    const standard = await runWith(STANDARD_PROFILE, null);
    expect(sameBenchmarkProfile([mobile, standard])).toBe(false);
    expect(() => buildJsonExport([mobile, standard], {}, null)).toThrow(BenchmarkProfileMixError);
    expect(() => buildRatingCsv([mobile, standard], {})).toThrow(BenchmarkProfileMixError);
    // 同じ profile なら export でき、JSON・CSV に profile が入る。
    const json = buildJsonExport([mobile], {}, null);
    expect(json.runs[0].profile).toMatchObject({ id: 'MOBILE_FEASIBILITY', version: 1, recorded: true });
    const csv = buildRatingCsv([mobile], {});
    expect(csv).toContain('profile_id,profile_version,validator_version');
    expect(csv).toContain('MOBILE_FEASIBILITY,1,2');
  });
});

describe('MOBILE_FEASIBILITY の段階制', () => {
  it('LOAD ONLY → 1 CASE → QUICK 10 → FULL 100', () => {
    const ds = dataset();
    expect(FEASIBILITY_STAGES).toEqual(['LOAD_ONLY', 'ONE_CASE', 'QUICK_10', 'FULL_100']);
    expect(stageCaseIds('LOAD_ONLY', ds)).toEqual([]);
    expect(stageCaseIds('ONE_CASE', ds)).toEqual([quickCaseIds(ds)[0]]);
    expect(stageCaseIds('QUICK_10', ds)).toHaveLength(10);
    expect(stageCaseIds('FULL_100', ds)).toHaveLength(ds.cases.length);
  });

  const at = '2026-01-01T00:00:00.000Z';
  const success = (stage: StageRecord['stage']): StageRecord => ({
    stage,
    status: 'success',
    at,
    loadKind: 'cache-cold',
    loadTimeMs: 1000,
    casesTotal: 1,
    casesCompleted: 1,
    errors: 0,
    timeouts: 0,
    gpuError: false,
    detail: null,
    runId: null,
  });

  it('前の段階が成功していれば次を推奨し、未実施・失敗なら推奨しない', () => {
    const initial = adviseStages([], false);
    expect(initial.map((item) => item.recommended)).toEqual([true, false, false, false]);
    const afterLoad = adviseStages([success('LOAD_ONLY')], false);
    expect(afterLoad.map((item) => item.recommended)).toEqual([true, true, false, false]);
    const failedCase = adviseStages([success('LOAD_ONLY'), { ...success('ONE_CASE'), status: 'failed', errors: 1 }], false);
    expect(failedCase[2].recommended).toBe(false);
    expect(failedCase[2].reasonsJa.join('')).toContain('失敗');
  });

  it('load 失敗・checkpoint が残っている・device lost / GPU error なら次へ進むことを推奨しない', () => {
    const loadFailed = stageRecordFromLoadFailure('LOAD_ONLY', { failureClass: 'gpu-load-failed', message: 'Device was lost' }, at, false);
    expect(loadFailed).toMatchObject({ status: 'failed', gpuError: true });
    expect(adviseStages([loadFailed], false).every((item) => !item.recommended)).toBe(true);
    const stale = adviseStages([success('LOAD_ONLY')], true);
    expect(stale.every((item) => !item.recommended)).toBe(true);
    expect(stale[0].reasonsJa.join('')).toContain('checkpoint');
    const incomplete = adviseStages([success('LOAD_ONLY'), { ...success('ONE_CASE'), status: 'incomplete' }], false);
    expect(incomplete[2].reasonsJa.join('')).toContain('正常終了しなかった');
  });

  it('段階の結果: 生成のエラー・タイムアウトは失敗、GPU の失敗を見分ける。品質の不合格は失敗にしない', async () => {
    const runtime = createMockRuntime({
      clock: createFakeClock(),
      cachedCandidateIds: [CANDIDATE.id],
      respond: () => {
        throw new Error('GPUDevice was lost');
      },
    });
    const load = await runtime.load(CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
    expect(stageRecordFromLoad(load, at)).toMatchObject({ stage: 'LOAD_ONLY', status: 'success', loadKind: 'cache-cold' });
    const run = await runBenchmark({ runtime, candidate: CANDIDATE, dataset: dataset(), caseIds: stageCaseIds('ONE_CASE', dataset()), load, clockIso: ISO });
    expect(stageRecordFromRun('ONE_CASE', run, at)).toMatchObject({ status: 'failed', errors: 1, gpuError: true });

    const noisy = createMockRuntime({ clock: createFakeClock(), cachedCandidateIds: [CANDIDATE.id], respond: () => 'STANDARD_ROUTE です。' });
    await noisy.load(CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
    const quality = await runBenchmark({ runtime: noisy, candidate: CANDIDATE, dataset: dataset(), caseIds: stageCaseIds('ONE_CASE', dataset()), clockIso: ISO });
    expect(quality.results[0].validationPassed).toBe(false);
    expect(stageRecordFromRun('ONE_CASE', quality, at).status).toBe('success');
  });
});

describe('Runtime のメモリの扱い（Mock Runtime）', () => {
  it('context window が違えば読み込み直し、同じなら読み込み済みのまま（モデルは常に 1 つだけ）', async () => {
    const runtime = createMockRuntime({ clock: createFakeClock(), cachedCandidateIds: [CANDIDATE.id] });
    const signal = new AbortController().signal;
    expect((await runtime.load(CANDIDATE, { allowDownload: false, signal })).kind).toBe('cache-cold');
    expect((await runtime.load(CANDIDATE, { allowDownload: false, signal, contextWindowSize: 2048 })).kind).toBe('cache-warm');
    expect(runtime.loadedContextWindowSize()).toBe(2048);
    expect((await runtime.load(CANDIDATE, { allowDownload: false, signal, contextWindowSize: 2048 })).kind).toBe('already-loaded');
    expect(runtime.residentModels()).toBe(1);
    await runtime.unload();
    expect(runtime.residentModels()).toBe(0);
    // context window を変えても取得（download）は起きない。
    expect(runtime.log.filter((entry) => entry.startsWith('download'))).toEqual([]);
  });
});

describe('WebLLM Runtime のメモリの扱い（偽のモジュール）', () => {
  const storage = fakeStorage({ opfs: { 'tvmjs-opfs-store': { webllm: { model: {} } } } });

  function fakeModule(cached: Set<string>) {
    const calls: string[] = [];
    const chatOpts: (ChatOptionsLike | undefined)[] = [];
    const configs: unknown[] = [];
    let engines = 0;
    let resident = 0;
    let releaseReload: (() => void) | null = null;
    let holdReload = false;
    const module: WebLlmModuleLike = {
      prebuiltAppConfig: { model_list: [{ model: 'https://example.test/fixture', model_id: 'fixture-model-id', model_lib: 'https://example.test/lib.wasm' }] },
      MLCEngine: class {
        constructor(config: { appConfig: unknown }) {
          engines += 1;
          configs.push(config.appConfig);
        }
        chat = { completions: { create: async () => (async function* () {})() } };
        async reload(modelId: string, options?: ChatOptionsLike) {
          // WebLLM の reload は、前のモデルを解放してから読み込む。
          resident = 0;
          calls.push(`reload:${modelId}`);
          chatOpts.push(options);
          if (holdReload) await new Promise<void>((resolve) => (releaseReload = resolve));
          resident = 1;
        }
        async unload() {
          resident = 0;
          calls.push('unload');
        }
        async resetChat() {}
        interruptGenerate() {}
        setInitProgressCallback() {}
      },
      hasModelInCache: async (modelId, appConfig) => {
        configs.push(appConfig);
        return cached.has(modelId);
      },
      deleteModelAllInfoInCache: async () => {},
    };
    return {
      module,
      calls,
      chatOpts,
      configs,
      engines: () => engines,
      resident: () => resident,
      hold: () => (holdReload = true),
      release: () => releaseReload?.(),
    };
  }

  it('STANDARD は chatOpts を渡さず、MOBILE_FEASIBILITY は context_window_size だけを渡す', async () => {
    const fake = fakeModule(new Set(['fixture-model-id']));
    const runtime = createWebLlmRuntime({ loadModule: async () => fake.module, storage, now: () => 0 });
    const signal = new AbortController().signal;
    const standard = await runtime.load(CANDIDATE, { allowDownload: false, signal, contextWindowSize: STANDARD_PROFILE.contextWindowSize });
    expect(standard).toMatchObject({ kind: 'cache-cold', contextWindowSize: null });
    const mobile = await runtime.load(CANDIDATE, { allowDownload: false, signal, contextWindowSize: MOBILE_FEASIBILITY_PROFILE.contextWindowSize });
    expect(mobile).toMatchObject({ kind: 'cache-warm', contextWindowSize: 2048 });
    expect(fake.chatOpts).toEqual([undefined, { context_window_size: 2048 }]);
    // 同じ設定なら読み込み直さない。
    expect((await runtime.load(CANDIDATE, { allowDownload: false, signal, contextWindowSize: 2048 })).kind).toBe('already-loaded');
    expect(fake.calls.filter((call) => call.startsWith('reload'))).toHaveLength(2);
  });

  it('MLCEngine を重複して作らず、appConfig（保存場所）を変えないので再取得しない', async () => {
    const fake = fakeModule(new Set(['fixture-model-id']));
    const runtime = createWebLlmRuntime({ loadModule: async () => fake.module, storage, now: () => 0 });
    const signal = new AbortController().signal;
    for (const contextWindowSize of [null, 2048, null, 2048]) {
      const record = await runtime.load(CANDIDATE, { allowDownload: false, signal, contextWindowSize });
      expect(record.kind).not.toBe('download');
      expect(fake.resident()).toBe(1);
    }
    expect(fake.engines()).toBe(1);
    // 存在確認・MLCEngine に渡した appConfig はすべて同じオブジェクト（profile で保存場所が変わらない）。
    expect(new Set(fake.configs).size).toBe(1);
    await runtime.unload();
    expect(fake.resident()).toBe(0);
  });

  it('読み込みを同時に 2 つ走らせない', async () => {
    const fake = fakeModule(new Set(['fixture-model-id']));
    const runtime = createWebLlmRuntime({ loadModule: async () => fake.module, storage, now: () => 0 });
    const signal = new AbortController().signal;
    fake.hold();
    const first = runtime.load(CANDIDATE, { allowDownload: false, signal, contextWindowSize: 2048 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(runtime.load(CANDIDATE, { allowDownload: false, signal })).rejects.toMatchObject({ code: 'runtime-unavailable' });
    fake.release();
    await first;
    expect(fake.engines()).toBe(1);
  });

  it('取得が途中で止まったモデルの残り（partial）を、保存領域を作らずに見分ける', async () => {
    const record = (url: string, nbytes: number) => JSON.stringify({ url, nbytes });
    const partial = fakeStorage({
      opfs: {
        'tvmjs-opfs-store': {
          webllm: {
            model: {
              'a.record.json': record('https://example.test/fixture/params_shard_0.bin', 4),
              'a.bin': 4,
              'b.record.json': record('https://example.test/other/params_shard_0.bin', 4),
              'b.bin': 4,
            },
          },
        },
      },
    });
    const fake = fakeModule(new Set());
    const runtime = createWebLlmRuntime({ loadModule: async () => fake.module, storage: partial });
    expect(await runtime.modelStorage?.hasPartial?.(CANDIDATE)).toBe(true);
    expect(partial.log).toEqual([]);
    // すべてそろっていれば partial ではない。保存領域が無ければ WebLLM を読まずに false。
    const complete = createWebLlmRuntime({ loadModule: async () => fakeModule(new Set(['fixture-model-id'])).module, storage: partial });
    expect(await complete.modelStorage?.hasPartial?.(CANDIDATE)).toBe(false);
    let loaded = false;
    const empty = createWebLlmRuntime({
      loadModule: async () => {
        loaded = true;
        return fake.module;
      },
      storage: fakeStorage({ opfs: {} }),
    });
    expect(await empty.modelStorage?.hasPartial?.(CANDIDATE)).toBe(false);
    expect(loaded).toBe(false);
    // IndexedDB は数えられないので不明。
    const idb = createWebLlmRuntime({ loadModule: async () => fake.module, storage: fakeStorage({ indexedDbNames: ['webllm/model'] }), storageBackend: 'indexeddb' });
    expect(await idb.modelStorage?.hasPartial?.(CANDIDATE)).toBeNull();
  });
});
