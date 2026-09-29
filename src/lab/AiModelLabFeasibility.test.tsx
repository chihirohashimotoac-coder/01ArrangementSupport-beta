/**
 * AI MODEL LAB: Benchmark Profile・MOBILE_FEASIBILITY の段階・crash checkpoint・モデルの解放・再評価の画面テスト。
 *
 * Mock Runtime（Fake Model）だけを使い、実モデルは取得しない。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_CANDIDATE } from '../ai/benchmark/candidates';
import { assembleDataset } from '../ai/benchmark/dataset';
import type { DeviceReport } from '../ai/benchmark/device';
import type { ModelStorageSupport, StorageStatus } from '../ai/benchmark/modelStorage';
import { PROMPT_VERSION_LABEL } from '../ai/benchmark/prompt';
import { runBenchmark } from '../ai/benchmark/runner';
import { createFakeClock, createMockRuntime, faithfulResponse, type MockRuntime } from '../ai/benchmark/runtimes/mockRuntime';
import { createTemplateRuntime } from '../ai/benchmark/runtimes/templateRuntime';
import {
  BENCHMARK_CATEGORIES,
  BenchmarkRuntimeError,
  type BenchmarkCandidate,
  type BenchmarkRun,
  type CaseResult,
  type GenerationRequest,
} from '../ai/benchmark/types';
import { buildDecisionEvidence } from '../ai/evidence';
import { suggestFor } from '../engine/recovery/suggest';
import AiModelLabPage from './AiModelLabPage';
import {
  BENCHMARK_CHECKPOINT_KEY,
  FEASIBILITY_RECORDS_KEY,
  readCheckpoint,
  startCheckpoint,
  type BenchmarkCheckpoint,
} from './benchmarkCheckpoint';
import { BENCHMARK_PROFILE_KEY, BENCHMARK_RUNS_KEY, MAX_STORED_RUNS } from './labStorage';

/** 各カテゴリ 3 件（計 15 件）。クイックは各カテゴリ 2 件で 10 件。 */
const buildDataset = () =>
  assembleDataset({
    id: 'fixture',
    version: 1,
    labelJa: 'Fixture Dataset',
    drafts: BENCHMARK_CATEGORIES.flatMap((category, index) =>
      [0, 1, 2].map((offset) => {
        const left = 60 + index * 10 + offset;
        return {
          id: `${category}-${offset}`,
          category,
          titleJa: `${left}`,
          input: { kind: 'decision' as const, decision: buildDecisionEvidence(suggestFor(left, 3)), previousThrow: null },
        };
      }),
    ),
  });

const FINGERPRINT = buildDataset().fingerprint;

const MEASURED: BenchmarkCandidate = {
  ...BASELINE_CANDIDATE,
  id: 'fixture-model',
  displayName: 'Fixture Model',
  runtime: 'webllm',
  runtimeModelId: 'fixture-model-id',
  estimatedVramBytes: 2 * 1024 ** 3,
  contextWindow: 4096,
  supportsThinkingToggle: true,
  promptTokenMeasurement: {
    datasetFingerprint: FINGERPRINT,
    promptVersion: PROMPT_VERSION_LABEL,
    cases: 15,
    meanTokens: 1000,
    p95Tokens: 1400,
    maxTokens: 1500,
    maxCaseId: 'SETUP-0',
    tokenizerJa: 'fixture',
  },
};

const UNMEASURED: BenchmarkCandidate = { ...MEASURED, id: 'unmeasured-model', displayName: 'Unmeasured Model', promptTokenMeasurement: undefined };

const DEVICE: DeviceReport = {
  userAgent: 'test-agent',
  browserBrands: null,
  platform: null,
  mobile: true,
  webGpuExposed: true,
  adapter: 'available',
  adapterError: null,
  adapterInfo: { vendor: 'apple', architecture: 'common-3', device: null, description: null },
  isFallbackAdapter: false,
  gpuFeatures: [],
  gpuLimits: { maxBufferSize: 1024 ** 3, maxStorageBufferBindingSize: 1024 ** 3 },
  deviceMemoryGiB: null,
  hardwareConcurrency: 6,
  storage: null,
};

