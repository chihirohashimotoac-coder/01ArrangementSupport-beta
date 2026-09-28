/**
 * テスト用の Fake Storage Adapter（保存 API を使わず、書いた量だけを数える）。
 *
 * unit test で success / QuotaExceeded / abort / cleanup / cleanup failure を再現するために使う。
 * アプリの画面からは使わない（`StorageDiagnosticsSection` の既定はブラウザの Adapter）。
 */
import type { DiagnosticBackend } from './constants';
import type { DiagnosticStorageAdapter, DiagnosticWriter } from './types';

export interface FakeAdapterOptions {
  readonly backend: DiagnosticBackend;
  readonly available?: boolean;
  /** この量を超える書き込みを QuotaExceededError にする。 */
  readonly quotaBytes?: number;
  /** open が失敗する。 */
  readonly openError?: Error;
  /** finish（確定）が失敗する。 */
  readonly finishError?: Error;
  /** cleanup が失敗する（前回の残りの削除を含む）。 */
  readonly cleanupError?: Error;
  /** 書き込みのたびに待つ（テストで中止を挟む）。 */
  readonly beforeWrite?: (index: number) => Promise<void>;
}

export interface FakeAdapter extends DiagnosticStorageAdapter {
  /** いま保存されている量（cleanup で 0 に戻る）。 */
  readonly storedBytes: () => number;
  readonly calls: { open: number; writes: number; finish: number; dispose: number; cleanup: number };
  /** write に渡された chunk の ArrayBuffer（使い回しているかを確かめる）。 */
  readonly buffers: Set<ArrayBufferLike>;
  /** write に渡された chunk の大きさ。 */
  readonly writeSizes: number[];
}

export function quotaExceededError(message = 'The quota has been exceeded.'): Error {
  const error = new Error(message);
  error.name = 'QuotaExceededError';
  return error;
}

export function createFakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  let stored = 0;
  const calls = { open: 0, writes: 0, finish: 0, dispose: 0, cleanup: 0 };
  const buffers = new Set<ArrayBufferLike>();
  const writeSizes: number[] = [];
  return {
    backend: options.backend,
    writeMethod: `fake ${options.backend}`,
    isAvailable: () => options.available ?? true,
    storedBytes: () => stored,
    calls,
    buffers,
    writeSizes,
    async open(): Promise<DiagnosticWriter> {
      calls.open += 1;
      if (options.openError) throw options.openError;
      return {
        async write(chunk, index) {
          calls.writes += 1;
          await options.beforeWrite?.(index);
          if (options.quotaBytes !== undefined && stored + chunk.byteLength > options.quotaBytes) throw quotaExceededError();
          buffers.add(chunk.buffer);
          writeSizes.push(chunk.byteLength);
          stored += chunk.byteLength;
        },
        async finish() {
          calls.finish += 1;
          if (options.finishError) throw options.finishError;
        },
        async dispose() {
          calls.dispose += 1;
        },
      };
    },
    async cleanup() {
      calls.cleanup += 1;
      if (options.cleanupError) throw options.cleanupError;
      const removed = stored > 0;
      stored = 0;
      return removed;
    },
    async hasLeftovers() {
      return stored > 0;
    },
  };
}
