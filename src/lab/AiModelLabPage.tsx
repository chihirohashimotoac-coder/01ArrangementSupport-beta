/**
 * AI MODEL LAB（開発者向け・Developer Gate 配下）。
 *
 * ローカル AI モデルを**公平に採用判断するための**内部 Lab。一般ユーザー向けの画面ではなく、
 * モデルの正式採用・AI Coach はここでは行わない。
 *
 *   候補を選ぶ → 端末を確認 → （明示操作で）Download / Load → 同じ Evidence で Benchmark
 *   → 自動検証・計測 → 人手評価 → JSON / CSV で export
 *
 * - モデルの取得は、モデル名・ダウンロードサイズ・推定メモリ・Runtime・ライセンスを表示した
 *   確認のあと、利用者が「ダウンロードを開始」を押したときだけ行う
 * - モデルの削除は Runtime のキャッシュだけを消す。Benchmark の結果・人手評価・利用者データは残る
 * - モデルの保存方式（Storage Backend）は既定で OPFS。方式ごとに保存場所が別なので、存在確認・削除も
 *   方式ごとに行う。失敗しても別の方式へ自動では切り替えない（`docs/AI_MODEL_STORAGE.md`）
 * - 取得・読み込みの失敗は区分（quota-exceeded など）と診断情報（保存方式・name・message・
 *   origin の usage / quota・進み具合）を画面に出し、JSON で保存できる
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BENCHMARK_CANDIDATES, BASELINE_CANDIDATE_ID } from '../ai/benchmark/candidates';
import { judgeCompatibility, probeDevice, type DeviceReport } from '../ai/benchmark/device';
import {
  HUMAN_RATING_KEYS,
  HUMAN_RATING_LABEL_JA,
  buildJsonExport,
  buildRatingCsv,
  datasetMatchingRun,
  isRatingValue,
  summarizeRatings,
  type HumanRating,
  type HumanRatings,
} from '../ai/benchmark/export';
import { summarizeRun, type Distribution } from '../ai/benchmark/metrics';
import {
  classifyModelLoadFailure,
  describeModelLoadFailure,
  errorMessageOf,
  errorNameOf,
  type ModelLoadFailureDiagnostics,
} from '../ai/benchmark/modelLoadFailure';
import {
  MODEL_STORAGE_BACKENDS,
  MODEL_STORAGE_DESCRIPTION_JA,
  MODEL_STORAGE_LABEL,
  chooseModelStorageBackend,
  detectModelStorageSupport,
  estimatedDownloadFootprint,
  isModelStorageBackend,
  probeStorageStatus,
  requestPersistentStorage,
  type ModelStorageBackend,
  type ModelStorageSupport,
  type StorageStatus,
} from '../ai/benchmark/modelStorage';
import { PROMPT_VERSION_LABEL } from '../ai/benchmark/prompt';
import { runBenchmark } from '../ai/benchmark/runner';
import { createTemplateRuntime } from '../ai/benchmark/runtimes/templateRuntime';
import { createWebLlmRuntime } from '../ai/benchmark/runtimes/webllmRuntime';
import {
  BENCHMARK_CATEGORIES,
  type BenchmarkCandidate,
  type BenchmarkDataset,
  type BenchmarkRun,
  type BenchmarkRuntime,
  type CaseResult,
  type LoadRecord,
  type ThinkingMode,
} from '../ai/benchmark/types';
import { coreDataset } from './benchmarkDataset';
import { deleteRun, loadRatings, loadRuns, saveRating, saveRun } from './labStorage';
import './AiModelLabPage.css';

type CacheState = 'unknown' | 'checking' | 'cached' | 'not-cached';
type Busy = 'idle' | 'downloading' | 'loading' | 'running' | 'deleting';
/** 方式ごとの保存状況。`unavailable` はこのブラウザにその方式の API が無い。 */
type Presence = boolean | null | 'unavailable';

export interface AiModelLabPageProps {
  readonly onBack: () => void;
  /**
   * テストで Mock Runtime を渡す。既定は template / WebLLM（選んだ保存方式で作る）。
   * 関数なら保存方式を変えるたびに呼ぶ（1 つの Runtime は 1 つの保存方式だけを使う）。
   */
  readonly runtimes?: readonly BenchmarkRuntime[] | ((backend: ModelStorageBackend | null) => readonly BenchmarkRuntime[]);
  readonly candidates?: readonly BenchmarkCandidate[];
  readonly buildDataset?: () => BenchmarkDataset;
  readonly probe?: () => Promise<DeviceReport>;
  /** このブラウザが公開している保存方式。既定は API の有無から判定。 */
  readonly storageSupport?: ModelStorageSupport;
  /** origin の usage / quota / persisted を調べる。既定は `navigator.storage`。 */
  readonly probeStorage?: () => Promise<StorageStatus>;
  /** 永続化の要求（best-effort）。既定は `navigator.storage.persist()`。 */
  readonly requestPersist?: () => Promise<boolean | null>;
}

const defaultRuntimes = (backend: ModelStorageBackend | null): readonly BenchmarkRuntime[] =>
  backend === null ? [createTemplateRuntime()] : [createTemplateRuntime(), createWebLlmRuntime({ storageBackend: backend })];

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '不明（未計測）';
  if (bytes === 0) return '0';
  return bytes >= GIB ? `${(bytes / GIB).toFixed(2)} GiB` : `${(bytes / MIB).toFixed(0)} MiB`;
}

function formatMs(value: number | null): string {
  return value === null ? '—' : `${value >= 1000 ? (value / 1000).toFixed(2) + ' s' : value.toFixed(0) + ' ms'}`;
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatDistribution(distribution: Distribution, format: (value: number | null) => string): string {
  return `平均 ${format(distribution.mean)} / p50 ${format(distribution.p50)} / p95 ${format(distribution.p95)}`;
}

function number(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits);
}

function formatStorageBytes(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? 'unknown' : formatBytes(bytes);
}