const ALL_STORAGE: ModelStorageSupport = { opfs: true, indexeddb: true, cache: true };
const STATUS: StorageStatus = { usageBytes: 1024 ** 2, quotaBytes: 10 * 1024 ** 3, persisted: false };

function renderLab(mock: MockRuntime, candidates: BenchmarkCandidate[] = [MEASURED, UNMEASURED, BASELINE_CANDIDATE]) {
  return render(
    <AiModelLabPage
      onBack={() => {}}
      runtimes={[createTemplateRuntime(() => 0), mock]}
      candidates={candidates}
      buildDataset={buildDataset}
      probe={async () => DEVICE}
      storageSupport={ALL_STORAGE}
      probeStorage={async () => STATUS}
      requestPersist={async () => false}
    />,
  );
}

function cachedMock(options: Parameters<typeof createMockRuntime>[0] = {}): MockRuntime {
  return createMockRuntime({ id: 'mock', cachedCandidateIds: ['fixture-model', 'unmeasured-model'], ...options });
}

async function chooseMobile(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByTestId('lab-profile-select'), 'MOBILE_FEASIBILITY');
  await waitFor(() => expect(screen.getByTestId('lab-stage-run-LOAD_ONLY')).toBeEnabled());
}

function storedRuns(): BenchmarkRun[] {
  return JSON.parse(window.localStorage.getItem(BENCHMARK_RUNS_KEY) ?? '{"runs":[]}').runs;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('Benchmark Profile', () => {
  it('STANDARD は従来どおり（Run Benchmark・max_tokens 384・既定の context）で、run に profile を保存する', async () => {
    const user = userEvent.setup();
    const mock = cachedMock();
    renderLab(mock);
    expect(await screen.findByTestId('lab-profile')).toHaveTextContent('STANDARD v1');
    expect(screen.getByTestId('lab-profile-max-tokens')).toHaveTextContent('384');
    expect(screen.getByTestId('lab-profile-context')).toHaveTextContent('Runtime の既定（4096）');
    expect(screen.queryByTestId('lab-stages')).toBeNull();
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(screen.getByTestId('lab-run')).toBeEnabled());
    expect(mock.loadedContextWindowSize()).toBeNull();
    await user.click(screen.getByTestId('lab-run'));
    await screen.findByTestId('metric-validation');
    const [run] = storedRuns();
    expect(run.profile).toEqual({ id: 'STANDARD', version: 1, contextWindowSize: null, stage: null });
    expect(run.settings.maxTokens).toBe(384);
    expect(run.validatorVersion).toBe(2);
    expect(screen.getByTestId('result-profile')).toHaveTextContent('STANDARD v1');
    expect(screen.queryByTestId('result-profile-warning')).toBeNull();
    expect(screen.getByTestId('metric-clean')).toHaveTextContent('15 / 15');
  });

  it('MOBILE_FEASIBILITY は context 2048・max_tokens 192 を示し、品質の benchmark ではない・比べないと警告する。選択を覚える', async () => {
    const user = userEvent.setup();
    renderLab(cachedMock());
    await chooseMobile(user);
    expect(screen.getByTestId('lab-profile')).toHaveTextContent('MOBILE_FEASIBILITY v1');
    expect(screen.getByTestId('lab-profile-context')).toHaveTextContent('2048');
    expect(screen.getByTestId('lab-profile-max-tokens')).toHaveTextContent('192');
    expect(screen.getByTestId('lab-profile-warning')).toHaveTextContent('STANDARD と直接比べないでください');
    // いきなり 100 件は走らせない（Run Benchmark は出さず、段階だけ）。
    expect(screen.queryByTestId('lab-run')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(BENCHMARK_PROFILE_KEY) ?? 'null')).toBe('MOBILE_FEASIBILITY');
    // 最初に推奨するのは LOAD ONLY だけ。
    expect(screen.getByTestId('lab-stage-run-LOAD_ONLY')).toHaveTextContent('LOAD ONLY');
    expect(screen.getByTestId('lab-stage-run-ONE_CASE')).toHaveTextContent('非推奨');
    expect(screen.getByTestId('lab-stage-run-FULL_100')).toHaveTextContent('非推奨');
  });

  it('prompt token 数が未計測の候補には MOBILE_FEASIBILITY を使わない', async () => {
    const user = userEvent.setup();
    renderLab(cachedMock());
    await chooseMobile(user);
    await user.selectOptions(screen.getByTestId('lab-model-select'), 'unmeasured-model');
    expect(await screen.findByTestId('lab-profile-unfit')).toHaveTextContent('未計測');
    expect(screen.getByTestId('lab-stage-run-LOAD_ONLY')).toBeDisabled();
  });
});

