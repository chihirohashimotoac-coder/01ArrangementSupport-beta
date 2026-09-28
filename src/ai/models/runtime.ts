/**
 * Model Runtime の境界と、Provider abstraction との接続点。
 *
 *   AI Explanation Layer（explain.ts）
 *        ↓ AiProvider
 *   AI Provider（選択中のモデル用に Runtime が作る）
 *        ↓
 *   Model Runtime（LocalModelRuntime。将来のブラウザ内推論の実装）
 *        ↓
 *   Active Local Model（activeModelId のモデル）
 *
 * このファイルには interface と、状態から Provider を解決する関数だけを置く。
 * **実際のダウンロード・推論の実装はまだ無い**（WebGPU 推論・モデル取得は別 PR）。
 */
import type { AiProvider } from '../types';
import type { LocalAiModelCatalog, LocalAiModelDefinition } from './catalog';
import { deleteModel, modelStatusOf, type ModelManagerState, type ModelTransition } from './state';

/**
 * モデルのファイルを置く Cache Storage / IndexedDB の名前の接頭辞。
 *
 * - 利用者データ（localStorage の `01as-beta:` キー）とは別の保存領域
 * - アプリ本体のオフライン用キャッシュ（Workbox の `01as-beta-precache-…`）とも別の名前
 *
 * モデルを削除するときに消してよいのは、この接頭辞を持つ保存領域だけ。
 */
export const AI_MODEL_CACHE_NAMESPACE = '01as-beta-ai-model:';

export function modelCacheNameOf(definition: LocalAiModelDefinition): string {
  return `${AI_MODEL_CACHE_NAMESPACE}${definition.id}`;
}

export function isModelCacheName(name: string): boolean {
  return name.startsWith(AI_MODEL_CACHE_NAMESPACE) && name.length > AI_MODEL_CACHE_NAMESPACE.length;
}

export interface ModelDownloadOptions {
  readonly signal: AbortSignal;
  /** 0〜1。 */
  readonly onProgress: (fraction: number) => void;
}

/**
 * Model Runtime。モデルの取得・削除・推論を担う実装の境界。
 *
 * 実装は `modelCacheNameOf()` の保存領域だけを読み書き・削除し、利用者データへ触れない。
 * 返す AiProvider は Evidence を受け取り説明文を返すだけ（`AiProvider` の約束どおり）。
 */
export interface LocalModelRuntime {
  readonly id: string;
  /** この端末・ブラウザで動かせるか（WebGPU・メモリ等を調べる）。 */
  checkSupport(definition: LocalAiModelDefinition): Promise<{ supported: boolean; reason?: string }>;
  /** 利用者が明示的に選んだときだけ呼ぶ。 */
  download(definition: LocalAiModelDefinition, options: ModelDownloadOptions): Promise<void>;
  /** モデルのファイル（`modelCacheNameOf`）だけを削除する。 */
  remove(definition: LocalAiModelDefinition): Promise<void>;
  /** 導入済みのモデルで説明を生成する Provider を作る。 */
  createProvider(definition: LocalAiModelDefinition): Promise<AiProvider>;
}

export type ActiveProviderResolution =
  | { readonly provider: AiProvider; readonly modelId: string; readonly reason: null }
  | {
      readonly provider: null;
      readonly modelId: string | null;
      readonly reason:
        | 'developer-gate-closed'
        | 'no-active-model'
        | 'model-not-in-catalog'
        | 'runtime-not-found'
        | 'runtime-error';
    };

/**
 * Developer Gate と選択中のモデルから、説明に使う Provider を解決する。
 *
 * どこかで失敗したら `provider: null` を返し、呼び出し側（explain.ts）は従来の 01AS の
 * 説明へ切り替える。例外を投げない。
 */
export async function resolveActiveProvider(input: {
  readonly developerGateOpen: boolean;
  readonly state: ModelManagerState;
  readonly catalog: LocalAiModelCatalog;
  readonly runtimes: readonly LocalModelRuntime[];
}): Promise<ActiveProviderResolution> {
  const { state, catalog } = input;
  if (!input.developerGateOpen) {
    return { provider: null, modelId: state.activeModelId, reason: 'developer-gate-closed' };
  }
  const modelId = state.activeModelId;
  if (modelId === null || modelStatusOf(state, modelId) !== 'ACTIVE') {
    return { provider: null, modelId: null, reason: 'no-active-model' };
  }
  const definition = catalog.byId(modelId);
  if (!definition) return { provider: null, modelId, reason: 'model-not-in-catalog' };
  const runtime = input.runtimes.find((candidate) => candidate.id === definition.runtimeId);
  if (!runtime) return { provider: null, modelId, reason: 'runtime-not-found' };
  try {
    const provider = await runtime.createProvider(definition);
    return { provider, modelId, reason: null };
  } catch {
    return { provider: null, modelId, reason: 'runtime-error' };
  }
}

/**
 * 導入済みのモデルを削除する。Runtime にモデルのファイルだけを消させ、状態を更新する。
 *
 * 利用者データ（設定・学習履歴・SIMULATION 設定・GAME REVIEW）はこの経路に一切現れない。
 * Runtime の削除に失敗した場合は状態を変えない（まだファイルが残っている可能性があるため）。
 */
export async function removeModel(input: {
  readonly state: ModelManagerState;
  readonly catalog: LocalAiModelCatalog;
  readonly runtimes: readonly LocalModelRuntime[];
  readonly modelId: string;
}): Promise<ModelTransition | { readonly ok: false; readonly state: ModelManagerState; readonly reason: 'runtime-error' | 'runtime-not-found' }> {
  const { state, catalog, modelId } = input;
  const definition = catalog.byId(modelId);
  const check = deleteModel(state, modelId);
  if (!definition || !check.ok) return check;
  const runtime = input.runtimes.find((candidate) => candidate.id === definition.runtimeId);
  if (!runtime) return { ok: false, state, reason: 'runtime-not-found' };
  try {
    await runtime.remove(definition);
  } catch {
    return { ok: false, state, reason: 'runtime-error' };
  }
  return check;
}
