/**
 * 保存方式ごとの Adapter（OPFS / IndexedDB / Cache API）。
 *
 * どれも**診断用の名前（`constants.ts`）の保存領域だけ**を作成・書き込み・削除する。
 * OPFS root・ほかのデータベース・ほかの cache（WebLLM のモデル・アプリのオフライン用キャッシュ）を
 * 列挙して消すことはしない（`architecture.test.ts` が呼び出しの引数まで検査する）。
 *
 * 書き込みの方法は、WebLLM 0.2.85 がモデルを保存するときの方法に近づけてある（比較のため）。
 *
 * - OPFS: `createWritable()` の stream へ chunk を順に `write()` し、最後に `close()` で確定する
 *   （WebLLM が画面のスレッドで動くときの async 経路と同じ API。sync access handle は worker 専用なので使わない）
 * - IndexedDB: chunk ごとに readwrite transaction を 1 つ作り、ArrayBuffer を `put()` して complete を待つ
 * - Cache API: chunk ごとに `Response` を作り、`cache.put()` で保存する（通信はしない）
 */
import {
  DIAGNOSTIC_CACHE_NAME,
  DIAGNOSTIC_CACHE_PATH,
  DIAGNOSTIC_IDB_NAME,
  DIAGNOSTIC_IDB_STORE,
  DIAGNOSTIC_IDB_VERSION,
  DIAGNOSTIC_OPFS_DIRECTORY,
  DIAGNOSTIC_OPFS_FILE,
  type DiagnosticBackend,
} from './constants';
import { errorNameOf } from './runner';
import type { DiagnosticStorageAdapter, DiagnosticWriter, OriginStorageStatus } from './types';

// ---------------------------------------------------------------------------
// 使うブラウザ API の型（使う部分だけ。テストでは偽物を渡す）
// ---------------------------------------------------------------------------

export interface OpfsWritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface OpfsFileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableLike>;
}

export interface OpfsDirectoryLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface IdbRequestLike<T> {
  result: T;
  error: DOMException | null;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((event: unknown) => void) | null;
  onblocked: ((event: unknown) => void) | null;
}

export interface IdbTransactionLike {
  error: DOMException | null;
  oncomplete: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  objectStore(name: string): { put(value: unknown, key: number): unknown };
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  onversionchange: ((event: unknown) => void) | null;
  createObjectStore(name: string): unknown;
  transaction(storeName: string, mode: 'readwrite'): IdbTransactionLike;
  close(): void;
}

export interface IdbFactoryLike {
  open(name: string, version: number): IdbOpenRequestLike;
  deleteDatabase(name: string): IdbOpenRequestLike;
  databases?(): Promise<readonly { readonly name?: string }[]>;
}

export interface CacheLike {
  put(request: string, response: Response): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<boolean>;
}

export interface StorageManagerLike {
  getDirectory?(): Promise<OpfsDirectoryLike>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

export interface DiagnosticEnvironment {
  readonly storageManager: StorageManagerLike | null;
  readonly indexedDb: IdbFactoryLike | null;
  readonly cacheStorage: CacheStorageLike | null;
  /** Cache API の鍵にする URL の origin（`location.origin`）。 */
  readonly origin: string;
  /** Cache API へ保存する応答を作る。既定は `new Response()`。 */
  readonly createResponse?: (body: Uint8Array) => Response;
}

export function browserDiagnosticEnvironment(): DiagnosticEnvironment {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { storage?: StorageManagerLike });
  return {
    storageManager: nav?.storage ?? null,
    indexedDb: typeof indexedDB === 'undefined' ? null : (indexedDB as unknown as IdbFactoryLike),
    cacheStorage: typeof caches === 'undefined' ? null : (caches as unknown as CacheStorageLike),
    origin: typeof location === 'undefined' ? 'http://localhost' : location.origin,
  };
}

