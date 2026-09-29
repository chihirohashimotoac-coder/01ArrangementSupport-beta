/**
 * WebLLM を Benchmark Runtime として動かす（primary runtime 候補の検証用）。
 *
 * - WebLLM 本体は**動的 import**（`import('@mlc-ai/web-llm')`）で読む。Lab を開いて
 *   Runtime を使うまでアプリ本体の bundle にも Service Worker の precache にも入らない
 * - モデルの取得は `load({ allowDownload: true })` のときだけ（利用者が Download を押したとき）。
 *   Benchmark の実行時は `allowDownload: false` で、保存されていなければ失敗させる
 * - 保存方式（Storage Backend）は Runtime ごとに 1 つ（既定は OPFS。`modelStorage.ts`）。
 *   `prebuiltAppConfig` に保存方式を重ねた**同じ appConfig**を、`hasModelInCache`・
 *   `deleteModelAllInfoInCache`・`MLCEngine` のすべてへ渡す（方式を混ぜない）。
 *   WebLLM 0.2.85 の `prebuiltAppConfig` の既定は Cache API（`cacheBackend: "cache"`）
 * - 保存場所の名前は WebLLM 側で固定（`webllm/model`・`webllm/config`・`webllm/wasm`、
 *   OPFS では `tvmjs-opfs-store/webllm/*`）。削除は WebLLM の `deleteModelAllInfoInCache` だけを使い、
 *   01AS の利用者データ（localStorage の `01as-beta:`）には触れない
 * - thinking は `extra_body.enable_thinking` で切り替える（01AS の既定は OFF）
 * - 毎回 `resetChat()` してから生成する（前のケースの会話を持ち越さない）
 * - Benchmark Profile の context window は `reload(modelId, { context_window_size })`（WebLLM 0.2.85 の公式の上書き）で渡す。
 *   appConfig・モデルの URL は変えないので、保存済みのモデルをそのまま使う（再取得しない）。
 *   読み込み済みのモデルと context window が違えば読み込み直す（`reload` は前のモデルを解放してから読み込む）
 * - MLCEngine は Runtime につき 1 つだけ作り、読み込みを同時に 2 つ走らせない
 */
import { splitThinking } from '../checks';
import {
  BenchmarkRuntimeError,
  type BenchmarkCandidate,
  type BenchmarkRuntime,
  type GenerationRecord,
  type GenerationRequest,
  type LoadOptions,
  type LoadRecord,
} from '../types';
import {
  DEFAULT_MODEL_STORAGE_BACKEND,
  browserStorageEnvironment,
  countModelEntries,
  hasWebLlmStore,
  measureModelBytes,
  withModelStorage,
  type ModelStorageBackend,
  type StorageEnvironment,
} from '../modelStorage';

export const WEBLLM_RUNTIME_ID = 'webllm';

// ---------------------------------------------------------------------------
// WebLLM の API のうち、ここで使う部分だけの型（SDK の型をアプリへ漏らさない）
// ---------------------------------------------------------------------------

interface ModelRecordLike {
  readonly model: string;
  readonly model_id: string;
  readonly model_lib: string;
  readonly vram_required_MB?: number;
  readonly low_resource_required?: boolean;
  readonly required_features?: readonly string[];
}

export interface AppConfigLike {
  readonly model_list: readonly ModelRecordLike[];
  readonly cacheBackend?: string;
  readonly opfsAccessMode?: string;
}

interface ChunkLike {
  readonly choices: readonly { readonly delta?: { readonly content?: string | null }; readonly finish_reason?: string | null }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly extra?: { readonly decode_tokens_per_s?: number };
  } | null;
}

/**
 * WebLLM 0.2.85 の `ChatOptions`（`Partial<ChatConfig>`）のうち、ここで上書きするものだけ。
 * `reload(modelId, chatOpts)` の chatOpts は `mlc-chat-config.json`・`ModelRecord.overrides` の上に重なる
 * （`reloadInternal` の `Object.assign({}, config, modelRecord.overrides, chatOpts)`）。
 * `context_window_size` は KV cache（`create_tir_paged_kv_cache` の max_total_sequence_length）の大きさを決め、
 * 読み込み時に確保される。モデルのファイル（取得・保存するもの）は変わらない。
 */
