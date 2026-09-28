/**
 * 保存方式ごとの Adapter を、偽の OPFS / IndexedDB / Cache Storage で確かめる。
 *
 * 偽の保存領域には、あらかじめ WebLLM のモデル（`tvmjs-opfs-store/`・`webllm/*`）と
 * アプリのオフライン用キャッシュを置いておき、診断（成功・QuotaExceeded・中止・後片付け）のあとも
 * **それらが 1 byte も変わらない**こと、診断用の名前の保存領域だけが作られ・消えることを確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IDB_DELETE_BLOCKED_TIMEOUT_MS,
  createCacheAdapter,
  createIndexedDbAdapter,
  createOpfsAdapter,
  diagnosticCacheUrl,
  probeOriginStorage,
  type CacheStorageLike,
  type DiagnosticEnvironment,
  type IdbDatabaseLike,
  type IdbFactoryLike,
  type IdbOpenRequestLike,
  type IdbTransactionLike,
  type OpfsDirectoryLike,
  type OpfsFileHandleLike,
} from './browserAdapters';
import {
  DIAGNOSTIC_CACHE_NAME,
  DIAGNOSTIC_IDB_NAME,
  DIAGNOSTIC_IDB_STORE,
  DIAGNOSTIC_OPFS_DIRECTORY,
  DIAGNOSTIC_OPFS_FILE,
} from './constants';
import { runStorageDiagnostic } from './runner';

const KIB = 1024;

function domError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** 偽の端末全体の容量。どの方式の書き込みもここから引く。 */
class FakeDisk {
  used = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  take(bytes: number): void {
    if (this.used + bytes > this.limit) throw domError('QuotaExceededError', 'Quota exceeded.');
    this.used += bytes;
  }
  release(bytes: number): void {
    this.used -= bytes;
  }
}

// ---------------------------------------------------------------------------
// 偽の OPFS
// ---------------------------------------------------------------------------

class FakeFile implements OpfsFileHandleLike {
  size = 0;
  openWritables = 0;
  private readonly disk: FakeDisk;
  constructor(disk: FakeDisk) {
    this.disk = disk;
  }
  async createWritable() {
    this.openWritables += 1;
    let pending = 0;
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.openWritables -= 1;
      if (commit) {
        this.disk.release(this.size);
        this.size = pending;
      } else {
        this.disk.release(pending);
      }
    };
    return {
      write: async (data: Uint8Array) => {
        // 一時ファイル（swap）へ書く分も容量として数える（Chrome と同じく close まで確定しない）。
        this.disk.take(data.byteLength);
        pending += data.byteLength;
      },
      close: async () => finish(true),
      abort: async () => finish(false),
    };
  }
}

class FakeDirectory implements OpfsDirectoryLike {
  readonly directories = new Map<string, FakeDirectory>();
  readonly files = new Map<string, FakeFile>();
  readonly removed: string[] = [];
  removeError: Error | null = null;
  private readonly disk: FakeDisk;
  constructor(disk: FakeDisk) {
    this.disk = disk;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!options?.create) throw domError('NotFoundError');
      directory = new FakeDirectory(this.disk);
      this.directories.set(name, directory);
    }
    return directory;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file) {
      if (!options?.create) throw domError('NotFoundError');
      file = new FakeFile(this.disk);
      this.files.set(name, file);
    }
    return file;
  }
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    if (this.removeError) throw this.removeError;
    const directory = this.directories.get(name);
    if (directory) {
      if (!options?.recursive && (directory.directories.size > 0 || directory.files.size > 0)) throw domError('InvalidModificationError');
      if ([...directory.files.values()].some((file) => file.openWritables > 0)) throw domError('NoModificationAllowedError');
      this.disk.release(directory.totalBytes());
      this.directories.delete(name);
    } else if (this.files.has(name)) {
      this.disk.release(this.files.get(name)!.size);
      this.files.delete(name);
    } else {
      throw domError('NotFoundError');
    }
    this.removed.push(name);
  }
  totalBytes(): number {
    let total = 0;
    for (const file of this.files.values()) total += file.size;
    for (const directory of this.directories.values()) total += directory.totalBytes();
    return total;
  }
  /** 中身の一覧（パス → 大きさ）。 */
  snapshot(prefix = ''): Record<string, number> {
    const entries: Record<string, number> = {};
    for (const [name, file] of this.files) entries[`${prefix}${name}`] = file.size;
    for (const [name, directory] of this.directories) {
      entries[`${prefix}${name}/`] = -1;
      Object.assign(entries, directory.snapshot(`${prefix}${name}/`));
    }
    return entries;
  }
}