function formatPersisted(value: boolean | null | undefined): string {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

const PRESENCE_LABEL = (value: Presence | undefined): string =>
  value === undefined ? '確認中…' : value === 'unavailable' ? '使えません' : value === null ? '不明' : value ? 'あり' : 'なし';

const CACHE_LABEL: Record<CacheState, string> = {
  unknown: '未確認',
  checking: '確認中…',
  cached: 'ダウンロード済み（キャッシュあり）',
  'not-cached': '未ダウンロード',
};

const LOAD_KIND_LABEL: Record<LoadRecord['kind'], string> = {
  download: 'download（取得を含む）',
  'cache-cold': 'cache-cold（このページで初回）',
  'cache-warm': 'cache-warm（このページで再読み込み）',
  'already-loaded': '読み込み済み',
};

function download(filename: string, content: string, type: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 各カテゴリの先頭 2 件（計 10 件）。実機で最初に流れを確かめる用。 */
function quickCaseIds(dataset: BenchmarkDataset): string[] {
  return BENCHMARK_CATEGORIES.flatMap((category) =>
    dataset.cases.filter((item) => item.category === category).slice(0, 2).map((item) => item.id),
  );
}

export default function AiModelLabPage({
  onBack,
  runtimes: injectedRuntimes,
  candidates = BENCHMARK_CANDIDATES,
  buildDataset = coreDataset,
  probe = probeDevice,
  storageSupport: injectedStorageSupport,
  probeStorage = probeStorageStatus,
  requestPersist = requestPersistentStorage,
}: AiModelLabPageProps) {
  const storageSupport = useMemo(() => injectedStorageSupport ?? detectModelStorageSupport(), [injectedStorageSupport]);
  const storageChoice = useMemo(() => chooseModelStorageBackend(storageSupport), [storageSupport]);
  const [storageBackend, setStorageBackend] = useState<ModelStorageBackend | null>(storageChoice.backend);
  const runtimes = useMemo(() => {
    if (typeof injectedRuntimes === 'function') return injectedRuntimes(storageBackend);
    return injectedRuntimes ?? defaultRuntimes(storageBackend);
  }, [injectedRuntimes, storageBackend]);
  const [dataset, setDataset] = useState<BenchmarkDataset | null>(null);
  const [device, setDevice] = useState<DeviceReport | null>(null);
  const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? BASELINE_CANDIDATE_ID);
  const [cacheState, setCacheState] = useState<Record<string, CacheState>>({});
  const [measuredSize, setMeasuredSize] = useState<Record<string, number | null>>({});
  const [loaded, setLoaded] = useState<{ candidateId: string; runtimeId: string; load: LoadRecord } | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [progress, setProgress] = useState<{ fraction: number; text: string } | null>(null);
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [thinking, setThinking] = useState<'off' | 'on'>('off');
  const [scope, setScope] = useState<'all' | 'quick'>('all');
  const [runs, setRuns] = useState<BenchmarkRun[]>(() => loadRuns());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => loadRuns()[0]?.runId ?? null);
  const [ratings, setRatings] = useState<HumanRatings>(() => loadRatings());
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<ModelLoadFailureDiagnostics | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  /** 方式ごとの保存状況（候補 × Runtime の保存方式ごと）。 */
  const [presenceByKey, setPresenceByKey] = useState<Record<string, Partial<Record<ModelStorageBackend, Presence>>>>({});
  /** 保存状況を読み直すたびに増やす（取得・削除のあと）。 */
  const [storageRevision, setStorageRevision] = useState(0);
  /** download 前後の origin usage の差（候補 × 保存方式ごと）。 */
  const [footprint, setFootprint] = useState<Record<string, number | null>>({});
  const abortRef = useRef<AbortController | null>(null);
  /** 永続化の要求は、この画面で 1 回まで（permission の連続要求をしない）。 */
  const persistRequestedRef = useRef(false);

  // Lab を離れたら、進行中の取得・Benchmark を中止し、読み込んだモデルを解放する
  // （画面の外で数 GB の取得が続いたり、WebGPU の資源が残ったりしないように）。
  useEffect(
    () => () => {
      abortRef.current?.abort();
      for (const item of runtimes) void item.unload().catch(() => {});
    },
    [runtimes],
  );

  const candidate = candidates.find((item) => item.id === candidateId) ?? candidates[0];
  const runtime = runtimes.find((item) => item.supports(candidate)) ?? null;
  const runtimeBackend = runtime?.modelStorage?.backend ?? null;
  /** 候補 × 保存方式。保存方式が違えば、同じ候補でも別の保存場所として扱う。 */
  const storageKey = `${runtimeBackend ?? '-'}:${candidate.id}`;
  const compatibility = judgeCompatibility(candidate, device);
  const isLoaded = loaded?.candidateId === candidate.id;
  const effectiveThinking: ThinkingMode = candidate.supportsThinkingToggle ? thinking : 'not-applicable';

  // データセットは engine を呼んで組み立てるので、最初の描画のあとに作る。
  useEffect(() => {
    const timer = setTimeout(() => setDataset(buildDataset()), 0);
    return () => clearTimeout(timer);
  }, [buildDataset]);

  // 端末の確認（WebGPU・adapter・ブラウザ情報）。モデルは取得しない。
  useEffect(() => {
    let active = true;
    void probe().then((report) => {
      if (active) setDevice(report);
    });
    return () => {
      active = false;
    };
  }, [probe]);

  // origin 全体の保存状況（usage / quota / persisted）。
  useEffect(() => {
    let active = true;
    void probeStorage()
      .catch(() => null)
      .then((status) => {
        if (active) setStorageStatus(status);
      });
    return () => {
      active = false;
    };
  }, [probeStorage, storageRevision]);

  // 選んだ候補のキャッシュ状態（取得はしない）。保存済みなら、その方式でのサイズも数える。
  useEffect(() => {
    if (!runtime || candidate.labAvailability !== 'RUNNABLE') return;
    let active = true;
    void runtime.isCached(candidate).then(async (cached) => {
      if (!active) return;
      setCacheState((state) => ({
        ...state,
        [storageKey]: cached === null ? 'unknown' : cached ? 'cached' : 'not-cached',
      }));
      if (cached !== true || candidate.runtime === 'deterministic') return;
      const size = await runtime.cachedSizeBytes(candidate).catch(() => null);
      if (active) setMeasuredSize((state) => ({ ...state, [storageKey]: size }));
    });
    return () => {
      active = false;
    };
  }, [runtime, candidate, storageKey, storageRevision]);

  // 方式ごとの保存状況（「この方式に無い」＝「どこにも無い」とは扱わない）。取得も保存領域の作成もしない。
  useEffect(() => {
    const modelStorage = runtime?.modelStorage;
    if (!modelStorage || candidate.labAvailability !== 'RUNNABLE') return;
    let active = true;
    void Promise.all(
      MODEL_STORAGE_BACKENDS.map(async (backend): Promise<[ModelStorageBackend, Presence]> => [
        backend,
        storageSupport[backend] ? await modelStorage.isCachedIn(candidate, backend).catch(() => null) : 'unavailable',
      ]),
    ).then((entries) => {
      if (active) setPresenceByKey((state) => ({ ...state, [storageKey]: Object.fromEntries(entries) }));
    });
    return () => {
      active = false;
    };
  }, [runtime, candidate, storageKey, storageSupport, storageRevision]);

  /** 保存方式を変える。Runtime を作り直し（前の Runtime は解放）、読み込み済みの状態を外す。取得はしない。 */
  const changeStorageBackend = useCallback((next: ModelStorageBackend) => {
    abortRef.current?.abort();
    setStorageBackend(next);
    setLoaded(null);
    setConfirmDownload(false);
    setConfirmDelete(false);
    setMessage(null);
  }, []);

  const load = useCallback(
    async (allowDownload: boolean) => {
      if (!runtime) return;
      setConfirmDownload(false);
      setMessage(null);
      setFailure(null);
      setBusy(allowDownload ? 'downloading' : 'loading');
      setProgress({ fraction: 0, text: '' });
      const controller = new AbortController();
      abortRef.current = controller;
      let lastProgress: { fraction: number; text: string } | null = null;
      let before: StorageStatus | null = null;
      if (allowDownload) {
        // 永続化は eviction 対策（best-effort）。容量制限の対策ではない。拒否されても取得は続け、
        // この画面では 1 回だけ要求する。結果を待たずに取得を始める。
        if (!persistRequestedRef.current && storageStatus?.persisted !== true) {
          persistRequestedRef.current = true;
          void requestPersist()
            .catch(() => null)
            .then(() => setStorageRevision((value) => value + 1));
        }
        before = await probeStorage().catch(() => null);
      }
      try {
        if (loaded && loaded.runtimeId !== runtime.id) {
          await runtimes.find((item) => item.id === loaded.runtimeId)?.unload();
        }
        const record = await runtime.load(candidate, {
          allowDownload,
          signal: controller.signal,
          onProgress: (fraction, text) => {
            lastProgress = { fraction, text };
            setProgress({ fraction, text });
          },
        });
        setLoaded({ candidateId: candidate.id, runtimeId: runtime.id, load: record });
        setCacheState((state) => ({ ...state, [storageKey]: 'cached' }));
        const size = await runtime.cachedSizeBytes(candidate).catch(() => null);
        setMeasuredSize((state) => ({ ...state, [storageKey]: size }));
        if (record.kind === 'download') {
          const after = await probeStorage().catch(() => null);
          setFootprint((state) => ({ ...state, [storageKey]: estimatedDownloadFootprint(before, after) }));
        }
      } catch (error) {
        // 失敗した Runtime は、前に読み込んでいたモデルも外れていることがある（WebLLM の reload 失敗）。
        // 画面の「読み込み済み」を残すと、Run が読み込みを飛ばして全件 not-loaded になるので解除する。
        if (loaded?.runtimeId === runtime.id) setLoaded(null);
        const status = await probeStorage().catch(() => null);
        const progressAtFailure = lastProgress as { fraction: number; text: string } | null;
        setFailure({
          schema: '01as-ai-model-load-failure',
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          candidateId: candidate.id,
          runtimeId: runtime.id,
          runtimeModelId: candidate.runtimeModelId,
          download: allowDownload,
          storageBackend: runtimeBackend,
          failureClass: classifyModelLoadFailure(error, { backend: runtimeBackend, aborted: controller.signal.aborted }),
          errorName: errorNameOf(error),
          message: errorMessageOf(error),
          progressFraction: progressAtFailure?.fraction ?? null,
          progressText: progressAtFailure?.text ?? null,
          storage: status,
          storageBefore: before,
        });
      } finally {
        setBusy('idle');
        setProgress(null);
        abortRef.current = null;
        setStorageRevision((value) => value + 1);
      }
    },
    [runtime, runtimes, candidate, loaded, storageKey, runtimeBackend, storageStatus, probeStorage, requestPersist],
  );

  const unload = useCallback(async () => {
    if (!loaded) return;
    await runtimes.find((item) => item.id === loaded.runtimeId)?.unload();
    setLoaded(null);
  }, [loaded, runtimes]);

  const removeCache = useCallback(async () => {
    if (!runtime) return;
    setConfirmDelete(false);
    setBusy('deleting');
    const backendLabel = runtimeBackend === null ? '' : `（保存方式: ${MODEL_STORAGE_LABEL[runtimeBackend]}）`;
    try {
      await runtime.deleteCache(candidate);
      if (loaded?.candidateId === candidate.id) setLoaded(null);
      setCacheState((state) => ({ ...state, [storageKey]: 'not-cached' }));
      setMeasuredSize((state) => {
        const next = { ...state };
        delete next[storageKey];
        return next;
      });
      setMessage(`${candidate.displayName} のモデルキャッシュ${backendLabel}を削除しました（ほかの保存方式のモデル・Benchmark の結果・人手評価・利用者データは残っています）。`);
    } catch (error) {
      setMessage(`削除できませんでした${backendLabel}: ${errorMessageOf(error)}`);
    } finally {
      setBusy('idle');
      setStorageRevision((value) => value + 1);
    }
  }, [runtime, candidate, loaded, storageKey, runtimeBackend]);

  const run = useCallback(async () => {
    if (!runtime || !dataset) return;
    setMessage(null);
    setBusy('running');
    const controller = new AbortController();
    abortRef.current = controller;
    const caseIds = scope === 'quick' ? quickCaseIds(dataset) : undefined;
    const total = caseIds?.length ?? dataset.cases.length;
    setProgress({ fraction: 0, text: `0 / ${total}` });
    try {
      let loadRecord = loaded?.candidateId === candidate.id ? loaded.load : null;
      if (loadRecord === null) {
        // baseline など、取得の要らない Runtime だけがここを通る（取得は許可しない）。
        loadRecord = await runtime.load(candidate, { allowDownload: false, signal: controller.signal });
        setLoaded({ candidateId: candidate.id, runtimeId: runtime.id, load: loadRecord });
      }
      const result = await runBenchmark({
        runtime,
        candidate,
        dataset,
        caseIds,
        settings: { thinking: effectiveThinking },
        load: loadRecord,
        modelSizeBytes: measuredSize[storageKey] ?? null,
        device,
        signal: controller.signal,
        onCaseComplete: (_, index) => setProgress({ fraction: (index + 1) / total, text: `${index + 1} / ${total}` }),
      });
      const saved = saveRun(result);
      setRuns(saved.runs);
      setSelectedRunId(result.runId);
      if (!saved.saved) setMessage('結果を保存できませんでした（容量など）。この画面では表示できます。export で保存してください。');
    } catch (error) {
      setMessage(`Benchmark を実行できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('idle');
      setProgress(null);
      abortRef.current = null;
    }
  }, [runtime, dataset, scope, candidate, effectiveThinking, loaded, measuredSize, storageKey, device]);

  const selectedRun = runs.find((item) => item.runId === selectedRunId) ?? null;
  // まだ結果が無い間は確認中（isCached は取得をしない）。
  const cache = cacheState[storageKey] ?? (candidate.labAvailability === 'RUNNABLE' && runtime ? 'checking' : 'unknown');
  const measured = measuredSize[storageKey];
  const presence = presenceByKey[storageKey] ?? {};
  const measuredKnown = Object.prototype.hasOwnProperty.call(measuredSize, storageKey);
  const failureDescription = failure
    ? describeModelLoadFailure(failure, { opfsAvailable: storageSupport.opfs })
    : null;
  const elsewhere = runtimeBackend === null || cache !== 'not-cached'
    ? []
    : MODEL_STORAGE_BACKENDS.filter((backend) => backend !== runtimeBackend && presence[backend] === true);
  const runnable = candidate.labAvailability === 'RUNNABLE' && runtime !== null;
  const needsModel = candidate.runtime !== 'deterministic';
  const canRun = runnable && dataset !== null && busy === 'idle' && compatibility.verdict !== 'UNSUPPORTED' &&
    (!needsModel || isLoaded);

  const rate = (responseId: string, rating: HumanRating) => setRatings(saveRating(responseId, rating));

  return (
    <div className="lab" data-testid="ai-model-lab">
      <header className="lab__header">
        <button type="button" className="lab__back" onClick={onBack}>
          ← 戻る
        </button>
        <h1>AI MODEL LAB</h1>
        <p className="lab__note">
          ローカル AI モデルを<strong>同じ 01AS Evidence で比較し、採用判断の材料を集める</strong>ための画面です。
        </p>
        <ul className="lab__notice" data-testid="lab-experimental-notice">
          <li>開発者向けの実験機能です。01AS のアレンジ判断には使いません。</li>
          <li>モデルを使うと、端末へ大容量のデータ（数百 MB〜数 GB）をダウンロードします。ダウンロードは確認のあとだけ行います。</li>
          <li>どのモデルを正式に採用するかは、まだ決まっていません。</li>
        </ul>
      </header>

      {message && (
        <p className="lab__message" role="status" data-testid="lab-message">
          {message}
        </p>
      )}

      {failure && failureDescription && (
        <div className="lab__message lab__failure" role="alert" data-testid="lab-failure">
          {failureDescription.linesJa.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div className="lab__actions">
            {failureDescription.suggestOpfs && (
              <button
                type="button"
                data-testid="lab-retry-opfs"
                disabled={busy !== 'idle'}
                onClick={() => {
                  changeStorageBackend('opfs');
                  setFailure(null);
                  setConfirmDownload(true);
                }}
              >
                OPFS で再試行
              </button>
            )}
            <button
              type="button"
              data-testid="lab-failure-export"
              onClick={() =>
                download(`01as-ai-model-load-failure-${failure.occurredAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(failure, null, 2), 'application/json')}
            >
              診断情報を保存（JSON）
            </button>
            <button type="button" onClick={() => setFailure(null)}>
              閉じる
            </button>
          </div>
          <details>
            <summary>診断情報</summary>
            <dl className="lab__facts" data-testid="lab-failure-diagnostics">
              <dt>Error class</dt>
              <dd data-testid="failure-class">{failure.failureClass}</dd>
              <dt>Storage backend</dt>
              <dd>{failure.storageBackend === null ? '—' : MODEL_STORAGE_LABEL[failure.storageBackend]}</dd>
              <dt>Error name</dt>
              <dd>{failure.errorName ?? '—'}</dd>
              <dt>Message</dt>
              <dd className="lab__ua">{failure.message}</dd>
              <dt>Model</dt>
              <dd>{failure.runtimeModelId ?? failure.candidateId}</dd>
              <dt>Download progress</dt>
              <dd>{failure.progressFraction === null ? '—' : `${(failure.progressFraction * 100).toFixed(1)}%`}</dd>
              <dt>Origin Usage / Quota（失敗の直後）</dt>
              <dd>
                {formatStorageBytes(failure.storage?.usageBytes)} / {formatStorageBytes(failure.storage?.quotaBytes)}
              </dd>
              <dt>Origin Usage（取得の前）</dt>
              <dd>{formatStorageBytes(failure.storageBefore?.usageBytes)}</dd>
              <dt>Storage Persistent</dt>
              <dd>{formatPersisted(failure.storage?.persisted)}</dd>
              <dt>Time</dt>
              <dd>{failure.occurredAt}</dd>
            </dl>
          </details>
        </div>
      )}

      <section className="lab__section" data-testid="lab-device">
        <h2>DEVICE</h2>
        {device === null ? (
          <p>確認中…</p>
        ) : (
          <dl className="lab__facts">
            <dt>WebGPU</dt>
            <dd data-testid="device-webgpu">{device.webGpuExposed ? 'available' : 'not available'}</dd>
            <dt>Adapter</dt>
            <dd data-testid="device-adapter">
              {device.adapter}
              {device.adapterInfo && ` （${[device.adapterInfo.vendor, device.adapterInfo.architecture].filter(Boolean).join(' / ') || '詳細なし'}）`}
            </dd>
            <dt>GPU features</dt>
            <dd>{device.gpuFeatures.length > 0 ? device.gpuFeatures.join(', ') : '—'}</dd>
            <dt>maxBufferSize</dt>
            <dd>{formatBytes(device.gpuLimits?.maxBufferSize ?? null)}</dd>
            <dt>端末メモリ（報告値）</dt>
            <dd>{device.deviceMemoryGiB === null ? '取得できません' : `${device.deviceMemoryGiB} GiB${device.deviceMemoryGiB >= 8 ? ' 以上' : ''}`}</dd>
            <dt>保存容量（この origin）</dt>
            <dd>
              {device.storage?.quotaBytes != null
                ? `${formatBytes(device.storage.usageBytes)} / ${formatBytes(device.storage.quotaBytes)}`
                : '取得できません'}
            </dd>
            <dt>Browser</dt>
            <dd className="lab__ua">{device.browserBrands?.join(', ') ?? device.userAgent ?? '不明'}</dd>
          </dl>
        )}
        <p className="lab__hint">GPU の VRAM 量はブラウザの API では取得できないため、表示・推測しません。</p>
      </section>

      <section className="lab__section" data-testid="lab-storage">
        <h2>STORAGE</h2>
        <dl className="lab__facts">
          <dt>Model Storage Backend</dt>
          <dd data-testid="storage-backend">
            {storageBackend === null
              ? '使えません（このブラウザは OPFS / IndexedDB / Cache API のどれも公開していません）'
              : `${MODEL_STORAGE_LABEL[storageBackend]} — ${MODEL_STORAGE_DESCRIPTION_JA[storageBackend]}`}
          </dd>
          <dt>使える方式</dt>
          <dd data-testid="storage-support">
            {MODEL_STORAGE_BACKENDS.map((backend) => `${MODEL_STORAGE_LABEL[backend]} ${storageSupport[backend] ? 'yes' : 'no'}`).join(' / ')}
          </dd>
          <dt>Storage Persistent</dt>
          <dd data-testid="storage-persistent">{formatPersisted(storageStatus?.persisted)}</dd>
          <dt>Origin Usage</dt>
          <dd data-testid="storage-usage">{formatStorageBytes(storageStatus?.usageBytes)}</dd>
          <dt>Origin Quota</dt>
          <dd data-testid="storage-quota">{formatStorageBytes(storageStatus?.quotaBytes)}</dd>
        </dl>
        {storageBackend !== null && (
          <label className="lab__field">
            <span>保存方式</span>
            <select
              data-testid="lab-storage-backend-select"
              value={storageBackend}
              disabled={busy !== 'idle'}
              onChange={(event) => {
                if (isModelStorageBackend(event.target.value)) changeStorageBackend(event.target.value);
              }}
            >
              {MODEL_STORAGE_BACKENDS.map((backend) => (
                <option key={backend} value={backend} disabled={!storageSupport[backend]}>
                  {MODEL_STORAGE_LABEL[backend]}
                  {backend === 'opfs' ? '（既定）' : ''}
                  {storageSupport[backend] ? '' : '（使えません）'}
                </option>
              ))}
            </select>
          </label>
        )}
        {storageChoice.usedFallback && (
          <p className="lab__hint" data-testid="storage-fallback">
            このブラウザは OPFS の API を公開していないため、推奨順（OPFS → IndexedDB → Cache API）で
            {storageChoice.backend === null ? '' : ` ${MODEL_STORAGE_LABEL[storageChoice.backend]} `}を初期値にしました。
          </p>
        )}
        <p className="lab__hint">
          保存方式が違えば、同じモデルでも保存場所は別です。方式を切り替えても、別の方式に保存したモデルは移動・削除されません
          （切り替えた方式に無ければ、その方式へ新しくダウンロードします）。取得に失敗しても、別の方式へ自動では切り替えません。
        </p>
        <p className="lab__hint">
          Origin Usage / Quota は origin 全体の値（navigator.storage.estimate()）で、モデル単位の値ではありません。
          Storage Persistent は eviction（自動削除）への対策で、容量制限の対策ではありません。
        </p>
      </section>

      <section className="lab__section" data-testid="lab-model">
        <h2>MODEL</h2>
        <label className="lab__field">
          <span>Model</span>
          <select
            data-testid="lab-model-select"
            value={candidate.id}
            disabled={busy !== 'idle'}
            onChange={(event) => {
              setCandidateId(event.target.value);
              setConfirmDownload(false);
              setConfirmDelete(false);
            }}
          >
            {candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
                {item.labAvailability !== 'RUNNABLE' ? `（${item.labAvailability}）` : ''}
              </option>
            ))}
          </select>
        </label>

        <dl className="lab__facts" data-testid="lab-model-facts">
          <dt>Runtime</dt>
          <dd>{candidate.runtime}{candidate.runtimeModelId ? ` — ${candidate.runtimeModelId}` : ''}</dd>
          <dt>License</dt>
          <dd>{candidate.license}</dd>
          <dt>Parameters / 量子化</dt>
          <dd>{candidate.parameterSize} / {candidate.quantization ?? '—'}</dd>
          <dt>想定 class（仮説）</dt>
          <dd>{candidate.provisionalClass}</dd>
          <dt>Model status</dt>
          <dd data-testid="lab-model-status">
            {candidate.runtime === 'deterministic'
              ? 'モデル不要'
              : candidate.labAvailability !== 'RUNNABLE'
                ? candidate.labAvailability
                : isLoaded
                  ? `読み込み済み（${LOAD_KIND_LABEL[loaded.load.kind]}・${formatMs(loaded.load.loadTimeMs)}）`
                  : CACHE_LABEL[cache]}
          </dd>
          {runtime?.modelStorage && candidate.labAvailability === 'RUNNABLE' && (
            <>
              <dt>保存状況（方式ごと）</dt>
              <dd data-testid="lab-model-storage-presence">
                {MODEL_STORAGE_BACKENDS.map((backend) => `${MODEL_STORAGE_LABEL[backend]}: ${PRESENCE_LABEL(presence[backend])}`).join(' / ')}
              </dd>
            </>
          )}
          <dt>Download size</dt>
          <dd data-testid="lab-download-size">
            {measured != null
              ? `${formatBytes(measured)}（${runtimeBackend === null ? '保存領域' : MODEL_STORAGE_LABEL[runtimeBackend]} から計測）`
              : measuredKnown && cache === 'cached'
                ? `unknown（${runtimeBackend === null ? 'この保存領域' : MODEL_STORAGE_LABEL[runtimeBackend]} では、モデル単位のサイズを正確に数えられません）`
                : formatBytes(candidate.downloadSizeBytes)}
          </dd>
          {Object.prototype.hasOwnProperty.call(footprint, storageKey) && (
            <>
              <dt>Estimated download footprint</dt>
              <dd data-testid="lab-download-footprint">
                {formatStorageBytes(footprint[storageKey])}
                （download 前後の origin usage の差。origin 全体の差分で、モデルのファイルの厳密なサイズではありません）
              </dd>
            </>
          )}
          <dt>Estimated memory</dt>
          <dd data-testid="lab-estimated-memory">
            {candidate.estimatedVramBytes === null ? '不明' : `${formatBytes(candidate.estimatedVramBytes)}（Runtime の設定値・VRAM の目安）`}
          </dd>
          <dt>Compatibility</dt>
          <dd data-testid="lab-compatibility">
            <strong>{compatibility.verdict}</strong>
            <ul>
              {compatibility.reasonsJa.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </dd>
          <dt>Adoption</dt>
          <dd>{candidate.adoptionStatus}</dd>
        </dl>
        <p className="lab__hint">{candidate.notesJa}</p>
        {elsewhere.length > 0 && (
          <p className="lab__hint" data-testid="lab-model-elsewhere">
            このモデルは {elsewhere.map((backend) => MODEL_STORAGE_LABEL[backend]).join(' / ')} に保存されています。
            保存方式を切り替えると、再ダウンロードせずに Load できます。
          </p>
        )}

        {needsModel && runnable && (
          <div className="lab__actions">
            {!isLoaded && cache !== 'cached' && (
              <button
                type="button"
                data-testid="lab-download"
                disabled={busy !== 'idle' || compatibility.verdict === 'UNSUPPORTED'}
                onClick={() => setConfirmDownload(true)}
              >
                Download
              </button>
            )}
            {!isLoaded && cache === 'cached' && (
              <button type="button" data-testid="lab-load" disabled={busy !== 'idle'} onClick={() => void load(false)}>
                Load
              </button>
            )}
            {isLoaded && (
              <button type="button" data-testid="lab-unload" disabled={busy !== 'idle'} onClick={() => void unload()}>
                Unload
              </button>
            )}
            {cache === 'cached' && (
              <button
                type="button"
                className="lab__danger"
                data-testid="lab-delete-model"
                disabled={busy !== 'idle'}
                onClick={() => setConfirmDelete(true)}
              >
                モデルを削除
              </button>
            )}
            {(busy === 'downloading' || busy === 'loading') && (
              <button type="button" onClick={() => abortRef.current?.abort()}>
                中止
              </button>
            )}
          </div>
        )}

        {confirmDownload && (
          <div className="lab__confirm" role="dialog" aria-label="ダウンロードの確認" data-testid="lab-download-confirm">
            <p>次のモデルをダウンロードします。よろしいですか。</p>
            <dl className="lab__facts">
              <dt>Model</dt>
              <dd>{candidate.displayName}（{candidate.runtimeModelId}）</dd>
              <dt>Download size</dt>
              <dd>{formatBytes(candidate.downloadSizeBytes)}</dd>
              <dt>Estimated memory</dt>
              <dd>{formatBytes(candidate.estimatedVramBytes)}</dd>
              <dt>Runtime</dt>
              <dd>{runtime?.labelJa}</dd>
              <dt>保存方式</dt>
              <dd data-testid="lab-download-confirm-storage">
                {runtimeBackend === null ? '—' : MODEL_STORAGE_LABEL[runtimeBackend]}
              </dd>
              <dt>License</dt>
              <dd>{candidate.license}</dd>
            </dl>
            <p className="lab__hint">
              モデルは配布元から取得し、ブラウザの保存領域（上の保存方式）へ保存します。
              01AS の利用者データとは別の場所で、「モデルを削除」で消せます（この保存方式のこのモデルだけを消します）。
            </p>
            <div className="lab__actions">
              <button type="button" data-testid="lab-download-start" onClick={() => void load(true)}>
                ダウンロードを開始
              </button>
              <button type="button" onClick={() => setConfirmDownload(false)}>
                キャンセル
              </button>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div className="lab__confirm" role="dialog" aria-label="削除の確認" data-testid="lab-delete-confirm">
            <p>
              {candidate.displayName} のモデルキャッシュ（保存方式: {runtimeBackend === null ? '—' : MODEL_STORAGE_LABEL[runtimeBackend]}）を削除します。
              ほかの保存方式のモデル・TRAINING 履歴・SIMULATION 設定・設定・Benchmark の結果・人手評価は削除しません。
            </p>
            <div className="lab__actions">
              <button type="button" className="lab__danger" data-testid="lab-delete-start" onClick={() => void removeCache()}>
                削除する
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                キャンセル
              </button>
            </div>
          </div>
        )}

        {progress && (
          <div className="lab__progress" data-testid="lab-progress">
            <progress max={1} value={progress.fraction} />
            <span>{progress.text}</span>
          </div>
        )}
      </section>

      <section className="lab__section" data-testid="lab-benchmark">
        <h2>BENCHMARK</h2>
        <dl className="lab__facts">
          <dt>Dataset</dt>
          <dd data-testid="lab-dataset">{dataset ? dataset.labelJa : '準備中…'}</dd>
          <dt>Cases</dt>
          <dd data-testid="lab-cases">{dataset ? dataset.cases.length : '—'}</dd>
          <dt>Fingerprint</dt>
          <dd>{dataset?.fingerprint ?? '—'}</dd>
          <dt>Prompt</dt>
          <dd>{PROMPT_VERSION_LABEL}</dd>
        </dl>
        <div className="lab__options">
          <label className="lab__field">
            <span>ケース</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as 'all' | 'quick')} disabled={busy !== 'idle'}>
              <option value="all">すべて</option>
              <option value="quick">クイック（各カテゴリ 2 件）</option>
            </select>
          </label>
          {candidate.supportsThinkingToggle && (
            <label className="lab__field">
              <span>Thinking</span>
              <select
                data-testid="lab-thinking"
                value={thinking}
                onChange={(event) => setThinking(event.target.value as 'off' | 'on')}
                disabled={busy !== 'idle'}
              >
                <option value="off">OFF（01AS の既定）</option>
                <option value="on">ON（比較用）</option>
              </select>
            </label>
          )}
        </div>
        <div className="lab__actions">
          <button type="button" data-testid="lab-run" disabled={!canRun} onClick={() => void run()}>
            Run Benchmark
          </button>
          {busy === 'running' && (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              中止
            </button>
          )}
        </div>
        {needsModel && !isLoaded && runnable && (
          <p className="lab__hint">先にモデルを Download / Load してください（Benchmark はモデルを取得しません）。</p>
        )}
      </section>

      <ResultsSection
        runs={runs}
        selectedRun={selectedRun}
        onSelect={setSelectedRunId}
        onDelete={(runId) => {
          const next = deleteRun(runId);
          setRuns(next);
          setSelectedRunId(next[0]?.runId ?? null);
        }}
        ratings={ratings}
        onRate={rate}
        dataset={dataset}
      />
    </div>
  );
}