describe('MOBILE_FEASIBILITY の段階', () => {
  it('LOAD ONLY: 取得せずに context 2048 で読み込み、すぐ解放して、成否と時間を記録する', async () => {
    const user = userEvent.setup();
    const mock = cachedMock();
    renderLab(mock);
    await chooseMobile(user);
    await user.click(screen.getByTestId('lab-stage-run-LOAD_ONLY'));
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-LOAD_ONLY')).toHaveTextContent('前回: 成功'));
    expect(screen.getByTestId('lab-stage-last-LOAD_ONLY')).toHaveTextContent('load 1.00 s');
    expect(mock.log).toEqual(['load:fixture-model:cache-cold:ctx2048', 'unload:fixture-model']);
    expect(mock.residentModels()).toBe(0);
    expect(readCheckpoint()).toBeNull();
    // 次（1 CASE）を推奨する。
    expect(screen.getByTestId('lab-stage-run-ONE_CASE')).not.toHaveTextContent('非推奨');
    expect(JSON.parse(window.localStorage.getItem(FEASIBILITY_RECORDS_KEY) ?? '{}').records).toHaveLength(1);
  });

  it('1 CASE → QUICK 10: 各ケースの生成の前後に checkpoint を書き、正常終了で消し、終わったら解放する', async () => {
    const user = userEvent.setup();
    const phases: (BenchmarkCheckpoint | null)[] = [];
    const mock = cachedMock({
      respond: (request: GenerationRequest) => {
        phases.push(readCheckpoint());
        return faithfulResponse(request);
      },
    });
    renderLab(mock);
    await chooseMobile(user);
    await user.click(screen.getByTestId('lab-stage-run-LOAD_ONLY'));
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-LOAD_ONLY')).toHaveTextContent('成功'));

    await user.click(screen.getByTestId('lab-stage-run-ONE_CASE'));
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-ONE_CASE')).toHaveTextContent(/前回: 成功・load .+・1 \/ 1 件/));
    expect(phases[0]).toMatchObject({
      phase: 'generating',
      stage: 'ONE_CASE',
      profileId: 'MOBILE_FEASIBILITY',
      profileVersion: 1,
      contextWindowSize: 2048,
      caseIndex: 0,
      caseTotal: 1,
      caseId: 'CHECKOUT-0',
      candidateLabel: 'Fixture Model',
    });
    expect(readCheckpoint()).toBeNull();
    expect(mock.residentModels()).toBe(0);
    const oneCase = storedRuns()[0];
    expect(oneCase.profile).toEqual({ id: 'MOBILE_FEASIBILITY', version: 1, contextWindowSize: 2048, stage: 'ONE_CASE' });
    expect(oneCase.settings.maxTokens).toBe(192);
    expect(oneCase.results).toHaveLength(1);
    expect(screen.getByTestId('result-profile-warning')).toHaveTextContent('STANDARD の結果と直接比べないでください');

    await user.click(screen.getByTestId('lab-stage-run-QUICK_10'));
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-QUICK_10')).toHaveTextContent('10 / 10 件'));
    expect(phases.slice(1).map((item) => item?.caseIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(storedRuns()[0].results.map((result) => result.caseId)).toEqual([
      'CHECKOUT-0', 'CHECKOUT-1', 'SETUP-0', 'SETUP-1', 'NEXT_VISIT-0', 'NEXT_VISIT-1', 'RECOVERY-0', 'RECOVERY-1',
      'SIMULATION_REVIEW-0', 'SIMULATION_REVIEW-1',
    ]);
    expect(readCheckpoint()).toBeNull();
    // 取得は一度も起きない（保存済みを読み込むだけ）。
    expect(mock.log.some((entry) => entry.startsWith('download'))).toBe(false);
    expect(screen.getByTestId('lab-stage-run-FULL_100')).not.toHaveTextContent('非推奨');
  });

  it('推奨されていない段階は、確認を挟んでから実行する', async () => {
    const user = userEvent.setup();
    const mock = cachedMock();
    renderLab(mock);
    await chooseMobile(user);
    await user.click(screen.getByTestId('lab-stage-run-QUICK_10'));
    const confirm = screen.getByTestId('lab-stage-confirm');
    expect(confirm).toHaveTextContent('推奨されていません');
    expect(confirm).toHaveTextContent('1 CASE がまだ成功していません');
    await user.click(screen.getByTestId('lab-stage-confirm-cancel'));
    expect(mock.log).toEqual([]);
    await user.click(screen.getByTestId('lab-stage-run-QUICK_10'));
    await user.click(screen.getByTestId('lab-stage-confirm-run'));
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-QUICK_10')).toHaveTextContent('成功'));
  });

  it('load 失敗（GPU）は失敗として記録し、次の段階を推奨しない。checkpoint は消す', async () => {
    const user = userEvent.setup();
    const mock = cachedMock({ failLoad: () => Object.assign(new Error('The WebGPU device was lost'), { name: 'DeviceLostError' }) });
    renderLab(mock);
    await chooseMobile(user);
    await user.click(screen.getByTestId('lab-stage-run-LOAD_ONLY'));
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-LOAD_ONLY')).toHaveTextContent('前回: 失敗'));
    expect(screen.getByTestId('lab-stage-last-LOAD_ONLY')).toHaveTextContent('GPU error');
    expect(screen.getByTestId('failure-class')).toHaveTextContent('gpu-load-failed');
    expect(screen.getByTestId('lab-stage-run-ONE_CASE')).toHaveTextContent('非推奨');
    expect(screen.getByTestId('lab-stage-reasons-ONE_CASE')).toHaveTextContent('GPU');
    expect(readCheckpoint()).toBeNull();
  });

  it('中止すると中止として記録し、checkpoint を消し、モデルを解放する', async () => {
    const user = userEvent.setup();
    const mock = cachedMock({
      respond: (request) =>
        new Promise<string>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new BenchmarkRuntimeError('aborted', '中止')));
        }),
    });
    renderLab(mock);
    await chooseMobile(user);
    await user.click(screen.getByTestId('lab-stage-run-ONE_CASE'));
    await user.click(screen.getByTestId('lab-stage-confirm-run'));
    await waitFor(() => expect(readCheckpoint()?.phase).toBe('generating'));
    await user.click(screen.getByTestId('lab-stage-abort'));
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-ONE_CASE')).toHaveTextContent('前回: 中止'));
    expect(readCheckpoint()).toBeNull();
    expect(mock.residentModels()).toBe(0);
  });
});

