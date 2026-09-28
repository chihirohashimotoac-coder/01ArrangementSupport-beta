/**
 * テスト用の偽の保存 API（OPFS・Cache API・IndexedDB）。実際の保存領域には触れない。
 *
 * OPFS はディレクトリの木をそのまま渡す。ファイルは中身（文字列）か大きさ（数値）で表す。
 *
 *   fakeOpfs({ 'tvmjs-opfs-store': { webllm: { model: { 'x.record.json': '{...}', 'x.bin': 1024 } } } })
 */
import type {
  CacheStorageLike,
  DirectoryHandleLike,
  IndexedDbLike,
  StorageEnvironment,
  StorageManagerLike,
} from '../modelStorage';

export interface FakeDirectory {
  readonly [name: string]: FakeDirectory | string | number;
}

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function directoryHandle(tree: FakeDirectory, log: string[], path: string): DirectoryHandleLike {
  return {
    async getDirectoryHandle(name: string, ...rest: unknown[]) {
      if (rest.length > 0) log.push(`options:${path}/${name}`);
      const entry = tree[name];
      if (entry === undefined) throw domError('NotFoundError');
      if (typeof entry !== 'object') throw domError('TypeMismatchError');
      return directoryHandle(entry, log, `${path}/${name}`);
    },
    async getFileHandle(name: string, ...rest: unknown[]) {
      if (rest.length > 0) log.push(`options:${path}/${name}`);
      const entry = tree[name];
      if (entry === undefined) throw domError('NotFoundError');
      if (typeof entry === 'object') throw domError('TypeMismatchError');
      return {
        async getFile() {
          return {
            size: typeof entry === 'number' ? entry : new TextEncoder().encode(entry).byteLength,
            text: async () => (typeof entry === 'string' ? entry : ''),
          };
        },
      };
    },
    async *keys() {
      for (const name of Object.keys(tree)) yield name;
    },
  };
}

export interface FakeStorageOptions {
  /** OPFS の中身。undefined なら OPFS の API が無いブラウザ。 */
  readonly opfs?: FakeDirectory;
  /** Cache API の中身（cache 名 → URL → headers）。undefined なら API が無い。 */
  readonly caches?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
  /** IndexedDB のデータベース名。undefined なら API が無い。null なら `databases()` が無い。 */
  readonly indexedDbNames?: readonly string[] | null;
  readonly usage?: number;
  readonly quota?: number;
  readonly persisted?: boolean;
  readonly persistResult?: boolean;
}

export interface FakeStorage extends StorageEnvironment {
  /** 保存領域を作ろうとした（options 付きの呼び出し）・persist の要求などの記録。 */
  readonly log: string[];
}

export function fakeStorage(options: FakeStorageOptions = {}): FakeStorage {
  const log: string[] = [];
  const storageManager: StorageManagerLike = {
    ...(options.opfs ? { getDirectory: async () => directoryHandle(options.opfs!, log, '') } : {}),
    estimate: async () => ({ usage: options.usage, quota: options.quota }),
    persisted: async () => options.persisted ?? false,
    persist: async () => {
      log.push('persist');
      return options.persistResult ?? false;
    },
  };
  const cacheStorage: CacheStorageLike | null = options.caches
    ? {
        has: async (name) => name in options.caches!,
        open: async (name) => {
          const entries = options.caches![name] ?? {};
          return {
            keys: async () => Object.keys(entries).map((url) => ({ url })),
            match: async (request) => {
              const headers = entries[request.url];
              return headers ? { headers: { get: (key: string) => headers[key.toLowerCase()] ?? null } } : undefined;
            },
          };
        },
      }
    : null;
  const indexedDb: IndexedDbLike | null =
    options.indexedDbNames === undefined
      ? null
      : options.indexedDbNames === null
        ? {}
        : { databases: async () => options.indexedDbNames!.map((name) => ({ name })) };
  return { storageManager, cacheStorage, indexedDb, log };
}