interface ResultsSectionProps {
  readonly runs: readonly BenchmarkRun[];
  readonly selectedRun: BenchmarkRun | null;
  readonly onSelect: (runId: string) => void;
  readonly onDelete: (runId: string) => void;
  readonly ratings: HumanRatings;
  readonly onRate: (responseId: string, rating: HumanRating) => void;
  readonly dataset: BenchmarkDataset | null;
}

function ResultsSection({ runs, selectedRun, onSelect, onDelete, ratings, onRate, dataset }: ResultsSectionProps) {
  if (runs.length === 0 || selectedRun === null) {
    return (
      <section className="lab__section" data-testid="lab-results">
        <h2>RESULTS</h2>
        <p>まだ結果はありません。</p>
      </section>
    );
  }
  const summary = summarizeRun(selectedRun);
  const human = summarizeRatings(selectedRun.results, ratings);
  // 保存済みの古い run に、いまのデータセット（別の版・指紋）を付けて export しない。
  const datasetForRun = datasetMatchingRun(dataset, selectedRun);
  const stamp = selectedRun.startedAt.replace(/[:.]/g, '-');
  const titleOf = (caseId: string) => datasetForRun?.cases.find((item) => item.id === caseId)?.titleJa ?? caseId;

  return (
    <section className="lab__section" data-testid="lab-results">
      <h2>RESULTS</h2>
      <label className="lab__field">
        <span>Run</span>
        <select value={selectedRun.runId} onChange={(event) => onSelect(event.target.value)}>
          {runs.map((item) => (
            <option key={item.runId} value={item.runId}>
              {item.candidateId} / thinking {item.settings.thinking} / {item.results.length} 件 / {item.startedAt}
            </option>
          ))}
        </select>
      </label>

      <h3>01AS の重要指標（優先順）</h3>
      <dl className="lab__facts lab__metrics" data-testid="lab-metrics">
        <dt>1. Engine contradiction</dt>
        <dd data-testid="metric-contradiction">
          {summary.withContradictions} / {summary.completed}（{formatRate(summary.engineContradictionRate)}）
        </dd>
        <dt>2. Unsupported claims</dt>
        <dd data-testid="metric-unsupported">
          {summary.unsupportedClaimTotal} 件・{summary.withUnsupportedClaims} 応答（{formatRate(summary.unsupportedClaimRate)}）
        </dd>
        <dt>3. Validation pass</dt>
        <dd data-testid="metric-validation">
          {summary.validationPassed} / {summary.total}（失敗率 {formatRate(summary.validationFailureRate)}）
        </dd>
        <dt>4. 日本語（人手評価）</dt>
        <dd data-testid="metric-human">
          評価済み {human.ratedResponses} / {summary.total}
          {HUMAN_RATING_KEYS.map((key) => ` ・${HUMAN_RATING_LABEL_JA[key]} ${number(human.means[key], 2)}`).join('')}
        </dd>
        <dt>4. 日本語（自動の目安）</dt>
        <dd>
          長すぎ {summary.styleFlagCounts.tooLong}・短すぎ {summary.styleFlagCounts.tooShort}・日本語が少ない{' '}
          {summary.styleFlagCounts.lowJapaneseRatio}・Markdown {summary.styleFlagCounts.markdown}・英文{' '}
          {summary.styleFlagCounts.englishSentence}・thinking の漏れ {summary.styleFlagCounts.thinkingLeak}・第 1 候補に触れた{' '}
          {summary.mentionsTopTarget} / {summary.decisionCases}
        </dd>
        <dt>5. TTFT</dt>
        <dd data-testid="metric-ttft">{formatDistribution(summary.timeToFirstTokenMs, formatMs)}</dd>
        <dt>5. TTFT（本文）</dt>
        <dd>{formatDistribution(summary.timeToFirstVisibleTokenMs, formatMs)}</dd>
        <dt>5. Generation time</dt>
        <dd data-testid="metric-generation">{formatDistribution(summary.generationTimeMs, formatMs)}</dd>
        <dt>5. tok/s</dt>
        <dd data-testid="metric-tps">{formatDistribution(summary.tokensPerSecond, (value) => number(value))}</dd>
        <dt>Output tokens / 文字数</dt>
        <dd>
          平均 {number(summary.outputTokens.mean)} tokens / 平均 {number(summary.outputLength.mean, 0)} 文字
        </dd>
        <dt>エラー / タイムアウト</dt>
        <dd>
          {summary.errors} / {summary.timeouts}
          {selectedRun.aborted ? '（中止）' : ''}
        </dd>
        <dt>Model load</dt>
        <dd>
          {selectedRun.load ? `${LOAD_KIND_LABEL[selectedRun.load.kind]}・${formatMs(selectedRun.load.loadTimeMs)}` : '—'}
        </dd>
        <dt>Model size / Estimated VRAM</dt>
        <dd>
          {formatBytes(selectedRun.modelSizeBytes)} / {formatBytes(selectedRun.estimatedVramBytes)}
        </dd>
        <dt>Dataset / Prompt</dt>
        <dd>
          {selectedRun.datasetId} v{selectedRun.datasetVersion}（{selectedRun.datasetFingerprint}）/ {selectedRun.promptVersion}
        </dd>
      </dl>

      <table className="lab__table" data-testid="lab-category-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Pass</th>
            <th>Contradiction</th>
            <th>Unsupported</th>
          </tr>
        </thead>
        <tbody>
          {BENCHMARK_CATEGORIES.map((category) => {
            const row = summary.byCategory[category];
            return (
              <tr key={category}>
                <td>{category}</td>
                <td>{row.validationPassed} / {row.total}</td>
                <td>{row.withContradictions}</td>
                <td>{row.withUnsupportedClaims}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="lab__actions">
        <button
          type="button"
          data-testid="lab-export-json"
          onClick={() =>
            download(`01as-ai-benchmark-${stamp}.json`, JSON.stringify(buildJsonExport([selectedRun], ratings, datasetForRun), null, 2), 'application/json')}
        >
          Export JSON
        </button>
        <button
          type="button"
          data-testid="lab-export-csv"
          onClick={() => download(`01as-ai-benchmark-${stamp}.csv`, buildRatingCsv([selectedRun], ratings), 'text/csv')}
        >
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => download(`01as-ai-benchmark-blind-${stamp}.csv`, buildRatingCsv([selectedRun], ratings, { blind: true }), 'text/csv')}
        >
          Export CSV（blind）
        </button>
        <button type="button" className="lab__danger" onClick={() => onDelete(selectedRun.runId)}>
          この結果を削除
        </button>
      </div>

      <h3>応答と人手評価</h3>
      <ol className="lab__responses" data-testid="lab-responses">
        {selectedRun.results.map((result) => (
          <ResponseItem
            key={result.responseId}
            result={result}
            title={titleOf(result.caseId)}
            rating={ratings[result.responseId] ?? {}}
            onRate={(rating) => onRate(result.responseId, rating)}
          />
        ))}
      </ol>
    </section>
  );
}

function ResponseItem({
  result,
  title,
  rating,
  onRate,
}: {
  readonly result: CaseResult;
  readonly title: string;
  readonly rating: HumanRating;
  readonly onRate: (rating: HumanRating) => void;
}) {
  const issues = [...result.contradictions, ...result.unsupportedClaims, result.shapeProblem, result.error].filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return (
    <li className="lab__response" data-testid={`lab-response-${result.caseId}`}>
      <details>
        <summary>
          <span className={result.validationPassed ? 'lab__pass' : 'lab__fail'}>{result.validationPassed ? 'PASS' : 'FAIL'}</span>{' '}
          {result.caseId} — {title}
        </summary>
        <p className="lab__text">{result.text ?? '（応答なし）'}</p>
        {issues.length > 0 && (
          <ul className="lab__issues">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <p className="lab__hint">
          TTFT {formatMs(result.timeToFirstTokenMs)}・生成 {formatMs(result.generationTimeMs)}・
          {number(result.tokensPerSecond)} tok/s・{result.outputTokens ?? '—'} tokens・{result.outputLength ?? '—'} 文字
        </p>
        <div className="lab__ratings">
          {HUMAN_RATING_KEYS.map((key) => (
            <label key={key} className="lab__field">
              <span>{HUMAN_RATING_LABEL_JA[key]}</span>
              <select
                data-testid={`rating-${key}-${result.caseId}`}
                value={rating[key] ?? ''}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  const next: Record<string, unknown> = { ...rating };
                  if (isRatingValue(value)) next[key] = value;
                  else delete next[key];
                  onRate(next as HumanRating);
                }}
              >
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="lab__field lab__field--wide">
            <span>メモ</span>
            <input
              type="text"
              defaultValue={rating.note ?? ''}
              onBlur={(event) => onRate({ ...rating, note: event.target.value })}
            />
          </label>
        </div>
      </details>
    </li>
  );
}
