/**
 * AI MODEL LAB の画面テスト（Mock Runtime・Fake Model。実モデルは取得しない）。
 *
 * - 明示操作（確認 → ダウンロードを開始）なしにモデルを取得しない
 * - 確認画面に model / download size / estimated memory / runtime / license を出す
 * - Benchmark の結果・人手評価は Beta の名前空間に保存し、モデルの削除で消えない
 * - WebGPU が無い端末では Download できない（UNSUPPORTED）
 * - 保存方式（既定 OPFS）・origin の usage / quota / persisted を表示し、方式ごとに保存状況を確かめる
 * - 容量制限（QuotaExceededError）を quota-exceeded として示し、OPFS での再試行は確認を経てから取得する
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_CANDIDATE } from '../ai/benchmark/candidates';
import { assembleDataset } from '../ai/benchmark/dataset';
import type { DeviceReport } from '../ai/benchmark/device';
import type { ModelStorageBackend, ModelStorageSupport, StorageStatus } from '../ai/benchmark/modelStorage';
import { createMockRuntime, type MockRuntime, type MockRuntimeOptions } from '../ai/benchmark/runtimes/mockRuntime';
import { createTemplateRuntime } from '../ai/benchmark/runtimes/templateRuntime';
import { BenchmarkRuntimeError, type BenchmarkCandidate, type BenchmarkRuntime } from '../ai/benchmark/types';
import { buildDecisionEvidence } from '../ai/evidence';
import { suggestFor } from '../engine/recovery/suggest';
import { TRAINING_HISTORY_KEY } from '../storage/trainingHistory';
import { SIMULATION_SETTINGS_KEY } from '../storage/simulationSettings';
import { PREFERENCES_KEY } from '../storage/preferences';
import { createFakeAdapter } from '../storageDiagnostics/fakeAdapter';
import AiModelLabPage, { type AiModelLabPageProps } from './AiModelLabPage';
import { BENCHMARK_RATINGS_KEY, BENCHMARK_RUNS_KEY } from './labStorage';

const FIXTURE: BenchmarkCandidate = {
  ...BASELINE_CANDIDATE,
  id: 'fixture-model',
  displayName: 'Fixture Model',
  runtime: 'webllm',
  runtimeModelId: 'fixture-model-id',
  license: 'Fixture License',
  downloadSizeBytes: 3 * 1024 ** 3,
  estimatedVramBytes: 2 * 1024 ** 3,
  lowResourceRequired: true,
  supportsThinkingToggle: true,
};

const DEVICE: DeviceReport = {
  userAgent: 'test-agent',
  browserBrands: null,
  platform: null,
  mobile: false,
  webGpuExposed: true,
  adapter: 'available',
  adapterError: null,
  adapterInfo: { vendor: 'fixture', architecture: 'gpu', device: null, description: null },
  isFallbackAdapter: false,
  gpuFeatures: ['shader-f16'],
  gpuLimits: { maxBufferSize: 1024 ** 3, maxStorageBufferBindingSize: 1024 ** 3 },
  deviceMemoryGiB: 8,
  hardwareConcurrency: 8,
  storage: null,
};

const buildDataset = () =>
  assembleDataset({
    id: 'fixture',
    version: 1,
    labelJa: 'Fixture Dataset',
    drafts: [
      [170, 3],
      [301, 3],
    ].map(([left, darts]) => ({
      id: `C-${left}`,
      category: left > 170 ? 'SETUP' : 'CHECKOUT',
      titleJa: `${left}`,
      input: { kind: 'decision', decision: buildDecisionEvidence(suggestFor(left, darts)), previousThrow: null },
    })),
  });

const USER_DATA = {
  [TRAINING_HISTORY_KEY]: '{"version":2,"records":[],"migrationSkippedCount":0}',
  [SIMULATION_SETTINGS_KEY]: '{"version":1}',
  [PREFERENCES_KEY]: '{"version":1}',
};

const ALL_STORAGE: ModelStorageSupport = { opfs: true, indexeddb: true, cache: true };
const STATUS: StorageStatus = { usageBytes: 1024 ** 2, quotaBytes: 10 * 1024 ** 3, persisted: false };

function renderLab<R extends BenchmarkRuntime = MockRuntime>(
  options: {
    mock?: R;
    device?: DeviceReport;
    candidates?: BenchmarkCandidate[];
    probeStorage?: () => Promise<StorageStatus>;
    requestPersist?: () => Promise<boolean | null>;
    storageDiagnostics?: AiModelLabPageProps['storageDiagnostics'];
  } = {},
): R & { unmount: () => void } {
  const mock = (options.mock ?? createMockRuntime({ id: 'mock' })) as R;
  const view = render(
    <AiModelLabPage
      onBack={() => {}}
      runtimes={[createTemplateRuntime(() => 0), mock]}
      candidates={options.candidates ?? [FIXTURE, BASELINE_CANDIDATE]}
      buildDataset={buildDataset}
      probe={async () => options.device ?? DEVICE}
      storageSupport={ALL_STORAGE}
      probeStorage={options.probeStorage ?? (async () => STATUS)}
      requestPersist={options.requestPersist ?? (async () => false)}
      storageDiagnostics={options.storageDiagnostics}
    />,
  );
  return Object.assign(mock, { unmount: view.unmount });
}

/** 保存方式ごとに Mock Runtime を作る（Lab が方式を変えるたびに作り直すのと同じ形）。 */
function perBackendRuntimes(options: (backend: ModelStorageBackend) => MockRuntimeOptions) {
  const created: Partial<Record<ModelStorageBackend, MockRuntime>> = {};
  const factory = (backend: ModelStorageBackend | null) => {
    if (backend === null) return [createTemplateRuntime(() => 0)];
    created[backend] ??= createMockRuntime({ id: `mock-${backend}`, storageBackend: backend, ...options(backend) });
    return [createTemplateRuntime(() => 0), created[backend]!];
  };
  return { factory, created };
}

