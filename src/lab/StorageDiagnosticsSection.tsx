/**
 * BROWSER STORAGE DIAGNOSTICS（AI MODEL LAB 内）。
 *
 * WebLLM・モデル・外部の通信を**一切使わずに**、この端末で作ったテストデータを OPFS / IndexedDB /
 * Cache API へ逐次書き込み、どこまで書けるかを方式ごとに測る。モデルの取得で起きる
 * `QuotaExceededError` が「Browser Storage 自体の問題」か「WebLLM 固有の問題」かを切り分けるため
 * （`docs/BROWSER_STORAGE_DIAGNOSTICS.md`）。
 *
 * - 書き込みは利用者がボタンを押したときだけ始める（画面を開いただけでは書かない）
 * - 中止・画面を離れる・ページを閉じると中止し、診断用のデータだけを削除する
 * - 永続化の要求（persist）は別のボタン。書き込みのテストとは混ぜない
 * - 保存領域の操作はすべて `src/storageDiagnostics/` が行う（この画面は呼ぶだけ）
 * - 削除が Origin Usage に反映されないまま次を測ると容量がずれるので、そのときは残りの方式を測らず、
 *   再読み込みするまで次のテストを始めさせない。結果は再読み込みをまたいで残し（`labStorage.ts`）、比べられるようにする
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBrowserAdapters,
  probeOriginStorage,
  requestOriginPersistence,
  type DiagnosticAdapters,
} from '../storageDiagnostics/browserAdapters';
import {
  DEFAULT_DIAGNOSTIC_SIZE_ID,
  DEFAULT_DIAGNOSTIC_TEST_MODE_SIZE_ID,
  DIAGNOSTIC_BACKENDS,
  DIAGNOSTIC_BACKEND_LABEL,
  DIAGNOSTIC_CHUNK_BYTES,
  DIAGNOSTIC_NAMESPACE,
  DIAGNOSTIC_SIZE_OPTIONS,
  DIAGNOSTIC_TEST_MODE_CHUNK_BYTES,
  DIAGNOSTIC_TEST_MODE_PARAM,
  DIAGNOSTIC_TEST_MODE_SIZE_OPTIONS,
  formatDiagnosticBytes,
  type DiagnosticBackend,
} from '../storageDiagnostics/constants';
import { buildDiagnosticExport, compareBackends, describeBrowser } from '../storageDiagnostics/report';
import { STALE_USAGE_ERROR_NAME, errorMessageOf, errorNameOf, runStorageDiagnostic } from '../storageDiagnostics/runner';
import type { DiagnosticProgress, OriginStorageStatus, StorageDiagnosticResult } from '../storageDiagnostics/types';
import { clearDiagnosticResults, loadDiagnosticResults, saveDiagnosticResults } from './labStorage';

export interface StorageDiagnosticsSectionProps {
  /** テストでは Fake Adapter を渡す。既定はブラウザの OPFS / IndexedDB / Cache API。 */
  readonly adapters?: DiagnosticAdapters;
  readonly probeStorage?: () => Promise<OriginStorageStatus>;
  readonly requestPersist?: () => Promise<boolean | null>;
  /** E2E 用の小さいサイズ（1〜4 MiB）。既定は URL の `?storage-diagnostic-test-mode=1`。 */
  readonly testMode?: boolean;
  /** Lab でモデルの取得などが進行中なら、測定がずれるので開始できなくする。 */
  readonly disabled?: boolean;
  /** 診断の実行中かを Lab へ知らせる（実行中はモデルの取得を始めさせない）。 */
  readonly onRunningChange?: (running: boolean) => void;
}

function testModeFromLocation(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get(DIAGNOSTIC_TEST_MODE_PARAM) === '1';
}