function startCheckpointForTest() {
  startCheckpoint({
    candidateId: 'fixture-model',
    candidateLabel: 'Fixture Model',
    runtimeModelId: 'fixture-model-id',
    profileId: 'MOBILE_FEASIBILITY',
    profileVersion: 1,
    contextWindowSize: 2048,
    stage: 'QUICK_10',
    storageBackend: 'opfs',
  }).update('generating', { runId: 'r', caseIndex: 1, caseTotal: 10, caseId: 'CHECKOUT-1' });
}

describe('Lab を離れた・ページを閉じたことによる中止では checkpoint を残す', () => {
  function hangingMock() {
    let settled = 0;
    const mock = cachedMock({
      respond: (request) =>
        new Promise<string>((_, reject) => {
          request.signal.addEventListener('abort', () => {
            settled += 1;
            reject(new BenchmarkRuntimeError('aborted', '中止'));
          });
        }),
    });
    return { mock, settled: () => settled };
  }

  async function startOneCase(user: ReturnType<typeof userEvent.setup>) {
    await chooseMobile(user);
    await user.click(screen.getByTestId('lab-stage-run-ONE_CASE'));
    await user.click(screen.getByTestId('lab-stage-confirm-run'));
    await waitFor(() => expect(readCheckpoint()?.phase).toBe('generating'));
  }

  it('Lab を離れる（unmount）と中止・解放するが、checkpoint は generating のまま残り、中止としては記録しない', async () => {
    const user = userEvent.setup();
    const { mock, settled } = hangingMock();
    const view = renderLab(mock);
    await startOneCase(user);
    view.unmount();
    await waitFor(() => expect(settled()).toBe(1));
    await waitFor(() => expect(mock.residentModels()).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readCheckpoint()).toMatchObject({ phase: 'generating', stage: 'ONE_CASE', caseIndex: 0 });
    const records = JSON.parse(window.localStorage.getItem(FEASIBILITY_RECORDS_KEY) ?? '{"records":[]}').records;
    expect(records.filter((record: { stage: string }) => record.stage === 'ONE_CASE')).toEqual([]);

    // 次に開くと「正常終了しませんでした」と示し、その段階を incomplete として記録する。
    renderLab(cachedMock());
    expect(await screen.findByTestId('lab-stale-checkpoint')).toHaveTextContent('前回のBenchmarkは正常終了しませんでした。');
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-ONE_CASE')).toHaveTextContent('正常終了しなかった'));
  });

  it('back-forward cache から戻ったとき（pageshow・persisted）、残した checkpoint を読み直して示す', async () => {
    renderLab(cachedMock());
    await screen.findByTestId('lab-profile');
    expect(screen.queryByTestId('lab-stale-checkpoint')).toBeNull();
    // pagehide で中止した実行の checkpoint が残っている状態で、同じ画面へ戻る。
    startCheckpointForTest();
    const persisted = new Event('pageshow');
    Object.defineProperty(persisted, 'persisted', { value: true });
    window.dispatchEvent(persisted);
    expect(await screen.findByTestId('lab-stale-checkpoint')).toHaveTextContent('前回のBenchmarkは正常終了しませんでした。');
    expect(screen.getByTestId('checkpoint-case')).toHaveTextContent('2 / 10');
    // 通常の pageshow（persisted でない）では何もしない。
    window.localStorage.removeItem(BENCHMARK_CHECKPOINT_KEY);
  });

  it('pagehide でも checkpoint を残す', async () => {
    const user = userEvent.setup();
    const { mock, settled } = hangingMock();
    renderLab(mock);
    await startOneCase(user);
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(settled()).toBe(1));
    await waitFor(() => expect(screen.getByTestId('lab-stage-run-ONE_CASE')).toBeEnabled());
    expect(readCheckpoint()).toMatchObject({ phase: 'generating', stage: 'ONE_CASE' });
    expect(screen.getByTestId('lab-stage-last-ONE_CASE')).toHaveTextContent('未実施');
  });
});

