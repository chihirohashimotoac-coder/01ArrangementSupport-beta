/**
 * モデルの保存方式（OPFS / IndexedDB / Cache API）と、取得失敗の分類のテスト。
 *
 * **実モデル・実際の保存領域は使わない。** WebLLM は偽のモジュール、保存 API は偽物（`runtimes/fakeStorage.ts`）。
 */
import * as webllm from '@mlc-ai/web-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_CANDIDATE } from './candidates';
import {
  classifyModelLoadFailure,
  describeModelLoadFailure,
  isPostStoreReadFailure,
  MODEL_LOAD_FAILURE_CLASSES,
  type ModelLoadFailureDiagnostics,
} from './modelLoadFailure';
import {
  chooseModelStorageBackend,
  detectModelStorageSupport,
  estimatedDownloadFootprint,
  hasWebLlmStore,
  measureModelBytes,
  probeStorageStatus,
  requestPersistentStorage,
  webLlmStorageConfig,
  withModelStorage,
  type ModelStorageBackend,
} from './modelStorage';
import { fakeStorage, type FakeDirectory } from './runtimes/fakeStorage';
import { createWebLlmRuntime, type AppConfigLike, type WebLlmModuleLike } from './runtimes/webllmRuntime';
import { BenchmarkRuntimeError, type BenchmarkCandidate } from './types';

const MODEL_URL = 'https://example.test/org/fixture-model';
const OTHER_URL = 'https://example.test/org/fixture-model-extra';
const MODEL_LIB = 'https://example.test/libs/fixture-model.wasm';
const LOCATION = { model: MODEL_URL, model_lib: MODEL_LIB };

const CANDIDATE: BenchmarkCandidate = {
  ...BASELINE_CANDIDATE,
  id: 'fixture-model',
  displayName: 'Fixture model',
  runtime: 'webllm',
  runtimeModelId: 'fixture-model-id',
};

// ---------------------------------------------------------------------------
// 方式の判定
// ---------------------------------------------------------------------------

describe('保存方式の判定（OPFS → IndexedDB → Cache API）', () => {
  it('OPFS の API があれば OPFS を選ぶ', () => {
    const support = detectModelStorageSupport(fakeStorage({ opfs: {}, caches: {}, indexedDbNames: [] }));
    expect(support).toEqual({ opfs: true, indexeddb: true, cache: true });
    expect(chooseModelStorageBackend(support)).toEqual({
      backend: 'opfs',
      usedFallback: false,
      alternatives: ['indexeddb', 'cache'],
    });
  });

  it('OPFS の API が無ければ、推奨順で次の方式を初期値にする（fallback の候補を返す）', () => {
    const support = detectModelStorageSupport(fakeStorage({ caches: {}, indexedDbNames: [] }));
    expect(support.opfs).toBe(false);
    expect(chooseModelStorageBackend(support)).toEqual({ backend: 'indexeddb', usedFallback: true, alternatives: ['cache'] });
    expect(chooseModelStorageBackend({ opfs: false, indexeddb: false, cache: true })).toEqual({
      backend: 'cache',
      usedFallback: true,
      alternatives: [],
    });
    expect(chooseModelStorageBackend({ opfs: false, indexeddb: false, cache: false }).backend).toBeNull();
  });

  it('WebLLM の設定は OPFS なら cacheBackend: opfs・opfsAccessMode: auto。元の prebuiltAppConfig は変えない', () => {
    // WebLLM 0.2.85 の prebuiltAppConfig の既定は Cache API（今回の QuotaExceeded の経路）。
    expect((webllm.prebuiltAppConfig as { cacheBackend?: string }).cacheBackend).toBe('cache');
    const config = withModelStorage(webllm.prebuiltAppConfig, 'opfs');
    expect(config.cacheBackend).toBe('opfs');
    expect(config.opfsAccessMode).toBe('auto');
    expect(config.model_list).toBe(webllm.prebuiltAppConfig.model_list);
    expect((webllm.prebuiltAppConfig as { cacheBackend?: string }).cacheBackend).toBe('cache');
    // WebLLM 0.2.85 の型（AppConfig の cacheBackend / opfsAccessMode）としてそのまま渡せる（typecheck で検査）。
    const typed: webllm.AppConfig = config;
    expect(typed.cacheBackend).toBe('opfs');

    // OPFS 以外では opfsAccessMode を持ち込まない（元の設定にあっても消す）。
    const indexeddb = withModelStorage({ ...webllm.prebuiltAppConfig, opfsAccessMode: 'sync' }, 'indexeddb');
    expect(indexeddb.cacheBackend).toBe('indexeddb');
    expect('opfsAccessMode' in indexeddb).toBe(false);
    expect(webLlmStorageConfig('cache')).toEqual({ cacheBackend: 'cache' });
  });
});

