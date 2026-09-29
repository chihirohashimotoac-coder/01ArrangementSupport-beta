/**
 * AI MODEL LAB のモデル保存方式（Storage Backend）。
 *
 * WebLLM 0.2.85 は保存方式を `appConfig.cacheBackend` で選ぶ。`prebuiltAppConfig` の既定は
 * `"cache"`（Cache API）で、大きなモデルの保存で `QuotaExceededError` になる事例がある
 * （`docs/AI_MODEL_STORAGE.md`）。Lab では次の方針で保存方式を決める。
 *
 * - 既定は **OPFS**（`cacheBackend: 'opfs'`・`opfsAccessMode: 'auto'`）
 * - OPFS の API が無いブラウザだけ、推奨順（OPFS → IndexedDB → Cache API）で次の方式を**初期値**にする。
 *   判定は API の有無だけで行い（同じブラウザなら毎回同じ結果）、保存の失敗を理由に別の方式へ
 *   **自動で切り替えない**（利用者の意図しない再ダウンロードを起こさないため）
 * - 保存方式が違えば、同じモデル ID でも保存場所は別。存在確認・サイズ・削除は方式ごとに行う
 *   （「Cache API に無い」＝「どこにも無い」とは判断しない）
 *
 * ここにある処理は**読むだけ**。保存領域の作成・書き込み・削除はしない（削除は WebLLM の
 * `deleteModelAllInfoInCache` だけ。`src/ai/architecture.test.ts`）。
 */

/** 保存方式（推奨順）。 */
export const MODEL_STORAGE_BACKENDS = ['opfs', 'indexeddb', 'cache'] as const;
export type ModelStorageBackend = (typeof MODEL_STORAGE_BACKENDS)[number];

export const DEFAULT_MODEL_STORAGE_BACKEND: ModelStorageBackend = 'opfs';

export const MODEL_STORAGE_LABEL: Readonly<Record<ModelStorageBackend, string>> = {
  opfs: 'OPFS',
  indexeddb: 'IndexedDB',
  cache: 'Cache API',
};

export const MODEL_STORAGE_DESCRIPTION_JA: Readonly<Record<ModelStorageBackend, string>> = {
  opfs: 'Origin Private File System（大容量ファイル向け。Lab の既定）',
  indexeddb: 'IndexedDB',
  cache: 'Cache Storage（WebLLM の既定。大きなモデルで容量制限の事例あり）',
};

