/**
 * テスト・CI 用の Mock Runtime（Fake Model）。
 *
 * 実モデルを取得しない。CI で数 GB のモデルをダウンロードしないために、Benchmark の
 * 流れ（読み込み → 生成 → 検証 → 計測 → export）をこれで確かめる。
 *
 * - 出力は `respond` が決める（既定は決定論的な baseline と同じ文面）
 * - 時間は偽の時計（`FakeClock`）を進めるだけなので、計測値も決定論的になる
 * - キャッシュの有無・取得・削除を記録し、「明示操作なしに取得しない」ことを検査できる
 * - 保存方式（Storage Backend）を 1 つ持ち、方式ごとの有無を別々に答える（既定は OPFS）
 */
import {
  explainDecisionDeterministically,
  summarizeSessionDeterministically,
} from '../../templateProvider';
import {
  BenchmarkRuntimeError,
  type BenchmarkCandidate,
  type BenchmarkRuntime,
  type GenerationRecord,
  type GenerationRequest,
  type LoadOptions,
  type LoadRecord,
} from '../types';
import { DEFAULT_MODEL_STORAGE_BACKEND, type ModelStorageBackend } from '../modelStorage';

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

export function createFakeClock(start = 0): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export function faithfulResponse(request: GenerationRequest): string {
  const input = request.input;
  return input.kind === 'decision'
    ? explainDecisionDeterministically(input.decision).text
    : summarizeSessionDeterministically(input.review).text;
}

export interface MockRuntimeOptions {
  readonly id?: string;
  readonly clock?: FakeClock;
  /** 生成する文字列。throw すればエラー、解決しなければタイムアウトを模擬できる。 */
  readonly respond?: (request: GenerationRequest) => string | Promise<string>;
  /** 最初からキャッシュにある候補の ID。 */
  readonly cachedCandidateIds?: readonly string[];
  readonly loadMs?: number;
  readonly downloadMs?: number;
  readonly ttftMs?: number;
  readonly msPerToken?: number;
  /** 保存済みのサイズ。null なら「不明」を返す。 */
  readonly sizeBytes?: number | null;
  /** この Runtime の保存方式。既定は OPFS。 */
  readonly storageBackend?: ModelStorageBackend;
  /** ほかの保存方式に保存済みの候補（方式ごと）。存在確認だけに使い、読み込みには使わない。 */
  readonly cachedElsewhere?: Partial<Record<ModelStorageBackend, readonly string[]>>;
  /** 取得を伴う読み込みで投げる失敗（容量制限などを模擬する）。 */
  readonly failDownload?: (candidate: BenchmarkCandidate) => unknown;
  /** キャッシュからの読み込みで投げる失敗（GPU への読み込みの失敗などを模擬する）。 */
  readonly failLoad?: (candidate: BenchmarkCandidate, contextWindowSize: number | null) => unknown;
  /** 生成の finish_reason（既定は stop）。 */
  readonly finishReason?: (request: GenerationRequest) => string | null;
  /** 一部だけ保存された（取得が途中で止まった）候補。 */
  readonly partialCandidateIds?: readonly string[];
}

export interface MockRuntime extends BenchmarkRuntime {
  readonly log: string[];
  readonly cached: Set<string>;
  loadedCandidateId(): string | null;
  /** 読み込み中のモデルの context window（読み込んでいなければ undefined）。 */
  loadedContextWindowSize(): number | null | undefined;
  /** いま GPU に載っているモデルの数（読み込み・解放の対応を確かめる。0 か 1 のはず）。 */
  residentModels(): number;
}

/** 決定論的なトークン数（2 文字 = 1 トークンとみなす）。 */
export function mockTokenCount(text: string): number {
  return Math.ceil(text.length / 2);
}