// ---------------------------------------------------------------------------
// WebLLM Runtime が方式を混ぜないこと
// ---------------------------------------------------------------------------

function recordingModule(cached: Set<string>) {
  const hasConfigs: AppConfigLike[] = [];
  const deleteConfigs: AppConfigLike[] = [];
  const engineConfigs: AppConfigLike[] = [];
  const module: WebLlmModuleLike = {
    prebuiltAppConfig: {
      cacheBackend: 'cache',
      model_list: [{ model: MODEL_URL, model_id: 'fixture-model-id', model_lib: MODEL_LIB }],
    },
    MLCEngine: class {
      constructor(config: { appConfig: AppConfigLike }) {
        engineConfigs.push(config.appConfig);
      }
      chat = { completions: { create: async () => (async function* () {})() } };
      async reload(modelId: string) {
        cached.add(modelId);
      }
      async unload() {}
      async resetChat() {}
      interruptGenerate() {}
      setInitProgressCallback() {}
    },
    hasModelInCache: async (modelId, appConfig) => {
      hasConfigs.push(appConfig!);
      return cached.has(modelId);
    },
    deleteModelAllInfoInCache: async (modelId, appConfig) => {
      deleteConfigs.push(appConfig!);
      cached.delete(modelId);
    },
  };
  return { module, hasConfigs, deleteConfigs, engineConfigs };
}

const OPFS_WITH_STORE: FakeDirectory = { 'tvmjs-opfs-store': { webllm: { model: {} } } };

