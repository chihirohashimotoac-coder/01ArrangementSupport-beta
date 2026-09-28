/**
 * BROWSER STORAGE DIAGNOSTICS の画面テスト（Fake Storage Adapter。実際の保存 API には書かない）。
 *
 * - 画面を開いただけでは書かない（ボタンを押したときだけ）
 * - 進行中は Written / % / 中止を出し、成功・失敗（QuotaExceededError・Failed at・Last successful）・中止を表示する
 * - 後片付けの失敗は「diagnostic cleanup failed」として表示する
 * - 3 方式を同じ大きさで比べ、Case を表示する
 * - Persistent Storage の要求は別のボタン（書き込みのテストでは要求しない）
 * - 画面を離れたら中止し、診断用のデータを削除する
 * - JSON で保存できる
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticAdapters } from '../storageDiagnostics/browserAdapters';
import { MIB } from '../storageDiagnostics/constants';
import { createFakeAdapter, type FakeAdapter, type FakeAdapterOptions } from '../storageDiagnostics/fakeAdapter';
import type { StorageDiagnosticExport } from '../storageDiagnostics/report';
import type { OriginStorageStatus } from '../storageDiagnostics/types';
import { STORAGE_DIAGNOSTIC_RESULTS_KEY } from './labStorage';
import StorageDiagnosticsSection, { type StorageDiagnosticsSectionProps } from './StorageDiagnosticsSection';

const STATUS: OriginStorageStatus = { usageBytes: 304 * MIB, quotaBytes: 10.3 * 1024 * MIB, persisted: false };

function fakes(options: Partial<Record<'opfs' | 'indexeddb' | 'cache', Omit<FakeAdapterOptions, 'backend'>>> = {}) {
  const adapters = {
    opfs: createFakeAdapter({ backend: 'opfs', ...options.opfs }),
    indexeddb: createFakeAdapter({ backend: 'indexeddb', ...options.indexeddb }),
    cache: createFakeAdapter({ backend: 'cache', ...options.cache }),
  };
  return adapters as typeof adapters & DiagnosticAdapters;
}

function renderSection(props: Partial<StorageDiagnosticsSectionProps> & { adapters: DiagnosticAdapters }) {
  const requestPersist = vi.fn(async () => true as boolean | null);
  const view = render(
    <StorageDiagnosticsSection probeStorage={async () => STATUS} requestPersist={requestPersist} testMode {...props} />,
  );
  return { ...view, requestPersist };
}

/** 書き込みを 1 回ずつ止められる Fake（中止を挟む）。 */
function gated() {
  let release: (() => void) | null = null;
  const waiting: number[] = [];
  const beforeWrite = (index: number) =>
    new Promise<void>((resolve) => {
      waiting.push(index);
      release = resolve;
    });
  return {
    beforeWrite,
    waiting,
    next: () => {
      const resolve = release;
      release = null;
      resolve?.();
    },
  };
}