describe('crash checkpoint の復元', () => {
  const stale: BenchmarkCheckpoint = {
    schema: '01as-ai-benchmark-checkpoint',
    version: 1,
    runId: 'fixture-model|mock|thinking-off|MOBILE_FEASIBILITY@1|2026-09-29T00:00:00.000Z',
    candidateId: 'fixture-model',
    candidateLabel: 'Fixture Model',
    runtimeModelId: 'fixture-model-id',
    profileId: 'MOBILE_FEASIBILITY',
    profileVersion: 1,
    contextWindowSize: 2048,
    stage: 'QUICK_10',
    storageBackend: 'opfs',
    phase: 'generating',
    caseIndex: 3,
    caseTotal: 10,
    caseId: 'SETUP-1',
    startedAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:01:00.000Z',
  };

  it('前回の checkpoint が残っていれば「正常終了しませんでした」と示し、原因は断定しない。段階は非推奨になる', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(BENCHMARK_CHECKPOINT_KEY, JSON.stringify(stale));
    window.localStorage.setItem(BENCHMARK_PROFILE_KEY, JSON.stringify('MOBILE_FEASIBILITY'));
    const mock = cachedMock();
    renderLab(mock);
    const banner = await screen.findByTestId('lab-stale-checkpoint');
    expect(banner).toHaveTextContent('前回のBenchmarkは正常終了しませんでした。');
    expect(screen.getByTestId('checkpoint-model')).toHaveTextContent('Fixture Model');
    expect(screen.getByTestId('checkpoint-phase')).toHaveTextContent('generating');
    expect(screen.getByTestId('checkpoint-case')).toHaveTextContent('4 / 10');
    expect(screen.getByTestId('checkpoint-case-id')).toHaveTextContent('SETUP-1');
    expect(screen.getByTestId('checkpoint-profile')).toHaveTextContent('MOBILE_FEASIBILITY v1');
    expect(banner).toHaveTextContent('強制終了した証拠ではなく、原因（メモリ不足など）は断定できません');
    // 開いただけではモデルを読み込まない。
    expect(mock.log).toEqual([]);
    // その段階は「正常終了しなかった」として記録され、どの段階も推奨しない。
    await waitFor(() => expect(screen.getByTestId('lab-stage-last-QUICK_10')).toHaveTextContent('正常終了しなかった'));
    expect(screen.getByTestId('lab-stage-run-LOAD_ONLY')).toHaveTextContent('非推奨');
    expect(screen.getByTestId('lab-stage-reasons-LOAD_ONLY')).toHaveTextContent('checkpoint が残っています');

    await user.click(within(banner).getByTestId('checkpoint-dismiss'));
    expect(screen.queryByTestId('lab-stale-checkpoint')).toBeNull();
    expect(window.localStorage.getItem(BENCHMARK_CHECKPOINT_KEY)).toBeNull();
    // 記録は残るので、QUICK 10 の次（FULL 100）は引き続き推奨しない。
    expect(screen.getByTestId('lab-stage-run-FULL_100')).toHaveTextContent('非推奨');
    expect(screen.getByTestId('lab-stage-run-LOAD_ONLY')).not.toHaveTextContent('非推奨');
  });
});