describe('WebLLM Runtime の保存方式', () => {
  it('hasModelInCache・deleteModelAllInfoInCache・MLCEngine に同じ appConfig（OPFS）を渡す', async () => {
    const { module, hasConfigs, deleteConfigs, engineConfigs } = recordingModule(new Set());
    const runtime = createWebLlmRuntime({ loadModule: async () => module, storage: fakeStorage({ opfs: OPFS_WITH_STORE }) });
    expect(runtime.storageBackend).toBe('opfs');
    expect(runtime.modelStorage?.backend).toBe('opfs');

    expect(await runtime.isCached(CANDIDATE)).toBe(false);
    await runtime.load(CANDIDATE, { allowDownload: true, signal: new AbortController().signal });
    await runtime.deleteCache(CANDIDATE);

    const config = await runtime.appConfig();
    expect(config).toMatchObject({ cacheBackend: 'opfs', opfsAccessMode: 'auto' });
    expect(config).not.toBe(module.prebuiltAppConfig);
    const used = [...hasConfigs, ...deleteConfigs, ...engineConfigs];
    expect(hasConfigs.length).toBeGreaterThan(0);
    expect(deleteConfigs).toHaveLength(1);
    expect(engineConfigs).toHaveLength(1);
    // 同じオブジェクト（方式が混ざらない）。
    expect(used.every((item) => item === config)).toBe(true);
    expect(module.prebuiltAppConfig.cacheBackend).toBe('cache');
  });

  it('方式ごとに Runtime を分け、別の方式の appConfig を混ぜない', async () => {
    const backends: ModelStorageBackend[] = ['opfs', 'indexeddb', 'cache'];
    const storage = fakeStorage({ opfs: OPFS_WITH_STORE, indexedDbNames: ['webllm/model'], caches: { 'webllm/model': {} } });
    for (const backend of backends) {
      const { module, hasConfigs, deleteConfigs, engineConfigs } = recordingModule(new Set(['fixture-model-id']));
      const runtime = createWebLlmRuntime({ loadModule: async () => module, storage, storageBackend: backend });
      await runtime.load(CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
      await runtime.deleteCache(CANDIDATE);
      const backendsUsed = new Set([...hasConfigs, ...deleteConfigs, ...engineConfigs].map((item) => item.cacheBackend));
      expect([...backendsUsed]).toEqual([backend]);
    }
  });

  it('保存領域がまだ無い方式では WebLLM を呼ばずに「なし」と答え、保存領域を作らない', async () => {
    const { module, hasConfigs, deleteConfigs } = recordingModule(new Set());
    const storage = fakeStorage({ opfs: {}, caches: {}, indexedDbNames: [] });
    const runtime = createWebLlmRuntime({ loadModule: async () => module, storage });
    expect(await runtime.isCached(CANDIDATE)).toBe(false);
    for (const backend of ['opfs', 'indexeddb', 'cache'] as const) {
      expect(await runtime.modelStorage!.isCachedIn(CANDIDATE, backend)).toBe(false);
    }
    await runtime.deleteCache(CANDIDATE);
    expect(hasConfigs).toEqual([]);
    expect(deleteConfigs).toEqual([]);
    // getDirectoryHandle / getFileHandle に { create: true } などの options を渡していない。
    expect(storage.log).toEqual([]);
    await expect(
      runtime.load(CANDIDATE, { allowDownload: false, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'not-downloaded' });
  });

  it('方式ごとに存在を確かめる（Cache API に無くても、OPFS にあれば「あり」）', async () => {
    const { module, hasConfigs } = recordingModule(new Set());
    const storage = fakeStorage({ opfs: OPFS_WITH_STORE, caches: { 'webllm/model': {} }, indexedDbNames: null });
    // この偽物では、OPFS の設定のときだけモデルがある。
    module.hasModelInCache = async (_modelId, appConfig) => {
      hasConfigs.push(appConfig!);
      return appConfig?.cacheBackend === 'opfs';
    };
    const runtime = createWebLlmRuntime({ loadModule: async () => module, storage, storageBackend: 'cache' });
    expect(await runtime.isCached(CANDIDATE)).toBe(false);
    expect(await runtime.modelStorage!.isCachedIn(CANDIDATE, 'opfs')).toBe(true);
    // IndexedDB は databases() が無く、作らずに確かめられないので「不明」。
    expect(await runtime.modelStorage!.isCachedIn(CANDIDATE, 'indexeddb')).toBeNull();
    expect(new Set(hasConfigs.map((item) => item.cacheBackend))).toEqual(new Set(['cache', 'opfs']));
  });

  describe('利用者データ', () => {
    afterEach(() => window.localStorage.clear());

    it('保存方式を変えても、モデルを削除しても 01as-beta:oas.* / 01as-beta:ai.benchmark.* を変えない', async () => {
      const userData = {
        '01as-beta:oas.trainingHistory.v2': '{"version":2,"records":[]}',
        '01as-beta:oas.preferences.v1': '{"version":1}',
        '01as-beta:ai.benchmark.runs.v1': '{"version":1,"runs":[]}',
        '01as-beta:ai.benchmark.ratings.v1': '{"version":1,"ratings":{}}',
      };
      for (const [key, value] of Object.entries(userData)) window.localStorage.setItem(key, value);
      const storage = fakeStorage({ opfs: OPFS_WITH_STORE, indexedDbNames: ['webllm/model'], caches: { 'webllm/model': {} } });
      for (const backend of ['opfs', 'indexeddb', 'cache'] as const) {
        const { module } = recordingModule(new Set(['fixture-model-id']));
        const runtime = createWebLlmRuntime({ loadModule: async () => module, storage, storageBackend: backend });
        await runtime.load(CANDIDATE, { allowDownload: false, signal: new AbortController().signal });
        await runtime.deleteCache(CANDIDATE);
      }
      expect(Object.fromEntries(Object.keys(userData).map((key) => [key, window.localStorage.getItem(key)]))).toEqual(userData);
      expect(window.localStorage.length).toBe(Object.keys(userData).length);
    });
  });
});

// ---------------------------------------------------------------------------
// サイズ（分からなければ unknown）
// ---------------------------------------------------------------------------

function opfsRecord(url: string, nbytes: number): string {
  return JSON.stringify({ url, nbytes });
}

describe('保存済みモデルのサイズ（方式ごと。誤った値より unknown）', () => {
  it('OPFS: そのモデルの記録（nbytes）と本体の大きさが一致したものだけを合計する', async () => {
    const storage = fakeStorage({
      opfs: {
        'tvmjs-opfs-store': {
          webllm: {
            model: {
              'a.record.json': opfsRecord(`${MODEL_URL}/resolve/main/params_shard_0.bin`, 1000),
              'a.bin': 1000,
              'b.record.json': opfsRecord(`${MODEL_URL}/resolve/main/tokenizer.json`, 20),
              'b.bin': 20,
              // 名前が前方一致するだけの別モデルは数えない。
              'c.record.json': opfsRecord(`${OTHER_URL}/resolve/main/params_shard_0.bin`, 5000),
              'c.bin': 5000,
              'broken.record.json': 'not json',
            },
            config: {
              'd.record.json': opfsRecord(`${MODEL_URL}/resolve/main/mlc-chat-config.json`, 3),
              'd.bin': 3,
            },
            wasm: {
              'e.record.json': opfsRecord(MODEL_LIB, 400),
              'e.bin': 400,
            },
          },
        },
      },
    });
    expect(await measureModelBytes('opfs', LOCATION, storage)).toBe(1423);
    expect(storage.log).toEqual([]);
  });

  it('OPFS: 本体が無い・大きさが記録と違う（書きかけ）なら unknown', async () => {
    const partial = fakeStorage({
      opfs: {
        'tvmjs-opfs-store': {
          webllm: {
            model: {
              'a.record.json': opfsRecord(`${MODEL_URL}/resolve/main/params_shard_0.bin`, 1000),
              'a.bin': 999,
            },
          },
        },
      },
    });
    expect(await measureModelBytes('opfs', LOCATION, partial)).toBeNull();
    const missing = fakeStorage({
      opfs: { 'tvmjs-opfs-store': { webllm: { model: { 'a.record.json': opfsRecord(`${MODEL_URL}/x.bin`, 10) } } } },
    });
    expect(await measureModelBytes('opfs', LOCATION, missing)).toBeNull();
    // 何も保存されていなければ 0 ではなく unknown。
    expect(await measureModelBytes('opfs', LOCATION, fakeStorage({ opfs: {} }))).toBeNull();
  });

  it('IndexedDB は unknown（本体を読み出さないと数えられないため）', async () => {
    expect(await measureModelBytes('indexeddb', LOCATION, fakeStorage({ indexedDbNames: ['webllm/model'] }))).toBeNull();
  });

  it('Cache API: content-length の合計。無い・圧縮されている項目があれば unknown', async () => {
    const ok = fakeStorage({
      caches: {
        'webllm/model': {
          [`${MODEL_URL}/resolve/main/params_shard_0.bin`]: { 'content-length': '1000' },
          [`${OTHER_URL}/resolve/main/params_shard_0.bin`]: { 'content-length': '9999' },
        },
        'webllm/wasm': { [MODEL_LIB]: { 'content-length': '400' } },
      },
    });
    expect(await measureModelBytes('cache', LOCATION, ok)).toBe(1400);
    const noLength = fakeStorage({ caches: { 'webllm/model': { [`${MODEL_URL}/resolve/main/a.bin`]: {} } } });
    expect(await measureModelBytes('cache', LOCATION, noLength)).toBeNull();
    const gzip = fakeStorage({
      caches: {
        'webllm/model': { [`${MODEL_URL}/resolve/main/tokenizer.json`]: { 'content-length': '10', 'content-encoding': 'gzip' } },
      },
    });
    expect(await measureModelBytes('cache', LOCATION, gzip)).toBeNull();
  });

  it('保存領域の有無は、作らずに調べる', async () => {
    expect(await hasWebLlmStore('opfs', fakeStorage({ opfs: {} }))).toBe(false);
    expect(await hasWebLlmStore('opfs', fakeStorage({ opfs: OPFS_WITH_STORE }))).toBe(true);
    expect(await hasWebLlmStore('opfs', fakeStorage({}))).toBe(false);
    expect(await hasWebLlmStore('indexeddb', fakeStorage({ indexedDbNames: null }))).toBeNull();
    expect(await hasWebLlmStore('cache', fakeStorage({ caches: { 'webllm/model': {} } }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// origin の保存状況・永続化
// ---------------------------------------------------------------------------

describe('Storage Diagnostics', () => {
  it('usage / quota / persisted を返し、取得できなければ unknown（null）', async () => {
    const storage = fakeStorage({ usage: 1024 ** 2, quota: 10 * 1024 ** 3, persisted: true });
    expect(await probeStorageStatus(storage)).toEqual({ usageBytes: 1024 ** 2, quotaBytes: 10 * 1024 ** 3, persisted: true });
    expect(await probeStorageStatus({ storageManager: null, cacheStorage: null, indexedDb: null })).toEqual({
      usageBytes: null,
      quotaBytes: null,
      persisted: null,
    });
  });

  it('永続化の要求は best-effort（拒否・例外でも投げない）', async () => {
    const storage = fakeStorage({ persistResult: false });
    expect(await requestPersistentStorage(storage)).toBe(false);
    expect(storage.log).toEqual(['persist']);
    const throwing = {
      storageManager: { persist: async () => { throw new Error('denied'); } },
      cacheStorage: null,
      indexedDb: null,
    };
    expect(await requestPersistentStorage(throwing)).toBeNull();
  });

  it('download 前後の usage の差を footprint とする（取れなければ null）', () => {
    const status = (usageBytes: number | null) => ({ usageBytes, quotaBytes: null, persisted: null });
    expect(estimatedDownloadFootprint(status(100), status(1100))).toBe(1000);
    expect(estimatedDownloadFootprint(status(100), status(50))).toBeNull();
    expect(estimatedDownloadFootprint(status(null), status(50))).toBeNull();
    expect(estimatedDownloadFootprint(null, status(50))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 失敗の分類
// ---------------------------------------------------------------------------

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('取得・読み込みの失敗の分類', () => {
  const opfs = { backend: 'opfs' as const, aborted: false };
  const cache = { backend: 'cache' as const, aborted: false };

  it('QuotaExceededError は quota-exceeded（GPU 不足として扱わない）', () => {
    expect(classifyModelLoadFailure(new DOMException('Quota exceeded.', 'QuotaExceededError'), cache)).toBe('quota-exceeded');
    expect(classifyModelLoadFailure(new DOMException('Quota exceeded.', 'QuotaExceededError'), opfs)).toBe('quota-exceeded');
    expect(classifyModelLoadFailure(new Error("Failed to execute 'add' on 'Cache': Quota exceeded."), cache)).toBe('quota-exceeded');
    // GPU を思わせる語が混ざっていても、容量制限を優先する。
    expect(classifyModelLoadFailure(named('QuotaExceededError', 'WebGPU buffer quota'), cache)).toBe('quota-exceeded');
  });

  it('OPFS を使えないときは opfs-unavailable', () => {
    expect(classifyModelLoadFailure(new Error('OPFSStore: OPFS API unavailable.'), opfs)).toBe('opfs-unavailable');
    expect(classifyModelLoadFailure(named('SecurityError', 'The operation is insecure.'), opfs)).toBe('opfs-unavailable');
    expect(classifyModelLoadFailure(new Error('OPFSStore: crypto.subtle.digest is unavailable.'), opfs)).toBe('opfs-unavailable');
  });

  it('通信・GPU・保存領域・中止を区別する', () => {
    expect(classifyModelLoadFailure(new TypeError('Failed to fetch'), opfs)).toBe('network-failed');
    expect(classifyModelLoadFailure(new Error('ArtifactOPFSCache: Unable to fetch https://example.test/x, received status 404'), opfs))
      .toBe('network-failed');
    expect(classifyModelLoadFailure(named('DeviceLostError', 'The WebGPU device was lost while loading the model.'), opfs))
      .toBe('gpu-load-failed');
    expect(classifyModelLoadFailure(named('WebGPUNotAvailableError', 'WebGPU is not supported'), opfs)).toBe('gpu-load-failed');
    expect(classifyModelLoadFailure(named('ShaderF16SupportError', 'This model requires WebGPU extension shader-f16'), opfs))
      .toBe('gpu-load-failed');
    expect(classifyModelLoadFailure(named('InvalidStateError', 'An operation that depends on state failed'), opfs)).toBe('storage-failed');
    expect(classifyModelLoadFailure(named('NoModificationAllowedError', 'locked'), opfs)).toBe('storage-failed');
    expect(classifyModelLoadFailure(named('AbortError', 'aborted'), opfs)).toBe('aborted');
    expect(classifyModelLoadFailure(new BenchmarkRuntimeError('aborted', '読み込みを中止しました。'), opfs)).toBe('aborted');
    expect(classifyModelLoadFailure(new Error('whatever'), { backend: 'opfs', aborted: true })).toBe('aborted');
    expect(classifyModelLoadFailure(new Error('something odd'), opfs)).toBe('unknown');
    expect(classifyModelLoadFailure('plain string', { backend: null, aborted: false })).toBe('unknown');
  });

  it('IndexedDB で 30/30 shard を取得した後の読み戻しの失敗は storage-failed（network-failed にしない）', () => {
    const indexeddb = { backend: 'indexeddb' as const, aborted: false };
    const shard = 'https://example.test/resolve/main/params_shard_0.bin';
    // WebLLM 0.2.85 の ArtifactIndexedDBCache.fetchWithCache が投げる文面（PC 実機で観測したもの）。
    const readBack = new Error(`ArtifactIndexedDBCache failed to fetch: ${shard}`);
    expect(isPostStoreReadFailure(readBack, 'indexeddb')).toBe(true);
    expect(classifyModelLoadFailure(readBack, indexeddb)).toBe('storage-failed');
    // OPFS・Cache API の同じ段階の失敗も保存領域の失敗。
    expect(classifyModelLoadFailure(new Error(`ArtifactOPFSCache failed to fetch: ${shard}`), opfs)).toBe('storage-failed');
    expect(classifyModelLoadFailure(new Error(`Cannot fetch ${shard}`), cache)).toBe('storage-failed');
  });

  it('本物の通信の失敗（取得の失敗・HTTP の失敗・接続の失敗）は network-failed のまま', () => {
    const indexeddb = { backend: 'indexeddb' as const, aborted: false };
    const shard = 'https://example.test/resolve/main/params_shard_0.bin';
    // IndexedDB の addToCache は、取得の失敗を「Failed to store … with error: …」で包んで投げる。
    expect(classifyModelLoadFailure(new Error(`Failed to store ${shard} with error: TypeError: Failed to fetch`), indexeddb))
      .toBe('network-failed');
    expect(classifyModelLoadFailure(new Error(`Failed to store ${shard} with error: Error: Network response was not ok`), indexeddb))
      .toBe('network-failed');
    expect(classifyModelLoadFailure(new TypeError('Failed to fetch'), indexeddb)).toBe('network-failed');
    expect(classifyModelLoadFailure(new TypeError('Load failed'), indexeddb)).toBe('network-failed');
    expect(classifyModelLoadFailure(new Error('net::ERR_CONNECTION_RESET'), indexeddb)).toBe('network-failed');
    expect(classifyModelLoadFailure(new Error(`ArtifactOPFSCache: Unable to fetch ${shard}, received status 503`), opfs))
      .toBe('network-failed');
    // 文の途中に同じ語があっても、先頭が読み戻しの形でなければ読み戻しとはみなさない。
    expect(isPostStoreReadFailure(new Error(`Error: ArtifactIndexedDBCache failed to fetch: ${shard}`), 'indexeddb')).toBe(false);
    // Cache API の読み戻しの形は、Cache API のときだけ。
    expect(isPostStoreReadFailure(new Error(`Cannot fetch ${shard}`), 'indexeddb')).toBe(false);
  });

  const diagnostics = (overrides: Partial<ModelLoadFailureDiagnostics>): ModelLoadFailureDiagnostics => ({
    schema: '01as-ai-model-load-failure',
    schemaVersion: 1,
    occurredAt: '2026-09-28T00:00:00.000Z',
    candidateId: 'fixture-model',
    runtimeId: 'webllm',
    runtimeModelId: 'fixture-model-id',
    download: true,
    storageBackend: 'cache',
    failureClass: 'quota-exceeded',
    errorName: 'QuotaExceededError',
    message: 'Quota exceeded.',
    progressFraction: 0.42,
    progressText: 'Fetching param cache[10/40]',
    storage: { usageBytes: 1024 ** 2, quotaBytes: 10 * 1024 ** 3, persisted: false },
    storageBefore: null,
    ...overrides,
  });

  it('利用者向けの説明: 保存方式と容量制限を示し、Cache API なら OPFS での再試行を示す', () => {
    const cacheQuota = describeModelLoadFailure(diagnostics({}), { opfsAvailable: true });
    expect(cacheQuota.linesJa).toContain('モデルの保存に失敗しました。');
    expect(cacheQuota.linesJa).toContain('保存方式: Cache API');
    expect(cacheQuota.linesJa.join('\n')).toContain('容量制限');
    expect(cacheQuota.linesJa.join('\n')).toContain('OPFS で再試行できます');
    expect(cacheQuota.suggestOpfs).toBe(true);

    const opfsQuota = describeModelLoadFailure(diagnostics({ storageBackend: 'opfs' }), { opfsAvailable: true });
    expect(opfsQuota.suggestOpfs).toBe(false);
    expect(opfsQuota.linesJa).toContain('保存方式: OPFS');

    const noOpfs = describeModelLoadFailure(diagnostics({}), { opfsAvailable: false });
    expect(noOpfs.suggestOpfs).toBe(false);

    const gpu = describeModelLoadFailure(diagnostics({ failureClass: 'gpu-load-failed', storageBackend: 'opfs' }), { opfsAvailable: true });
    expect(gpu.linesJa.join('\n')).toContain('保存領域の問題ではありません');
  });

  it('読み戻しの失敗は「通信の失敗ではない」と示し、原因は断定しない', () => {
    const readBack = describeModelLoadFailure(
      diagnostics({ failureClass: 'storage-failed', storageBackend: 'indexeddb', progressFraction: 1, postStoreReadFailure: true }),
      { opfsAvailable: true },
    );
    const text = readBack.linesJa.join('\n');
    expect(text).toContain('通信の失敗ではありません');
    expect(text).toContain('可能性');
    expect(text).toContain('断定できません');
    expect(readBack.suggestOpfs).toBe(true);
  });

  it('すべての区分に説明がある', () => {
    for (const failureClass of MODEL_LOAD_FAILURE_CLASSES) {
      const description = describeModelLoadFailure(diagnostics({ failureClass }), { opfsAvailable: true });
      expect(description.linesJa.length).toBeGreaterThan(0);
    }
  });
});