async function seedOpfs(root: FakeDirectory): Promise<void> {
  const store = await root.getDirectoryHandle('tvmjs-opfs-store', { create: true });
  const model = await (await store.getDirectoryHandle('webllm', { create: true })).getDirectoryHandle('model', { create: true });
  const file = await model.getFileHandle('abc.bin', { create: true });
  const writable = await file.createWritable();
  await writable.write(new Uint8Array(8 * KIB));
  await writable.close();
  await root.getFileHandle('unrelated.txt', { create: true });
}

// ---------------------------------------------------------------------------
// 偽の IndexedDB
// ---------------------------------------------------------------------------

type Handler = ((event: unknown) => void) | null;

function later(callback: () => void): void {
  setTimeout(callback, 0);
}

class FakeIdbDatabase implements IdbDatabaseLike {
  onversionchange: Handler = null;
  closed = false;
  private readonly factory: FakeIdbFactory;
  readonly name: string;
  constructor(factory: FakeIdbFactory, name: string) {
    this.factory = factory;
    this.name = name;
  }
  get objectStoreNames() {
    const stores = this.factory.data.get(this.name)!;
    return { contains: (store: string) => stores.has(store) };
  }
  createObjectStore(store: string) {
    this.factory.data.get(this.name)!.set(store, new Map());
    return {};
  }
  transaction(store: string, mode: 'readwrite'): IdbTransactionLike {
    void mode;
    const records = this.factory.data.get(this.name)!.get(store);
    if (!records) throw domError('NotFoundError');
    const tx: IdbTransactionLike = {
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore: () => ({
        put: (value: unknown, key: number) => {
          later(() => {
            const bytes = (value as ArrayBuffer).byteLength;
            try {
              this.factory.disk.take(bytes);
            } catch (error) {
              tx.error = error as DOMException;
              tx.onabort?.({});
              return;
            }
            records.set(key, bytes);
            tx.oncomplete?.({});
          });
        },
      }),
    };
    return tx;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.factory.connectionClosed();
  }
}

class FakeIdbFactory implements IdbFactoryLike {
  /** データベース名 → object store 名 → key → 大きさ。 */
  readonly data = new Map<string, Map<string, Map<number, number>>>();
  readonly deleted: string[] = [];
  readonly connections: FakeIdbDatabase[] = [];
  private pendingDelete: (() => void) | null = null;
  readonly disk: FakeDisk;
  constructor(disk: FakeDisk) {
    this.disk = disk;
  }