export function createMockRuntime(options: MockRuntimeOptions = {}): MockRuntime {
  const clock = options.clock ?? createFakeClock();
  const respond = options.respond ?? faithfulResponse;
  const cached = new Set(options.cachedCandidateIds ?? []);
  const loadedOnce = new Set<string>();
  const log: string[] = [];
  const backend = options.storageBackend ?? DEFAULT_MODEL_STORAGE_BACKEND;
  const partial = new Set(options.partialCandidateIds ?? []);
  let loaded: string | null = null;
  let loadedContext: number | null = null;

  return {
    id: options.id ?? 'mock',
    kind: 'mock',
    labelJa: 'Mock Runtime（テスト用・実モデルなし）',
    log,
    cached,
    loadedCandidateId: () => loaded,
    loadedContextWindowSize: () => (loaded === null ? undefined : loadedContext),
    residentModels: () => (loaded === null ? 0 : 1),
    supports: () => true,
    modelStorage: {
      backend,
      isCachedIn: async (candidate, target) =>
        target === backend ? cached.has(candidate.id) : (options.cachedElsewhere?.[target] ?? []).includes(candidate.id),
      hasPartial: async (candidate) => !cached.has(candidate.id) && partial.has(candidate.id),
    },
    isCached: async (candidate) => cached.has(candidate.id),
    async load(candidate: BenchmarkCandidate, loadOptions: LoadOptions): Promise<LoadRecord> {
      const contextWindowSize = loadOptions.contextWindowSize ?? null;
      if (loaded === candidate.id && loadedContext === contextWindowSize) {
        return { candidateId: candidate.id, kind: 'already-loaded', loadTimeMs: 0, contextWindowSize };
      }
      if (loaded !== null) {
        // 実際の Runtime と同じく、別のモデル・別の設定を読み込む前に今のモデルを解放する。
        log.push(`unload:${loaded}`);
        loaded = null;
      }
      const started = clock.now();
      let kind: LoadRecord['kind'];
      if (!cached.has(candidate.id)) {
        if (!loadOptions.allowDownload) {
          throw new BenchmarkRuntimeError('not-downloaded', `${candidate.id} はまだダウンロードされていません。`);
        }
        log.push(`download:${candidate.id}`);
        loadOptions.onProgress?.(0.5, 'downloading');
        if (options.failDownload) throw options.failDownload(candidate);
        clock.advance(options.downloadMs ?? 5000);
        cached.add(candidate.id);
        kind = 'download';
      } else {
        kind = loadedOnce.has(candidate.id) ? 'cache-warm' : 'cache-cold';
        if (options.failLoad) {
          const failure = options.failLoad(candidate, contextWindowSize);
          if (failure !== undefined) throw failure;
        }
      }
      clock.advance(options.loadMs ?? (kind === 'cache-warm' ? 200 : 1000));
      loadOptions.onProgress?.(1, 'ready');
      loaded = candidate.id;
      loadedContext = contextWindowSize;
      loadedOnce.add(candidate.id);
      log.push(`load:${candidate.id}:${kind}${contextWindowSize === null ? '' : `:ctx${contextWindowSize}`}`);
      return { candidateId: candidate.id, kind, loadTimeMs: clock.now() - started, contextWindowSize };
    },
    async generate(request: GenerationRequest): Promise<GenerationRecord> {
      if (loaded === null) throw new BenchmarkRuntimeError('not-loaded', 'モデルが読み込まれていません。');
      const started = clock.now();
      const text = await respond(request);
      const tokens = mockTokenCount(text);
      const ttft = options.ttftMs ?? 100;
      clock.advance(ttft + tokens * (options.msPerToken ?? 20));
      return {
        rawText: text,
        promptTokens: mockTokenCount(request.messages.map((message) => message.content).join('')),
        outputTokens: tokens,
        timeToFirstTokenMs: ttft,
        timeToFirstVisibleTokenMs: ttft,
        generationTimeMs: clock.now() - started,
        runtimeDecodeTokensPerSecond: null,
        finishReason: options.finishReason ? options.finishReason(request) : 'stop',
      };
    },
    async unload() {
      if (loaded !== null) log.push(`unload:${loaded}`);
      loaded = null;
    },
    async deleteCache(candidate) {
      log.push(`delete:${candidate.id}`);
      cached.delete(candidate.id);
      partial.delete(candidate.id);
      if (loaded === candidate.id) loaded = null;
    },
    cachedSizeBytes: async (candidate) =>
      cached.has(candidate.id) ? (options.sizeBytes === undefined ? 1_000_000 : options.sizeBytes) : null,
  };
}