export interface ChatOptionsLike {
  readonly context_window_size?: number;
}

interface EngineLike {
  reload(modelId: string, chatOpts?: ChatOptionsLike): Promise<void>;
  unload(): Promise<void>;
  resetChat(): Promise<void>;
  interruptGenerate(): void;
  setInitProgressCallback(callback?: (report: { progress: number; text: string }) => void): void;
  readonly chat: {
    readonly completions: {
      create(request: Record<string, unknown>): Promise<AsyncIterable<ChunkLike>>;
    };
  };
}

export interface WebLlmModuleLike {
  readonly prebuiltAppConfig: AppConfigLike;
  readonly MLCEngine: new (config: { appConfig: AppConfigLike }) => EngineLike;
  hasModelInCache(modelId: string, appConfig?: AppConfigLike): Promise<boolean>;
  deleteModelAllInfoInCache(modelId: string, appConfig?: AppConfigLike): Promise<void>;
}

export interface WebLlmRuntimeOptions {
  readonly now?: () => number;
  /** テストで偽のモジュールを渡す。既定は動的 import。 */
  readonly loadModule?: () => Promise<WebLlmModuleLike>;
  /** 保存方式。既定は OPFS。 */
  readonly storageBackend?: ModelStorageBackend;
  /** テストで偽の保存 API を渡す。既定はブラウザの API（読むだけ）。 */
  readonly storage?: StorageEnvironment;
}

function defaultLoadModule(): Promise<WebLlmModuleLike> {
  return import('@mlc-ai/web-llm') as unknown as Promise<WebLlmModuleLike>;
}

function modelIdOf(candidate: BenchmarkCandidate): string {
  if (candidate.runtime !== 'webllm' || candidate.runtimeModelId === null) {
    throw new BenchmarkRuntimeError('unsupported', `${candidate.id} は WebLLM の候補ではありません。`);
  }
  return candidate.runtimeModelId;
}

export interface WebLlmRuntime extends BenchmarkRuntime {
  readonly storageBackend: ModelStorageBackend;
  /** 読み込んだ WebLLM の設定から、その候補の記録を返す（表示・照合用）。 */
  modelRecordOf(candidate: BenchmarkCandidate): Promise<ModelRecordLike | null>;
  /** この Runtime が WebLLM へ渡す appConfig（毎回同じオブジェクト）。 */
  appConfig(): Promise<AppConfigLike>;
}