describe('モデルの解放（メモリを残さない）', () => {
  it('候補・profile を切り替えたら、読み込んでいたモデルを解放する', async () => {
    const user = userEvent.setup();
    const mock = cachedMock();
    renderLab(mock);
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(mock.residentModels()).toBe(1));
    await user.selectOptions(screen.getByTestId('lab-profile-select'), 'MOBILE_FEASIBILITY');
    await waitFor(() => expect(mock.residentModels()).toBe(0));

    await user.selectOptions(screen.getByTestId('lab-profile-select'), 'STANDARD');
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(mock.residentModels()).toBe(1));
    await user.selectOptions(screen.getByTestId('lab-model-select'), 'unmeasured-model');
    await waitFor(() => expect(mock.residentModels()).toBe(0));
  });

  it('profile を切り替えたら、解放が終わるまで段階を始められない（解放と読み込みを重ねない）', async () => {
    const user = userEvent.setup();
    const mock = cachedMock();
    const realUnload = mock.unload.bind(mock);
    let finish: (() => void) | null = null;
    vi.spyOn(mock, 'unload').mockImplementation(async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      await realUnload();
    });
    renderLab(mock);
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(mock.residentModels()).toBe(1));
    await user.selectOptions(screen.getByTestId('lab-profile-select'), 'MOBILE_FEASIBILITY');
    expect(screen.getByTestId('lab-stage-run-LOAD_ONLY')).toBeDisabled();
    expect(screen.getByTestId('lab-profile-select')).toBeDisabled();
    await waitFor(() => expect(finish).not.toBeNull());
    finish!();
    await waitFor(() => expect(screen.getByTestId('lab-stage-run-LOAD_ONLY')).toBeEnabled());
    expect(mock.residentModels()).toBe(0);
  });

  it('pagehide でも解放する', async () => {
    const user = userEvent.setup();
    const mock = cachedMock();
    const unload = vi.spyOn(mock, 'unload');
    renderLab(mock);
    await user.click(await screen.findByTestId('lab-load'));
    await waitFor(() => expect(mock.residentModels()).toBe(1));
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(mock.residentModels()).toBe(0));
    expect(unload).toHaveBeenCalled();
  });
});

