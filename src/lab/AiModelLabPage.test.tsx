/**
 * AI MODEL LAB の画面テスト（Mock Runtime・Fake Model。実モデルは取得しない）。
 *
 * - 明示操作（確認 → ダウンロードを開始）なしにモデルを取得しない
 * - 確認画面に model / download size / estimated memory / runtime / license を出す
 * - Benchmark の結果・人手評価は Beta の名前空間に保存し、モデルの削除で消えない
 * - WebGPU が無い端末では Download できない（UNSUPPORTED）
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_CANDIDATE } from '../ai/benchmark/candidates';
import { assembleDataset } from '../ai/benchmark/dataset';
import type { DeviceReport } from '../ai/benchmark/device';
import { createMockRuntime, type MockRuntime } from '../ai/benchmark/runtimes/mockRuntime';
import { createTemplateRuntime } from '../ai/benchmark/runtimes/templateRuntime';
import { BenchmarkRuntimeError, type BenchmarkCandidate, type BenchmarkRuntime } from '../ai/benchmark/types';
import { buildDecisionEvidence } from '../ai/evidence';
import { suggestFor } from '../engine/recovery/suggest';
import { TRAINING_HISTORY_KEY } from '../storage/trainingHistory';
import { SIMULATION_SETTINGS_KEY } from '../storage/simulationSettings';
import { PREFERENCES_KEY } from '../storage/preferences';
import AiModelLabPage from './AiModelLabPage';
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

function renderLab<R extends BenchmarkRuntime = MockRuntime>(
  options: { mock?: R; device?: DeviceReport; candidates?: BenchmarkCandidate[] } = {},
): R & { unmount: () => void } {
  const mock = (options.mock ?? createMockRuntime({ id: 'mock' })) as R;
  const view = render(
    <AiModelLabPage
      onBack={() => {}}
      runtimes={[createTemplateRuntime(() => 0), mock]}
      candidates={options.candidates ?? [FIXTURE, BASELINE_CANDIDATE]}
      buildDataset={buildDataset}
      probe={async () => options.device ?? DEVICE}
    />,
  );
  return Object.assign(mock, { unmount: view.unmount });
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
    expect(await screen.findByTestId('lab-message')).toHaveTextContent('読み込めませんでした');
    await user.selectOptions(screen.getByTestId('lab-model-select'), 'fixture-model');
    expect(screen.getByTestId('lab-model-status')).not.toHaveTextContent('読み込み済み');
    expect(screen.getByTestId('lab-run')).toBeDisabled();
  });

  it('WebGPU が無い端末では UNSUPPORTED とし、Download できない', async () => {
    renderLab({ device: { ...DEVICE, webGpuExposed: false, adapter: 'not-checked', adapterInfo: null } });
    await waitFor(() => expect(screen.getByTestId('lab-compatibility')).toHaveTextContent('UNSUPPORTED'));
    expect(screen.getByTestId('lab-download')).toBeDisabled();
  });
});