export function isModelStorageBackend(value: unknown): value is ModelStorageBackend {
  return typeof value === 'string' && (MODEL_STORAGE_BACKENDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// WebLLM 0.2.85 の保存場所（WebLLM / tvmjs 側で固定。01AS から名前を変えられない）
// ---------------------------------------------------------------------------

/**
 * 保存の区分。Cache API では cache 名、IndexedDB ではデータベース名、OPFS では
 * `tvmjs-opfs-store/` 以下のディレクトリになる。
 */
export const WEBLLM_STORE_SCOPES = ['webllm/model', 'webllm/config', 'webllm/wasm'] as const;
/** OPFS で WebLLM（tvmjs の OPFSStore）が使うディレクトリ。 */
export const WEBLLM_OPFS_ROOT = 'tvmjs-opfs-store';
/** OPFS の記録ファイル（`<sha256(url)>.record.json`。中身は `{ url, nbytes }`）と本体（`.bin`）。 */
const OPFS_RECORD_SUFFIX = '.record.json';
const OPFS_PAYLOAD_SUFFIX = '.bin';

/**
 * WebLLM の `appConfig` のうち、保存方式を決める部分。
 *
 * `opfsAccessMode: 'auto'` は「dedicated worker で sync access handle が使えれば sync、
 * 使えなければ async」。Lab は WebLLM を画面のスレッドで動かすので、実際には async になる。
 */
export interface WebLlmStorageConfig {
  readonly cacheBackend: ModelStorageBackend;
  readonly opfsAccessMode?: 'auto';
}

export function webLlmStorageConfig(backend: ModelStorageBackend): WebLlmStorageConfig {
  return backend === 'opfs' ? { cacheBackend: 'opfs', opfsAccessMode: 'auto' } : { cacheBackend: backend };
}

/**
 * WebLLM の設定（`prebuiltAppConfig` など）に保存方式を重ねた、新しい設定を返す。元の設定は変更しない。
 * 元の設定の `cacheBackend`・`opfsAccessMode` は引き継がない（方式が混ざらないように）。
 */
export function withModelStorage<T extends object>(base: T, backend: ModelStorageBackend): Omit<T, 'cacheBackend' | 'opfsAccessMode'> & WebLlmStorageConfig {
  const rest: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  delete rest.cacheBackend;
  delete rest.opfsAccessMode;
  return { ...rest, ...webLlmStorageConfig(backend) } as Omit<T, 'cacheBackend' | 'opfsAccessMode'> & WebLlmStorageConfig;
}

// ---------------------------------------------------------------------------
// ブラウザの保存 API（読む部分だけの型）
// ---------------------------------------------------------------------------

interface FileLike {
  readonly size: number;
  text(): Promise<string>;
}

interface FileHandleLike {
  getFile(): Promise<FileLike>;
}

/** OPFS のディレクトリ。**作成しない**よう、作成の options は渡さない（名前だけで開く）。 */
export interface DirectoryHandleLike {
  getDirectoryHandle(name: string): Promise<DirectoryHandleLike>;
  getFileHandle(name: string): Promise<FileHandleLike>;
  keys?(): AsyncIterable<string>;
}

export interface StorageManagerLike {
  getDirectory?(): Promise<DirectoryHandleLike>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

export interface CacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<{
    keys(): Promise<readonly { readonly url: string }[]>;
    match(request: { readonly url: string }): Promise<{ readonly headers: { get(name: string): string | null } } | undefined>;
  }>;
}

export interface IndexedDbLike {
  databases?(): Promise<readonly { readonly name?: string }[]>;
}

/** 保存 API の入口。テストでは偽物を渡す。 */
export interface StorageEnvironment {
  readonly storageManager: StorageManagerLike | null;
  readonly cacheStorage: CacheStorageLike | null;
  readonly indexedDb: IndexedDbLike | null;
}

export function browserStorageEnvironment(): StorageEnvironment {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { storage?: StorageManagerLike });
  return {
    storageManager: nav?.storage ?? null,
    cacheStorage: typeof caches === 'undefined' ? null : (caches as unknown as CacheStorageLike),
    indexedDb: typeof indexedDB === 'undefined' ? null : (indexedDB as unknown as IndexedDbLike),
  };
}

// ---------------------------------------------------------------------------
// 方式の判定
// ---------------------------------------------------------------------------

/** 方式ごとに、このブラウザが API を公開しているか（使えることの保証ではない）。 */
export type ModelStorageSupport = Readonly<Record<ModelStorageBackend, boolean>>;

export function detectModelStorageSupport(env: StorageEnvironment = browserStorageEnvironment()): ModelStorageSupport {
  return {
    opfs: typeof env.storageManager?.getDirectory === 'function',
    indexeddb: env.indexedDb !== null,
    cache: env.cacheStorage !== null,
  };
}

export interface ModelStorageChoice {
  /** 初期値にする方式。どの方式も無ければ null（モデルを保存できない）。 */
  readonly backend: ModelStorageBackend | null;
  /** 既定（OPFS）を使えず、推奨順の次の方式を初期値にしたか。 */
  readonly usedFallback: boolean;
  /** 選んだ方式以外で、このブラウザが公開している方式（推奨順）。**自動では切り替えない**。 */
  readonly alternatives: readonly ModelStorageBackend[];
}

/** 推奨順（OPFS → IndexedDB → Cache API）で、API のある最初の方式を初期値にする。 */
export function chooseModelStorageBackend(support: ModelStorageSupport): ModelStorageChoice {
  const available = MODEL_STORAGE_BACKENDS.filter((backend) => support[backend]);
  const backend = available[0] ?? null;
  return {
    backend,
    usedFallback: backend !== null && backend !== DEFAULT_MODEL_STORAGE_BACKEND,
    alternatives: available.filter((item) => item !== backend),
  };
}

// ---------------------------------------------------------------------------
// 保存領域の有無（作らずに調べる）
// ---------------------------------------------------------------------------

function errorName(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

/** OPFS の `tvmjs-opfs-store/<scope>` を、作らずに開く。無ければ null。 */
async function openOpfsScope(storage: StorageManagerLike, scope: string): Promise<DirectoryHandleLike | null> {
  if (typeof storage.getDirectory !== 'function') return null;
  try {
    let directory = await (await storage.getDirectory()).getDirectoryHandle(WEBLLM_OPFS_ROOT);
    for (const part of scope.split('/').filter((item) => item.length > 0)) {
      directory = await directory.getDirectoryHandle(encodeURIComponent(part));
    }
    return directory;
  } catch (error) {
    const name = errorName(error);
    if (name === 'NotFoundError' || name === 'TypeMismatchError') return null;
    throw error;
  }
}

/**
 * その方式に WebLLM のモデル保存領域（`webllm/model`）があるか。**保存領域を作らない**。
 *
 * - `false`: 無い（その方式にはどのモデルも保存されていない）
 * - `true`: ある（モデルがあるかは WebLLM の `hasModelInCache` で確かめる）
 * - `null`: 作らずに確かめる方法が無い（IndexedDB の `databases()` が無いなど）・失敗した
 */
export async function hasWebLlmStore(backend: ModelStorageBackend, env: StorageEnvironment): Promise<boolean | null> {
  const scope = WEBLLM_STORE_SCOPES[0];
  try {
    switch (backend) {
      case 'opfs':
        return env.storageManager ? (await openOpfsScope(env.storageManager, scope)) !== null : false;
      case 'indexeddb': {
        if (env.indexedDb === null) return false;
        if (typeof env.indexedDb.databases !== 'function') return null;
        return (await env.indexedDb.databases()).some((item) => item.name === scope);
      }
      case 'cache':
        return env.cacheStorage ? await env.cacheStorage.has(scope) : false;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// モデル単位のサイズ（分からなければ null。誤った 0 B より「不明」を優先する）
// ---------------------------------------------------------------------------

/** サイズを数える対象のモデル（WebLLM の ModelRecord のうち使う部分）。 */
export interface ModelLocation {
  /** 例: 配布元のモデルの URL。重み・tokenizer・設定はこの下に保存される。 */
  readonly model: string;
  /** model library（wasm）の URL。 */
  readonly model_lib: string;
}

function belongsTo(url: string, location: ModelLocation): boolean {
  const base = location.model.endsWith('/') ? location.model : `${location.model}/`;
  return url.startsWith(base) || url === location.model_lib;
}

/**
 * OPFS: WebLLM が書いた記録（`{ url, nbytes }`）のうち、そのモデルのものを合計する。
 * 本体（`.bin`）が無い・記録と大きさが違う項目があれば、未完成として null（不明）。
 */
async function measureOpfs(storage: StorageManagerLike, location: ModelLocation): Promise<number | null> {
  let total = 0;
  let counted = 0;
  for (const scope of WEBLLM_STORE_SCOPES) {
    const directory = await openOpfsScope(storage, scope);
    if (directory === null) continue;
    if (typeof directory.keys !== 'function') return null;
    for await (const name of directory.keys()) {
      if (!name.endsWith(OPFS_RECORD_SUFFIX)) continue;
      let record: { url?: unknown; nbytes?: unknown };
      try {
        record = JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text()) as typeof record;
      } catch {
        continue; // WebLLM も読めない記録は「無い」として扱う
      }
      if (typeof record.url !== 'string' || !belongsTo(record.url, location)) continue;
      if (typeof record.nbytes !== 'number' || !Number.isSafeInteger(record.nbytes) || record.nbytes < 0) return null;
      const payloadName = `${name.slice(0, -OPFS_RECORD_SUFFIX.length)}${OPFS_PAYLOAD_SUFFIX}`;
      let payloadSize: number;
      try {
        payloadSize = (await (await directory.getFileHandle(payloadName)).getFile()).size;
      } catch {
        return null;
      }
      if (payloadSize !== record.nbytes) return null;
      total += record.nbytes;
      counted += 1;
    }
  }
  return counted === 0 ? null : total;
}

/**
 * Cache API: 保存された応答の `content-length` を合計する。
 * `content-length` が無い・圧縮（`content-encoding`）されていて本体の大きさと一致しない項目があれば null（不明）。
 */
async function measureCache(cacheStorage: CacheStorageLike, location: ModelLocation): Promise<number | null> {
  let total = 0;
  let counted = 0;
  for (const scope of WEBLLM_STORE_SCOPES) {
    if (!(await cacheStorage.has(scope))) continue;
    const cache = await cacheStorage.open(scope);
    for (const request of await cache.keys()) {
      if (!belongsTo(request.url, location)) continue;
      const response = await cache.match(request);
      const encoding = response?.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') return null;
      const length = Number(response?.headers.get('content-length') ?? Number.NaN);
      if (!Number.isSafeInteger(length) || length <= 0) return null;
      total += length;
      counted += 1;
    }
  }
  return counted === 0 ? null : total;
}

/**
 * その方式に保存されたモデルの大きさ（byte）。正確に数えられなければ null（不明）。
 *
 * - OPFS: WebLLM の記録（nbytes）と本体の大きさが一致したものの合計
 * - Cache API: `content-length` の合計（無い・圧縮されている項目があれば不明）
 * - IndexedDB: 不明（大きさを知るには本体を読み出す必要があり、数 GB をメモリへ載せるため行わない）
 */
export async function measureModelBytes(
  backend: ModelStorageBackend,
  location: ModelLocation,
  env: StorageEnvironment,
): Promise<number | null> {
  try {
    switch (backend) {
      case 'opfs':
        return env.storageManager ? await measureOpfs(env.storageManager, location) : null;
      case 'cache':
        return env.cacheStorage ? await measureCache(env.cacheStorage, location) : null;
      case 'indexeddb':
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * その方式に残っている、そのモデルの項目（ファイル）の数。**読むだけ**（作成・削除しない）。
 * 取得が途中で止まったモデルの残り（partial）を見分けるために使う（WebLLM の存在確認は、すべてそろわないと「無い」と答える）。
 *
 * - OPFS: WebLLM の記録（`.record.json`）のうち、そのモデルの URL のものの数
 * - Cache API: `webllm/{model,config,wasm}` の鍵のうち、そのモデルの URL のものの数
 * - IndexedDB: 数えない（null）
 */
export async function countModelEntries(
  backend: ModelStorageBackend,
  location: ModelLocation,
  env: StorageEnvironment,
): Promise<number | null> {
  try {
    if (backend === 'opfs') {
      if (!env.storageManager) return 0;
      let count = 0;
      for (const scope of WEBLLM_STORE_SCOPES) {
        const directory = await openOpfsScope(env.storageManager, scope);
        if (directory === null) continue;
        if (typeof directory.keys !== 'function') return null;
        for await (const name of directory.keys()) {
          if (!name.endsWith(OPFS_RECORD_SUFFIX)) continue;
          try {
            const record = JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text()) as { url?: unknown };
            if (typeof record.url === 'string' && belongsTo(record.url, location)) count += 1;
          } catch {
            // 読めない記録は数えない
          }
        }
      }
      return count;
    }
    if (backend === 'cache') {
      if (!env.cacheStorage) return 0;
      let count = 0;
      for (const scope of WEBLLM_STORE_SCOPES) {
        if (!(await env.cacheStorage.has(scope))) continue;
        const cache = await env.cacheStorage.open(scope);
        count += (await cache.keys()).filter((request) => belongsTo(request.url, location)).length;
      }
      return count;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// origin 全体の保存状況（Storage Diagnostics）
// ---------------------------------------------------------------------------

export interface StorageStatus {
  /** `navigator.storage.estimate().usage`（origin 全体）。 */
  readonly usageBytes: number | null;
  /** `navigator.storage.estimate().quota`（origin 全体）。 */
  readonly quotaBytes: number | null;
  /** `navigator.storage.persisted()`。取得できなければ null。 */
  readonly persisted: boolean | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** origin 全体の使用量・上限・永続化の状態。例外を投げない。 */
export async function probeStorageStatus(env: StorageEnvironment = browserStorageEnvironment()): Promise<StorageStatus> {
  const storage = env.storageManager;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  let persisted: boolean | null = null;
  try {
    const estimate = await storage?.estimate?.();
    usageBytes = finiteOrNull(estimate?.usage);
    quotaBytes = finiteOrNull(estimate?.quota);
  } catch {
    // 取得できなければ不明のまま
  }
  try {
    const value = await storage?.persisted?.();
    persisted = typeof value === 'boolean' ? value : null;
  } catch {
    persisted = null;
  }
  return { usageBytes, quotaBytes, persisted };
}

/**
 * 永続化（eviction されにくくする）を best-effort で要求する。**容量制限の対策ではない**。
 * 例外を投げない。結果（許可されたか）を返し、分からなければ null。
 */
export async function requestPersistentStorage(env: StorageEnvironment = browserStorageEnvironment()): Promise<boolean | null> {
  try {
    const value = await env.storageManager?.persist?.();
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/**
 * ダウンロード前後の `estimate().usage` の差（**origin 全体の差分**）。
 * モデルのファイルの厳密な大きさではない（同じ時間の他の保存も含み、ブラウザの見積もりでもある）。
 */
export function estimatedDownloadFootprint(before: StorageStatus | null, after: StorageStatus | null): number | null {
  if (before?.usageBytes == null || after?.usageBytes == null) return null;
  const difference = after.usageBytes - before.usageBytes;
  return difference > 0 ? difference : null;
}
