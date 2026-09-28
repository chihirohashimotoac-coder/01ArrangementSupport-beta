/**
 * Model Management（カタログ・状態・Runtime 境界）のテスト。
 *
 * 実モデル・実 Runtime は使わない。純粋な状態遷移と mock の Runtime だけで確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestFor } from '../../engine/recovery/suggest';
import { buildDecisionEvidence } from '../evidence';
import { explainDecision } from '../explain';
import type { AiProvider } from '../types';
import { PREFERENCES_KEY } from '../../storage/preferences';
import { SIMULATION_SETTINGS_KEY } from '../../storage/simulationSettings';
import { TRAINING_HISTORY_KEY } from '../../storage/trainingHistory';
import { STORAGE_NAMESPACE } from '../../storage/namespace';
import {
  DEFAULT_MODEL_CATALOG,
  LOCAL_AI_MODEL_CLASSES,
  LOCAL_AI_MODEL_CLASS_PROFILES,
  createModelCatalog,
  type LocalAiModelDefinition,
} from './catalog';
import {
  MODEL_RUNTIME_STATUSES,
  MODEL_STATE_STORAGE_NAME,
  activateModel,
  cancelDownload,
  clearActiveModel,
  completeDownload,
  createModelState,
  deleteModel,
  downloadedModelIds,
  failDownload,
  modelStatusOf,
  restoreModelState,
  startDownload,
  updateDownloadProgress,
  type ModelManagerState,
  type ModelTransition,
} from './state';
import {
  AI_MODEL_CACHE_NAMESPACE,
  isModelCacheName,
  modelCacheNameOf,
  removeModel,
  resolveActiveProvider,
  type LocalModelRuntime,
} from './runtime';

const GB = 1024 ** 3;

/** テスト用の定義。実在のモデル名は使わない。 */
function model(id: string, overrides: Partial<LocalAiModelDefinition> = {}): LocalAiModelDefinition {
  return {
    id,
    displayName: `Fixture ${id}`,
    modelClass: 'LIGHT',
    runtimeId: 'mock-runtime',
    modelId: `fixture/${id}`,
    parameterClass: '1.5B',
    downloadSizeBytes: 1 * GB,
    estimatedMemoryBytes: 2 * GB,
    contextWindow: 4096,
    capabilities: { explanation: true, review: true, coach: false },
    requirements: { webGpu: false },
    status: 'supported',
    ...overrides,
  };
}

const CATALOG = createModelCatalog([
  model('ultra', { modelClass: 'ULTRA_LIGHT', parameterClass: '0.5B' }),
  model('light', { modelClass: 'LIGHT' }),
  model('standard', { modelClass: 'STANDARD', parameterClass: '3B', requirements: { webGpu: true } }),
  model('quality', { modelClass: 'QUALITY', parameterClass: '7B', requirements: { webGpu: true } }),
  model('experimental', { modelClass: 'EXPERIMENTAL', status: 'experimental' }),
  model('old', { modelClass: 'LIGHT', status: 'deprecated' }),
]);

const WEBGPU = { webGpu: true } as const;
const NO_WEBGPU = { webGpu: false } as const;

function ok(transition: ModelTransition): ModelManagerState {
  if (!transition.ok) throw new Error(`遷移に失敗: ${transition.reason}`);
  return transition.state;
}

function downloaded(state: ModelManagerState, id: string): ModelManagerState {
  let next = ok(startDownload(state, CATALOG, id));
  next = ok(updateDownloadProgress(next, id, 0.5));
  return ok(completeDownload(next, id));
}

function mockProvider(id: string): AiProvider {
  return {
    id,
    kind: 'browser-local',
    explainDecision: async () => ({ text: 'T20 → S16 → D20（推奨度 S）は基準ルートです。' }),
  };
}

