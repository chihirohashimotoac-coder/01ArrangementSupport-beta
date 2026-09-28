/**
 * 1 つの保存方式へ、目標の大きさまで chunk を逐次書き込み、どこまで書けたかを測る。
 *
 *   origin の状態（前） → 前回の残りを削除 → 開く → chunk を順に書く → 確定
 *   → origin の状態（後） → 診断用のデータだけを削除 → origin の状態（後片付けの後）
 *
 * - 大きな単一のバッファは作らない。`chunkBytes` のバッファを 1 つだけ作って使い回す
 *   （RAM の試験ではなく、保存容量の試験）
 * - 中身は圧縮で小さくならないよう疑似乱数で埋める（方式によって圧縮の有無が違うと比べられない）
 * - 中止（AbortSignal）は chunk の境目で確かめる。進行中の 1 chunk は待ってから止める
 * - 成功・失敗・中止のどれでも、最後に診断用のデータを削除する。削除の失敗は結果に残す（黙って成功にしない）
 * - 削除のあと、Origin Usage が元に戻るまで少し待つ（戻らなければ `usageReclaimed: false` として残す。
 *   Chromium では Cache API の削除が、ページの再読み込みまで usage に反映されないことがある）
 * - 例外を投げない（どの失敗も結果として返す）
 */
import type { DiagnosticBackend } from './constants';
import type {
  DiagnosticCleanup,
  DiagnosticPhase,
  DiagnosticProgress,
  DiagnosticStatus,
  DiagnosticStorageAdapter,
  DiagnosticWriter,
  OriginStorageStatus,
  StorageDiagnosticResult,
} from './types';

export function errorNameOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  }
  return null;
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * 使い回す chunk を作る。xorshift32 の疑似乱数で埋める（圧縮されない・毎回同じ中身）。
 */
export function createDiagnosticChunk(bytes: number, seed = 0x01a5_0001): Uint8Array {
  const chunk = new Uint8Array(bytes);
  const words = new Uint32Array(chunk.buffer, 0, Math.floor(bytes / 4));
  let state = seed >>> 0 || 1;
  for (let index = 0; index < words.length; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    words[index] = state;
  }
  for (let index = words.length * 4; index < bytes; index += 1) chunk[index] = index & 0xff;
  return chunk;
}

/** chunk ごとに先頭 4 byte を書き換え、同じ中身の chunk が並ばないようにする。 */
function stampChunk(chunk: Uint8Array, index: number): void {
  if (chunk.byteLength < 4) return;
  new DataView(chunk.buffer, chunk.byteOffset, 4).setUint32(0, index >>> 0, true);
}

const UNKNOWN_STATUS: OriginStorageStatus = { usageBytes: null, quotaBytes: null, persisted: null };

async function safeProbe(probe: () => Promise<OriginStorageStatus>): Promise<OriginStorageStatus> {
  try {
    return await probe();
  } catch {
    return UNKNOWN_STATUS;
  }
}

export interface RunStorageDiagnosticOptions {
  readonly adapter: DiagnosticStorageAdapter;
  readonly targetBytes: number;
  readonly chunkBytes: number;
  readonly probeStorage: () => Promise<OriginStorageStatus>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DiagnosticProgress) => void;
  /** 時刻（ms）。テストで固定する。 */
  readonly now?: () => number;
  /** テストで chunk を差し替える（既定は疑似乱数の chunk）。 */
  readonly createChunk?: (bytes: number) => Uint8Array;
  /** 削除が Origin Usage に反映されるのを待つ上限（既定 5 秒）と間隔（既定 0.5 秒）。 */
  readonly reclaimTimeoutMs?: number;
  readonly reclaimPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RECLAIM_TIMEOUT_MS = 5_000;
