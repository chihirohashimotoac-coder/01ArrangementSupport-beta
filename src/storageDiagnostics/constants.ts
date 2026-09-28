/**
 * BROWSER STORAGE DIAGNOSTICS の名前と大きさ（`docs/BROWSER_STORAGE_DIAGNOSTICS.md`）。
 *
 * 診断で作る保存領域は、すべて `01as-beta-storage-diagnostic` の名前を持つ。
 * 作成・書き込み・削除してよいのは**ここに書いた名前だけ**（`architecture.test.ts` で検査する）。
 *
 * - WebLLM の保存領域（`webllm/*`・`tvmjs-opfs-store/`）には触れない
 * - 01AS の利用者データ（localStorage の `01as-beta:*`）には触れない
 * - モデルや外部の通信は使わない。書くのはこの端末で作ったテストデータだけ
 */

/** 診断用の保存領域に共通の名前。 */
export const DIAGNOSTIC_NAMESPACE = '01as-beta-storage-diagnostic';

/** OPFS: root 直下の診断専用ディレクトリ。削除するのはこのディレクトリだけ。 */
export const DIAGNOSTIC_OPFS_DIRECTORY = DIAGNOSTIC_NAMESPACE;
/** OPFS: 診断専用ディレクトリの中の、唯一のファイル。 */
export const DIAGNOSTIC_OPFS_FILE = 'opfs-test.bin';

/** IndexedDB: 診断専用のデータベース。削除するのはこのデータベースだけ。 */
export const DIAGNOSTIC_IDB_NAME = DIAGNOSTIC_NAMESPACE;
export const DIAGNOSTIC_IDB_VERSION = 1;
/** IndexedDB: 診断専用の object store。 */
export const DIAGNOSTIC_IDB_STORE = 'chunks';

/** Cache API: 診断専用の cache。削除するのはこの cache だけ。 */
export const DIAGNOSTIC_CACHE_NAME = DIAGNOSTIC_NAMESPACE;
/** Cache API: 保存の鍵にする URL の path（実際には通信しない。origin の下の、存在しない path）。 */
export const DIAGNOSTIC_CACHE_PATH = `/${DIAGNOSTIC_NAMESPACE}/`;

export const MIB = 1024 ** 2;
export const GIB = 1024 ** 3;

/** 1 回に書く大きさ。この大きさのバッファを 1 つだけ作り、使い回す。 */
export const DIAGNOSTIC_CHUNK_BYTES = 16 * MIB;

export interface DiagnosticSizeOption {
  readonly id: string;
  readonly bytes: number;
  /** 通常の画面では隠し、「Advanced」を開いたときだけ選べる。 */
  readonly advanced: boolean;
}

/** 通常の選択肢。既定は 1 GiB。2 GiB は Advanced。 */
export const DIAGNOSTIC_SIZE_OPTIONS: readonly DiagnosticSizeOption[] = [
  { id: '256MiB', bytes: 256 * MIB, advanced: false },
  { id: '512MiB', bytes: 512 * MIB, advanced: false },
  { id: '1GiB', bytes: GIB, advanced: false },
  { id: '2GiB', bytes: 2 * GIB, advanced: true },
];
export const DEFAULT_DIAGNOSTIC_SIZE_ID = '1GiB';

/**
 * E2E 用の test mode（URL に `?storage-diagnostic-test-mode=1`）。CI のディスクを使わないよう
 * 1〜4 MiB だけを、1 MiB の chunk で書く。
 */
export const DIAGNOSTIC_TEST_MODE_PARAM = 'storage-diagnostic-test-mode';
export const DIAGNOSTIC_TEST_MODE_CHUNK_BYTES = MIB;
export const DIAGNOSTIC_TEST_MODE_SIZE_OPTIONS: readonly DiagnosticSizeOption[] = [
  { id: '1MiB', bytes: MIB, advanced: false },
  { id: '2MiB', bytes: 2 * MIB, advanced: false },
  { id: '4MiB', bytes: 4 * MIB, advanced: false },
];
export const DEFAULT_DIAGNOSTIC_TEST_MODE_SIZE_ID = '4MiB';

/** 測る保存方式（表示順）。 */
export const DIAGNOSTIC_BACKENDS = ['opfs', 'indexeddb', 'cache'] as const;
export type DiagnosticBackend = (typeof DIAGNOSTIC_BACKENDS)[number];

export const DIAGNOSTIC_BACKEND_LABEL: Readonly<Record<DiagnosticBackend, string>> = {
  opfs: 'OPFS',
  indexeddb: 'IndexedDB',
  cache: 'Cache API',
};

/** 大きさの表示（1 GiB・304 MiB・10.30 GiB）。 */
export function formatDiagnosticBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  if (bytes >= GIB) {
    const value = bytes / GIB;
    return Number.isInteger(value) ? `${value} GiB` : `${value.toFixed(2)} GiB`;
  }
  const value = bytes / MIB;
  return Number.isInteger(value) ? `${value} MiB` : `${value.toFixed(1)} MiB`;
}
