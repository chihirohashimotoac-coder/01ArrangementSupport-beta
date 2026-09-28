import { describe, expect, it } from 'vitest';
import { GIB, MIB, type DiagnosticBackend } from './constants';
import { buildDiagnosticExport, compareBackends } from './report';
import type { DiagnosticStatus, StorageDiagnosticResult } from './types';

function result(backend: DiagnosticBackend, status: DiagnosticStatus, targetBytes = GIB): StorageDiagnosticResult {
  const written = status === 'success' ? targetBytes : 304 * MIB;
  return {
    backend,
    writeMethod: `fake ${backend}`,
    status,
    startedAt: '2026-09-28T00:00:00.000Z',
    finishedAt: '2026-09-28T00:00:10.000Z',
    targetBytes,
    chunkBytes: 16 * MIB,
    writtenBytes: written,
    lastSuccessfulBytes: written,
    failedAtBytes: status === 'failed' ? 320 * MIB : null,
    failedPhase: status === 'failed' ? 'write' : null,
    durationMs: 10_000,
    bytesPerSecond: null,
    errorName: status === 'failed' ? 'QuotaExceededError' : null,
    errorMessage: status === 'failed' ? 'Quota exceeded.' : null,
    originUsageBefore: 300 * MIB,
    originUsageAfter: 300 * MIB + written,
    originQuotaBefore: 10 * GIB,
    originQuotaAfter: 10 * GIB,
    originUsageAfterCleanup: 300 * MIB,
    usageReclaimed: true,
    reclaimWaitMs: 0,
    persisted: false,
    cleanup: { status: 'ok', errorName: null, errorMessage: null },
  };
}

describe('compareBackends（docs の Case A〜D）', () => {
  it.each([
    ['A', 'success', 'success', 'success'],
    ['B', 'failed', 'failed', 'failed'],
    ['C', 'failed', 'success', 'failed'],
    ['D', 'success', 'success', 'failed'],
    ['other', 'success', 'failed', 'success'],
  ] as const)('Case %s: OPFS %s / IndexedDB %s / Cache API %s', (expected, opfs, indexeddb, cache) => {
    const comparison = compareBackends([result('opfs', opfs), result('indexeddb', indexeddb), result('cache', cache)], GIB);
    expect(comparison?.case).toBe(expected);
    expect(comparison?.outcomes).toEqual({ opfs, indexeddb, cache });
    expect(comparison?.interpretationJa).toContain(expected === 'other' ? 'どれにも当てはまりません' : `Case ${expected}`);
  });

  it('書き込みの前の失敗（prepare）は、その方式の容量の結果として比べない', () => {
    const prepare = { ...result('cache', 'failed'), failedPhase: 'prepare' as const, writtenBytes: 0, failedAtBytes: 0, errorName: 'BlockedError' };
    expect(compareBackends([result('opfs', 'failed'), result('indexeddb', 'success'), prepare], GIB)).toBeNull();
    // あとで書き込みまで走った結果があれば、それを使う。
    expect(compareBackends([result('opfs', 'failed'), result('indexeddb', 'success'), prepare, result('cache', 'failed')], GIB)?.case).toBe('C');
  });

  it('3 方式がそろわない・大きさが違う・中止した結果は比べない。同じ方式は最後の結果を使う', () => {
    expect(compareBackends([result('opfs', 'success'), result('indexeddb', 'success')], GIB)).toBeNull();
    expect(compareBackends([result('opfs', 'success'), result('indexeddb', 'success'), result('cache', 'success', 512 * MIB)], GIB)).toBeNull();
    expect(compareBackends([result('opfs', 'success'), result('indexeddb', 'success'), result('cache', 'aborted')], GIB)).toBeNull();
    expect(
      compareBackends(
        [result('opfs', 'failed'), result('indexeddb', 'success'), result('cache', 'failed'), result('opfs', 'success'), result('cache', 'aborted')],
        GIB,
      )?.case,
    ).toBe('D');
  });
});

describe('buildDiagnosticExport', () => {
  it('schema・browser・storage・results・comparison を持つ JSON を作る', () => {
    const results = [result('opfs', 'failed'), result('indexeddb', 'failed'), result('cache', 'failed')];
    const report = buildDiagnosticExport({
      exportedAt: '2026-09-28T00:01:00.000Z',
      browser: { userAgent: 'test-agent', brands: ['Chromium 140'], platform: 'Windows' },
      storage: { usageBytes: 300 * MIB, quotaBytes: 10 * GIB, persisted: false },
      support: { opfs: true, indexeddb: true, cache: true },
      testMode: false,
      results,
      comparisonTargetBytes: GIB,
    });
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsed.schema).toBe('01as-browser-storage-diagnostic');
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.browser.userAgent).toBe('test-agent');
    expect(parsed.storage).toEqual({ usageBytes: 300 * MIB, quotaBytes: 10 * GIB, persisted: false });
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0]).toMatchObject({ backend: 'opfs', targetBytes: 1073741824, writtenBytes: 318767104, errorName: 'QuotaExceededError' });
    // 必須の項目がすべてある。
    for (const key of [
      'backend',
      'startedAt',
      'finishedAt',
      'targetBytes',
      'writtenBytes',
      'lastSuccessfulBytes',
      'failedAtBytes',
      'durationMs',
      'errorName',
      'errorMessage',
      'originUsageBefore',
      'originUsageAfter',
      'originQuotaBefore',
      'originQuotaAfter',
      'persisted',
    ]) {
      expect(parsed.results[0]).toHaveProperty(key);
    }
    expect(parsed.comparison?.case).toBe('B');
  });

  it('origin の状態が分からなければ null を入れる', () => {
    const report = buildDiagnosticExport({
      exportedAt: '2026-09-28T00:01:00.000Z',
      browser: { userAgent: null, brands: null, platform: null },
      storage: null,
      support: { opfs: false, indexeddb: true, cache: true },
      testMode: true,
      results: [],
      comparisonTargetBytes: GIB,
    });
    expect(report.storage).toEqual({ usageBytes: null, quotaBytes: null, persisted: null });
    expect(report.comparison).toBeNull();
    expect(report.testMode).toBe(true);
  });
});
