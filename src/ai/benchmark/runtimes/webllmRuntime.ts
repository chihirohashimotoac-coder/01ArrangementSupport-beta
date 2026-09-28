/**
 * WebLLM を Benchmark Runtime として動かす（primary runtime 候補の検証用）。
 *
 * - WebLLM 本体は**動的 import**（`import('@mlc-ai/web-llm')`）で読む。Lab を開いて
 *   Runtime を使うまでアプリ本体の bundle にも Service Worker の precache にも入らない
 * - モデルの取得は `load({ allowDownload: true })` のときだけ（利用者が Download を押したとき）。
 *   Benchmark の実行時は `allowDownload: false` で、キャッシュに無ければ失敗させる
 * - キャッシュは WebLLM の Cache Storage（`webllm/model`・`webllm/config`・`webllm/wasm`。
 *   名前は WebLLM 側で固定）。削除は WebLLM の `deleteModelAllInfoInCache` だけを使い、
 *   01AS の利用者データ（localStorage の `01as-beta:`）には触れない
 * - thinking は `extra_body.enable_thinking` で切り替える（01AS の既定は OFF）
 * - 毎回 `resetChat()` してから生成する（前のケースの会話を持ち越さない）
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

export const WEBLLM_RUNTIME_ID = 'webllm';

/** WebLLM が使う Cache Storage の名前（WebLLM 側で固定。変更できない）。 */
export const WEBLLM_CACHE_NAMES = ['webllm/model', 'webllm/config', 'webllm/wasm'] as const;

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

interface AppConfigLike {
  readonly model_list: readonly ModelRecordLike[];
}

interface ChunkLike {
  readonly choices: readonly { readonly delta?: { readonly content?: string | null }; readonly finish_reason?: string | null }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly extra?: { readonly decode_tokens_per_s?: number };
  } | null;
}

interface EngineLike {
  reload(modelId: string): Promise<void>;
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

interface CacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<{
    keys(): Promise<readonly { readonly url: string }[]>;
    match(request: { readonly url: string }): Promise<{ readonly headers: { get(name: string): string | null } } | undefined>;
  }>;
}

export interface WebLlmRuntimeOptions {
  readonly now?: () => number;
  /** テストで偽のモジュールを渡す。既定は動的 import。 */
  readonly loadModule?: () => Promise<WebLlmModuleLike>;
  readonly cacheStorage?: CacheStorageLike | null;
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
  /** 読み込んだ WebLLM の設定から、その候補の記録を返す（表示・照合用）。 */
  modelRecordOf(candidate: BenchmarkCandidate): Promise<ModelRecordLike | null>;
}