  private request(): IdbOpenRequestLike {
    return { result: undefined as unknown as IdbDatabaseLike, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  }

  open(name: string, version: number): IdbOpenRequestLike {
    void version;
    const request = this.request();
    later(() => {
      const db = new FakeIdbDatabase(this, name);
      this.connections.push(db);
      request.result = db;
      if (!this.data.has(name)) {
        this.data.set(name, new Map());
        request.onupgradeneeded?.({});
      }
      request.onsuccess?.({});
    });
    return request;
  }

  deleteDatabase(name: string): IdbOpenRequestLike {
    const request = this.request();
    later(() => {
      const remove = () => {
        const stores = this.data.get(name);
        if (stores) for (const records of stores.values()) for (const bytes of records.values()) this.disk.release(bytes);
        this.data.delete(name);
        this.deleted.push(name);
        request.onsuccess?.({});
      };
      const open = () => this.connections.filter((db) => db.name === name && !db.closed);
      for (const db of open()) db.onversionchange?.({});
      if (open().length === 0) return remove();
      this.pendingDelete = () => {
        if (open().length === 0) {
          this.pendingDelete = null;
          remove();
        }
      };
      request.onblocked?.({});
    });
    return request;
  }

  connectionClosed() {
    this.pendingDelete?.();
  }

  async databases() {
    return [...this.data.keys()].map((name) => ({ name }));
  }

  snapshot(): Record<string, number> {
    const entries: Record<string, number> = {};
    for (const [db, stores] of this.data) {
      for (const [store, records] of stores) for (const [key, bytes] of records) entries[`${db}/${store}/${key}`] = bytes;
    }
    return entries;
  }
}

function seedIdb(factory: FakeIdbFactory): void {
  factory.data.set('webllm/model', new Map([['urls', new Map([[1, 4 * KIB]])]]));
  factory.disk.take(4 * KIB);
}

// ---------------------------------------------------------------------------
// 偽の Cache Storage
// ---------------------------------------------------------------------------

class FakeCacheStorage implements CacheStorageLike {
  readonly caches = new Map<string, Map<string, number>>();
  readonly deleted: string[] = [];
  deleteError: Error | null = null;
  private readonly disk: FakeDisk;
  constructor(disk: FakeDisk) {
    this.disk = disk;
  }
  async open(name: string) {
    let entries = this.caches.get(name);
    if (!entries) {
      entries = new Map();
      this.caches.set(name, entries);
    }
    const target = entries;
    return {
      put: async (url: string, response: Response) => {
        const bytes = (await response.arrayBuffer()).byteLength;
        this.disk.take(bytes);
        target.set(url, bytes);
      },
    };
  }
  async has(name: string) {
    return this.caches.has(name);
  }
  async delete(name: string) {
    if (this.deleteError) throw this.deleteError;
    const entries = this.caches.get(name);
    if (!entries) return false;
    for (const bytes of entries.values()) this.disk.release(bytes);
    this.caches.delete(name);
    this.deleted.push(name);
    return true;
  }
  snapshot(): Record<string, number> {
    const entries: Record<string, number> = {};
    for (const [name, cache] of this.caches) for (const [url, bytes] of cache) entries[`${name} ${url}`] = bytes;
    return entries;
  }
}

async function seedCaches(storage: FakeCacheStorage): Promise<void> {
  await (await storage.open('webllm/model')).put('https://example.test/model/params_shard_0.bin', new Response(new Uint8Array(2 * KIB)));
  await (await storage.open('webllm/config')).put('https://example.test/model/mlc-chat-config.json', new Response('{}'));
  await (await storage.open('01as-beta-precache-v2')).put('http://localhost/index.html', new Response('<html>'));
}

// ---------------------------------------------------------------------------

function environment(limit: number) {
  const disk = new FakeDisk(limit);
  const root = new FakeDirectory(disk);
  const idb = new FakeIdbFactory(disk);
  const cacheStorage = new FakeCacheStorage(disk);
  const env: DiagnosticEnvironment = {
    storageManager: {
      getDirectory: async () => root,
      estimate: async () => ({ usage: disk.used, quota: disk.limit }),
      persisted: async () => false,
    },
    indexedDb: idb,
    cacheStorage,
    origin: 'http://localhost',
  };
  return { disk, root, idb, cacheStorage, env };
}

async function seeded(limit: number) {
  const fake = environment(limit);
  await seedOpfs(fake.root);
  seedIdb(fake.idb);
  await seedCaches(fake.cacheStorage);
  const foreign = () => ({
    opfs: fake.root.snapshot(),
    idb: fake.idb.snapshot(),
    caches: fake.cacheStorage.snapshot(),
  });
  return { ...fake, foreign, before: foreign(), usageBefore: fake.disk.used };
}

const ADAPTERS = {
  opfs: createOpfsAdapter,
  indexeddb: createIndexedDbAdapter,
  cache: createCacheAdapter,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe.each(Object.keys(ADAPTERS) as (keyof typeof ADAPTERS)[])('%s adapter', (backend) => {
  it('success: 診断用の保存領域だけへ書き、終わったら診断用の保存領域だけを削除する（ほかは 1 byte も変えない）', async () => {
    const fake = await seeded(1024 * KIB);
    const adapter = ADAPTERS[backend](fake.env);
    expect(adapter.isAvailable()).toBe(true);
    const seen: Record<string, number>[] = [];
    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 40 * KIB,
      chunkBytes: 16 * KIB,
      probeStorage: () => probeOriginStorage(fake.env),
      onProgress: () => seen.push({ used: fake.disk.used }),
    });

    expect(result.status).toBe('success');
    expect(result.writtenBytes).toBe(40 * KIB);
    expect(result.cleanup.status).toBe('ok');
    expect(result.originUsageBefore).toBe(fake.usageBefore);
    expect(result.originUsageAfter).toBe(fake.usageBefore + 40 * KIB);
    expect(result.originUsageAfterCleanup).toBe(fake.usageBefore);
    expect(seen.length).toBe(3);
    // WebLLM のモデル・アプリのキャッシュ・ほかの OPFS のファイルはそのまま。
    expect(fake.foreign()).toEqual(fake.before);
    expect(await adapter.hasLeftovers()).toBe(false);
    // 削除したのは診断用の名前だけ。
    expect(fake.root.removed.every((name) => name === DIAGNOSTIC_OPFS_DIRECTORY)).toBe(true);
    expect(fake.idb.deleted.every((name) => name === DIAGNOSTIC_IDB_NAME)).toBe(true);
    expect(fake.cacheStorage.deleted.every((name) => name === DIAGNOSTIC_CACHE_NAME)).toBe(true);
  });

  it('QuotaExceeded: 失敗の位置を残し、診断用のデータを削除して容量を戻す（ほかは変えない）', async () => {
    const fake = await seeded(64 * KIB);
    const free = fake.disk.limit - fake.disk.used;
    const result = await runStorageDiagnostic({
      adapter: ADAPTERS[backend](fake.env),
      targetBytes: 256 * KIB,
      chunkBytes: 16 * KIB,
      probeStorage: () => probeOriginStorage(fake.env),
    });
    const lastSuccessful = Math.floor(free / (16 * KIB)) * 16 * KIB;
    expect(result.status).toBe('failed');
    expect(result.failedPhase).toBe('write');
    expect(result.errorName).toBe('QuotaExceededError');
    expect(result.lastSuccessfulBytes).toBe(lastSuccessful);
    expect(result.failedAtBytes).toBe(lastSuccessful + 16 * KIB);
    expect(result.cleanup.status).toBe('ok');
    expect(fake.disk.used).toBe(fake.usageBefore);
    expect(fake.foreign()).toEqual(fake.before);
  });

  it('abort: 途中で止めても、診断用のデータを削除する', async () => {
    const fake = await seeded(1024 * KIB);
    const controller = new AbortController();
    const result = await runStorageDiagnostic({
      adapter: ADAPTERS[backend](fake.env),
      targetBytes: 256 * KIB,
      chunkBytes: 16 * KIB,
      probeStorage: () => probeOriginStorage(fake.env),
      signal: controller.signal,
      onProgress: (value) => {
        if (value.writtenBytes >= 32 * KIB) controller.abort();
      },
    });
    expect(result.status).toBe('aborted');
    expect(result.writtenBytes).toBe(32 * KIB);
    expect(result.cleanup.status).toBe('ok');
    expect(fake.disk.used).toBe(fake.usageBefore);
    expect(fake.foreign()).toEqual(fake.before);
  });

  it('前回のテストの残りを検出し、次のテストの前に消す', async () => {
    const fake = await seeded(1024 * KIB);
    const adapter = ADAPTERS[backend](fake.env);
    // 残り（途中でページを閉じた想定）を作る。
    const writer = await adapter.open();
    await writer.write(new Uint8Array(16 * KIB), 0);
    await writer.finish();
    expect(await adapter.hasLeftovers()).toBe(true);

    const result = await runStorageDiagnostic({
      adapter,
      targetBytes: 16 * KIB,
      chunkBytes: 16 * KIB,
      probeStorage: () => probeOriginStorage(fake.env),
    });
    expect(result.status).toBe('success');
    // 残りを消してから測るので、usage は前回の残りの分だけ減ってから 16 KiB 増える。
    expect(result.originUsageAfter).toBe(fake.usageBefore + 16 * KIB);
    expect(await adapter.hasLeftovers()).toBe(false);
    expect(fake.foreign()).toEqual(fake.before);
  });
});

