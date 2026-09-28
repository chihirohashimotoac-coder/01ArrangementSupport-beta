/**
 * Runner の unit test（Fake Storage Adapter。実際の保存 API には書かない）。
 *
 * success / QuotaExceeded / abort / cleanup / cleanup failure と、chunk を使い回すこと
 * （巨大な単一バッファを作らないこと）を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { MIB } from './constants';
import { createFakeAdapter, quotaExceededError } from './fakeAdapter';
import { STALE_USAGE_ERROR_NAME, createDiagnosticChunk, runStorageDiagnostic } from './runner';
import type { OriginStorageStatus } from './types';

/** 呼ばれるたびに usage が増える probe（前 → 後 → 後片付けの後）。 */
function probeSequence(...usages: number[]) {
  let call = 0;
  const probe = async (): Promise<OriginStorageStatus> => {
    const usage = usages[Math.min(call, usages.length - 1)];
    call += 1;
    return { usageBytes: usage, quotaBytes: 10 * 1024 * MIB, persisted: false };
  };
  return Object.assign(probe, { calls: () => call });
}

/** テストを速くするため、chunk は小さいゼロのバッファ（使い回しは runner に任せる）。 */
const zeroChunk = (bytes: number) => new Uint8Array(bytes);

describe('runStorageDiagnostic', () => {
  it('success: 目標まで 16 MiB ずつ書き、同じバッファを使い回し、最後に診断用のデータを削除する', async () => {
    const adapter = createFakeAdapter({ backend: 'opfs' });
    const progress: number[] = [];
    let clock = 1_000;
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 64 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(300 * MIB, 300 * MIB, 364 * MIB, 300 * MIB),
      onProgress: (value) => progress.push(value.writtenBytes),
      now: () => (clock += 250),
      createChunk: zeroChunk,
    });

    expect(result.status).toBe('success');
    expect(result.writtenBytes).toBe(64 * MIB);
    expect(result.lastSuccessfulBytes).toBe(64 * MIB);
    expect(result.failedAtBytes).toBeNull();
    expect(result.failedPhase).toBeNull();
    expect(result.errorName).toBeNull();
    expect(progress).toEqual([16, 32, 48, 64].map((value) => value * MIB));
    expect(adapter.writeSizes).toEqual([16, 16, 16, 16].map((value) => value * MIB));
    // 巨大な単一バッファを作らない（すべての write が同じ 16 MiB のバッファ）。
    expect(adapter.buffers.size).toBe(1);
    expect([...adapter.buffers][0].byteLength).toBe(16 * MIB);
    expect(adapter.calls.finish).toBe(1);
    expect(adapter.calls.dispose).toBe(0);
    // 前回の残りの削除 ＋ 終了後の削除。
    expect(adapter.calls.cleanup).toBe(2);
    expect(adapter.storedBytes()).toBe(0);
    expect(result.cleanup).toEqual({ status: 'ok', errorName: null, errorMessage: null });
    expect(result.originUsageBefore).toBe(300 * MIB);
    expect(result.originUsageAfter).toBe(364 * MIB);
    expect(result.originUsageAfterCleanup).toBe(300 * MIB);
    expect(result.originQuotaBefore).toBe(10 * 1024 * MIB);
    expect(result.originQuotaAfter).toBe(10 * 1024 * MIB);
    expect(result.persisted).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.bytesPerSecond).toBeGreaterThan(0);
    expect(Date.parse(result.startedAt)).toBeLessThan(Date.parse(result.finishedAt));
  });

  it('目標が chunk の倍数でなければ、最後の chunk だけ短く書く', async () => {
    const adapter = createFakeAdapter({ backend: 'cache' });
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 40 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      createChunk: zeroChunk,
    });
    expect(result.status).toBe('success');
    expect(adapter.writeSizes).toEqual([16 * MIB, 16 * MIB, 8 * MIB]);
    expect(adapter.buffers.size).toBe(1);
  });

  it('QuotaExceeded: 失敗した位置・最後に成功した位置・name / message を残し、診断用のデータを削除する', async () => {
    const adapter = createFakeAdapter({ backend: 'indexeddb', quotaBytes: 304 * MIB });
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 1024 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(300 * MIB, 300 * MIB, 604 * MIB, 300 * MIB),
      createChunk: zeroChunk,
    });

    expect(result.status).toBe('failed');
    expect(result.failedPhase).toBe('write');
    expect(result.errorName).toBe('QuotaExceededError');
    expect(result.errorMessage).toBe('The quota has been exceeded.');
    expect(result.writtenBytes).toBe(304 * MIB);
    expect(result.lastSuccessfulBytes).toBe(304 * MIB);
    expect(result.failedAtBytes).toBe(320 * MIB);
    expect(adapter.calls.finish).toBe(0);
    expect(adapter.calls.dispose).toBe(1);
    expect(adapter.storedBytes()).toBe(0);
    expect(result.cleanup.status).toBe('ok');
    expect(result.originUsageAfter).toBe(604 * MIB);
  });

  it('abort: chunk の境目で止め、書いた量を残し、診断用のデータを削除する', async () => {
    const controller = new AbortController();
    const adapter = createFakeAdapter({ backend: 'opfs' });
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 1024 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      signal: controller.signal,
      onProgress: (value) => {
        if (value.writtenBytes >= 32 * MIB) controller.abort();
      },
      createChunk: zeroChunk,
    });

    expect(result.status).toBe('aborted');
    expect(result.writtenBytes).toBe(32 * MIB);
    expect(result.failedAtBytes).toBeNull();
    expect(result.errorName).toBeNull();
    expect(adapter.calls.writes).toBe(2);
    expect(adapter.calls.finish).toBe(0);
    expect(adapter.calls.dispose).toBe(1);
    expect(adapter.storedBytes()).toBe(0);
    expect(result.cleanup.status).toBe('ok');
  });

  it('始める前に中止されていたら書かない（それでも診断用の名前の保存領域だけは削除を試みる）', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createFakeAdapter({ backend: 'cache' });
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 16 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      signal: controller.signal,
      createChunk: zeroChunk,
    });
    expect(result.status).toBe('aborted');
    expect(adapter.calls.open).toBe(0);
    expect(adapter.calls.writes).toBe(0);
    expect(adapter.calls.cleanup).toBe(1);
  });

  it('cleanup failure: 削除の失敗を結果に残す（黙って成功にしない）。書き込みの結果は別に残る', async () => {
    const error = new Error('removal refused');
    error.name = 'NoModificationAllowedError';
    const adapter = createFakeAdapter({ backend: 'opfs', cleanupError: error });
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 32 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      createChunk: zeroChunk,
    });
    // 前回の残りの削除で失敗するので、書き込みは始めない（prepare の失敗）。後片付けも失敗として残る。
    expect(result.status).toBe('failed');
    expect(result.failedPhase).toBe('prepare');
    expect(result.cleanup).toEqual({ status: 'failed', errorName: 'NoModificationAllowedError', errorMessage: 'removal refused' });
  });

  it('cleanup failure（書き込みのあと）: 書き込みは成功、後片付けは failed として分けて残す', async () => {
    let cleanups = 0;
    const base = createFakeAdapter({ backend: 'indexeddb' });
    const adapter = {
      ...base,
      async cleanup() {
        cleanups += 1;
        if (cleanups > 1) throw Object.assign(new Error('blocked by another tab'), { name: 'BlockedError' });
      },
    };
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 32 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      createChunk: zeroChunk,
    });
    expect(result.status).toBe('success');
    expect(result.cleanup).toEqual({ status: 'failed', errorName: 'BlockedError', errorMessage: 'blocked by another tab' });
  });

  it('open の失敗は prepare、確定（close）の失敗は finalize として残す', async () => {
    const openFailure = await runStorageDiagnostic({
      adapter: createFakeAdapter({ backend: 'opfs', openError: Object.assign(new Error('no'), { name: 'SecurityError' }) }),
      targetBytes: 16 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      createChunk: zeroChunk,
    });
    expect(openFailure).toMatchObject({ status: 'failed', failedPhase: 'prepare', errorName: 'SecurityError', writtenBytes: 0 });

    const finalize = createFakeAdapter({ backend: 'opfs', finishError: quotaExceededError('close failed') });
    const finalizeFailure = await runStorageDiagnostic({
      adapter: finalize,
      targetBytes: 32 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      createChunk: zeroChunk,
    });
    expect(finalizeFailure).toMatchObject({
      status: 'failed',
      failedPhase: 'finalize',
      errorName: 'QuotaExceededError',
      writtenBytes: 32 * MIB,
      failedAtBytes: 32 * MIB,
    });
    expect(finalize.calls.dispose).toBe(1);
    expect(finalize.storedBytes()).toBe(0);
  });

  it('origin の状態を読めなくても例外を投げない（unknown として残す）', async () => {
    const result = await runStorageDiagnostic({
      adapter: createFakeAdapter({ backend: 'cache' }),
      targetBytes: 16 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: () => Promise.reject(new Error('no storage manager')),
      createChunk: zeroChunk,
    });
    expect(result.status).toBe('success');
    expect(result.originUsageBefore).toBeNull();
    expect(result.originQuotaAfter).toBeNull();
    expect(result.persisted).toBeNull();
  });

  it('削除が Origin Usage に反映されるまで待ち、反映されたら usageReclaimed: true', async () => {
    const waits: number[] = [];
    const result = await runStorageDiagnostic({
      adapter: createFakeAdapter({ backend: 'cache' }),
      targetBytes: 64 * MIB,
      chunkBytes: 16 * MIB,
      // 前 300 → 後 364 → 削除直後はまだ 364 → 0.5 秒後も 364 → 1 秒後に 300
      probeStorage: probeSequence(300 * MIB, 300 * MIB, 364 * MIB, 364 * MIB, 364 * MIB, 300 * MIB),
      sleep: async (ms) => {
        waits.push(ms);
      },
      createChunk: zeroChunk,
    });
    expect(result.usageReclaimed).toBe(true);
    expect(result.reclaimWaitMs).toBe(1000);
    expect(waits).toEqual([500, 500]);
    expect(result.originUsageAfterCleanup).toBe(300 * MIB);
  });

  it('上限まで待っても反映されなければ usageReclaimed: false（Chromium の Cache API で起きる。次の方式の測定がずれる）', async () => {
    const result = await runStorageDiagnostic({
      adapter: createFakeAdapter({ backend: 'cache' }),
      targetBytes: 64 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(300 * MIB, 300 * MIB, 364 * MIB),
      reclaimTimeoutMs: 2000,
      reclaimPollMs: 500,
      sleep: async () => {},
      createChunk: zeroChunk,
    });
    expect(result.status).toBe('success');
    expect(result.cleanup.status).toBe('ok');
    expect(result.usageReclaimed).toBe(false);
    expect(result.reclaimWaitMs).toBe(2000);
    expect(result.originUsageAfterCleanup).toBe(364 * MIB);
  });

  it('前回の残りを削除したあとの usage を基準にする（残りの分で「元に戻った」と誤判定しない）', async () => {
    const result = await runStorageDiagnostic({
      adapter: createFakeAdapter({ backend: 'opfs' }),
      targetBytes: 64 * MIB,
      chunkBytes: 16 * MIB,
      // 開始前 400（前回の残り 100 を含む）→ 残りの削除後 300 → 書いた後 364 → 今回の分が消えずに 364 のまま
      probeStorage: probeSequence(400 * MIB, 300 * MIB, 364 * MIB),
      reclaimTimeoutMs: 1000,
      sleep: async () => {},
      createChunk: zeroChunk,
    });
    expect(result.originUsageBefore).toBe(300 * MIB);
    expect(result.usageReclaimed).toBe(false);
    expect(result.originUsageAfterCleanup).toBe(364 * MIB);
  });

  it('前回の残りがあれば、削除が usage に反映されるまで待ってから基準を取る', async () => {
    const adapter = createFakeAdapter({ backend: 'cache' });
    const waits: number[] = [];
    const result = await runStorageDiagnostic({
      adapter: { ...adapter, hasLeftovers: async () => true },
      targetBytes: 32 * MIB,
      chunkBytes: 16 * MIB,
      // 開始前 400（残り 100）→ 削除直後はまだ 400 → 0.5 秒後に 300 → 書いた後 332 → 削除後 300
      probeStorage: probeSequence(400 * MIB, 400 * MIB, 300 * MIB, 332 * MIB, 300 * MIB),
      sleep: async (ms) => {
        waits.push(ms);
      },
      createChunk: zeroChunk,
    });
    expect(result.status).toBe('success');
    expect(result.originUsageBefore).toBe(300 * MIB);
    expect(result.usageReclaimed).toBe(true);
    expect(waits).toEqual([500]);
  });

  it('前回の残りの削除が usage に反映されなければ、書き込みを始めない（StaleUsageError・prepare）', async () => {
    const adapter = createFakeAdapter({ backend: 'cache' });
    const result = await runStorageDiagnostic({
      adapter: { ...adapter, hasLeftovers: async () => true },
      targetBytes: 32 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(400 * MIB),
      reclaimTimeoutMs: 2000,
      sleep: async () => {},
      createChunk: zeroChunk,
    });
    expect(result).toMatchObject({ status: 'failed', failedPhase: 'prepare', errorName: STALE_USAGE_ERROR_NAME, writtenBytes: 0 });
    expect(adapter.calls.open).toBe(0);
  });

  it('書き始める前に、ほかの方式に残った診断用のデータも削除する（削除できなければ書き始めない）', async () => {
    const opfs = createFakeAdapter({ backend: 'opfs' });
    const leftover = await opfs.open();
    await leftover.write(new Uint8Array(1024), 0);
    const cache = createFakeAdapter({ backend: 'cache' });
    const indexeddb = createFakeAdapter({ backend: 'indexeddb' });
    const result = await runStorageDiagnostic({
      adapter: indexeddb,
      otherAdapters: [opfs, cache],
      targetBytes: 16 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(300 * MIB, 299 * MIB, 315 * MIB, 299 * MIB),
      createChunk: zeroChunk,
    });
    expect(result.status).toBe('success');
    expect(opfs.storedBytes()).toBe(0);
    expect(opfs.calls.cleanup).toBe(1);
    // 残りの無い方式は触らない。
    expect(cache.calls.cleanup).toBe(0);
    expect(result.originUsageBefore).toBe(299 * MIB);

    const locked = createFakeAdapter({ backend: 'opfs', cleanupError: Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' }) });
    const lockedWriter = await locked.open();
    await lockedWriter.write(new Uint8Array(1024), 0);
    const blocked = createFakeAdapter({ backend: 'indexeddb' });
    const failed = await runStorageDiagnostic({
      adapter: blocked,
      otherAdapters: [locked],
      targetBytes: 16 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(0),
      createChunk: zeroChunk,
    });
    expect(failed).toMatchObject({ status: 'failed', failedPhase: 'prepare', errorName: 'NoModificationAllowedError', writtenBytes: 0 });
    expect(failed.errorMessage).toContain('OPFS に残った診断用のデータを削除できませんでした: locked');
    expect(blocked.calls.open).toBe(0);
  });

  it('中止・削除の失敗・usage 不明のときは反映を待たない', async () => {
    const sleep = async () => {
      throw new Error('待たないはず');
    };
    const controller = new AbortController();
    const aborted = await runStorageDiagnostic({
      adapter: createFakeAdapter({ backend: 'opfs' }),
      targetBytes: 64 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: probeSequence(300 * MIB, 300 * MIB, 332 * MIB),
      signal: controller.signal,
      onProgress: () => controller.abort(),
      sleep,
      createChunk: zeroChunk,
    });
    expect(aborted).toMatchObject({ status: 'aborted', usageReclaimed: false, reclaimWaitMs: 0 });

    const unknown = await runStorageDiagnostic({
      adapter: createFakeAdapter({ backend: 'opfs' }),
      targetBytes: 16 * MIB,
      chunkBytes: 16 * MIB,
      probeStorage: async () => ({ usageBytes: null, quotaBytes: null, persisted: null }),
      sleep,
      createChunk: zeroChunk,
    });
    expect(unknown).toMatchObject({ status: 'success', usageReclaimed: null, reclaimWaitMs: 0 });
  });

  it('不正な大きさは受け付けない', async () => {
    const adapter = createFakeAdapter({ backend: 'opfs' });
    await expect(runStorageDiagnostic({ adapter, targetBytes: 0, chunkBytes: MIB, probeStorage: probeSequence(0) })).rejects.toThrow(RangeError);
    await expect(runStorageDiagnostic({ adapter, targetBytes: MIB, chunkBytes: -1, probeStorage: probeSequence(0) })).rejects.toThrow(RangeError);
    expect(adapter.calls.open).toBe(0);
  });
});

describe('createDiagnosticChunk', () => {
  it('毎回同じ中身の、圧縮で小さくならない（同じ値が並ばない）データを作る', () => {
    const a = createDiagnosticChunk(64 * 1024);
    const b = createDiagnosticChunk(64 * 1024);
    expect(a.every((value, index) => value === b[index])).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(200);
    // 端数（4 の倍数でない大きさ）も埋める。
    expect(createDiagnosticChunk(7).byteLength).toBe(7);
  });
});