beforeEach(() => {
  window.localStorage.clear();
  for (const [key, value] of Object.entries(USER_DATA)) window.localStorage.setItem(key, value);
});

afterEach(() => {
  window.localStorage.clear();
});

describe('AI MODEL LAB', () => {
  it('端末・データセット・モデルの情報を表示する', async () => {
    renderLab();
    expect(await screen.findByTestId('device-webgpu')).toHaveTextContent('available');
    await waitFor(() => expect(screen.getByTestId('lab-cases')).toHaveTextContent('2'));
    expect(screen.getByTestId('lab-dataset')).toHaveTextContent('Fixture Dataset');
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('未ダウンロード'));
    expect(screen.getByTestId('lab-estimated-memory')).toHaveTextContent('2.00 GiB');
    // モデルが無いので Benchmark は実行できない。
    expect(screen.getByTestId('lab-run')).toBeDisabled();
  });

  it('確認画面で必要な情報を示し、「ダウンロードを開始」を押すまで取得しない', async () => {
    const user = userEvent.setup();
    const mock = renderLab();
    await user.click(await screen.findByTestId('lab-download'));
    const confirm = screen.getByTestId('lab-download-confirm');
    for (const text of ['Fixture Model', 'fixture-model-id', '3.00 GiB', '2.00 GiB', 'Mock Runtime', 'Fixture License']) {
      expect(within(confirm).getByText(new RegExp(text))).toBeInTheDocument();
    }
    expect(mock.log).toEqual([]);

    await user.click(within(confirm).getByText('キャンセル'));
    expect(mock.log).toEqual([]);

    await user.click(screen.getByTestId('lab-download'));
    await user.click(screen.getByTestId('lab-download-start'));
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('読み込み済み'));
    expect(mock.log[0]).toBe('download:fixture-model');
  });

  it('Benchmark を実行し、結果と人手評価を Beta の名前空間に保存する。モデル削除で結果・評価・利用者データは消えない', async () => {
    const user = userEvent.setup();
    const mock = renderLab({ mock: createMockRuntime({ id: 'mock', cachedCandidateIds: ['fixture-model'] }) });
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(screen.getByTestId('lab-run')).toBeEnabled());
    await user.click(screen.getByTestId('lab-run'));

    expect(await screen.findByTestId('metric-validation')).toHaveTextContent('2 / 2');
    expect(screen.getByTestId('metric-contradiction')).toHaveTextContent('0 / 2');
    expect(screen.getByTestId('metric-unsupported')).toHaveTextContent('0 件');
    expect(mock.log.some((entry) => entry.startsWith('download'))).toBe(false);

    await user.selectOptions(screen.getByTestId('rating-clarity-C-170'), '4');
    const storedRatings = JSON.parse(window.localStorage.getItem(BENCHMARK_RATINGS_KEY) ?? '{}');
    expect(Object.values(storedRatings.ratings)).toEqual([{ clarity: 4 }]);
    expect(BENCHMARK_RATINGS_KEY.startsWith('01as-beta:')).toBe(true);
    expect(BENCHMARK_RUNS_KEY.startsWith('01as-beta:')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(BENCHMARK_RUNS_KEY) ?? '{}').runs).toHaveLength(1);

    await user.click(screen.getByTestId('lab-delete-model'));
    expect(screen.getByTestId('lab-delete-confirm')).toHaveTextContent('TRAINING 履歴');
    await user.click(screen.getByTestId('lab-delete-start'));
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('未ダウンロード'));
    expect(mock.log).toContain('delete:fixture-model');

    expect(window.localStorage.getItem(BENCHMARK_RATINGS_KEY)).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(BENCHMARK_RUNS_KEY) ?? '{}').runs).toHaveLength(1);
    for (const [key, value] of Object.entries(USER_DATA)) expect(window.localStorage.getItem(key)).toBe(value);
    // 結果はモデルを消したあとも表示できる。
    expect(screen.getByTestId('metric-validation')).toHaveTextContent('2 / 2');
  });

  it('baseline（template）はモデルなしで実行できる', async () => {
    const user = userEvent.setup();
    renderLab();
    await user.selectOptions(await screen.findByTestId('lab-model-select'), BASELINE_CANDIDATE.id);
    await waitFor(() => expect(screen.getByTestId('lab-run')).toBeEnabled());
    await user.click(screen.getByTestId('lab-run'));
    expect(await screen.findByTestId('metric-validation')).toHaveTextContent('2 / 2');
  });

  it('開発者向けの実験機能であること・大容量のダウンロード・正式採用は未定であることを示す', async () => {
    renderLab();
    const notice = await screen.findByTestId('lab-experimental-notice');
    expect(notice).toHaveTextContent('開発者向けの実験機能');
    expect(notice).toHaveTextContent('大容量のデータ');
    expect(notice).toHaveTextContent('正式に採用するかは、まだ決まっていません');
  });

  it('Lab を離れると、読み込んだモデルを解放する', async () => {
    const user = userEvent.setup();
    const mock = createMockRuntime({ id: 'mock', cachedCandidateIds: ['fixture-model'] });
    const unload = vi.spyOn(mock, 'unload');
    const view = renderLab({ mock });
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(mock.loadedCandidateId()).toBe('fixture-model'));
    view.unmount();
    expect(unload).toHaveBeenCalled();
    await waitFor(() => expect(mock.loadedCandidateId()).toBeNull());
  });

  it('読み込みに失敗したら「読み込み済み」を解除する（前のモデルで Run できる状態を残さない）', async () => {
    const user = userEvent.setup();
    const second: BenchmarkCandidate = { ...FIXTURE, id: 'second-model', displayName: 'Second Model', runtimeModelId: 'second-id' };
    const mock = createMockRuntime({ id: 'mock', cachedCandidateIds: ['fixture-model', 'second-model'] });
    const failing: BenchmarkRuntime = {
      ...mock,
      load: async (candidate, loadOptions) => {
        if (candidate.id === 'second-model') {
          await mock.unload();
          throw new BenchmarkRuntimeError('generation-failed', 'device lost');
        }
        return mock.load(candidate, loadOptions);
      },
    };
    renderLab({ mock: failing, candidates: [FIXTURE, second, BASELINE_CANDIDATE] });
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('読み込み済み'));
    await user.selectOptions(screen.getByTestId('lab-model-select'), 'second-model');
    await user.click(await screen.findByTestId('lab-load'));
    const failure = await screen.findByTestId('lab-failure');
    expect(failure).toHaveTextContent('GPU（WebGPU）へ読み込めませんでした');
    expect(screen.getByTestId('failure-class')).toHaveTextContent('gpu-load-failed');
    await user.selectOptions(screen.getByTestId('lab-model-select'), 'fixture-model');
    expect(screen.getByTestId('lab-model-status')).not.toHaveTextContent('読み込み済み');
    expect(screen.getByTestId('lab-run')).toBeDisabled();
  });

  it('WebGPU が無い端末では UNSUPPORTED とし、Download できない', async () => {
    renderLab({ device: { ...DEVICE, webGpuExposed: false, adapter: 'not-checked', adapterInfo: null } });
    await waitFor(() => expect(screen.getByTestId('lab-compatibility')).toHaveTextContent('UNSUPPORTED'));
    expect(screen.getByTestId('lab-download')).toBeDisabled();
  });

  it('保存方式（既定 OPFS）と origin の usage / quota / persisted を表示する', async () => {
    renderLab();
    expect(await screen.findByTestId('storage-backend')).toHaveTextContent('OPFS');
    await waitFor(() => expect(screen.getByTestId('storage-usage')).toHaveTextContent('1 MiB'));
    expect(screen.getByTestId('storage-quota')).toHaveTextContent('10.00 GiB');
    expect(screen.getByTestId('storage-persistent')).toHaveTextContent('no');
    expect(screen.getByTestId('lab-storage-backend-select')).toHaveValue('opfs');
    await waitFor(() =>
      expect(screen.getByTestId('lab-model-storage-presence')).toHaveTextContent('OPFS: なし / IndexedDB: なし / Cache API: なし'),
    );
  });

  it('OPFS が無いブラウザでは推奨順の次の方式を初期値にし、使えない方式は選べない', async () => {
    render(
      <AiModelLabPage
        onBack={() => {}}
        runtimes={[createTemplateRuntime(() => 0), createMockRuntime({ id: 'mock', storageBackend: 'indexeddb' })]}
        candidates={[FIXTURE, BASELINE_CANDIDATE]}
        buildDataset={buildDataset}
        probe={async () => DEVICE}
        storageSupport={{ opfs: false, indexeddb: true, cache: true }}
        probeStorage={async () => STATUS}
        requestPersist={async () => false}
      />,
    );
    expect(await screen.findByTestId('storage-backend')).toHaveTextContent('IndexedDB');
    expect(screen.getByTestId('storage-fallback')).toHaveTextContent('OPFS の API を公開していない');
    const select = screen.getByTestId('lab-storage-backend-select');
    expect(within(select).getByRole('option', { name: /OPFS/ })).toBeDisabled();
  });

  it('容量制限（QuotaExceededError）は quota-exceeded として保存方式・診断情報を示し、OPFS での再試行は確認を経てから取得する', async () => {
    const user = userEvent.setup();
    const { factory, created } = perBackendRuntimes((backend) => ({
      failDownload: backend === 'cache' ? () => new DOMException('Quota exceeded.', 'QuotaExceededError') : undefined,
    }));
    render(
      <AiModelLabPage
        onBack={() => {}}
        runtimes={factory}
        candidates={[FIXTURE, BASELINE_CANDIDATE]}
        buildDataset={buildDataset}
        probe={async () => DEVICE}
        storageSupport={ALL_STORAGE}
        probeStorage={async () => STATUS}
        requestPersist={async () => false}
      />,
    );
    await user.selectOptions(await screen.findByTestId('lab-storage-backend-select'), 'cache');
    expect(screen.getByTestId('storage-backend')).toHaveTextContent('Cache API');
    await user.click(await screen.findByTestId('lab-download'));
    expect(screen.getByTestId('lab-download-confirm-storage')).toHaveTextContent('Cache API');
    await user.click(screen.getByTestId('lab-download-start'));

    const failure = await screen.findByTestId('lab-failure');
    expect(failure).toHaveTextContent('モデルの保存に失敗しました。');
    expect(failure).toHaveTextContent('保存方式: Cache API');
    expect(failure).toHaveTextContent('容量制限');
    expect(failure).toHaveTextContent('GPU の不足ではありません');
    expect(failure).toHaveTextContent('OPFS で再試行できます');
    expect(screen.getByTestId('failure-class')).toHaveTextContent('quota-exceeded');
    const diagnostics = screen.getByTestId('lab-failure-diagnostics');
    expect(diagnostics).toHaveTextContent('QuotaExceededError');
    expect(diagnostics).toHaveTextContent('Quota exceeded.');
    expect(diagnostics).toHaveTextContent('50.0%');
    expect(diagnostics).toHaveTextContent('1 MiB / 10.00 GiB');
    expect(created.cache?.log).toEqual(['download:fixture-model']);

    // OPFS で再試行: 方式を OPFS に切り替え、確認画面を出すだけ（まだ取得しない）。
    await user.click(screen.getByTestId('lab-retry-opfs'));
    expect(screen.getByTestId('storage-backend')).toHaveTextContent('OPFS');
    expect(screen.getByTestId('lab-download-confirm-storage')).toHaveTextContent('OPFS');
    expect(screen.queryByTestId('lab-failure')).toBeNull();
    expect(created.opfs?.log ?? []).toEqual([]);
    await user.click(screen.getByTestId('lab-download-start'));
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('読み込み済み'));
    expect(created.opfs?.log[0]).toBe('download:fixture-model');
    // Cache API 側の記録は増えていない（方式を混ぜない）。
    expect(created.cache?.log).toEqual(['download:fixture-model']);
  });

  it('永続化は「ダウンロードを開始」を押したときに 1 回だけ要求し、拒否されても取得する', async () => {
    const user = userEvent.setup();
    const persist = vi.fn(async () => false);
    const mock = renderLab({ requestPersist: persist });
    await screen.findByTestId('storage-backend');
    expect(persist).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId('lab-download'));
    expect(persist).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('lab-download-start'));
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('読み込み済み'));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(mock.log[0]).toBe('download:fixture-model');

    // 削除して、もう一度ダウンロードしても再要求しない。
    await user.click(screen.getByTestId('lab-delete-model'));
    await user.click(screen.getByTestId('lab-delete-start'));
    await user.click(await screen.findByTestId('lab-download'));
    await user.click(screen.getByTestId('lab-download-start'));
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('読み込み済み'));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('download 前後の usage の差を、モデルの厳密な値ではない footprint として別に示す', async () => {
    const user = userEvent.setup();
    let usage = 1024 ** 2;
    renderLab({
      mock: createMockRuntime({ id: 'mock', sizeBytes: null }),
      probeStorage: async () => {
        const status = { usageBytes: usage, quotaBytes: 10 * 1024 ** 3, persisted: false };
        usage += 512 * 1024 ** 2;
        return status;
      },
    });
    await user.click(await screen.findByTestId('lab-download'));
    await user.click(screen.getByTestId('lab-download-start'));
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('読み込み済み'));
    expect(await screen.findByTestId('lab-download-footprint')).toHaveTextContent('512 MiB');
    expect(screen.getByTestId('lab-download-footprint')).toHaveTextContent('origin 全体の差分');
    // モデル単位のサイズを数えられない Runtime では 0 B ではなく unknown。
    expect(screen.getByTestId('lab-download-size')).toHaveTextContent('unknown');
  });

  it('いまの方式に無くても、別の方式に保存されていれば「どこにも無い」とは扱わない', async () => {
    renderLab({ mock: createMockRuntime({ id: 'mock', cachedElsewhere: { cache: ['fixture-model'] } }) });
    await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('未ダウンロード'));
    await waitFor(() =>
      expect(screen.getByTestId('lab-model-storage-presence')).toHaveTextContent('OPFS: なし / IndexedDB: なし / Cache API: あり'),
    );
    expect(screen.getByTestId('lab-model-elsewhere')).toHaveTextContent('Cache API に保存されています');
  });

  it('保存方式の変更・モデルの削除で 01as-beta:oas.* / 01as-beta:ai.benchmark.* を変えない', async () => {
    const user = userEvent.setup();
    const benchmarkData = {
      [BENCHMARK_RUNS_KEY]: '{"version":1,"runs":[]}',
      [BENCHMARK_RATINGS_KEY]: '{"version":1,"ratings":{"r":{"clarity":3}}}',
    };
    for (const [key, value] of Object.entries(benchmarkData)) window.localStorage.setItem(key, value);
    const snapshot = () =>
      Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)!)
        .map((key) => [key, window.localStorage.getItem(key)]));
    const before = snapshot();
    expect(Object.keys(before).every((key) => key.startsWith('01as-beta:oas.') || key.startsWith('01as-beta:ai.benchmark.'))).toBe(true);

    const { factory } = perBackendRuntimes(() => ({ cachedCandidateIds: ['fixture-model'] }));
    render(
      <AiModelLabPage
        onBack={() => {}}
        runtimes={factory}
        candidates={[FIXTURE, BASELINE_CANDIDATE]}
        buildDataset={buildDataset}
        probe={async () => DEVICE}
        storageSupport={ALL_STORAGE}
        probeStorage={async () => STATUS}
        requestPersist={async () => false}
      />,
    );
    for (const backend of ['indexeddb', 'cache', 'opfs'] as const) {
      await user.selectOptions(await screen.findByTestId('lab-storage-backend-select'), backend);
      await user.click(await screen.findByTestId('lab-delete-model'));
      expect(screen.getByTestId('lab-delete-confirm')).toHaveTextContent(`保存方式: ${{ opfs: 'OPFS', indexeddb: 'IndexedDB', cache: 'Cache API' }[backend]}`);
      await user.click(screen.getByTestId('lab-delete-start'));
      await waitFor(() => expect(screen.getByTestId('lab-model-status')).toHaveTextContent('未ダウンロード'));
    }
    expect(snapshot()).toEqual(before);
  });
  it('BROWSER STORAGE DIAGNOSTICS を表示し、診断の実行中はモデルの取得を始めない（WebLLM・モデルを使わない）', async () => {
    const user = userEvent.setup();
    let release: (() => void) | null = null;
    const opfs = createFakeAdapter({
      backend: 'opfs',
      beforeWrite: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const mock = renderLab({
      storageDiagnostics: {
        adapters: { opfs, indexeddb: createFakeAdapter({ backend: 'indexeddb' }), cache: createFakeAdapter({ backend: 'cache' }) },
        probeStorage: async () => STATUS,
        testMode: true,
      },
    });
    const section = await screen.findByTestId('lab-storage-diagnostics');
    expect(within(section).getByText('BROWSER STORAGE DIAGNOSTICS')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('lab-download')).toBeEnabled());

    await user.click(screen.getByTestId('diag-start-opfs'));
    await waitFor(() => expect(release).not.toBeNull());
    expect(screen.getByTestId('lab-download')).toBeDisabled();
    expect(screen.getByTestId('lab-storage-backend-select')).toBeDisabled();

    for (let index = 0; index < 4; index += 1) {
      await waitFor(() => expect(release).not.toBeNull());
      const next = release as unknown as () => void;
      release = null;
      next();
    }
    await waitFor(() => expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('OPFS 4 MiB書き込み成功'));
    await waitFor(() => expect(screen.getByTestId('lab-download')).toBeEnabled());
    // 診断はモデルの Runtime を呼ばない。利用者データも変えない。
    expect(mock.log).toEqual([]);
    for (const [key, value] of Object.entries(USER_DATA)) expect(window.localStorage.getItem(key)).toBe(value);
  });
});