describe('保存済み run の再評価', () => {
  async function legacyRun(): Promise<BenchmarkRun> {
    const runtime = createMockRuntime({
      clock: createFakeClock(),
      cachedCandidateIds: ['fixture-model'],
      respond: (request) => `${faithfulResponse(request)}理由は STANDARD_ROUTE です。`,
    });
    await runtime.load(MEASURED, { allowDownload: false, signal: new AbortController().signal });
    const run = await runBenchmark({ runtime, candidate: MEASURED, dataset: buildDataset(), clockIso: () => '2026-09-28T00:00:00.000Z' });
    const results = run.results.map((result): CaseResult => {
      const { finishReason: _f, repetition: _r, outputLimit: _o, internalCodeLeaks: _i, failureCodes: _c, ...rest } = result;
      return { ...rest, validationPassed: true };
    });
    const { validatorVersion: _v, profile: _p, ...rest } = run;
    return { ...rest, results };
  }

  it('v1 の run は新しい指標を「未計測」と示し、再評価すると元の run を残したまま別の run として結果を出す', async () => {
    const user = userEvent.setup();
    const original = await legacyRun();
    window.localStorage.setItem(BENCHMARK_RUNS_KEY, JSON.stringify({ version: 1, runs: [original] }));
    renderLab(cachedMock());
    expect(await screen.findByTestId('metric-internal-code')).toHaveTextContent('未計測');
    expect(screen.getByTestId('result-profile')).toHaveTextContent('profile の記録なし');
    await waitFor(() => expect(screen.getByTestId('lab-reevaluate')).toBeEnabled());
    await user.click(screen.getByTestId('lab-reevaluate'));
    await waitFor(() => expect(screen.getByTestId('metric-internal-code')).toHaveTextContent('15 / 15'));
    expect(screen.getByTestId('metric-validation')).toHaveTextContent('0 / 15');
    expect(screen.getByTestId('result-validator')).toHaveTextContent(`元の run: ${original.runId}`);
    const runs = storedRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual(original);
    expect(runs[0].reevaluation?.originalRunId).toBe(original.runId);
    // 再評価した run はもう一度は再評価しない。
    expect(screen.getByTestId('lab-reevaluate')).toBeDisabled();
  });

  it('保存が上限（5 件）のとき、いちばん古い run を再評価しても元の run は押し出さない', async () => {
    const user = userEvent.setup();
    const original = await legacyRun();
    const newer = Array.from({ length: MAX_STORED_RUNS - 1 }, (_, index) => ({
      ...original,
      runId: `newer-${index}`,
      startedAt: `2026-09-29T00:0${index}:00.000Z`,
    }));
    window.localStorage.setItem(BENCHMARK_RUNS_KEY, JSON.stringify({ version: 1, runs: [...newer, original] }));
    renderLab(cachedMock());
    await user.selectOptions(await screen.findByTestId('lab-run-select'), original.runId);
    await waitFor(() => expect(screen.getByTestId('lab-reevaluate')).toBeEnabled());
    await user.click(screen.getByTestId('lab-reevaluate'));
    await waitFor(() => expect(screen.getByTestId('result-validator')).toHaveTextContent(`元の run: ${original.runId}`));
    const runs = storedRuns();
    expect(runs).toHaveLength(MAX_STORED_RUNS);
    expect(runs.map((run) => run.runId)).toContain(original.runId);
    expect(runs[0].reevaluation?.originalRunId).toBe(original.runId);
    // 代わりに、元の run 以外でいちばん古いものが外れる。
    expect(runs.map((run) => run.runId)).not.toContain(`newer-${MAX_STORED_RUNS - 2}`);
  });
});
