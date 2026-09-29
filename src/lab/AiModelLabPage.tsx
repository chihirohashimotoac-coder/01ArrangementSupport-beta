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
 * - BROWSER STORAGE DIAGNOSTICS（`StorageDiagnosticsSection`）は WebLLM を使わずに保存方式ごとの
 *   書き込み量を測る。診断の実行中はモデルの取得・読み込みを始めない（測定がずれるため）
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
import { hasV2Checks, summarizeRun, type Distribution } from '../ai/benchmark/metrics';
import {
  classifyModelLoadFailure,
  describeModelLoadFailure,
  errorMessageOf,
  errorNameOf,
  isPostStoreReadFailure,
  type ModelLoadFailureDiagnostics,
} from '../ai/benchmark/modelLoadFailure';
import {
  BENCHMARK_PROFILES,
  FEASIBILITY_STAGE_LABEL,
  STANDARD_PROFILE,
  adviseStages,
  describeRunProfile,
  profileById,
  profileFitsCandidate,
  profileGenerationSettings,
  profileKey,
  quickCaseIds,
  runProfile,
  runProfileOf,
  stageCaseIds,
  stageRecordFromLoad,
  stageRecordFromLoadFailure,
  stageRecordFromRun,
  stageStatusLabel,
  type BenchmarkProfile,
  type FeasibilityStage,
  type StageRecord,
} from '../ai/benchmark/profiles';
import { reevaluateRun, reevaluationBlocker } from '../ai/benchmark/reevaluate';
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
  BenchmarkRuntimeError,
  type BenchmarkCandidate,
  type BenchmarkDataset,
  type BenchmarkRun,
  type BenchmarkRuntime,
  type CaseResult,
  type LoadRecord,
  type ThinkingMode,
} from '../ai/benchmark/types';
import { coreDataset } from './benchmarkDataset';
import {
  appendStageRecord,
  clearCheckpoint,
  loadStageRecords,
  readCheckpoint,
  stageRecordFromCheckpoint,
  startCheckpoint,
  type BenchmarkCheckpoint,
  type CheckpointSession,
  type StoredStageRecord,
} from './benchmarkCheckpoint';
import { deleteRun, loadProfileId, loadRatings, loadRuns, saveProfileId, saveRating, saveRun } from './labStorage';
import StorageDiagnosticsSection, { type StorageDiagnosticsSectionProps } from './StorageDiagnosticsSection';
import './AiModelLabPage.css';

type CacheState = 'unknown' | 'checking' | 'cached' | 'not-cached' | 'partial';
type Busy = 'idle' | 'downloading' | 'loading' | 'running' | 'deleting' | 'stage' | 'releasing';
/** 方式ごとの保存状況。`unavailable` はこのブラウザにその方式の API が無い。 */
type Presence = boolean | null | 'unavailable';

export interface AiModelLabPageProps {
  readonly onBack: () => void;
  /**
   * テストで Mock Runtime を渡す。既定は template / WebLLM（選んだ保存方式で作る）。
   * 関数なら保存方式を変えるたびに呼ぶ（1 つの Runtime は 1 つの保存方式だけを使う）。
   */
  readonly runtimes?:
    | readonly BenchmarkRuntime[]
    | ((backend: ModelStorageBackend | null, epoch: number) => readonly BenchmarkRuntime[]);
  readonly candidates?: readonly BenchmarkCandidate[];
  readonly buildDataset?: () => BenchmarkDataset;
  readonly probe?: () => Promise<DeviceReport>;
  /** このブラウザが公開している保存方式。既定は API の有無から判定。 */
  readonly storageSupport?: ModelStorageSupport;
  /** origin の usage / quota / persisted を調べる。既定は `navigator.storage`。 */
  readonly probeStorage?: () => Promise<StorageStatus>;
  /** 永続化の要求（best-effort）。既定は `navigator.storage.persist()`。 */
  readonly requestPersist?: () => Promise<boolean | null>;
  /** BROWSER STORAGE DIAGNOSTICS へ渡す（テストで Fake Adapter を使う）。既定はブラウザの保存 API。 */
  readonly storageDiagnostics?: Pick<StorageDiagnosticsSectionProps, 'adapters' | 'probeStorage' | 'requestPersist' | 'testMode'>;
}

/** `epoch` は作り直すたびに変わる値（作り直しの合図。Runtime の中身には使わない）。 */
const defaultRuntimes = (backend: ModelStorageBackend | null, _epoch = 0): readonly BenchmarkRuntime[] =>
  backend === null ? [createTemplateRuntime()] : [createTemplateRuntime(), createWebLlmRuntime({ storageBackend: backend })];

/**
 * E2E 用の Test Runtime（`?ai-lab-test-runtime=mock` / `mock-hang`）。実モデルを使わずに段階・checkpoint の流れを確かめる。
 * 指定が無ければ null（通常の Runtime）。Test Runtime のコードは指定したときだけ動的 import する（`labTestRuntime.ts`）。
 */
function testRuntimeModeFromLocation(): 'mock' | 'mock-hang' | null {
  if (typeof window === 'undefined') return null;
  const mode = new URLSearchParams(window.location.search).get('ai-lab-test-runtime');
  return mode === 'mock' || mode === 'mock-hang' ? mode : null;
}

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
  partial:
    '一部だけ保存（partial。前回の取得が途中で止まった可能性）。Download で残りを取得するか、「モデルを削除」でこのモデルの分だけ消せます',
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

/**
 * Lab を離れた（unmount）・ページを閉じた（pagehide）ことによる中止の理由。
 * 利用者の「中止」・捕まえた失敗と違い、この中止で終わった実行は「正常終了しなかった」ので checkpoint を消さない。
 */
const LIFECYCLE_ABORT_REASON = 'lab-lifecycle';

/** Lab を離れた・ページを閉じたことによる中止か。 */
function abortedByLifecycle(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === LIFECYCLE_ABORT_REASON;
}