export function createWebLlmRuntime(options: WebLlmRuntimeOptions = {}): WebLlmRuntime {
  const now = options.now ?? (() => performance.now());
  const loadModule = options.loadModule ?? defaultLoadModule;
  const cacheStorage =
    options.cacheStorage !== undefined
      ? options.cacheStorage
      : typeof caches === 'undefined'
        ? null
        : (caches as unknown as CacheStorageLike);
  let modulePromise: Promise<WebLlmModuleLike> | null = null;
  let engine: EngineLike | null = null;
  let loadedModelId: string | null = null;
  const loadedThisSession = new Set<string>();

  const module = async (): Promise<WebLlmModuleLike> => {
    modulePromise ??= loadModule().catch((error: unknown) => {
      modulePromise = null;
      throw new BenchmarkRuntimeError('runtime-unavailable', `WebLLM を読み込めませんでした: ${String(error)}`);
    });
    return modulePromise;
  };

  const recordOf = async (candidate: BenchmarkCandidate): Promise<ModelRecordLike | null> => {
    const webllm = await module();
    return webllm.prebuiltAppConfig.model_list.find((record) => record.model_id === modelIdOf(candidate)) ?? null;
  };

  return {
    id: WEBLLM_RUNTIME_ID,
    kind: 'webllm',
    labelJa: 'WebLLM（WebGPU）',
    supports: (candidate) => candidate.runtime === 'webllm' && candidate.runtimeModelId !== null,
    modelRecordOf: recordOf,

    async isCached(candidate) {
      try {
        const webllm = await module();
        return await webllm.hasModelInCache(modelIdOf(candidate), webllm.prebuiltAppConfig);
      } catch {
        return null;
      }
    },

    async load(candidate: BenchmarkCandidate, loadOptions: LoadOptions): Promise<LoadRecord> {
      const modelId = modelIdOf(candidate);
      if (engine !== null && loadedModelId === modelId) {
        return { candidateId: candidate.id, kind: 'already-loaded', loadTimeMs: 0 };
      }
      const webllm = await module();
      if (!(await recordOf(candidate))) {
        throw new BenchmarkRuntimeError('unsupported', `WebLLM の prebuilt に ${modelId} がありません。`);
      }
      const cached = await webllm.hasModelInCache(modelId, webllm.prebuiltAppConfig);
      if (!cached && !loadOptions.allowDownload) {
        throw new BenchmarkRuntimeError('not-downloaded', `${candidate.displayName} はまだダウンロードされていません。`);
      }
      const kind: LoadRecord['kind'] = !cached ? 'download' : loadedThisSession.has(modelId) ? 'cache-warm' : 'cache-cold';
      engine ??= new webllm.MLCEngine({ appConfig: webllm.prebuiltAppConfig });
      const current = engine;
      current.setInitProgressCallback((report) => loadOptions.onProgress?.(report.progress, report.text));
      const abort = () => {
        void current.unload();
      };
      loadOptions.signal.addEventListener('abort', abort);
      const started = now();
      try {
        await current.reload(modelId);
      } catch (error) {
        loadedModelId = null;
        if (loadOptions.signal.aborted) throw new BenchmarkRuntimeError('aborted', '読み込みを中止しました。');
        throw error;
      } finally {
        loadOptions.signal.removeEventListener('abort', abort);
        current.setInitProgressCallback(undefined);
      }
      if (loadOptions.signal.aborted) {
        await current.unload();
        loadedModelId = null;
        throw new BenchmarkRuntimeError('aborted', '読み込みを中止しました。');
      }
      loadedModelId = modelId;
      loadedThisSession.add(modelId);
      return { candidateId: candidate.id, kind, loadTimeMs: now() - started };
    },

    async generate(request: GenerationRequest): Promise<GenerationRecord> {
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
    },

    async unload() {
      if (engine !== null) await engine.unload();
      loadedModelId = null;
    },

    async deleteCache(candidate) {
      const modelId = modelIdOf(candidate);
      const webllm = await module();
      if (engine !== null && loadedModelId === modelId) {
        await engine.unload();
        loadedModelId = null;
      }
      // WebLLM の Cache Storage（webllm/*）の、このモデルの項目だけを消す。
      await webllm.deleteModelAllInfoInCache(modelId, webllm.prebuiltAppConfig);
      loadedThisSession.delete(modelId);
    },

    async cachedSizeBytes(candidate) {
      if (cacheStorage === null) return null;
      const record = await recordOf(candidate).catch(() => null);
      if (!record) return null;
      const modelBase = record.model.endsWith('/') ? record.model : `${record.model}/`;
      let total = 0;
      let counted = 0;
      for (const name of WEBLLM_CACHE_NAMES) {
        if (!(await cacheStorage.has(name))) continue;
        const cache = await cacheStorage.open(name);
        for (const request of await cache.keys()) {
          if (!request.url.startsWith(modelBase) && request.url !== record.model_lib) continue;
          const response = await cache.match(request);
          const length = Number(response?.headers.get('content-length'));
          if (Number.isFinite(length) && length > 0) {
            total += length;
            counted += 1;
          }
        }
      }
      return counted === 0 ? null : total;
    },
  };
}