describe('保存方式ごとの書き込み先', () => {
  it('OPFS: 診断専用ディレクトリの opfs-test.bin だけへ書く', async () => {
    const fake = await seeded(1024 * KIB);
    const writer = await createOpfsAdapter(fake.env).open();
    await writer.write(new Uint8Array(16 * KIB), 0);
    await writer.finish();
    const diagnostic = fake.root.directories.get(DIAGNOSTIC_OPFS_DIRECTORY)!;
    expect([...diagnostic.files.keys()]).toEqual([DIAGNOSTIC_OPFS_FILE]);
    expect(diagnostic.files.get(DIAGNOSTIC_OPFS_FILE)!.size).toBe(16 * KIB);
  });

  it('IndexedDB: 診断専用データベースの chunks だけへ、chunk の長さの ArrayBuffer を書く', async () => {
    const fake = await seeded(1024 * KIB);
    const writer = await createIndexedDbAdapter(fake.env).open();
    const shared = new Uint8Array(16 * KIB);
    await writer.write(shared, 0);
    await writer.write(shared.subarray(0, 4 * KIB), 1);
    await writer.finish();
    expect([...fake.idb.data.get(DIAGNOSTIC_IDB_NAME)!.keys()]).toEqual([DIAGNOSTIC_IDB_STORE]);
    expect([...fake.idb.data.get(DIAGNOSTIC_IDB_NAME)!.get(DIAGNOSTIC_IDB_STORE)!.entries()]).toEqual([
      [0, 16 * KIB],
      [1, 4 * KIB],
    ]);
  });

  it('Cache API: 診断専用 cache の、存在しない path の URL だけへ書く（通信しない）', async () => {
    const fake = await seeded(1024 * KIB);
    const writer = await createCacheAdapter(fake.env).open();
    await writer.write(new Uint8Array(16 * KIB), 0);
    expect([...fake.cacheStorage.caches.get(DIAGNOSTIC_CACHE_NAME)!.keys()]).toEqual([diagnosticCacheUrl('http://localhost', 0)]);
    expect(diagnosticCacheUrl('http://localhost', 12)).toBe('http://localhost/01as-beta-storage-diagnostic/chunk-000012.bin');
  });
});