function formatPersistent(value: boolean | null | undefined): string {
  return value === true ? 'Yes' : value === false ? 'No' : 'unknown';
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

function saveJson(filename: string, content: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * この結果のあとに、同じページで次の方式を測ってはいけない理由。
 *
 * - `cleanup-failed`: 診断用のデータが消せずに残っている（quota を使ったまま）
 * - `unreclaimed`: 削除したが、Origin Usage に反映されていない（quota に数えられたまま）
 * - `stale-usage`: 前回の残りを削除したが反映されず、書き始めの基準を決められなかった
 */
type BlockReason = 'cleanup-failed' | 'unreclaimed' | 'stale-usage';

function blockReasonOf(result: StorageDiagnosticResult): BlockReason | null {
  if (result.cleanup.status === 'failed') return 'cleanup-failed';
  if (result.errorName === STALE_USAGE_ERROR_NAME) return 'stale-usage';
  if (result.usageReclaimed === false) return 'unreclaimed';
  return null;
}

const BLOCK_REASON_JA: Readonly<Record<BlockReason, (result: StorageDiagnosticResult) => string>> = {
  'cleanup-failed': (result) =>
    `診断用のデータを削除できませんでした（${result.cleanup.errorName ?? 'Error'}: ${result.cleanup.errorMessage ?? ''}）。「診断用のデータを削除」を押してください`,
  unreclaimed: (result) =>
    `削除した診断用のデータが、まだ Origin Usage から減っていません（${formatDiagnosticBytes(result.originUsageBefore)} → ${formatDiagnosticBytes(result.originUsageAfterCleanup)}）`,
  'stale-usage': () => '前回のテストの残りを削除しましたが、Origin Usage にまだ反映されていないため、書き込みを始めませんでした',
};

const LEFTOVER_LABEL = (value: boolean | null | undefined): string =>
  value === undefined ? '確認中…' : value === null ? '不明' : value ? 'あり' : 'なし';

export default function StorageDiagnosticsSection({
  adapters: injectedAdapters,
  probeStorage = probeOriginStorage,
  requestPersist = requestOriginPersistence,
  testMode: injectedTestMode,
  disabled = false,
  onRunningChange,
}: StorageDiagnosticsSectionProps) {
  const adapters = useMemo(() => injectedAdapters ?? createBrowserAdapters(), [injectedAdapters]);
  const testMode = useMemo(() => injectedTestMode ?? testModeFromLocation(), [injectedTestMode]);
  const sizeOptions = testMode ? DIAGNOSTIC_TEST_MODE_SIZE_OPTIONS : DIAGNOSTIC_SIZE_OPTIONS;
  const chunkBytes = testMode ? DIAGNOSTIC_TEST_MODE_CHUNK_BYTES : DIAGNOSTIC_CHUNK_BYTES;
  const support = useMemo(
    () => Object.fromEntries(DIAGNOSTIC_BACKENDS.map((backend) => [backend, adapters[backend].isAvailable()])) as Record<DiagnosticBackend, boolean>,
    [adapters],
  );

  const [sizeId, setSizeId] = useState(testMode ? DEFAULT_DIAGNOSTIC_TEST_MODE_SIZE_ID : DEFAULT_DIAGNOSTIC_SIZE_ID);
  const [advanced, setAdvanced] = useState(false);
  const [status, setStatus] = useState<OriginStorageStatus | null>(null);
  const [revision, setRevision] = useState(0);
  /** これまでの結果（再読み込みの前の結果を含む。古い順）。 */
  const [results, setResults] = useState<StorageDiagnosticResult[]>(() => loadDiagnosticResults());
  /**
   * このページで測った結果のうち、診断用のデータ（またはその usage）が残ったもの（`blockReasonOf`）。
   * あれば、再読み込みするまで次のテストを始めない（残りの分が quota に数えられ、次の方式が少なく見えるため）。
   */
  const [blockingInPage, setBlockingInPage] = useState<StorageDiagnosticResult[]>([]);
  /** そのため、測らなかった方式。 */
  const [skipped, setSkipped] = useState<DiagnosticBackend[]>([]);
  const [progress, setProgress] = useState<DiagnosticProgress | null>(null);
  /** 実行中（キューを含む）の方式。null なら待機中。 */
  const [running, setRunning] = useState<DiagnosticBackend | null>(null);
  /** 「診断用のデータを削除」の実行中。 */
  const [cleaning, setCleaning] = useState(false);
  const [leftovers, setLeftovers] = useState<Partial<Record<DiagnosticBackend, boolean | null>>>({});
  const [cleanupMessage, setCleanupMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [persistMessage, setPersistMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const visibleOptions = sizeOptions.filter((option) => advanced || !option.advanced || option.id === sizeId);
  const size = sizeOptions.find((option) => option.id === sizeId) ?? sizeOptions[0];
  const sizeLabel = formatDiagnosticBytes(size.bytes);
  const idle = running === null && !cleaning;
  const needsReload = blockingInPage.length > 0;
  const canStart = idle && !disabled && !needsReload;

  useEffect(() => {
    onRunningChange?.(!idle);
  }, [idle, onRunningChange]);

  // 画面を離れたら中止する（runner は中止のあと、診断用のデータを削除してから終わる）。
  // ページを閉じる・別のページへ移るときも中止する（後片付けが間に合わなければ、次のテストの前に消す）。
  useEffect(() => {
    mountedRef.current = true;
    const onPageHide = () => abortRef.current?.abort();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', onPageHide);
      abortRef.current?.abort();
    };
  }, []);

  // origin 全体の状態（書き込みはしない）。
  useEffect(() => {
    let active = true;
    void probeStorage()
      .catch(() => null)
      .then((value) => {
        if (active) setStatus(value);
      });
    return () => {
      active = false;
    };
  }, [probeStorage, revision]);

  // 前回のテストの残り（保存領域を作らずに調べる）。
  useEffect(() => {
    let active = true;
    void Promise.all(
      DIAGNOSTIC_BACKENDS.map(async (backend) => [backend, await adapters[backend].hasLeftovers().catch(() => null)] as const),
    ).then((entries) => {
      if (active) setLeftovers(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [adapters, revision]);

  const runBackends = useCallback(
    async (backends: readonly DiagnosticBackend[]) => {
      // 同じ描画のうちに 2 回押されても、2 つのテストを同時に走らせない。
      if (!idle || disabled || needsReload || abortRef.current !== null) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setCleanupMessage(null);
      setSkipped([]);
      try {
        for (const [position, backend] of backends.entries()) {
          if (controller.signal.aborted) break;
          const adapter = adapters[backend];
          if (!adapter.isAvailable()) continue;
          setRunning(backend);
          setProgress({ backend, writtenBytes: 0, targetBytes: size.bytes });
          const result = await runStorageDiagnostic({
            adapter,
            targetBytes: size.bytes,
            chunkBytes,
            probeStorage,
            signal: controller.signal,
            onProgress: (value) => {
              if (mountedRef.current) setProgress(value);
            },
          });
          if (!mountedRef.current) return;
          setResults((items) => {
            const next = [...items, result];
            saveDiagnosticResults(next);
            return next;
          });
          setRevision((value) => value + 1);
          if (blockReasonOf(result) !== null) {
            // 診断用のデータ（またはその usage）が残ったまま次の方式を測ると、その方式の結果がずれる（Case を誤る）。
            // 残りは測らない。
            setBlockingInPage((items) => [...items, result]);
            setSkipped(backends.slice(position + 1).filter((item) => adapters[item].isAvailable()));
            break;
          }
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (mountedRef.current) {
          setRunning(null);
          setProgress(null);
        }
      }
    },
    [idle, disabled, needsReload, adapters, size.bytes, chunkBytes, probeStorage],
  );

  /** 診断用のデータだけを削除する（前回のテストが途中で閉じられたとき用）。 */
  const cleanupAll = useCallback(async () => {
    if (!idle || abortRef.current !== null) return;
    setCleaning(true);
    const failures: string[] = [];
    try {
      for (const backend of DIAGNOSTIC_BACKENDS) {
        if (!adapters[backend].isAvailable()) continue;
        try {
          await adapters[backend].cleanup();
        } catch (error) {
          failures.push(`${DIAGNOSTIC_BACKEND_LABEL[backend]}: ${errorNameOf(error) ?? 'Error'}: ${errorMessageOf(error)}`);
        }
      }
    } finally {
      if (mountedRef.current) setCleaning(false);
    }
    if (!mountedRef.current) return;
    setCleanupMessage(
      failures.length === 0
        ? { ok: true, text: '診断用のデータを削除しました（ほかの保存データには触れていません）。' }
        : { ok: false, text: `diagnostic cleanup failed — ${failures.join(' / ')}` },
    );
    setRevision((value) => value + 1);
  }, [idle, adapters]);

  const requestPersistence = useCallback(async () => {
    const granted = await requestPersist().catch(() => null);
    if (!mountedRef.current) return;
    setPersistMessage(
      granted === true
        ? 'Persistent Storage が許可されました。'
        : granted === false
          ? 'Persistent Storage は許可されませんでした（ブラウザの判断）。'
          : 'Persistent Storage の要求結果が分かりませんでした。',
    );
    setRevision((value) => value + 1);
  }, [requestPersist]);

  const latestByBackend = (backend: DiagnosticBackend): StorageDiagnosticResult | undefined =>
    results.filter((item) => item.backend === backend).at(-1);
  const comparison = compareBackends(results, size.bytes);

  const exportJson = () => {
    const exportedAt = new Date().toISOString();
    const report = buildDiagnosticExport({
      exportedAt,
      browser: describeBrowser(),
      storage: status,
      support,
      testMode,
      results,
      comparisonTargetBytes: size.bytes,
    });
    saveJson(`01as-browser-storage-diagnostic-${exportedAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(report, null, 2));
  };

  return (
    <section className="lab__section" data-testid="lab-storage-diagnostics">
      <h2>BROWSER STORAGE DIAGNOSTICS</h2>
      <p className="lab__hint">
        WebLLM・モデル・外部の通信を使わずに、この端末で作ったテストデータを {chunkBytes === DIAGNOSTIC_CHUNK_BYTES ? '16 MiB' : formatDiagnosticBytes(chunkBytes)}{' '}
        ずつ書き込み、保存方式ごとにどこまで書けるかを測ります。書くのは「{DIAGNOSTIC_NAMESPACE}」の名前の保存領域だけで、
        終了・失敗・中止のあとに、その診断用のデータだけを削除します。
      </p>
      {testMode && (
        <p className="lab__hint" data-testid="storage-diagnostics-test-mode">
          TEST MODE（E2E 用）: 1〜4 MiB だけを 1 MiB ずつ書きます。
        </p>
      )}

      <dl className="lab__facts">
        <dt>Origin Usage</dt>
        <dd data-testid="diag-origin-usage">{formatDiagnosticBytes(status?.usageBytes)}</dd>
        <dt>Origin Quota</dt>
        <dd data-testid="diag-origin-quota">{formatDiagnosticBytes(status?.quotaBytes)}</dd>
        <dt>Persistent</dt>
        <dd data-testid="diag-persistent">{formatPersistent(status?.persisted)}</dd>
        <dt>前回のテストの残り</dt>
        <dd data-testid="diag-leftovers">
          {DIAGNOSTIC_BACKENDS.map((backend) => `${DIAGNOSTIC_BACKEND_LABEL[backend]}: ${LEFTOVER_LABEL(leftovers[backend])}`).join(' / ')}
        </dd>
      </dl>

      <div className="lab__options">
        <label className="lab__field">
          <span>Test size</span>
          <select data-testid="diag-size" value={sizeId} disabled={!idle} onChange={(event) => setSizeId(event.target.value)}>
            {visibleOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {formatDiagnosticBytes(option.bytes)}
                {option.advanced ? '（Advanced）' : ''}
              </option>
            ))}
          </select>
        </label>
        {sizeOptions.some((option) => option.advanced) && (
          <label className="lab__check">
            <input
              type="checkbox"
              data-testid="diag-advanced"
              checked={advanced}
              disabled={!idle}
              onChange={(event) => setAdvanced(event.target.checked)}
            />
            Advanced（2 GiB を選べるようにする）
          </label>
        )}
      </div>

      <div className="lab__actions">
        <button type="button" data-testid="diag-start-all" disabled={!canStart} onClick={() => void runBackends(DIAGNOSTIC_BACKENDS)}>
          ストレージテスト開始（3 方式を同じ {sizeLabel} で順に）
        </button>
        {!idle && (
          <button type="button" data-testid="diag-abort" onClick={() => abortRef.current?.abort()}>
            中止
          </button>
        )}
        <button type="button" data-testid="diag-export" disabled={results.length === 0} onClick={exportJson}>
          診断結果を保存（JSON）
        </button>
        <button type="button" data-testid="diag-cleanup" disabled={!idle} onClick={() => void cleanupAll()}>
          診断用のデータを削除
        </button>
        <button
          type="button"
          data-testid="diag-clear-results"
          disabled={!idle || results.length === 0}
          onClick={() => {
            clearDiagnosticResults();
            setResults([]);
          }}
        >
          記録した結果を消す
        </button>
      </div>
      {disabled && idle && <p className="lab__hint">モデルの取得・読み込みの間は開始できません（測定がずれるため）。</p>}
      <p className="lab__hint">
        順番は OPFS → IndexedDB → Cache API です（削除が usage に反映されにくい Cache API を最後にします）。
        最も厳密に比べるには、方式ごとにページを再読み込みしてから 1 方式ずつ測ってください。
      </p>

      {cleanupMessage && (
        <p className={cleanupMessage.ok ? 'lab__message' : 'lab__message lab__failure'} role={cleanupMessage.ok ? 'status' : 'alert'} data-testid="diag-cleanup-message">
          {cleanupMessage.text}
        </p>
      )}

      {needsReload && (
        <div className="lab__message lab__failure" role="status" data-testid="diag-unreclaimed">
          <ul>
            {blockingInPage.map((item) => (
              <li key={`${item.backend}-${item.startedAt}`}>
                {DIAGNOSTIC_BACKEND_LABEL[item.backend]}: {BLOCK_REASON_JA[blockReasonOf(item) ?? 'unreclaimed'](item)}
              </li>
            ))}
          </ul>
          <p>Chromium では削除（特に Cache API）が、ページを再読み込みするまで usage に反映されないことがあります。</p>
          {skipped.length > 0 && (
            <p data-testid="diag-skipped">
              診断用のデータ（またはその usage）が残ったまま測ると容量が少なく見えるため、{skipped.map((item) => DIAGNOSTIC_BACKEND_LABEL[item]).join(' / ')} は測りませんでした。
            </p>
          )}
          <p>
            ページを再読み込みしてから、まだ測っていない方式の「テスト」を押してください（それまで次のテストは始められません。
            削除できなかったデータは、再読み込みのあとのテストの前にも削除を試みます）。
            ここまでの結果は再読み込みしても残り、比較に使えます。
          </p>
        </div>
      )}

      {DIAGNOSTIC_BACKENDS.map((backend) => (
        <BackendPanel
          key={backend}
          backend={backend}
          available={support[backend]}
          sizeLabel={sizeLabel}
          progress={running === backend ? progress : null}
          running={running === backend}
          result={latestByBackend(backend)}
          canStart={canStart}
          onStart={() => void runBackends([backend])}
          onAbort={() => abortRef.current?.abort()}
        />
      ))}

      {comparison && (
        <div className="lab__confirm" data-testid="diag-comparison">
          <p>
            <strong>COMPARISON（{formatDiagnosticBytes(comparison.targetBytes)}）</strong>
          </p>
          <table className="lab__table">
            <thead>
              <tr>
                <th>Backend</th>
                <th>Result</th>
                <th>Written</th>
                <th>Usage before</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {DIAGNOSTIC_BACKENDS.map((backend) => {
                const result = results.filter((item) => item.backend === backend && item.targetBytes === comparison.targetBytes && item.status !== 'aborted').at(-1);
                return (
                  <tr key={backend}>
                    <td>{DIAGNOSTIC_BACKEND_LABEL[backend]}</td>
                    <td>{comparison.outcomes[backend]}</td>
                    <td>{formatDiagnosticBytes(result?.writtenBytes)}</td>
                    <td>{formatDiagnosticBytes(result?.originUsageBefore)}</td>
                    <td>{result?.errorName ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p data-testid="diag-comparison-case">{comparison.interpretationJa}</p>
          <p className="lab__hint">切り分けの手がかりで、原因の断定ではありません（docs/BROWSER_STORAGE_DIAGNOSTICS.md）。</p>
        </div>
      )}

      <div className="lab__actions">
        <button type="button" data-testid="diag-request-persist" disabled={!idle} onClick={() => void requestPersistence()}>
          Persistent Storageを要求
        </button>
      </div>
      {persistMessage && (
        <p className="lab__hint" data-testid="diag-persist-message">
          {persistMessage}
        </p>
      )}
      <p className="lab__hint">
        Persistent Storage の要求は書き込みのテストとは別の操作です。まず要求せずに（通常の状態で）測ってください。
        Persistent は eviction（自動削除）への対策で、容量制限（quota）を広げるものではありません。
      </p>
    </section>
  );
}

function BackendPanel({
  backend,
  available,
  sizeLabel,
  progress,
  running,
  result,
  canStart,
  onStart,
  onAbort,
}: {
  readonly backend: DiagnosticBackend;
  readonly available: boolean;
  readonly sizeLabel: string;
  readonly progress: DiagnosticProgress | null;
  readonly running: boolean;
  readonly result: StorageDiagnosticResult | undefined;
  readonly canStart: boolean;
  readonly onStart: () => void;
  readonly onAbort: () => void;
}) {
  const label = DIAGNOSTIC_BACKEND_LABEL[backend];
  const percent = progress && progress.targetBytes > 0 ? Math.floor((progress.writtenBytes / progress.targetBytes) * 100) : 0;
  return (
    <div className="lab__confirm" data-testid={`diag-backend-${backend}`}>
      <p>
        <strong>{label}</strong>
      </p>
      {!available ? (
        <p data-testid={`diag-status-${backend}`}>Status: このブラウザでは使えません</p>
      ) : running && progress ? (
        <>
          <p data-testid={`diag-status-${backend}`}>
            Written {formatDiagnosticBytes(progress.writtenBytes)} / {formatDiagnosticBytes(progress.targetBytes)}
          </p>
          <div className="lab__progress">
            <progress max={1} value={progress.targetBytes > 0 ? progress.writtenBytes / progress.targetBytes : 0} />
            <span data-testid={`diag-percent-${backend}`}>{percent}%</span>
          </div>
        </>
      ) : result === undefined ? (
        <p data-testid={`diag-status-${backend}`}>Status: Not Tested</p>
      ) : (
        <ResultSummary result={result} />
      )}
      {result && !running && <ResultDetails result={result} />}
      {available && (
        <div className="lab__actions">
          {running ? (
            <button type="button" onClick={onAbort}>
              中止
            </button>
          ) : (
            <button type="button" data-testid={`diag-start-${backend}`} disabled={!canStart} onClick={onStart}>
              {sizeLabel}テスト
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ResultSummary({ result }: { readonly result: StorageDiagnosticResult }) {
  const backend = result.backend;
  const label = DIAGNOSTIC_BACKEND_LABEL[backend];
  return (
    <div data-testid={`diag-status-${backend}`}>
      {result.status === 'success' && (
        <p className="lab__pass">
          {label} {formatDiagnosticBytes(result.targetBytes)}書き込み成功
        </p>
      )}
      {result.status === 'failed' && (
        <>
          <p className="lab__fail">{result.errorName ?? 'Error'}</p>
          <p>
            Failed at: {formatDiagnosticBytes(result.failedAtBytes)}（{result.failedPhase}）
          </p>
          <p>Last successful: {formatDiagnosticBytes(result.lastSuccessfulBytes)}</p>
        </>
      )}
      {result.status === 'aborted' && (
        <p>
          中止しました（{formatDiagnosticBytes(result.writtenBytes)} / {formatDiagnosticBytes(result.targetBytes)} まで書き込み）
        </p>
      )}
      {result.cleanup.status === 'failed' && (
        <p className="lab__fail" role="alert" data-testid={`diag-cleanup-failed-${backend}`}>
          diagnostic cleanup failed: {result.cleanup.errorName ?? 'Error'}: {result.cleanup.errorMessage}
        </p>
      )}
    </div>
  );
}

function ResultDetails({ result }: { readonly result: StorageDiagnosticResult }) {
  return (
    <details>
      <summary>詳細</summary>
      <dl className="lab__facts" data-testid={`diag-details-${result.backend}`}>
        <dt>Method</dt>
        <dd className="lab__ua">{result.writeMethod}</dd>
        <dt>Target / Chunk</dt>
        <dd>
          {formatDiagnosticBytes(result.targetBytes)} / {formatDiagnosticBytes(result.chunkBytes)}
        </dd>
        <dt>Written</dt>
        <dd>{formatDiagnosticBytes(result.writtenBytes)}</dd>
        <dt>Duration</dt>
        <dd>
          {formatDuration(result.durationMs)}
          {result.bytesPerSecond !== null ? `（${formatDiagnosticBytes(result.bytesPerSecond)}/s）` : ''}
        </dd>
        <dt>Error</dt>
        <dd className="lab__ua">{result.errorName ? `${result.errorName}: ${result.errorMessage || '（message なし）'}` : '—'}</dd>
        <dt>Origin Usage（前 → 後 → 削除後）</dt>
        <dd>
          {formatDiagnosticBytes(result.originUsageBefore)} → {formatDiagnosticBytes(result.originUsageAfter)} →{' '}
          {formatDiagnosticBytes(result.originUsageAfterCleanup)}
        </dd>
        <dt>削除の反映</dt>
        <dd data-testid={`diag-reclaimed-${result.backend}`}>
          {result.usageReclaimed === true
            ? 'Origin Usage は元に戻りました'
            : result.usageReclaimed === false
              ? `まだ反映されていません（${(result.reclaimWaitMs / 1000).toFixed(1)} 秒待機）`
              : '不明'}
        </dd>
        <dt>Origin Quota（前 → 後）</dt>
        <dd>
          {formatDiagnosticBytes(result.originQuotaBefore)} → {formatDiagnosticBytes(result.originQuotaAfter)}
        </dd>
        <dt>Persistent（開始時）</dt>
        <dd>{formatPersistent(result.persisted)}</dd>
        <dt>Cleanup</dt>
        <dd>{result.cleanup.status === 'ok' ? 'ok（診断用のデータを削除）' : `failed: ${result.cleanup.errorName}: ${result.cleanup.errorMessage}`}</dd>
        <dt>Time</dt>
        <dd>
          {result.startedAt} → {result.finishedAt}
        </dd>
      </dl>
    </details>
  );
}