/** 実行が終わったあとで checkpoint を消す。Lab を離れた・ページを閉じたことによる中止なら残す。 */
function finishCheckpoint(checkpoint: CheckpointSession, signal: AbortSignal): void {
  if (abortedByLifecycle(signal)) return;
  checkpoint.clear();
}

const CHECKPOINT_PHASE_LABEL: Readonly<Record<BenchmarkCheckpoint['phase'], string>> = {
  loading: 'loading（モデルの読み込み中）',
  loaded: 'loaded（読み込み直後）',
  generating: 'generating（生成中）',
  validating: 'validating（生成が返った直後・検証中）',
  unloading: 'unloading（解放中）',
};

export default function AiModelLabPage({
  onBack,
  runtimes: injectedRuntimes,
  candidates = BENCHMARK_CANDIDATES,
  buildDataset = coreDataset,
  probe = probeDevice,
  storageSupport: injectedStorageSupport,
  probeStorage = probeStorageStatus,
  requestPersist = requestPersistentStorage,
  storageDiagnostics,
}: AiModelLabPageProps) {
  const storageSupport = useMemo(() => injectedStorageSupport ?? detectModelStorageSupport(), [injectedStorageSupport]);
  const storageChoice = useMemo(() => chooseModelStorageBackend(storageSupport), [storageSupport]);
  const [storageBackend, setStorageBackend] = useState<ModelStorageBackend | null>(storageChoice.backend);
  const testRuntimeMode = useMemo(() => (injectedRuntimes ? null : testRuntimeModeFromLocation()), [injectedRuntimes]);
  const [testRuntimes, setTestRuntimes] = useState<readonly BenchmarkRuntime[] | null>(null);
  useEffect(() => {
    if (testRuntimeMode === null) return;
    let active = true;
    void import('./labTestRuntime').then((module) => {
      if (active) setTestRuntimes(module.createLabTestRuntimes(testRuntimeMode, candidates));
    });
    return () => {
      active = false;
    };
  }, [testRuntimeMode, candidates]);
  const templateOnly = useMemo(() => [createTemplateRuntime()], []);
  /**
   * Runtime を作り直した回数。bfcache から戻ったときに中止に応じない操作が残っていたら増やし、その Runtime を捨てる
   * （WebLLM の Runtime は読み込みの最中だと次の読み込みを受け付けず、読み込みにはタイムアウトが無いため）。
   */
  const [runtimeEpoch, setRuntimeEpoch] = useState(0);
  const runtimes = useMemo(() => {
    if (typeof injectedRuntimes === 'function') return injectedRuntimes(storageBackend, runtimeEpoch);
    if (injectedRuntimes) return injectedRuntimes;
    if (testRuntimeMode !== null) return testRuntimes ?? templateOnly;
    return defaultRuntimes(storageBackend, runtimeEpoch);
  }, [injectedRuntimes, storageBackend, testRuntimeMode, testRuntimes, templateOnly, runtimeEpoch]);
  const [dataset, setDataset] = useState<BenchmarkDataset | null>(null);
  const [device, setDevice] = useState<DeviceReport | null>(null);
  const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? BASELINE_CANDIDATE_ID);
  const [cacheState, setCacheState] = useState<Record<string, CacheState>>({});
  const [measuredSize, setMeasuredSize] = useState<Record<string, number | null>>({});
  const [loaded, setLoaded] = useState<{ candidateId: string; runtimeId: string; load: LoadRecord } | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  /** BROWSER STORAGE DIAGNOSTICS の実行中。モデルの取得などと同時に走らせない。 */
  const [diagnosticRunning, setDiagnosticRunning] = useState(false);
  const labBusy = busy !== 'idle' || diagnosticRunning;
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
  /**
   * 操作（取得・読み込み・Benchmark・段階）の終わりの後片付け。まだその操作が現在の操作のときだけ busy などを戻す
   * （bfcache から戻ったときに打ち切った古い操作が、あとから新しい操作の状態を書き換えないように）。
   */
  const endOperation = useCallback((controller: AbortController) => {
    if (abortRef.current !== controller) return;
    abortRef.current = null;
    setBusy('idle');
    setProgress(null);
  }, []);
  /** 永続化の要求は、この画面で 1 回まで（permission の連続要求をしない）。 */
  const persistRequestedRef = useRef(false);
  /** Benchmark Profile（STANDARD / MOBILE_FEASIBILITY）。profile が違う run は比べない。 */
  const [profileId, setProfileId] = useState<string>(() => loadProfileId() ?? STANDARD_PROFILE.id);
  const profile: BenchmarkProfile = profileById(profileId) ?? STANDARD_PROFILE;
  /**
   * Lab を開いたときに残っていた checkpoint（前回の run が正常終了しなかった証拠。原因は断定しない）。
   * 新しい run が checkpoint を書く前に、最初の描画で 1 回だけ読む。
   */
  const [staleCheckpoint, setStaleCheckpoint] = useState<BenchmarkCheckpoint | null>(() => readCheckpoint());
  const [stageRecords, setStageRecords] = useState<StoredStageRecord[]>(() => {
    const stale = readCheckpoint();
    const record = stale ? stageRecordFromCheckpoint(stale) : null;
    return record ? appendStageRecord(record) : loadStageRecords();
  });
  /** 推奨されていない段階を実行する前の確認。 */
  const [confirmStage, setConfirmStage] = useState<FeasibilityStage | null>(null);

  // Lab を離れたら、進行中の取得・Benchmark を中止し、読み込んだモデルを解放する
  // （画面の外で数 GB の取得が続いたり、WebGPU の資源が残ったりしないように）。
  // この中止は利用者の「中止」ではないので、checkpoint は消さない（`LIFECYCLE_ABORT_REASON`）。
  useEffect(
    () => () => {
      abortRef.current?.abort(LIFECYCLE_ABORT_REASON);
      for (const item of runtimes) void item.unload().catch(() => {});
    },
    [runtimes],
  );

  // ページを閉じる・別のページへ移る（pagehide）ときも、できる範囲で中止・解放する。
  // checkpoint は消さない（途中で終わった run は、次に開いたとき「正常終了しなかった」と示す）。
  useEffect(() => {
    const release = () => {
      abortRef.current?.abort(LIFECYCLE_ABORT_REASON);
      for (const item of runtimes) void item.unload().catch(() => {});
    };
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
  }, [runtimes]);

  // back-forward cache から戻ったときは、同じ画面のまま再開するので state の初期化（checkpoint の読み込み）が走らない。
  // pagehide で残した checkpoint を読み直し、「正常終了しなかった」を示す。
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // pagehide でモデルを解放したので、画面の「読み込み済み」も外す（残すと Run が読み込みを飛ばして not-loaded になる）。
      setLoaded(null);
      // pagehide で中止した操作が中止に応じずに残っていても（読み込みにはタイムアウトが無い）、画面を操作できる状態に戻す。
      // 古い操作はもう現在の操作ではないので、あとで終わっても busy などを書き換えない（endOperation）。
      if (abortRef.current !== null) {
        abortRef.current.abort(LIFECYCLE_ABORT_REASON);
        // 中止に応じない操作を持つ Runtime は捨てて作り直す（その Runtime は次の読み込みを受け付けないことがある）。
        setRuntimeEpoch((value) => value + 1);
      }
      abortRef.current = null;
      setBusy('idle');
      setProgress(null);
      setConfirmStage(null);
      setStorageRevision((value) => value + 1);
      const stale = readCheckpoint();
      if (stale === null) return;
      setStaleCheckpoint(stale);
      const record = stageRecordFromCheckpoint(stale);
      if (record) setStageRecords(appendStageRecord(record));
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

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
      // 保存済みでなければ、取得が途中で止まった残り（partial）かを確かめる（読むだけ）。
      const partial = cached === true ? false : await runtime.modelStorage?.hasPartial?.(candidate).catch(() => null);
      if (!active) return;
      setCacheState((state) => ({
        ...state,
        [storageKey]: cached === true ? 'cached' : partial === true ? 'partial' : cached === null ? 'unknown' : 'not-cached',
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

  /** 読み込んでいるモデルを解放する（候補・profile を切り替えるとき。メモリを残さない）。 */
  const releaseLoaded = useCallback(async () => {
    if (!loaded) return;
    const current = loaded;
    setLoaded(null);
    await runtimes.find((item) => item.id === current.runtimeId)?.unload().catch(() => {});
  }, [loaded, runtimes]);

  /**
   * 読み込んでいるモデルを解放し終わるまで Lab を busy にする（解放の途中で次の読み込み・段階を始めさせない）。
   */
  const releaseWhileBusy = useCallback(async () => {
    if (!loaded) return;
    // 解放も 1 つの操作として扱う（bfcache から戻ったときに、終わっていない解放を持つ Runtime を作り直せるように。
    // 解放そのものは中止できないが、打ち切られたあとで終わっても busy を書き換えない）。
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('releasing');
    try {
      await releaseLoaded();
    } finally {
      endOperation(controller);
    }
  }, [loaded, releaseLoaded, endOperation]);

  /** 候補を切り替える。前の候補のモデルは解放する。 */
  const changeCandidate = useCallback((next: string) => {
    void releaseWhileBusy();
    setCandidateId(next);
    setConfirmDownload(false);
    setConfirmDelete(false);
    setConfirmStage(null);
  }, [releaseWhileBusy]);

  /** profile を切り替える。context window が変わるので、読み込んでいるモデルは解放する。 */
  const changeProfile = useCallback((next: string) => {
    if (!profileById(next)) return;
    void releaseWhileBusy();
    setProfileId(next);
    saveProfileId(next);
    setConfirmStage(null);
  }, [releaseWhileBusy]);

  /** 保存方式を変える。Runtime を作り直し（前の Runtime は解放）、読み込み済みの状態を外す。取得はしない。 */
  const changeStorageBackend = useCallback((next: ModelStorageBackend) => {
    abortRef.current?.abort();
    setStorageBackend(next);
    setLoaded(null);
    setConfirmDownload(false);
    setConfirmDelete(false);
    setMessage(null);
  }, []);

  /** checkpoint に書く、この実行の固定部分。 */
  const checkpointBase = useCallback(
    (stage: FeasibilityStage | null) => ({
      candidateId: candidate.id,
      candidateLabel: candidate.displayName,
      runtimeModelId: candidate.runtimeModelId,
      profileId: profile.id,
      profileVersion: profile.version,
      contextWindowSize: profile.contextWindowSize,
      stage,
      storageBackend: runtimeBackend,
    }),
    [candidate, profile, runtimeBackend],
  );

  /** 取得・読み込みの失敗の診断情報を作って画面に出す。 */
  const reportLoadFailure = useCallback(
    async (
      error: unknown,
      options: { download: boolean; aborted: boolean; progress: { fraction: number; text: string } | null; before: StorageStatus | null },
    ): Promise<ModelLoadFailureDiagnostics> => {
      const status = await probeStorage().catch(() => null);
      const diagnostics: ModelLoadFailureDiagnostics = {
        schema: '01as-ai-model-load-failure',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        candidateId: candidate.id,
        runtimeId: runtime?.id ?? '-',
        runtimeModelId: candidate.runtimeModelId,
        download: options.download,
        storageBackend: runtimeBackend,
        failureClass: classifyModelLoadFailure(error, { backend: runtimeBackend, aborted: options.aborted }),
        errorName: errorNameOf(error),
        message: errorMessageOf(error),
        progressFraction: options.progress?.fraction ?? null,
        progressText: options.progress?.text ?? null,
        storage: status,
        storageBefore: options.before,
        postStoreReadFailure: isPostStoreReadFailure(error, runtimeBackend),
      };
      setFailure(diagnostics);
      return diagnostics;
    },
    [candidate, runtime, runtimeBackend, probeStorage],
  );

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
      // 読み込みでタブごと終了したときの手がかり（読み込みが返れば消す）。
      const checkpoint = startCheckpoint(checkpointBase(null));
      checkpoint.update('loading');
      try {
        if (loaded && loaded.runtimeId !== runtime.id) {
          await runtimes.find((item) => item.id === loaded.runtimeId)?.unload();
        }
        const record = await runtime.load(candidate, {
          allowDownload,
          signal: controller.signal,
          contextWindowSize: profile.contextWindowSize,
          onProgress: (fraction, text) => {
            lastProgress = { fraction, text };
            setProgress({ fraction, text });
          },
        });
        // bfcache からの復帰などでこの操作が打ち切られていたら、画面の状態を書き換えない。
        if (abortRef.current !== controller) return;
        setLoaded({ candidateId: candidate.id, runtimeId: runtime.id, load: record });
        setCacheState((state) => ({ ...state, [storageKey]: 'cached' }));
        const size = await runtime.cachedSizeBytes(candidate).catch(() => null);
        setMeasuredSize((state) => ({ ...state, [storageKey]: size }));
        if (record.kind === 'download') {
          const after = await probeStorage().catch(() => null);
          setFootprint((state) => ({ ...state, [storageKey]: estimatedDownloadFootprint(before, after) }));
        }
      } catch (error) {
        // bfcache からの復帰などで打ち切った古い読み込みの失敗（中止）は、画面に出さない。
        if (abortRef.current !== controller) return;
        // 失敗した Runtime は、前に読み込んでいたモデルも外れていることがある（WebLLM の reload 失敗）。
        // 画面の「読み込み済み」を残すと、Run が読み込みを飛ばして全件 not-loaded になるので解除する。
        if (loaded?.runtimeId === runtime.id) setLoaded(null);
        await reportLoadFailure(error, {
          download: allowDownload,
          aborted: controller.signal.aborted,
          progress: lastProgress as { fraction: number; text: string } | null,
          before,
        });
      } finally {
        finishCheckpoint(checkpoint, controller.signal);
        endOperation(controller);
        setStorageRevision((value) => value + 1);
      }
    },
    [runtime, runtimes, candidate, loaded, storageKey, storageStatus, probeStorage, requestPersist, profile, reportLoadFailure, checkpointBase, endOperation],
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

  /** Benchmark を実行して保存する（読み込み済みの Runtime が前提）。 */
  const executeRun = useCallback(
    async (options: {
      caseIds: string[] | undefined;
      loadRecord: LoadRecord;
      stage: FeasibilityStage | null;
      checkpoint: CheckpointSession;
      signal: AbortSignal;
    }): Promise<BenchmarkRun | null> => {
      if (!runtime || !dataset) return null;
      const total = options.caseIds?.length ?? dataset.cases.length;
      setProgress({ fraction: 0, text: `0 / ${total}` });
      const result = await runBenchmark({
        runtime,
        candidate,
        dataset,
        caseIds: options.caseIds,
        settings: { ...profileGenerationSettings(profile), thinking: effectiveThinking },
        profile: runProfile(profile, options.stage),
        load: options.loadRecord,
        modelSizeBytes: measuredSize[storageKey] ?? null,
        device,
        signal: options.signal,
        // Lab を離れた・ページを閉じたことで打ち切った実行は、あとで生成が返っても checkpoint・進み具合を書き換えない。
        onCaseStart: (item, index, count, runId) => {
          if (!abortedByLifecycle(options.signal)) {
            options.checkpoint.update('generating', { runId, caseIndex: index, caseTotal: count, caseId: item.id });
          }
        },
        onCaseGenerated: (item, index, count, runId) => {
          if (!abortedByLifecycle(options.signal)) {
            options.checkpoint.update('validating', { runId, caseIndex: index, caseTotal: count, caseId: item.id });
          }
        },
        onCaseComplete: (_, index) => {
          if (!abortedByLifecycle(options.signal)) setProgress({ fraction: (index + 1) / total, text: `${index + 1} / ${total}` });
        },
      });
      // 打ち切った実行の結果は保存・選択しない（新しい run の選択や、保存上限の中の run を押し出さない）。
      // 利用者の「中止」で終わった run は、これまでどおり保存する。
      if (abortedByLifecycle(options.signal)) return null;
      const saved = saveRun(result);
      setRuns(saved.runs);
      setSelectedRunId(result.runId);
      if (!saved.saved) setMessage('結果を保存できませんでした（容量など）。この画面では表示できます。export で保存してください。');
      return result;
    },
    [runtime, dataset, candidate, profile, effectiveThinking, measuredSize, storageKey, device],
  );

  const run = useCallback(async () => {
    if (!runtime || !dataset) return;
    setMessage(null);
    setBusy('running');
    const controller = new AbortController();
    abortRef.current = controller;
    const checkpoint = startCheckpoint(checkpointBase(null));
    try {
      let loadRecord = loaded?.candidateId === candidate.id ? loaded.load : null;
      if (loadRecord === null) {
        // baseline など、取得の要らない Runtime だけがここを通る（取得は許可しない）。
        checkpoint.update('loading');
        loadRecord = await runtime.load(candidate, {
          allowDownload: false,
          signal: controller.signal,
          contextWindowSize: profile.contextWindowSize,
        });
        setLoaded({ candidateId: candidate.id, runtimeId: runtime.id, load: loadRecord });
        checkpoint.update('loaded');
      }
      await executeRun({
        caseIds: scope === 'quick' ? quickCaseIds(dataset) : undefined,
        loadRecord,
        stage: null,
        checkpoint,
        signal: controller.signal,
      });
    } catch (error) {
      setMessage(`Benchmark を実行できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // 正常終了・中止・捕まえた失敗のどれでも消す（残るのは Lab を離れた・ページが途中で終わったときだけ）。
      finishCheckpoint(checkpoint, controller.signal);
      endOperation(controller);
    }
  }, [runtime, dataset, scope, candidate, loaded, profile, checkpointBase, executeRun, endOperation]);

  const recordStage = useCallback(
    (record: StageRecord) => {
      setStageRecords(appendStageRecord({
        ...record,
        candidateId: candidate.id,
        profileKey: profileKey(profile),
        storageBackend: runtimeBackend,
      }));
    },
    [candidate, profile, runtimeBackend],
  );

  /**
   * MOBILE_FEASIBILITY の 1 段階。毎回「解放 → 読み込み（取得しない）→（生成）→ 解放」で、前の段階のメモリを持ち越さない。
   * LOAD ONLY は読み込んですぐ解放し、読み込みの成否と時間だけを測る。
   */
  const runStage = useCallback(
    async (stage: FeasibilityStage) => {
      if (!runtime || !dataset) return;
      setConfirmStage(null);
      setMessage(null);
      setFailure(null);
      setBusy('stage');
      const controller = new AbortController();
      abortRef.current = controller;
      const checkpoint = startCheckpoint(checkpointBase(stage));
        let lastProgress: { fraction: number; text: string } | null = null;
      let phase: 'load' | 'run' = 'load';
      try {
        checkpoint.update('loading');
        await releaseLoaded();
        // 解放を待つ間に中止されたら、読み込み（メモリを多く使う）を始めない。
        if (controller.signal.aborted) throw new BenchmarkRuntimeError('aborted', '読み込みの前に中止しました。');
        setProgress({ fraction: 0, text: `${FEASIBILITY_STAGE_LABEL[stage]}: 読み込み中` });
        const loadRecord = await runtime.load(candidate, {
          allowDownload: false,
          signal: controller.signal,
          contextWindowSize: profile.contextWindowSize,
          onProgress: (fraction, text) => {
            lastProgress = { fraction, text };
            setProgress({ fraction, text });
          },
        });
        checkpoint.update('loaded');
        phase = 'run';
        if (stage === 'LOAD_ONLY') {
          recordStage(stageRecordFromLoad(loadRecord, new Date().toISOString()));
          setMessage(`LOAD ONLY: 読み込みに成功しました（${LOAD_KIND_LABEL[loadRecord.kind]}・${formatMs(loadRecord.loadTimeMs)}）。すぐに解放しました。`);
        } else {
          const caseIds = stageCaseIds(stage, dataset);
          const result = await executeRun({ caseIds, loadRecord, stage, checkpoint, signal: controller.signal });
          // Lab を離れた・ページを閉じたことによる中止は記録しない（残した checkpoint を、次に開いたとき「正常終了しなかった」として記録する）。
          if (result && !abortedByLifecycle(controller.signal)) {
            recordStage(stageRecordFromRun(stage, result, new Date().toISOString(), caseIds.length));
          }
        }
        // 中止の理由が Lab を離れたことなら、最後の段階（generating など）を残したまま解放する。
        if (!abortedByLifecycle(controller.signal)) checkpoint.update('unloading');
        await runtime.unload();
      } catch (error) {
        await runtime.unload().catch(() => {});
        const at = new Date().toISOString();
        if (abortedByLifecycle(controller.signal)) {
          // 記録しない（上と同じ理由）。
        } else if (phase === 'load') {
          const diagnostics = await reportLoadFailure(error, {
            download: false,
            aborted: controller.signal.aborted,
            progress: lastProgress as { fraction: number; text: string } | null,
            before: null,
          });
          recordStage(stageRecordFromLoadFailure(stage, diagnostics, at, controller.signal.aborted));
        } else {
          setMessage(`${FEASIBILITY_STAGE_LABEL[stage]} を実行できませんでした: ${errorMessageOf(error)}`);
          recordStage(stageRecordFromLoadFailure(stage, {
            failureClass: classifyModelLoadFailure(error, { backend: runtimeBackend, aborted: controller.signal.aborted }),
            message: errorMessageOf(error),
          }, at, controller.signal.aborted));
        }
      } finally {
        finishCheckpoint(checkpoint, controller.signal);
        if (abortRef.current === controller) setLoaded(null);
        endOperation(controller);
        setStorageRevision((value) => value + 1);
      }
    },
    [runtime, dataset, candidate, profile, runtimeBackend, checkpointBase, releaseLoaded, executeRun, recordStage, reportLoadFailure, endOperation],
  );

  /** 保存済みの run を、モデルを再実行せずに現在の検証で評価し直す（元の run は残す）。 */
  const reevaluate = useCallback(
    (target: BenchmarkRun) => {
      const result = reevaluateRun(target, datasetMatchingRun(dataset, target), new Date().toISOString());
      if (!result.ok) {
        setMessage(`再評価できませんでした: ${result.reasonJa}`);
        return;
      }
      const saved = saveRun(result.run, { keepRunId: target.runId });
      setRuns(saved.runs);
      setSelectedRunId(result.run.runId);
      setMessage(
        `現在の検証（validator v${result.run.validatorVersion}）で ${result.reevaluatedCases} 件を評価し直しました（元の run は残っています）。` +
          (saved.saved ? '' : ' 保存できなかったので、export で保存してください。'),
      );
    },
    [dataset],
  );

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
  const profileFit = profileFitsCandidate(profile, candidate, dataset);
  const canRun = runnable && dataset !== null && !labBusy && compatibility.verdict !== 'UNSUPPORTED' &&
    (!needsModel || isLoaded) && profileFit.ok && !profile.staged;
  /** 段階は保存済みのモデルを読み込むだけ（取得しない）。 */
  const canStage = runnable && dataset !== null && !labBusy && compatibility.verdict !== 'UNSUPPORTED' &&
    profileFit.ok && (!needsModel || cache === 'cached' || isLoaded);
  const stageAdvice = adviseStages(
    stageRecords.filter((record) =>
      record.candidateId === candidate.id && record.profileKey === profileKey(profile) && record.storageBackend === runtimeBackend),
    staleCheckpoint !== null,
  );

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
        {testRuntimeMode !== null && (
          <p className="lab__hint lab__warning" data-testid="lab-test-runtime">
            TEST RUNTIME（{testRuntimeMode}）: E2E 用の Mock Runtime です。実モデル・WebLLM・WebGPU は使いません。
          </p>
        )}
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
                disabled={labBusy}
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

      {staleCheckpoint && (
        <div className="lab__message lab__failure" role="alert" data-testid="lab-stale-checkpoint">
          <p>
            <strong>前回のBenchmarkは正常終了しませんでした。</strong>
          </p>
          <dl className="lab__facts">
            <dt>Model</dt>
            <dd data-testid="checkpoint-model">{staleCheckpoint.candidateLabel}</dd>
            <dt>Profile</dt>
            <dd data-testid="checkpoint-profile">
              {staleCheckpoint.profileId} v{staleCheckpoint.profileVersion}（context {staleCheckpoint.contextWindowSize ?? '既定'}）
              {staleCheckpoint.stage ? ` / ${FEASIBILITY_STAGE_LABEL[staleCheckpoint.stage]}` : ''}
            </dd>
            <dt>Phase</dt>
            <dd data-testid="checkpoint-phase">{CHECKPOINT_PHASE_LABEL[staleCheckpoint.phase]}</dd>
            <dt>Case</dt>
            <dd data-testid="checkpoint-case">
              {staleCheckpoint.caseIndex === null
                ? '—（生成の前）'
                : `${staleCheckpoint.caseIndex + 1} / ${staleCheckpoint.caseTotal ?? '?'}`}
            </dd>
            <dt>ID</dt>
            <dd data-testid="checkpoint-case-id">{staleCheckpoint.caseId ?? '—'}</dd>
            <dt>Storage backend</dt>
            <dd>{staleCheckpoint.storageBackend ?? '—'}</dd>
            <dt>最後の記録</dt>
            <dd>{staleCheckpoint.updatedAt}</dd>
          </dl>
          <p className="lab__hint">
            これは「前回の run が正常終了しなかった」記録です。ブラウザ・タブが強制終了した証拠ではなく、原因（メモリ不足など）は断定できません
            （再読み込み・タブを閉じた場合も残ります）。次の段階へ進む前に、同じ段階をもう一度試すか、条件を見直してください。
          </p>
          <div className="lab__actions">
            <button
              type="button"
              data-testid="checkpoint-export"
              onClick={() =>
                download(`01as-ai-benchmark-checkpoint-${staleCheckpoint.updatedAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(staleCheckpoint, null, 2), 'application/json')}
            >
              checkpoint を保存（JSON）
            </button>
            <button
              type="button"
              data-testid="checkpoint-dismiss"
              onClick={() => {
                clearCheckpoint();
                setStaleCheckpoint(null);
              }}
            >
              確認した（表示を閉じる。段階の記録には残ります）
            </button>
          </div>
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
              disabled={labBusy}
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

      <StorageDiagnosticsSection {...storageDiagnostics} disabled={busy !== 'idle'} onRunningChange={setDiagnosticRunning} />

      <section className="lab__section" data-testid="lab-model">
        <h2>MODEL</h2>
        <label className="lab__field">
          <span>Model</span>
          <select
            data-testid="lab-model-select"
            value={candidate.id}
            disabled={labBusy}
            onChange={(event) => changeCandidate(event.target.value)}
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
                disabled={labBusy || compatibility.verdict === 'UNSUPPORTED'}
                onClick={() => setConfirmDownload(true)}
              >
                {cache === 'partial' ? 'Download（残りを取得）' : 'Download'}
              </button>
            )}
            {!isLoaded && cache === 'cached' && (
              <button type="button" data-testid="lab-load" disabled={labBusy} onClick={() => void load(false)}>
                Load
              </button>
            )}
            {isLoaded && (
              <button type="button" data-testid="lab-unload" disabled={labBusy} onClick={() => void unload()}>
                Unload
              </button>
            )}
            {(cache === 'cached' || cache === 'partial') && (
              <button
                type="button"
                className="lab__danger"
                data-testid="lab-delete-model"
                disabled={labBusy}
                onClick={() => setConfirmDelete(true)}
              >
                モデルを削除
              </button>
            )}
            {(busy === 'downloading' || busy === 'loading' || busy === 'stage') && (
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
              <button type="button" data-testid="lab-download-start" disabled={labBusy} onClick={() => void load(true)}>
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
              <button type="button" className="lab__danger" data-testid="lab-delete-start" disabled={labBusy} onClick={() => void removeCache()}>
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
          <label className="lab__field lab__field--wide">
            <span>Benchmark Profile</span>
            <select
              data-testid="lab-profile-select"
              value={profile.id}
              disabled={labBusy}
              onChange={(event) => changeProfile(event.target.value)}
            >
              {BENCHMARK_PROFILES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                  {item.qualityBenchmark ? '' : '（動作確認）'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <dl className="lab__facts" data-testid="lab-profile-facts">
          <dt>Profile</dt>
          <dd data-testid="lab-profile">{profile.id} v{profile.version}</dd>
          <dt>位置づけ</dt>
          <dd>{profile.labelJa}</dd>
          <dt>目的</dt>
          <dd>{profile.purposeJa}</dd>
          <dt>Context window</dt>
          <dd data-testid="lab-profile-context">
            {candidate.runtime === 'deterministic'
              ? '—（モデルなし）'
              : profile.contextWindowSize === null
              ? `Runtime の既定（${candidate.contextWindow ?? '不明'}）`
              : `${profile.contextWindowSize}（WebLLM の context_window_size を上書き。KV cache を小さくする）`}
          </dd>
          <dt>max_tokens</dt>
          <dd data-testid="lab-profile-max-tokens">{profile.maxTokens}</dd>
          {candidate.promptTokenMeasurement && (
            <>
              <dt>Prompt tokens（計測値）</dt>
              <dd>
                平均 {candidate.promptTokenMeasurement.meanTokens} / p95 {candidate.promptTokenMeasurement.p95Tokens} / 最大{' '}
                {candidate.promptTokenMeasurement.maxTokens}（{candidate.promptTokenMeasurement.maxCaseId}）
              </dd>
            </>
          )}
        </dl>
        {!profile.qualityBenchmark && (
          <p className="lab__hint lab__warning" data-testid="lab-profile-warning">
            {profile.id} は品質の benchmark ではありません（スマートフォンで安定して読み込み・生成できるかの確認）。
            context window・max_tokens が STANDARD と違うので、結果を STANDARD と直接比べないでください（run に profile を記録し、export でも混ぜません）。
          </p>
        )}
        {!profileFit.ok && (
          <p className="lab__hint lab__warning" data-testid="lab-profile-unfit">
            {profileFit.reasonJa}
          </p>
        )}

        {profile.staged ? (
          <FeasibilityStages
            advice={stageAdvice}
            disabled={!canStage}
            running={busy === 'stage'}
            needsDownload={needsModel && runnable && cache !== 'cached' && !isLoaded}
            confirmStage={confirmStage}
            onRequest={(stage) => {
              const item = stageAdvice.find((advice) => advice.stage === stage);
              if (item?.recommended) void runStage(stage);
              else setConfirmStage(stage);
            }}
            onConfirm={(stage) => void runStage(stage)}
            onCancel={() => setConfirmStage(null)}
            onAbort={() => abortRef.current?.abort()}
          />
        ) : null}

        <div className="lab__options">
          {!profile.staged && (
            <label className="lab__field">
              <span>ケース</span>
              <select
                data-testid="lab-scope"
                value={scope}
                onChange={(event) => setScope(event.target.value as 'all' | 'quick')}
                disabled={labBusy}
              >
                <option value="all">すべて</option>
                <option value="quick">クイック（各カテゴリ 2 件）</option>
              </select>
            </label>
          )}
          {candidate.supportsThinkingToggle && (
            <label className="lab__field">
              <span>Thinking</span>
              <select
                data-testid="lab-thinking"
                value={thinking}
                onChange={(event) => setThinking(event.target.value as 'off' | 'on')}
                disabled={labBusy}
              >
                <option value="off">OFF（01AS の既定）</option>
                <option value="on">ON（比較用）</option>
              </select>
            </label>
          )}
        </div>
        {!profile.staged && (
          <>
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
          </>
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
        onReevaluate={reevaluate}
        busy={labBusy}
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
  readonly onReevaluate: (run: BenchmarkRun) => void;
  readonly busy: boolean;
}

function hasV2RunChecks(run: BenchmarkRun): boolean {
  return run.results.length > 0 && run.results.every(hasV2Checks);
}

function countOf(value: number | null, total: number): string {
  return value === null ? '未計測（validator v1 の記録。「現在の検証で再評価」で計測できます）' : `${value} / ${total}`;
}

function ResultsSection({ runs, selectedRun, onSelect, onDelete, ratings, onRate, dataset, onReevaluate, busy }: ResultsSectionProps) {
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
  const runProfileInfo = runProfileOf(selectedRun);
  const reevaluateBlocked = reevaluationBlocker(selectedRun, datasetForRun);

  return (
    <section className="lab__section" data-testid="lab-results">
      <h2>RESULTS</h2>
      <label className="lab__field">
        <span>Run</span>
        <select data-testid="lab-run-select" value={selectedRun.runId} onChange={(event) => onSelect(event.target.value)}>
          {runs.map((item) => (
            <option key={item.runId} value={item.runId}>
              [{runProfileOf(item).id}] {item.candidateId} / thinking {item.settings.thinking} / {item.results.length} 件 /{' '}
              {item.startedAt}
              {item.reevaluation ? ` / 再評価 v${item.validatorVersion}` : ''}
            </option>
          ))}
        </select>
      </label>

      <dl className="lab__facts" data-testid="lab-run-profile">
        <dt>Profile</dt>
        <dd data-testid="result-profile">{describeRunProfile(selectedRun)}</dd>
        <dt>Validator</dt>
        <dd data-testid="result-validator">
          v{selectedRun.validatorVersion ?? 1}
          {selectedRun.reevaluation
            ? `（再評価。元の run: ${selectedRun.reevaluation.originalRunId}・元の validator v${selectedRun.reevaluation.originalValidatorVersion}）`
            : ''}
        </dd>
      </dl>
      {runProfileInfo.id !== STANDARD_PROFILE.id && (
        <p className="lab__hint lab__warning" data-testid="result-profile-warning">
          この run は {runProfileInfo.id} v{runProfileInfo.version} の結果です。品質の benchmark ではなく、条件（context window・max_tokens）が
          STANDARD と違うので、STANDARD の結果と直接比べないでください。
        </p>
      )}

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
        <dt>3a. Repetition</dt>
        <dd data-testid="metric-repetition">{countOf(summary.withRepetition, summary.total)}</dd>
        <dt>3b. Output limit reached</dt>
        <dd data-testid="metric-output-limit">{countOf(summary.withOutputLimit, summary.total)}</dd>
        <dt>3c. Internal code leak</dt>
        <dd data-testid="metric-internal-code">{countOf(summary.withInternalCodeLeak, summary.total)}</dd>
        <dt>Clean response</dt>
        <dd data-testid="metric-clean">
          {summary.cleanResponses === null
            ? countOf(null, summary.total)
            : `${summary.cleanResponses} / ${summary.total}（${formatRate(summary.cleanResponseRate)}）`}
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
        <button
          type="button"
          data-testid="lab-reevaluate"
          disabled={busy || reevaluateBlocked !== null}
          title={reevaluateBlocked ?? undefined}
          onClick={() => onReevaluate(selectedRun)}
        >
          Re-evaluate with current checks
        </button>
        <button type="button" className="lab__danger" onClick={() => onDelete(selectedRun.runId)}>
          この結果を削除
        </button>
      </div>
      {reevaluateBlocked !== null && !hasV2RunChecks(selectedRun) && (
        <p className="lab__hint" data-testid="lab-reevaluate-blocked">
          再評価できません: {reevaluateBlocked}
        </p>
      )}

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
  const issues = [
    ...result.contradictions,
    ...result.unsupportedClaims,
    result.shapeProblem,
    result.repetition ? `反復: ${result.repetition}` : null,
    result.outputLimit
      ? `出力の上限に達しました（${result.outputLimit.basis === 'finish-reason' ? 'finish_reason: length' : `出力 ${result.outputLimit.outputTokens ?? '?'} tokens / 上限 ${result.outputLimit.maxTokens}（finish_reason なし・トークン数で判断）`}）`
      : null,
    ...(result.internalCodeLeaks ?? []).map((code) => `内部の code が本文に出ています: ${code}`),
    result.error,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
  return (
    <li className="lab__response" data-testid={`lab-response-${result.caseId}`}>
      <details>
        <summary>
          <span className={result.validationPassed ? 'lab__pass' : 'lab__fail'}>{result.validationPassed ? 'PASS' : 'FAIL'}</span>{' '}
          {result.caseId} — {title}
          {result.failureCodes && result.failureCodes.length > 0 && (
            <span className="lab__codes" data-testid={`lab-response-codes-${result.caseId}`}> [{result.failureCodes.join(' ')}]</span>
          )}
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

interface FeasibilityStagesProps {
  readonly advice: readonly ReturnType<typeof adviseStages>[number][];
  readonly disabled: boolean;
  readonly running: boolean;
  /** モデルが保存されていない（段階は取得しないので、先に Download が必要）。 */
  readonly needsDownload: boolean;
  readonly confirmStage: FeasibilityStage | null;
  readonly onRequest: (stage: FeasibilityStage) => void;
  readonly onConfirm: (stage: FeasibilityStage) => void;
  readonly onCancel: () => void;
  readonly onAbort: () => void;
}

/**
 * MOBILE_FEASIBILITY の段階（LOAD ONLY → 1 CASE → QUICK 10 → FULL 100）。
 * 前の段階が成功していない・checkpoint が残っている・GPU の失敗を記録しているときは、次の段階を推奨せず、確認を挟む。
 */
function FeasibilityStages({
  advice,
  disabled,
  running,
  needsDownload,
  confirmStage,
  onRequest,
  onConfirm,
  onCancel,
  onAbort,
}: FeasibilityStagesProps) {
  const pending = confirmStage ? advice.find((item) => item.stage === confirmStage) : undefined;
  return (
    <div className="lab__stages" data-testid="lab-stages">
      <p className="lab__hint">
        段階ごとに「解放 → 保存済みのモデルを読み込む（取得しない）→ 生成 → 解放」で実行します。いきなり FULL 100 を実行せず、
        前の段階が成功してから次へ進んでください。
      </p>
      {needsDownload && (
        <p className="lab__hint lab__warning" data-testid="lab-stages-needs-download">
          このモデルはこの保存方式に保存されていません。段階はモデルを取得しないので、先に Download してください。
        </p>
      )}
      <ol className="lab__stage-list">
        {advice.map((item) => (
          <li key={item.stage} className="lab__stage" data-testid={`lab-stage-${item.stage}`}>
            <div className="lab__actions">
              <button
                type="button"
                data-testid={`lab-stage-run-${item.stage}`}
                className={item.recommended ? undefined : 'lab__caution'}
                disabled={disabled}
                onClick={() => onRequest(item.stage)}
              >
                {FEASIBILITY_STAGE_LABEL[item.stage]}
                {item.recommended ? '' : '（非推奨）'}
              </button>
              <span data-testid={`lab-stage-last-${item.stage}`}>
                {item.last === null
                  ? '未実施'
                  : `前回: ${stageStatusLabel(item.last.status)}` +
                    (item.last.loadTimeMs === null ? '' : `・load ${formatMs(item.last.loadTimeMs)}`) +
                    (item.last.casesTotal > 0 ? `・${item.last.casesCompleted} / ${item.last.casesTotal} 件` : '') +
                    (item.last.gpuError ? '・GPU error' : '')}
              </span>
            </div>
            {item.last?.detail && <p className="lab__hint">{item.last.detail}</p>}
            {!item.recommended && (
              <ul className="lab__hint" data-testid={`lab-stage-reasons-${item.stage}`}>
                {item.reasonsJa.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {running && (
        <div className="lab__actions">
          <button type="button" data-testid="lab-stage-abort" onClick={onAbort}>
            中止
          </button>
        </div>
      )}
      {pending && (
        <div className="lab__confirm" role="dialog" aria-label="段階の確認" data-testid="lab-stage-confirm">
          <p>
            {FEASIBILITY_STAGE_LABEL[pending.stage]} は<strong>推奨されていません</strong>。次の理由があります。
          </p>
          <ul>
            {pending.reasonsJa.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="lab__hint">
            実行すると、端末のメモリ不足でタブごと終了する可能性があります（保存中のほかの作業も失われることがあります）。
          </p>
          <div className="lab__actions">
            <button type="button" className="lab__danger" data-testid="lab-stage-confirm-run" onClick={() => onConfirm(pending.stage)}>
              理解したうえで実行する
            </button>
            <button type="button" data-testid="lab-stage-confirm-cancel" onClick={onCancel}>
              やめる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