function isNotFound(error: unknown): boolean {
  const name = errorNameOf(error);
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// ---------------------------------------------------------------------------
// OPFS
// ---------------------------------------------------------------------------

export function createOpfsAdapter(env: DiagnosticEnvironment): DiagnosticStorageAdapter {
  const root = async (): Promise<OpfsDirectoryLike> => {
    const storage = env.storageManager;
    if (typeof storage?.getDirectory !== 'function') throw namedError('NotSupportedError', 'OPFS（navigator.storage.getDirectory）を使えません');
    return storage.getDirectory();
  };
  return {
    backend: 'opfs',
    writeMethod: `OPFS ${DIAGNOSTIC_OPFS_DIRECTORY}/${DIAGNOSTIC_OPFS_FILE}: createWritable() → write(chunk) × n → close()`,
    isAvailable: () => typeof env.storageManager?.getDirectory === 'function',
    async open(): Promise<DiagnosticWriter> {
      const directory = await (await root()).getDirectoryHandle(DIAGNOSTIC_OPFS_DIRECTORY, { create: true });
      const file = await directory.getFileHandle(DIAGNOSTIC_OPFS_FILE, { create: true });
      const writable = await file.createWritable({ keepExistingData: false });
      return {
        write: (chunk) => writable.write(chunk),
        finish: () => writable.close(),
        dispose: () => writable.abort().catch(() => {}),
      };
    },
    async cleanup(): Promise<void> {
      if (typeof env.storageManager?.getDirectory !== 'function') return;
      try {
        // 診断専用のディレクトリ（中身は opfs-test.bin と、書き込み中の一時ファイルだけ）を消す。OPFS root は消さない。
        await (await root()).removeEntry(DIAGNOSTIC_OPFS_DIRECTORY, { recursive: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    },
    async hasLeftovers(): Promise<boolean | null> {
      if (typeof env.storageManager?.getDirectory !== 'function') return false;
      try {
        await (await root()).getDirectoryHandle(DIAGNOSTIC_OPFS_DIRECTORY);
        return true;
      } catch (error) {
        return isNotFound(error) ? false : null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

/** 別のタブが診断用のデータベースを開いたままのとき、削除を待つ時間。 */
export const IDB_DELETE_BLOCKED_TIMEOUT_MS = 10_000;

function openDiagnosticDatabase(idb: IdbFactoryLike): Promise<IdbDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = idb.open(DIAGNOSTIC_IDB_NAME, DIAGNOSTIC_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DIAGNOSTIC_IDB_STORE)) db.createObjectStore(DIAGNOSTIC_IDB_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 削除（deleteDatabase）を自分の接続で止めないよう、要求が来たら閉じる。
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? namedError('UnknownError', 'IndexedDB を開けませんでした'));
    request.onblocked = () => reject(namedError('BlockedError', 'IndexedDB を開けませんでした（別の接続が開いたままです）'));
  });
}

/** ArrayBuffer ごと保存されるので、部分（subarray）は必要な長さだけ複製する。 */
function bufferOf(chunk: Uint8Array): ArrayBuffer {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.buffer instanceof ArrayBuffer) return chunk.buffer;
  return chunk.slice().buffer;
}

function putChunk(db: IdbDatabaseLike, chunk: Uint8Array, index: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IdbTransactionLike;
    try {
      tx = db.transaction(DIAGNOSTIC_IDB_STORE, 'readwrite');
      tx.objectStore(DIAGNOSTIC_IDB_STORE).put(bufferOf(chunk), index);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    // 容量制限（QuotaExceededError）は transaction の abort として届く。
    tx.onabort = () => reject(tx.error ?? namedError('AbortError', 'IndexedDB の transaction が中断されました'));
  });
}

export function createIndexedDbAdapter(env: DiagnosticEnvironment): DiagnosticStorageAdapter {
  return {
    backend: 'indexeddb',
    writeMethod: `IndexedDB ${DIAGNOSTIC_IDB_NAME} / ${DIAGNOSTIC_IDB_STORE}: 1 chunk = 1 readwrite transaction（put(ArrayBuffer) → complete）`,
    isAvailable: () => env.indexedDb !== null,
    async open(): Promise<DiagnosticWriter> {
      const idb = env.indexedDb;
      if (idb === null) throw namedError('NotSupportedError', 'IndexedDB を使えません');
      const db = await openDiagnosticDatabase(idb);
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        db.close();
      };
      return {
        write: (chunk, index) => putChunk(db, chunk, index),
        // chunk ごとに transaction が確定している。接続を閉じて、このあとの削除を止めないようにする。
        finish: close,
        dispose: close,
      };
    },
    cleanup(): Promise<void> {
      const idb = env.indexedDb;
      if (idb === null) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const request = idb.deleteDatabase(DIAGNOSTIC_IDB_NAME);
        request.onsuccess = () => {
          clearTimeout(timer);
          resolve();
        };
        request.onerror = () => {
          clearTimeout(timer);
          reject(request.error ?? namedError('UnknownError', '診断用の IndexedDB を削除できませんでした'));
        };
        request.onblocked = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () =>
              reject(
                namedError(
                  'BlockedError',
                  `診断用の IndexedDB（${DIAGNOSTIC_IDB_NAME}）を、別のタブの接続が開いたままのため削除できませんでした。そのタブを閉じると削除されます`,
                ),
              ),
            IDB_DELETE_BLOCKED_TIMEOUT_MS,
          );
        };
      });
    },
    async hasLeftovers(): Promise<boolean | null> {
      const idb = env.indexedDb;
      if (idb === null) return false;
      if (typeof idb.databases !== 'function') return null;
      try {
        return (await idb.databases()).some((item) => item.name === DIAGNOSTIC_IDB_NAME);
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Cache API
// ---------------------------------------------------------------------------

export function diagnosticCacheUrl(origin: string, index: number): string {
  return `${origin}${DIAGNOSTIC_CACHE_PATH}chunk-${String(index).padStart(6, '0')}.bin`;
}

export function createCacheAdapter(env: DiagnosticEnvironment): DiagnosticStorageAdapter {
  const createResponse =
    env.createResponse ?? ((body: Uint8Array) => new Response(body as BodyInit, { headers: { 'content-type': 'application/octet-stream' } }));
  return {
    backend: 'cache',
    writeMethod: `Cache API ${DIAGNOSTIC_CACHE_NAME}: 1 chunk = 1 entry（cache.put(url, new Response(chunk))。通信しない）`,
    isAvailable: () => env.cacheStorage !== null,
    async open(): Promise<DiagnosticWriter> {
      const cacheStorage = env.cacheStorage;
      if (cacheStorage === null) throw namedError('NotSupportedError', 'Cache API を使えません');
      const cache = await cacheStorage.open(DIAGNOSTIC_CACHE_NAME);
      return {
        write: (chunk, index) => cache.put(diagnosticCacheUrl(env.origin, index), createResponse(chunk)),
        finish: async () => {},
        dispose: async () => {},
      };
    },
    async cleanup(): Promise<void> {
      const cacheStorage = env.cacheStorage;
      if (cacheStorage === null) return;
      // 診断専用の cache だけを消す（ほかの cache を列挙して消さない）。
      await cacheStorage.delete(DIAGNOSTIC_CACHE_NAME);
    },
    async hasLeftovers(): Promise<boolean | null> {
      const cacheStorage = env.cacheStorage;
      if (cacheStorage === null) return false;
      try {
        return await cacheStorage.has(DIAGNOSTIC_CACHE_NAME);
      } catch {
        return null;
      }
    },
  };
}

export type DiagnosticAdapters = Readonly<Record<DiagnosticBackend, DiagnosticStorageAdapter>>;

export function createBrowserAdapters(env: DiagnosticEnvironment = browserDiagnosticEnvironment()): DiagnosticAdapters {
  return {
    opfs: createOpfsAdapter(env),
    indexeddb: createIndexedDbAdapter(env),
    cache: createCacheAdapter(env),
  };
}

// ---------------------------------------------------------------------------
// origin 全体の状態・永続化
// ---------------------------------------------------------------------------

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `navigator.storage.estimate()` と `persisted()`。例外を投げない。 */
export async function probeOriginStorage(env: DiagnosticEnvironment = browserDiagnosticEnvironment()): Promise<OriginStorageStatus> {
  const storage = env.storageManager;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  let persisted: boolean | null = null;
  try {
    const estimate = await storage?.estimate?.();
    usageBytes = finiteOrNull(estimate?.usage);
    quotaBytes = finiteOrNull(estimate?.quota);
  } catch {
    // 不明のまま
  }
  try {
    const value = await storage?.persisted?.();
    persisted = typeof value === 'boolean' ? value : null;
  } catch {
    persisted = null;
  }
  return { usageBytes, quotaBytes, persisted };
}

/** `navigator.storage.persist()`。利用者の操作でだけ呼ぶ（書き込みのテストとは混ぜない）。例外を投げない。 */
export async function requestOriginPersistence(env: DiagnosticEnvironment = browserDiagnosticEnvironment()): Promise<boolean | null> {
  try {
    const value = await env.storageManager?.persist?.();
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}