describe('cleanup failure（黙って成功にしない）', () => {
  it('OPFS の削除が失敗したら、その error を結果に残す', async () => {
    const fake = await seeded(1024 * KIB);
    const adapter = createOpfsAdapter(fake.env);
    const ok = await runStorageDiagnostic({ adapter, targetBytes: 16 * KIB, chunkBytes: 16 * KIB, probeStorage: async () => ({ usageBytes: null, quotaBytes: null, persisted: null }) });
    expect(ok.cleanup.status).toBe('ok');
    // 残りを作ってから、削除を失敗させる。
    const writer = await adapter.open();
    await writer.write(new Uint8Array(KIB), 0);
    await writer.finish();
    fake.root.removeError = domError('NoModificationAllowedError', 'locked');
    await expect(adapter.cleanup()).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    // 消せなかった診断用のデータは残る（だから失敗として表示する）。ほかのデータは変わらない。
    const { opfs, ...rest } = fake.foreign();
    expect(Object.keys(opfs).filter((path) => path.startsWith(DIAGNOSTIC_OPFS_DIRECTORY))).toHaveLength(2);
    expect(Object.fromEntries(Object.entries(opfs).filter(([path]) => !path.startsWith(DIAGNOSTIC_OPFS_DIRECTORY)))).toEqual(fake.before.opfs);
    expect(rest).toEqual({ idb: fake.before.idb, caches: fake.before.caches });
  });

  it('Cache API の削除が失敗したら throw する', async () => {
    const fake = await seeded(1024 * KIB);
    fake.cacheStorage.deleteError = domError('UnknownError', 'cache backend failure');
    await expect(createCacheAdapter(fake.env).cleanup()).rejects.toMatchObject({ name: 'UnknownError' });
  });

  it('IndexedDB: 別のタブが接続を開いたままなら、待ったうえで BlockedError として失敗させる', async () => {
    vi.useFakeTimers();
    const fake = await (async () => {
      const value = environment(1024 * KIB);
      seedIdb(value.idb);
      return value;
    })();
    // 別のタブの接続（versionchange で閉じない）。
    const other = fake.idb.open(DIAGNOSTIC_IDB_NAME, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(other.result).toBeDefined();

    const cleanup = createIndexedDbAdapter(fake.env).cleanup();
    const outcome = cleanup.then(
      () => 'resolved',
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(IDB_DELETE_BLOCKED_TIMEOUT_MS + 10);
    expect(await outcome).toBe('BlockedError');
    // ほかのデータベースは消していない。
    expect(fake.idb.data.has('webllm/model')).toBe(true);
  });

  it('API が無い方式は使えないと判定し、後片付けは何もしない', async () => {
    const env: DiagnosticEnvironment = { storageManager: null, indexedDb: null, cacheStorage: null, origin: 'http://localhost' };
    for (const create of Object.values(ADAPTERS)) {
      const adapter = create(env);
      expect(adapter.isAvailable()).toBe(false);
      await expect(adapter.cleanup()).resolves.toBeUndefined();
      expect(await adapter.hasLeftovers()).toBe(false);
      await expect(adapter.open()).rejects.toMatchObject({ name: 'NotSupportedError' });
    }
  });
});