export const DEFAULT_RECLAIM_POLL_MS = 500;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runStorageDiagnostic(options: RunStorageDiagnosticOptions): Promise<StorageDiagnosticResult> {
  const { adapter, targetBytes, probeStorage, signal } = options;
  const now = options.now ?? (() => Date.now());
  const backend: DiagnosticBackend = adapter.backend;
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) throw new RangeError(`targetBytes が不正です: ${targetBytes}`);
  if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes <= 0) throw new RangeError(`chunkBytes が不正です: ${options.chunkBytes}`);
  const chunkBytes = Math.min(options.chunkBytes, targetBytes);

  const startedMs = now();
  // 開始前の値。前回の残りを削除できたら、削除のあとに測り直した値を「書き始めた時点」の基準にする
  // （残りの分を基準に含めると、今回の分が消えずに残っても「元に戻った」と判定してしまう）。
  let before = await safeProbe(probeStorage);

  let status: DiagnosticStatus = 'success';
  let failedPhase: DiagnosticPhase | null = null;
  let failedAtBytes: number | null = null;
  let failure: unknown = null;
  let writtenBytes = 0;
  let writeStartedMs = now();
  let writeFinishedMs = writeStartedMs;
  let writer: DiagnosticWriter | null = null;

  const fail = (phase: DiagnosticPhase, error: unknown, atBytes: number | null) => {
    status = 'failed';
    failedPhase = phase;
    failure = error;
    failedAtBytes = atBytes;
  };

  if (signal?.aborted) {
    status = 'aborted';
  } else {
    try {
      // 前回のテストが途中で閉じられて残ったデータを消してから測る（残りがあると容量の比較がずれる）。
      await adapter.cleanup();
      before = await safeProbe(probeStorage);
      writeStartedMs = now();
      writer = await adapter.open();
    } catch (error) {
      fail('prepare', error, 0);
    }
  }

  if (writer !== null && status === 'success') {
    const chunk = (options.createChunk ?? createDiagnosticChunk)(chunkBytes);
    let index = 0;
    while (writtenBytes < targetBytes) {
      if (signal?.aborted) {
        status = 'aborted';
        break;
      }
      const size = Math.min(chunkBytes, targetBytes - writtenBytes);
      const data = size === chunk.byteLength ? chunk : chunk.subarray(0, size);
      stampChunk(data, index);
      try {
        await writer.write(data, index);
      } catch (error) {
        fail('write', error, writtenBytes + size);
        break;
      }
      writtenBytes += size;
      index += 1;
      options.onProgress?.({ backend, writtenBytes, targetBytes });
    }
    if (status === 'success') {
      try {
        await writer.finish();
      } catch (error) {
        fail('finalize', error, writtenBytes);
      }
    }
    writeFinishedMs = now();
    if (status !== 'success') {
      try {
        await writer.dispose();
      } catch {
        // 閉じられなくても、このあと診断用のデータ全体を削除する（削除の失敗は結果に残る）。
      }
    }
  } else {
    writeFinishedMs = now();
  }

  const after = await safeProbe(probeStorage);

  // 成功・失敗・中止のどれでも（何も書く前の中止を含め）、診断用の名前の保存領域だけを削除する。
  let cleanup: DiagnosticCleanup = { status: 'ok', errorName: null, errorMessage: null };
  try {
    await adapter.cleanup();
  } catch (error) {
    cleanup = { status: 'failed', errorName: errorNameOf(error), errorMessage: errorMessageOf(error) };
  }
  // 削除が Origin Usage に反映されるのを待つ（反映されないまま次の方式を測ると、容量がずれる）。
  const sleep = options.sleep ?? defaultSleep;
  const reclaimTimeoutMs = options.reclaimTimeoutMs ?? DEFAULT_RECLAIM_TIMEOUT_MS;
  const reclaimPollMs = Math.max(1, options.reclaimPollMs ?? DEFAULT_RECLAIM_POLL_MS);
  const baseline = before.usageBytes;
  const reclaimedIn = (value: OriginStorageStatus) =>
    baseline === null || value.usageBytes === null ? null : value.usageBytes <= baseline + chunkBytes;
  let afterCleanup = await safeProbe(probeStorage);
  let reclaimWaitMs = 0;
  if (cleanup.status === 'ok' && !signal?.aborted) {
    while (reclaimedIn(afterCleanup) === false && reclaimWaitMs < reclaimTimeoutMs) {
      await sleep(reclaimPollMs);
      reclaimWaitMs += reclaimPollMs;
      afterCleanup = await safeProbe(probeStorage);
    }
  }

  const durationMs = Math.max(0, writeFinishedMs - writeStartedMs);
  return {
    backend,
    writeMethod: adapter.writeMethod,
    status,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    targetBytes,
    chunkBytes,
    writtenBytes,
    lastSuccessfulBytes: writtenBytes,
    failedAtBytes,
    failedPhase,
    durationMs,
    bytesPerSecond: durationMs > 0 && writtenBytes > 0 ? Math.round((writtenBytes / durationMs) * 1000) : null,
    errorName: failure === null ? null : errorNameOf(failure),
    errorMessage: failure === null ? null : errorMessageOf(failure),
    originUsageBefore: before.usageBytes,
    originUsageAfter: after.usageBytes,
    originQuotaBefore: before.quotaBytes,
    originQuotaAfter: after.quotaBytes,
    originUsageAfterCleanup: afterCleanup.usageBytes,
    usageReclaimed: reclaimedIn(afterCleanup),
    reclaimWaitMs,
    persisted: before.persisted,
    cleanup,
  };
}