export function createWebLlmRuntime(options: WebLlmRuntimeOptions = {}): WebLlmRuntime {
  const now = options.now ?? (() => performance.now());
  const loadModule = options.loadModule ?? defaultLoadModule;
  const backend = options.storageBackend ?? DEFAULT_MODEL_STORAGE_BACKEND;
  const storage = options.storage ?? browserStorageEnvironment();
  let modulePromise: Promise<WebLlmModuleLike> | null = null;
  // MLCEngine はこの Runtime につき 1 つだけ作る（reload は前のモデルを解放してから読み込む）。
  let engine: EngineLike | null = null;
  let loadedModelId: string | null = null;
  /** 読み込み中のモデルの context window（null は既定）。 */
  let loadedContextWindowSize: number | null = null;
  /** 読み込みの最中か（同時に 2 つ読み込まない）。 */
  let loading = false;
  const loadedThisSession = new Set<string>();

  const module = async (): Promise<WebLlmModuleLike> => {
    modulePromise ??= loadModule().catch((error: unknown) => {
      modulePromise = null;
      throw new BenchmarkRuntimeError('runtime-unavailable', `WebLLM を読み込めませんでした: ${String(error)}`);
    });
    return modulePromise;
  };

  // 保存方式ごとの appConfig。同じ方式には毎回同じオブジェクトを返す（has / delete / MLCEngine で共有）。
  const configs = new Map<ModelStorageBackend, AppConfigLike>();
  const configFor = (webllm: WebLlmModuleLike, target: ModelStorageBackend): AppConfigLike => {
    let config = configs.get(target);
    if (config === undefined) {
      config = withModelStorage(webllm.prebuiltAppConfig, target);
      configs.set(target, config);
    }
    return config;
  };

  const recordOf = async (candidate: BenchmarkCandidate): Promise<ModelRecordLike | null> => {
    const webllm = await module();
    return webllm.prebuiltAppConfig.model_list.find((record) => record.model_id === modelIdOf(candidate)) ?? null;
  };

  /**
   * その方式にモデルがあるか。保存領域がまだ無ければ WebLLM を呼ばずに false を返す
   * （WebLLM の確認処理は保存領域を作るため）。作らずに確かめられない別の方式は null（不明）。
   */
  const cachedIn = async (candidate: BenchmarkCandidate, target: ModelStorageBackend): Promise<boolean | null> => {
    const modelId = modelIdOf(candidate);
    const store = await hasWebLlmStore(target, storage);
    if (store === false) return false;
    if (store === null && target !== backend) return null;
    const webllm = await module();
    return webllm.hasModelInCache(modelId, configFor(webllm, target));
  };

  const modelStorage = {
    backend,
    async isCachedIn(candidate: BenchmarkCandidate, target: ModelStorageBackend) {
      try {
        return await cachedIn(candidate, target);
      } catch {
        return null;
      }
    },
    /** 一部だけ残っているか（取得が途中で止まった等）。保存領域が無ければ WebLLM も読まずに false。 */
    async hasPartial(candidate: BenchmarkCandidate): Promise<boolean | null> {
      try {
        if ((await hasWebLlmStore(backend, storage)) === false) return false;
        const cached = await cachedIn(candidate, backend);
        if (cached === true) return false;
        const record = await recordOf(candidate);
        if (!record) return null;
        const entries = await countModelEntries(backend, record, storage);
        if (entries === null) return null;
        return cached === false && entries > 0 ? true : entries === 0 ? false : null;
      } catch {
        return null;
      }
    },
  };

  const loadModel = async (
    candidate: BenchmarkCandidate,
    modelId: string,
    contextWindowSize: number | null,
    loadOptions: LoadOptions,
  ): Promise<LoadRecord> => {
    const webllm = await module();
    if (!(await recordOf(candidate))) {
      throw new BenchmarkRuntimeError('unsupported', `WebLLM の prebuilt に ${modelId} がありません。`);
    }
    const appConfig = configFor(webllm, backend);
    const cached = (await cachedIn(candidate, backend)) === true;
    if (!cached && !loadOptions.allowDownload) {
      throw new BenchmarkRuntimeError('not-downloaded', `${candidate.displayName} はまだダウンロードされていません。`);
    }
    const kind: LoadRecord['kind'] = !cached ? 'download' : loadedThisSession.has(modelId) ? 'cache-warm' : 'cache-cold';
    engine ??= new webllm.MLCEngine({ appConfig });
    const current = engine;
    current.setInitProgressCallback((report) => loadOptions.onProgress?.(report.progress, report.text));
    const abort = () => {
      void current.unload();
    };
    loadOptions.signal.addEventListener('abort', abort);
    const started = now();
    try {
      // context window は WebLLM の公式の上書き（chatOpts）で渡す。null なら何も渡さず、既定（prebuilt の設定）のまま。
      await current.reload(modelId, contextWindowSize === null ? undefined : { context_window_size: contextWindowSize });
    } catch (error) {
      loadedModelId = null;
      loadedContextWindowSize = null;
      if (loadOptions.signal.aborted) throw new BenchmarkRuntimeError('aborted', '読み込みを中止しました。');
      throw error;
    } finally {
      loadOptions.signal.removeEventListener('abort', abort);
      current.setInitProgressCallback(undefined);
    }
    if (loadOptions.signal.aborted) {
      await current.unload();
      loadedModelId = null;
      loadedContextWindowSize = null;
      throw new BenchmarkRuntimeError('aborted', '読み込みを中止しました。');
    }
    loadedModelId = modelId;
    loadedContextWindowSize = contextWindowSize;
    loadedThisSession.add(modelId);
    return { candidateId: candidate.id, kind, loadTimeMs: now() - started, contextWindowSize };
  };

  const generateWith = async (request: GenerationRequest): Promise<GenerationRecord> => {
    const current = engine;
    if (current === null || loadedModelId === null) {
      throw new BenchmarkRuntimeError('not-loaded', 'モデルが読み込まれていません。');
    }
    await current.resetChat();
    const interrupt = () => current.interruptGenerate();
    request.signal.addEventListener('abort', interrupt);
    const started = now();
    let text = '';
    let firstToken: number | null = null;
    let firstVisible: number | null = null;
    let promptTokens: number | null = null;
    let outputTokens: number | null = null;
    let decodeTokensPerSecond: number | null = null;
    let finishReason: string | null = null;
    try {
      const stream = await current.chat.completions.create({
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        stream_options: { include_usage: true },
        temperature: request.temperature,
        seed: request.seed,
        max_tokens: request.maxTokens,
        ...(request.thinking === 'not-applicable'
          ? {}
          : { extra_body: { enable_thinking: request.thinking === 'on' } }),
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta.length > 0) {
          const at = now();
          firstToken ??= at - started;
          text += delta;
          if (firstVisible === null && splitThinking(text).text.length > 0) firstVisible = at - started;
        }
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          decodeTokensPerSecond = chunk.usage.extra?.decode_tokens_per_s ?? decodeTokensPerSecond;
        }
      }
    } catch (error) {
      if (request.signal.aborted) throw new BenchmarkRuntimeError('aborted', '生成を中止しました。');
      throw new BenchmarkRuntimeError('generation-failed', String(error));
    } finally {
      request.signal.removeEventListener('abort', interrupt);
    }
    return {
      rawText: text,
      promptTokens,
      outputTokens,
      timeToFirstTokenMs: firstToken,
      timeToFirstVisibleTokenMs: firstVisible,
      generationTimeMs: now() - started,
      runtimeDecodeTokensPerSecond: decodeTokensPerSecond,
      finishReason,
    };
  };

  return {
    id: WEBLLM_RUNTIME_ID,
    kind: 'webllm',
    labelJa: 'WebLLM（WebGPU）',
    storageBackend: backend,
    modelStorage,
    supports: (candidate) => candidate.runtime === 'webllm' && candidate.runtimeModelId !== null,
    modelRecordOf: recordOf,

    async appConfig() {
      return configFor(await module(), backend);
    },

    isCached: (candidate) => modelStorage.isCachedIn(candidate, backend),

    async load(candidate: BenchmarkCandidate, loadOptions: LoadOptions): Promise<LoadRecord> {
      const modelId = modelIdOf(candidate);
      const contextWindowSize = loadOptions.contextWindowSize ?? null;
      if (engine !== null && loadedModelId === modelId && loadedContextWindowSize === contextWindowSize) {
        return { candidateId: candidate.id, kind: 'already-loaded', loadTimeMs: 0, contextWindowSize };
      }
      if (loading) throw new BenchmarkRuntimeError('runtime-unavailable', '別のモデルを読み込んでいる最中です。');
      loading = true;
      try {
        return await loadModel(candidate, modelId, contextWindowSize, loadOptions);
      } finally {
        loading = false;
      }
    },

    async generate(request: GenerationRequest): Promise<GenerationRecord> {
      return generateWith(request);
    },

    async unload() {
      if (engine !== null) await engine.unload();
      loadedModelId = null;
      loadedContextWindowSize = null;
    },

    async deleteCache(candidate) {
      const modelId = modelIdOf(candidate);
      const webllm = await module();
      const appConfig = configFor(webllm, backend);
      if (engine !== null && loadedModelId === modelId) {
        await engine.unload();
        loadedModelId = null;
        loadedContextWindowSize = null;
      }
      loadedThisSession.delete(modelId);
      // この方式に保存領域が無ければ、消すものは無い（WebLLM の削除処理は保存領域を作り、
      // 一覧のファイルが無いと取得しようとするため呼ばない）。
      if ((await hasWebLlmStore(backend, storage)) === false) return;
      // この方式の、このモデルの項目だけを消す（ほかのモデル・ほかの方式・利用者データには触れない）。
      await webllm.deleteModelAllInfoInCache(modelId, appConfig);
    },

    async cachedSizeBytes(candidate) {
      const record = await recordOf(candidate).catch(() => null);
      if (!record) return null;
      return measureModelBytes(backend, record, storage);
    },
  };
}