function mockRuntime(overrides: Partial<LocalModelRuntime> = {}): LocalModelRuntime & {
  removed: string[];
} {
  const removed: string[] = [];
  return {
    id: 'mock-runtime',
    removed,
    checkSupport: async () => ({ supported: true }),
    download: async () => undefined,
    remove: async (definition) => {
      removed.push(definition.id);
    },
    createProvider: async (definition) => mockProvider(`local:${definition.id}`),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Model Catalog', () => {
  it('複数のモデル定義を登録でき、model class を保持する', () => {
    expect(CATALOG.models).toHaveLength(6);
    expect(CATALOG.byId('ultra')?.modelClass).toBe('ULTRA_LIGHT');
    expect(CATALOG.byId('quality')?.modelClass).toBe('QUALITY');
    expect(CATALOG.byClass('LIGHT').map((definition) => definition.id)).toEqual(['light', 'old']);
    expect(CATALOG.byClass('EXPERIMENTAL').map((definition) => definition.id)).toEqual(['experimental']);
  });

  it('model class は 5 区分で、それぞれ説明を持つ', () => {
    expect(LOCAL_AI_MODEL_CLASSES).toEqual(['ULTRA_LIGHT', 'LIGHT', 'STANDARD', 'QUALITY', 'EXPERIMENTAL']);
    for (const modelClass of LOCAL_AI_MODEL_CLASSES) {
      expect(LOCAL_AI_MODEL_CLASS_PROFILES[modelClass].labelJa.length).toBeGreaterThan(0);
      expect(LOCAL_AI_MODEL_CLASS_PROFILES[modelClass].intendedForJa.length).toBeGreaterThan(0);
    }
  });

  it('ID の重複・未知の区分・不正なサイズは登録できない', () => {
    expect(() => createModelCatalog([model('a'), model('a')])).toThrow(/重複/);
    expect(() =>
      createModelCatalog([model('a', { modelClass: 'HUGE' as LocalAiModelDefinition['modelClass'] })]),
    ).toThrow(/modelClass/);
    expect(() => createModelCatalog([model('a', { downloadSizeBytes: -1 })])).toThrow(/downloadSizeBytes/);
  });

  it('既定のカタログは空（実モデルは未導入）', () => {
    expect(DEFAULT_MODEL_CATALOG.models).toEqual([]);
  });
});