/** 開いた直後の確認（origin の状態・前回の残り）が終わるまで待つ。 */
async function settled() {
  await waitFor(() => expect(screen.getByTestId('diag-leftovers')).not.toHaveTextContent('確認中'));
  await waitFor(() => expect(screen.getByTestId('diag-origin-usage')).not.toHaveTextContent('unknown'));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('StorageDiagnosticsSection', () => {
  it('開いただけでは書かず、origin の Usage / Quota / Persistent と Not Tested を表示する', async () => {
    const adapters = fakes();
    renderSection({ adapters, testMode: false });
    expect(screen.getByRole('heading', { name: 'BROWSER STORAGE DIAGNOSTICS' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('diag-origin-usage')).toHaveTextContent('304 MiB'));
    expect(screen.getByTestId('diag-origin-quota')).toHaveTextContent('10.30 GiB');
    expect(screen.getByTestId('diag-persistent')).toHaveTextContent('No');
    for (const backend of ['opfs', 'indexeddb', 'cache'] as const) {
      expect(screen.getByTestId(`diag-status-${backend}`)).toHaveTextContent('Status: Not Tested');
      expect(screen.getByTestId(`diag-start-${backend}`)).toHaveTextContent('1 GiBテスト');
    }
    await waitFor(() => expect(screen.getByTestId('diag-leftovers')).toHaveTextContent('OPFS: なし / IndexedDB: なし / Cache API: なし'));
    for (const adapter of Object.values(adapters) as FakeAdapter[]) {
      expect(adapter.calls.open).toBe(0);
      expect(adapter.calls.writes).toBe(0);
      expect(adapter.calls.cleanup).toBe(0);
    }
  });

  it('大きさは 256 MiB / 512 MiB / 1 GiB（既定）。2 GiB は Advanced を開いたときだけ選べる', async () => {
    const user = userEvent.setup();
    renderSection({ adapters: fakes(), testMode: false });
    const select = screen.getByTestId('diag-size') as HTMLSelectElement;
    expect(select.value).toBe('1GiB');
    expect([...select.options].map((option) => option.textContent)).toEqual(['256 MiB', '512 MiB', '1 GiB']);
    await user.click(screen.getByTestId('diag-advanced'));
    expect([...select.options].map((option) => option.textContent)).toEqual(['256 MiB', '512 MiB', '1 GiB', '2 GiB（Advanced）']);
    await user.selectOptions(select, '2GiB');
    expect(screen.getByTestId('diag-start-opfs')).toHaveTextContent('2 GiBテスト');
  });

  it('TEST MODE（E2E 用）は 1〜4 MiB だけを選べる', async () => {
    renderSection({ adapters: fakes() });
    await settled();
    expect(screen.getByTestId('storage-diagnostics-test-mode')).toBeInTheDocument();
    const select = screen.getByTestId('diag-size') as HTMLSelectElement;
    expect(select.value).toBe('4MiB');
    expect([...select.options].map((option) => option.textContent)).toEqual(['1 MiB', '2 MiB', '4 MiB']);
  });

  it('success: ボタンを押したときだけ書き、成功を表示し、診断用のデータを削除する', async () => {
    const user = userEvent.setup();
    const adapters = fakes();
    const { requestPersist } = renderSection({ adapters });
    await user.click(screen.getByTestId('diag-start-opfs'));
    await waitFor(() => expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('OPFS 4 MiB書き込み成功'));
    expect(adapters.opfs.writeSizes).toEqual([MIB, MIB, MIB, MIB]);
    expect(adapters.opfs.storedBytes()).toBe(0);
    expect(adapters.opfs.calls.cleanup).toBe(2);
    // ほかの方式には書いていない。
    expect(adapters.indexeddb.calls.open).toBe(0);
    expect(adapters.cache.calls.open).toBe(0);
    // 書き込みのテストで永続化を要求しない。
    expect(requestPersist).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('diag-details-opfs')).getByText('ok（診断用のデータを削除）')).toBeInTheDocument();
  });

  it('QuotaExceeded: errorName・Failed at・Last successful を表示する', async () => {
    const user = userEvent.setup();
    const adapters = fakes({ indexeddb: { quotaBytes: 2 * MIB } });
    renderSection({ adapters });
    await user.click(screen.getByTestId('diag-start-indexeddb'));
    const status = await screen.findByText('QuotaExceededError');
    const panel = screen.getByTestId('diag-status-indexeddb');
    expect(panel).toContainElement(status);
    expect(panel).toHaveTextContent('Failed at: 3 MiB（write）');
    expect(panel).toHaveTextContent('Last successful: 2 MiB');
    expect(adapters.indexeddb.storedBytes()).toBe(0);
  });

  it('実行中は Written / % / 中止を出し、中止すると書き込みを止めて診断用のデータを削除する', async () => {
    const user = userEvent.setup();
    const gate = gated();
    const adapters = fakes({ cache: { beforeWrite: gate.beforeWrite } });
    renderSection({ adapters });
    await user.click(screen.getByTestId('diag-start-cache'));
    await waitFor(() => expect(gate.waiting).toEqual([0]));
    act(() => gate.next());
    await waitFor(() => expect(screen.getByTestId('diag-status-cache')).toHaveTextContent('Written 1 MiB / 4 MiB'));
    expect(screen.getByTestId('diag-percent-cache')).toHaveTextContent('25%');
    // 実行中は、ほかのテストを始められない。
    expect(screen.getByTestId('diag-start-opfs')).toBeDisabled();
    expect(screen.getByTestId('diag-start-all')).toBeDisabled();

    await waitFor(() => expect(gate.waiting).toEqual([0, 1]));
    await user.click(screen.getByTestId('diag-abort'));
    act(() => gate.next());
    await waitFor(() => expect(screen.getByTestId('diag-status-cache')).toHaveTextContent('中止しました（2 MiB / 4 MiB まで書き込み）'));
    expect(adapters.cache.calls.writes).toBe(2);
    expect(adapters.cache.calls.dispose).toBe(1);
    expect(adapters.cache.storedBytes()).toBe(0);
    expect(screen.getByTestId('diag-start-opfs')).toBeEnabled();
  });

  it('cleanup failure: 「diagnostic cleanup failed」を表示する（黙って成功にしない）', async () => {
    const user = userEvent.setup();
    const error = Object.assign(new Error('entry is locked'), { name: 'NoModificationAllowedError' });
    renderSection({ adapters: fakes({ opfs: { cleanupError: error } }) });
    await user.click(screen.getByTestId('diag-start-opfs'));
    expect(await screen.findByTestId('diag-cleanup-failed-opfs')).toHaveTextContent(
      'diagnostic cleanup failed: NoModificationAllowedError: entry is locked',
    );

    // 「診断用のデータを削除」でも、失敗は失敗として表示する。
    await user.click(screen.getByTestId('diag-cleanup'));
    expect(await screen.findByTestId('diag-cleanup-message')).toHaveTextContent(
      'diagnostic cleanup failed — OPFS: NoModificationAllowedError: entry is locked',
    );
  });

  it('3 方式を同じ大きさで順に測り、比較（Case D）を表示する', async () => {
    const user = userEvent.setup();
    const adapters = fakes({ cache: { quotaBytes: MIB } });
    renderSection({ adapters });
    await user.click(screen.getByTestId('diag-start-all'));
    const comparison = await screen.findByTestId('diag-comparison');
    expect(comparison).toHaveTextContent('COMPARISON（4 MiB）');
    expect(screen.getByTestId('diag-comparison-case')).toHaveTextContent('Case D');
    expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('OPFS 4 MiB書き込み成功');
    expect(screen.getByTestId('diag-status-indexeddb')).toHaveTextContent('IndexedDB 4 MiB書き込み成功');
    expect(screen.getByTestId('diag-status-cache')).toHaveTextContent('QuotaExceededError');
    for (const adapter of [adapters.opfs, adapters.indexeddb, adapters.cache]) expect(adapter.storedBytes()).toBe(0);
  });

  it('削除が Origin Usage に反映されなければ警告し、再読み込みを勧める', async () => {
    const user = userEvent.setup();
    let usage = 300 * MIB;
    const adapters = fakes();
    // 書いた分だけ usage が増え、削除しても減らない（Chromium の Cache API で観測した振る舞い）。
    const probeStorage = async (): Promise<OriginStorageStatus> => {
      usage = Math.max(usage, 300 * MIB + adapters.cache.calls.writes * MIB);
      return { usageBytes: usage, quotaBytes: 10 * 1024 * MIB, persisted: false };
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<StorageDiagnosticsSection adapters={adapters} probeStorage={probeStorage} requestPersist={async () => null} testMode />);
      await user.click(screen.getByTestId('diag-start-cache'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByTestId('diag-unreclaimed')).toHaveTextContent('Cache API: 削除した診断用のデータが、まだ Origin Usage から減っていません（300 MiB → 304 MiB）');
      expect(screen.getByTestId('diag-unreclaimed')).toHaveTextContent('ページを再読み込み');
      expect(screen.getByTestId('diag-reclaimed-cache')).toHaveTextContent('まだ反映されていません（5.0 秒待機）');
      // 再読み込みするまで、次のテストは始められない（容量がずれるため）。
      expect(screen.getByTestId('diag-start-opfs')).toBeDisabled();
      expect(screen.getByTestId('diag-start-all')).toBeDisabled();
      expect(screen.getByTestId('diag-cleanup')).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('3 方式を順に測る途中で削除が反映されなければ、残りの方式は測らない（誤った Case を出さない）', async () => {
    const user = userEvent.setup();
    const adapters = fakes();
    // OPFS の分だけ usage が増え、削除しても減らない。
    const probeStorage = async (): Promise<OriginStorageStatus> => ({
      usageBytes: 300 * MIB + adapters.opfs.calls.writes * MIB,
      quotaBytes: 10 * 1024 * MIB,
      persisted: false,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<StorageDiagnosticsSection adapters={adapters} probeStorage={probeStorage} requestPersist={async () => null} testMode />);
      await user.click(screen.getByTestId('diag-start-all'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByTestId('diag-skipped')).toHaveTextContent('IndexedDB / Cache API は測りませんでした');
      expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('OPFS 4 MiB書き込み成功');
      expect(screen.getByTestId('diag-status-indexeddb')).toHaveTextContent('Status: Not Tested');
      expect(adapters.indexeddb.calls.open).toBe(0);
      expect(adapters.cache.calls.open).toBe(0);
      expect(screen.queryByTestId('diag-comparison')).toBeNull();
      expect(screen.getByTestId('diag-start-indexeddb')).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('結果は再読み込み（画面を開き直す）をまたいで残り、方式ごとに測った結果で比較できる。記録は消せる', async () => {
    const user = userEvent.setup();
    const adapters = fakes({ cache: { quotaBytes: MIB } });
    for (const backend of ['opfs', 'indexeddb', 'cache'] as const) {
      const view = renderSection({ adapters });
      await user.click(screen.getByTestId(`diag-start-${backend}`));
      await waitFor(() => expect(screen.getByTestId(`diag-status-${backend}`)).not.toHaveTextContent('Not Tested'));
      await waitFor(() => expect(screen.getByTestId(`diag-start-${backend}`)).toBeEnabled());
      view.unmount();
    }
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_DIAGNOSTIC_RESULTS_KEY) ?? '{}') as { results: unknown[] };
    expect(STORAGE_DIAGNOSTIC_RESULTS_KEY.startsWith('01as-beta:ai.')).toBe(true);
    expect(stored.results).toHaveLength(3);

    renderSection({ adapters });
    expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('OPFS 4 MiB書き込み成功');
    expect(screen.getByTestId('diag-comparison-case')).toHaveTextContent('Case D');
    await user.click(screen.getByTestId('diag-clear-results'));
    expect(screen.queryByTestId('diag-comparison')).toBeNull();
    expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('Status: Not Tested');
    expect(window.localStorage.getItem(STORAGE_DIAGNOSTIC_RESULTS_KEY)).toBeNull();
  });

  it('削除に失敗したら（usage が分からなくても）残りの方式を測らず、再読み込みまで次のテストを始めない', async () => {
    const user = userEvent.setup();
    let cleanups = 0;
    const base = fakes();
    const opfs = {
      ...base.opfs,
      async cleanup() {
        cleanups += 1;
        // 前回の残りの削除は成功し、終了後の削除だけ失敗する（別のタブが接続を開いたまま、など）。
        if (cleanups > 1) throw Object.assign(new Error('blocked by another tab'), { name: 'BlockedError' });
      },
    };
    const adapters = { ...base, opfs } as typeof base;
    render(
      <StorageDiagnosticsSection
        adapters={adapters}
        probeStorage={async () => ({ usageBytes: null, quotaBytes: null, persisted: null })}
        requestPersist={async () => null}
        testMode
      />,
    );
    await user.click(screen.getByTestId('diag-start-all'));
    expect(await screen.findByTestId('diag-skipped')).toHaveTextContent('IndexedDB / Cache API は測りませんでした');
    expect(screen.getByTestId('diag-unreclaimed')).toHaveTextContent('OPFS: 診断用のデータを削除できませんでした（BlockedError: blocked by another tab）');
    expect(screen.getByTestId('diag-cleanup-failed-opfs')).toBeInTheDocument();
    expect(base.indexeddb.calls.open).toBe(0);
    expect(base.cache.calls.open).toBe(0);
    expect(screen.getByTestId('diag-start-indexeddb')).toBeDisabled();
    expect(screen.getByTestId('diag-cleanup')).toBeEnabled();
  });

  it('前回の残りを削除しても usage が減らなければ、書き込みを始めずに再読み込みを求める（比較にも使わない）', async () => {
    const user = userEvent.setup();
    const base = fakes();
    // 前回の残りがあり、削除しても usage が減らない。
    const opfs = { ...base.opfs, hasLeftovers: async () => true };
    const adapters = { ...base, opfs } as typeof base;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<StorageDiagnosticsSection adapters={adapters} probeStorage={async () => STATUS} requestPersist={async () => null} testMode />);
      await user.click(screen.getByTestId('diag-start-opfs'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByTestId('diag-unreclaimed')).toHaveTextContent('Origin Usage にまだ反映されていないため、書き込みを始めませんでした');
      expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('StaleUsageError');
      expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('Failed at: 0 MiB（prepare）');
      expect(base.opfs.calls.open).toBe(0);
      expect(screen.getByTestId('diag-start-cache')).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('使えない方式は「使えません」と表示し、測らない', async () => {
    const user = userEvent.setup();
    const adapters = fakes({ opfs: { available: false } });
    renderSection({ adapters });
    expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('このブラウザでは使えません');
    expect(screen.queryByTestId('diag-start-opfs')).toBeNull();
    await user.click(screen.getByTestId('diag-start-all'));
    await waitFor(() => expect(screen.getByTestId('diag-status-cache')).toHaveTextContent('書き込み成功'));
    expect(adapters.opfs.calls.open).toBe(0);
    expect(adapters.opfs.calls.cleanup).toBe(0);
  });

  it('Persistent Storage の要求は、そのボタンを押したときだけ行う', async () => {
    const user = userEvent.setup();
    const { requestPersist } = renderSection({ adapters: fakes() });
    expect(requestPersist).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('diag-request-persist'));
    expect(requestPersist).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('diag-persist-message')).toHaveTextContent('許可されました');
  });

  it('画面を離れたら中止し、診断用のデータを削除する', async () => {
    const user = userEvent.setup();
    const gate = gated();
    const adapters = fakes({ opfs: { beforeWrite: gate.beforeWrite } });
    const view = renderSection({ adapters });
    await user.click(screen.getByTestId('diag-start-all'));
    await waitFor(() => expect(gate.waiting).toEqual([0]));
    view.unmount();
    gate.next();
    await waitFor(() => expect(adapters.opfs.calls.cleanup).toBe(2));
    expect(adapters.opfs.calls.writes).toBe(1);
    expect(adapters.opfs.storedBytes()).toBe(0);
    // 残りの方式は始めない。
    expect(adapters.indexeddb.calls.open).toBe(0);
    expect(adapters.cache.calls.open).toBe(0);
  });

  it('ページを閉じる（pagehide）と中止する', async () => {
    const user = userEvent.setup();
    const gate = gated();
    const adapters = fakes({ indexeddb: { beforeWrite: gate.beforeWrite } });
    renderSection({ adapters });
    await user.click(screen.getByTestId('diag-start-indexeddb'));
    await waitFor(() => expect(gate.waiting).toEqual([0]));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    act(() => gate.next());
    await waitFor(() => expect(screen.getByTestId('diag-status-indexeddb')).toHaveTextContent('中止しました'));
    expect(adapters.indexeddb.storedBytes()).toBe(0);
  });

  it('Lab が取得・読み込み中（disabled）なら開始できない', async () => {
    renderSection({ adapters: fakes(), disabled: true });
    await settled();
    expect(screen.getByTestId('diag-start-all')).toBeDisabled();
    expect(screen.getByTestId('diag-start-opfs')).toBeDisabled();
  });

  it('実行中かどうかを Lab へ知らせる', async () => {
    const user = userEvent.setup();
    const onRunningChange = vi.fn();
    renderSection({ adapters: fakes(), onRunningChange });
    await user.click(screen.getByTestId('diag-start-opfs'));
    await waitFor(() => expect(screen.getByTestId('diag-status-opfs')).toHaveTextContent('書き込み成功'));
    expect(onRunningChange.mock.calls.map(([value]) => value)).toEqual([false, true, false]);
  });

  it('診断結果を JSON で保存できる', async () => {
    const user = userEvent.setup();
    let saved: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      saved = blob;
      return 'blob:diagnostic';
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderSection({ adapters: fakes({ opfs: { quotaBytes: 2 * MIB } }) });
    expect(screen.getByTestId('diag-export')).toBeDisabled();
    await user.click(screen.getByTestId('diag-start-opfs'));
    await screen.findByText('QuotaExceededError');
    await user.click(screen.getByTestId('diag-export'));

    expect(click).toHaveBeenCalledTimes(1);
    expect(saved).not.toBeNull();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved!);
    });
    const report = JSON.parse(text) as StorageDiagnosticExport;
    expect(report.schema).toBe('01as-browser-storage-diagnostic');
    expect(report.schemaVersion).toBe(1);
    expect(report.storage).toEqual({ usageBytes: STATUS.usageBytes, quotaBytes: STATUS.quotaBytes, persisted: false });
    expect(report.testMode).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      backend: 'opfs',
      targetBytes: 4 * MIB,
      writtenBytes: 2 * MIB,
      lastSuccessfulBytes: 2 * MIB,
      failedAtBytes: 3 * MIB,
      errorName: 'QuotaExceededError',
      originUsageBefore: STATUS.usageBytes,
      originQuotaBefore: STATUS.quotaBytes,
      persisted: false,
    });
  });
});