describe('Model State', () => {
  it('表せる状態は AVAILABLE / DOWNLOADING / DOWNLOADED / ACTIVE / ERROR / UNSUPPORTED', () => {
    expect([...MODEL_RUNTIME_STATUSES].sort()).toEqual(
      ['ACTIVE', 'AVAILABLE', 'DOWNLOADED', 'DOWNLOADING', 'ERROR', 'UNSUPPORTED'].sort(),
    );
    let state = createModelState(CATALOG, WEBGPU);
    expect(modelStatusOf(state, 'light')).toBe('AVAILABLE');
    state = ok(startDownload(state, CATALOG, 'light'));
    expect(modelStatusOf(state, 'light')).toBe('DOWNLOADING');
    state = ok(completeDownload(state, 'light'));
    expect(modelStatusOf(state, 'light')).toBe('DOWNLOADED');
    state = ok(activateModel(state, 'light'));
    expect(modelStatusOf(state, 'light')).toBe('ACTIVE');
    state = ok(failDownload(ok(startDownload(state, CATALOG, 'ultra')), 'ultra', 'network'));
    expect(modelStatusOf(state, 'ultra')).toBe('ERROR');
    expect(modelStatusOf(createModelState(CATALOG, NO_WEBGPU), 'standard')).toBe('UNSUPPORTED');
  });

  it('初期状態では何も導入されておらず、使用中のモデルも無い（従来の 01AS）', () => {
    const state = createModelState(CATALOG, WEBGPU);
    expect(state.activeModelId).toBeNull();
    expect(downloadedModelIds(state)).toEqual([]);
  });

  it('未導入のモデルは active にできない', () => {
    const state = createModelState(CATALOG, WEBGPU);
    expect(activateModel(state, 'light')).toMatchObject({ ok: false, reason: 'not-downloaded' });
    const downloading = ok(startDownload(state, CATALOG, 'light'));
    expect(activateModel(downloading, 'light')).toMatchObject({ ok: false, reason: 'not-downloaded' });
    expect(activateModel(state, 'missing')).toMatchObject({ ok: false, reason: 'unknown-model' });
  });

  it('導入済みのモデルを active にでき、別の導入済みモデルへ切り替えられる', () => {
    let state = downloaded(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'standard');
    state = ok(activateModel(state, 'light'));
    expect(state.activeModelId).toBe('light');
    state = ok(activateModel(state, 'standard'));
    expect(state.activeModelId).toBe('standard');
    expect(modelStatusOf(state, 'light')).toBe('DOWNLOADED');
    expect(modelStatusOf(state, 'standard')).toBe('ACTIVE');
    // 選択を外すと従来の 01AS。導入済みのモデルは残る。
    state = clearActiveModel(state);
    expect(state.activeModelId).toBeNull();
    expect(downloadedModelIds(state).sort()).toEqual(['light', 'standard']);
  });

  it('active のモデルを削除すると、使用中のモデルは null（従来の 01AS）へ戻る', () => {
    let state = downloaded(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'ultra');
    state = ok(activateModel(state, 'light'));
    state = ok(deleteModel(state, 'light'));
    expect(state.activeModelId).toBeNull();
    expect(modelStatusOf(state, 'light')).toBe('AVAILABLE');
    // ほかの導入済みモデルへ勝手に切り替えない。
    expect(modelStatusOf(state, 'ultra')).toBe('DOWNLOADED');
  });

  it('active でないモデルを削除しても、使用中のモデルは変わらない', () => {
    let state = downloaded(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'ultra');
    state = ok(activateModel(state, 'light'));
    state = ok(deleteModel(state, 'ultra'));
    expect(state.activeModelId).toBe('light');
  });

  it('この端末で使えないモデルはダウンロードも選択もできない', () => {
    const state = createModelState(CATALOG, NO_WEBGPU);
    expect(modelStatusOf(state, 'quality')).toBe('UNSUPPORTED');
    expect(state.entries.quality.reason).toBe('webgpu-required');
    expect(startDownload(state, CATALOG, 'quality')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(activateModel(state, 'quality')).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('廃止予定（deprecated）のモデルは新しくダウンロードできない', () => {
    const state = createModelState(CATALOG, WEBGPU);
    expect(startDownload(state, CATALOG, 'old')).toMatchObject({ ok: false, reason: 'deprecated' });
  });

  it('失敗したダウンロードは再試行でき、中止すると AVAILABLE へ戻る', () => {
    let state = createModelState(CATALOG, WEBGPU);
    state = ok(failDownload(ok(startDownload(state, CATALOG, 'light')), 'light', 'network'));
    state = ok(startDownload(state, CATALOG, 'light'));
    expect(modelStatusOf(state, 'light')).toBe('DOWNLOADING');
    state = ok(cancelDownload(state, 'light'));
    expect(modelStatusOf(state, 'light')).toBe('AVAILABLE');
  });

  it('不正な遷移は状態を変えずに拒否する', () => {
    const state = createModelState(CATALOG, WEBGPU);
    const result = completeDownload(state, 'light');
    expect(result).toMatchObject({ ok: false, reason: 'invalid-transition' });
    expect(result.state).toBe(state);
    expect(deleteModel(state, 'light')).toMatchObject({ ok: false, reason: 'invalid-transition' });
  });

  it('保存した状態を復元する（中断・消えたモデル・非対応・壊れた値）', () => {
    let saved = downloaded(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'standard');
    saved = ok(activateModel(saved, 'standard'));
    saved = ok(startDownload(saved, CATALOG, 'ultra'));
    const raw = JSON.parse(JSON.stringify(saved)) as unknown;

    const restored = restoreModelState(raw, CATALOG, WEBGPU);
    expect(restored.activeModelId).toBe('standard');
    expect(modelStatusOf(restored, 'ultra')).toBe('AVAILABLE'); // 中断されたダウンロード

    // WebGPU が無い端末では、WebGPU 必須のモデルは選べない。
    const noGpu = restoreModelState(raw, CATALOG, NO_WEBGPU);
    expect(modelStatusOf(noGpu, 'standard')).toBe('UNSUPPORTED');
    expect(noGpu.activeModelId).toBeNull();

    // カタログから消えたモデルは捨てる。
    const smaller = createModelCatalog([model('light')]);
    const pruned = restoreModelState(raw, smaller, WEBGPU);
    expect(Object.keys(pruned.entries)).toEqual(['light']);
    expect(pruned.activeModelId).toBeNull();

    expect(restoreModelState('壊れている', CATALOG, WEBGPU)).toEqual(createModelState(CATALOG, WEBGPU));
    expect(restoreModelState({ version: 2 }, CATALOG, WEBGPU).activeModelId).toBeNull();
  });
});

describe('Provider abstraction との接続', () => {
  it('選択中のモデルの Runtime から Provider を作る', async () => {
    const state = ok(activateModel(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'light'));
    const resolution = await resolveActiveProvider({
      developerGateOpen: true,
      state,
      catalog: CATALOG,
      runtimes: [mockRuntime()],
    });
    expect(resolution).toMatchObject({ modelId: 'light', reason: null });
    expect(resolution.provider?.id).toBe('local:light');
  });

  it.each([
    ['モデル未導入', false, 'no-active-model'],
    ['Developer Gate が閉', true, 'developer-gate-closed'],
  ] as const)('%s なら Provider を作らない', async (_label, withModel, reason) => {
    const base = createModelState(CATALOG, WEBGPU);
    const state = withModel ? ok(activateModel(downloaded(base, 'light'), 'light')) : base;
    const createProvider = vi.fn(async () => mockProvider('x'));
    const resolution = await resolveActiveProvider({
      developerGateOpen: reason !== 'developer-gate-closed',
      state,
      catalog: CATALOG,
      runtimes: [mockRuntime({ createProvider })],
    });
    expect(resolution).toMatchObject({ provider: null, reason });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('Runtime が見つからない・失敗したときは Provider 無し（従来の説明へ）', async () => {
    const state = ok(activateModel(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'light'));
    expect(
      await resolveActiveProvider({ developerGateOpen: true, state, catalog: CATALOG, runtimes: [] }),
    ).toMatchObject({ provider: null, reason: 'runtime-not-found' });
    const failing = mockRuntime({
      createProvider: async () => {
        throw new Error('WebGPU device lost');
      },
    });
    expect(
      await resolveActiveProvider({ developerGateOpen: true, state, catalog: CATALOG, runtimes: [failing] }),
    ).toMatchObject({ provider: null, reason: 'runtime-error' });
  });

  it('解決した Provider は explainDecision から使われ、未導入なら従来の説明になる', async () => {
    const evidence = buildDecisionEvidence(suggestFor(116, 3));
    const active = ok(activateModel(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'light'));
    const withModel = await resolveActiveProvider({
      developerGateOpen: true,
      state: active,
      catalog: CATALOG,
      runtimes: [mockRuntime()],
    });
    expect(await explainDecision(evidence, { developerGate: true, provider: withModel.provider }))
      .toMatchObject({ status: 'ok', source: 'provider', providerId: 'local:light' });

    const none = await resolveActiveProvider({
      developerGateOpen: true,
      state: createModelState(CATALOG, WEBGPU),
      catalog: CATALOG,
      runtimes: [mockRuntime()],
    });
    expect(await explainDecision(evidence, { developerGate: true, provider: none.provider }))
      .toMatchObject({ status: 'ok', source: 'fallback', fallbackReason: 'no-active-model' });
  });
});

describe('モデルの削除と利用者データの分離', () => {
  it('モデルのキャッシュ名は利用者データのキーと別の名前空間', () => {
    const cache = modelCacheNameOf(CATALOG.byId('light')!);
    expect(cache).toBe(`${AI_MODEL_CACHE_NAMESPACE}light`);
    expect(isModelCacheName(cache)).toBe(true);
    for (const userKey of [PREFERENCES_KEY, TRAINING_HISTORY_KEY, SIMULATION_SETTINGS_KEY]) {
      expect(isModelCacheName(userKey), userKey).toBe(false);
      expect(userKey.startsWith(STORAGE_NAMESPACE)).toBe(true);
    }
    // Workbox の precache（01as-beta-precache-…）とも別。
    expect(isModelCacheName('01as-beta-precache-v2-https://example.test/')).toBe(false);
    // モデル状態の保存名も、利用者データのキー名と重ならない。
    expect([PREFERENCES_KEY, TRAINING_HISTORY_KEY, SIMULATION_SETTINGS_KEY]).not.toContain(
      `${STORAGE_NAMESPACE}${MODEL_STATE_STORAGE_NAME}`,
    );
  });

  it('モデルを削除しても、設定・学習履歴・SIMULATION 設定は読まれず・消されない', async () => {
    const userData = {
      [PREFERENCES_KEY]: JSON.stringify({ version: 1, preferredDoubles: ['D16'], setupMainTarget: 'T20', theme: 'light' }),
      [TRAINING_HISTORY_KEY]: JSON.stringify({ version: 2, records: [], migrationSkippedCount: 3 }),
      [SIMULATION_SETTINGS_KEY]: JSON.stringify({ version: 1, startScore: 701 }),
    };
    for (const [key, value] of Object.entries(userData)) window.localStorage.setItem(key, value);
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');

    const runtime = mockRuntime();
    let state = ok(activateModel(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'light'));
    const result = await removeModel({ state, catalog: CATALOG, runtimes: [runtime], modelId: 'light' });
    expect(result.ok).toBe(true);
    state = result.state;

    expect(runtime.removed).toEqual(['light']);
    expect(state.activeModelId).toBeNull();
    for (const spy of [get, set, remove, clear]) expect(spy).not.toHaveBeenCalled();
    for (const [key, value] of Object.entries(userData)) expect(window.localStorage.getItem(key)).toBe(value);
  });

  it('Runtime の削除が失敗したら状態を変えない', async () => {
    const state = ok(activateModel(downloaded(createModelState(CATALOG, WEBGPU), 'light'), 'light'));
    const failing = mockRuntime({
      remove: async () => {
        throw new Error('quota');
      },
    });
    const result = await removeModel({ state, catalog: CATALOG, runtimes: [failing], modelId: 'light' });
    expect(result).toMatchObject({ ok: false, reason: 'runtime-error' });
    expect(result.state).toBe(state);
  });
});

describe('モデルの状態は Decision Engine に影響しない', () => {
  function engineFingerprint(): string {
    return JSON.stringify(
      [[116, 3], [103, 3], [150, 1], [119, 2], [301, 3], [159, 3], [171, 1]].map(([left, darts]) => {
        const suggestion = suggestFor(left, darts);
        return [
          suggestion.mode,
          suggestion.checkoutRoutes.map((route) => [route.key, route.grade, route.score]),
          suggestion.setupRoutes.map((route) => [route.key, route.grade, route.score]),
          suggestion.nextVisitProposals.map((item) => [item.route.key, item.route.grade]),
          suggestion.practicalLastDart?.dartId ?? null,
        ];
      }),
    );
  }

  it('導入・選択・切り替え・削除をしても engine の結果は同じ', async () => {
    const before = engineFingerprint();
    const runtime = mockRuntime();
    let state = createModelState(CATALOG, WEBGPU);
    for (const id of ['ultra', 'light', 'standard']) state = downloaded(state, id);
    for (const id of ['ultra', 'light', 'standard']) {
      state = ok(activateModel(state, id));
      const { provider } = await resolveActiveProvider({
        developerGateOpen: true,
        state,
        catalog: CATALOG,
        runtimes: [runtime],
      });
      await explainDecision(buildDecisionEvidence(suggestFor(116, 3)), { developerGate: true, provider });
      expect(engineFingerprint()).toBe(before);
    }
    state = (await removeModel({ state, catalog: CATALOG, runtimes: [runtime], modelId: 'standard' })).state;
    expect(state.activeModelId).toBeNull();
    expect(engineFingerprint()).toBe(before);
  });
});
