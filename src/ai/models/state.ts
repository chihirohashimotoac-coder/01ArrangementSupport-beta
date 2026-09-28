/**
 * ローカル AI モデルの状態（Model State）。
 *
 * 純粋関数だけで状態遷移を表す。実際のダウンロード・削除・推論は Model Runtime
 * （`runtime.ts` の `LocalModelRuntime`）の仕事で、ここは「いまどういう状態か」と
 * 「その操作をしてよいか」だけを決める。
 *
 * - 複数のモデルを導入（DOWNLOADED）でき、その中から 1 つを `activeModelId` として選ぶ
 * - 導入していないモデルは選べない
 * - 選択中のモデルを削除したら `activeModelId` は null（= 従来の 01AS として動作）に戻る
 * - この状態は Decision Engine・TRAINING / SIMULATION の履歴・GAME REVIEW・通常の設定を
 *   一切持たない・参照しない・変更しない（別の保存領域。`MODEL_STATE_STORAGE_NAME`）
 */
import type { LocalAiModelCatalog, LocalAiModelDefinition } from './catalog';

/** 導入状態（モデルごとに保存する値）。 */
export type ModelInstallStatus =
  /** 導入できる（未ダウンロード）。 */
  | 'AVAILABLE'
  | 'DOWNLOADING'
  /** 導入済み（端末に保存されている）。 */
  | 'DOWNLOADED'
  /** ダウンロード・検証に失敗した。再試行できる。 */
  | 'ERROR'
  /** この端末・ブラウザでは使えない。 */
  | 'UNSUPPORTED';

/** 画面に見せる状態。ACTIVE は「導入済みで、かつ選択中」。 */
export type ModelRuntimeStatus = ModelInstallStatus | 'ACTIVE';

export const MODEL_RUNTIME_STATUSES: readonly ModelRuntimeStatus[] = [
  'AVAILABLE',
  'DOWNLOADING',
  'DOWNLOADED',
  'ACTIVE',
  'ERROR',
  'UNSUPPORTED',
];

export interface ModelEntry {
  readonly status: ModelInstallStatus;
  /** DOWNLOADING のときの進捗（0〜1）。それ以外は null。 */
  readonly progress: number | null;
  /** ERROR / UNSUPPORTED の理由コード。 */
  readonly reason: string | null;
}

export interface ModelManagerState {
  readonly version: 1;
  readonly entries: Readonly<Record<string, ModelEntry>>;
  /** 使用中のモデル。null なら AI 機能は使わず、従来の 01AS として動作する。 */
  readonly activeModelId: string | null;
}

/**
 * モデル状態を保存するときの名前（Beta の保存層で `namespacedKey()` を付けて使う）。
 * 利用者データ（設定・学習履歴・SIMULATION 設定）とは別のキー。
 */
export const MODEL_STATE_STORAGE_NAME = 'ai.models.v1';

/** 端末・ブラウザの能力（Runtime が調べた結果を渡す）。 */
export interface ModelEnvironment {
  readonly webGpu: boolean;
}

export type ModelTransitionError =
  | 'unknown-model'
  | 'unsupported'
  | 'deprecated'
  | 'not-downloaded'
  | 'invalid-transition';

export type ModelTransition =
  | { readonly ok: true; readonly state: ModelManagerState }
  | { readonly ok: false; readonly state: ModelManagerState; readonly reason: ModelTransitionError };

const AVAILABLE_ENTRY: ModelEntry = { status: 'AVAILABLE', progress: null, reason: null };

function freezeState(state: ModelManagerState): ModelManagerState {
  const entries = Object.fromEntries(
    Object.entries(state.entries).map(([id, entry]) => [id, Object.freeze({ ...entry })]),
  );
  return Object.freeze({ ...state, entries: Object.freeze(entries) });
}

function supportOf(definition: LocalAiModelDefinition, environment: ModelEnvironment): ModelEntry {
  if (definition.requirements?.webGpu && !environment.webGpu) {
    return { status: 'UNSUPPORTED', progress: null, reason: 'webgpu-required' };
  }
  return AVAILABLE_ENTRY;
}

/** カタログと端末の能力から、初期状態（何も導入していない）を作る。 */
export function createModelState(
  catalog: LocalAiModelCatalog,
  environment: ModelEnvironment,
): ModelManagerState {
  return freezeState({
    version: 1,
    entries: Object.fromEntries(
      catalog.models.map((definition) => [definition.id, supportOf(definition, environment)]),
    ),
    activeModelId: null,
  });
}

/** 画面に見せる状態。カタログに無いモデルは null。 */
export function modelStatusOf(state: ModelManagerState, modelId: string): ModelRuntimeStatus | null {
  const entry = state.entries[modelId];
  if (!entry) return null;
  if (entry.status === 'DOWNLOADED' && state.activeModelId === modelId) return 'ACTIVE';
  return entry.status;
}

/** 導入済みのモデル（選択中を含む）。 */
export function downloadedModelIds(state: ModelManagerState): string[] {
  return Object.entries(state.entries)
    .filter(([, entry]) => entry.status === 'DOWNLOADED')
    .map(([id]) => id);
}

function reject(state: ModelManagerState, reason: ModelTransitionError): ModelTransition {
  return { ok: false, state, reason };
}

function withEntry(
  state: ModelManagerState,
  modelId: string,
  entry: ModelEntry,
  activeModelId: string | null = state.activeModelId,
): ModelTransition {
  return {
    ok: true,
    state: freezeState({ ...state, entries: { ...state.entries, [modelId]: entry }, activeModelId }),
  };
}

/** 明示的なダウンロードの開始。AVAILABLE / ERROR からだけ。 */
export function startDownload(
  state: ModelManagerState,
  catalog: LocalAiModelCatalog,
  modelId: string,
): ModelTransition {
  const definition = catalog.byId(modelId);
  const entry = state.entries[modelId];
  if (!definition || !entry) return reject(state, 'unknown-model');
  if (entry.status === 'UNSUPPORTED') return reject(state, 'unsupported');
  if (definition.status === 'deprecated') return reject(state, 'deprecated');
  if (entry.status !== 'AVAILABLE' && entry.status !== 'ERROR') {
    return reject(state, 'invalid-transition');
  }
  return withEntry(state, modelId, { status: 'DOWNLOADING', progress: 0, reason: null });
}

export function updateDownloadProgress(
  state: ModelManagerState,
  modelId: string,
  progress: number,
): ModelTransition {
  const entry = state.entries[modelId];
  if (!entry) return reject(state, 'unknown-model');
  if (entry.status !== 'DOWNLOADING') return reject(state, 'invalid-transition');
  const clamped = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  return withEntry(state, modelId, { ...entry, progress: clamped });
}

export function completeDownload(state: ModelManagerState, modelId: string): ModelTransition {
  const entry = state.entries[modelId];
  if (!entry) return reject(state, 'unknown-model');
  if (entry.status !== 'DOWNLOADING') return reject(state, 'invalid-transition');
  return withEntry(state, modelId, { status: 'DOWNLOADED', progress: null, reason: null });
}

export function failDownload(
  state: ModelManagerState,
  modelId: string,
  reason: string,
): ModelTransition {
  const entry = state.entries[modelId];
  if (!entry) return reject(state, 'unknown-model');
  if (entry.status !== 'DOWNLOADING') return reject(state, 'invalid-transition');
  return withEntry(state, modelId, { status: 'ERROR', progress: null, reason });
}

/** ダウンロードの中止。途中のファイルは Runtime が片付ける。 */
export function cancelDownload(state: ModelManagerState, modelId: string): ModelTransition {
  const entry = state.entries[modelId];
  if (!entry) return reject(state, 'unknown-model');
  if (entry.status !== 'DOWNLOADING') return reject(state, 'invalid-transition');
  return withEntry(state, modelId, AVAILABLE_ENTRY);
}

/** 使用するモデルを選ぶ（切り替えも同じ）。導入済みのモデルだけ。 */
export function activateModel(state: ModelManagerState, modelId: string): ModelTransition {
  const entry = state.entries[modelId];
  if (!entry) return reject(state, 'unknown-model');
  if (entry.status === 'UNSUPPORTED') return reject(state, 'unsupported');
  if (entry.status !== 'DOWNLOADED') return reject(state, 'not-downloaded');
  return { ok: true, state: freezeState({ ...state, activeModelId: modelId }) };
}

/** どのモデルも使わない（従来の 01AS）に戻す。導入済みのモデルは残す。 */
export function clearActiveModel(state: ModelManagerState): ModelManagerState {
  return freezeState({ ...state, activeModelId: null });
}

/**
 * 導入済みのモデルを削除した後の状態。選択中だった場合は `activeModelId` を null に戻す
 * （別のモデルへ勝手に切り替えない。利用者が改めて選ぶまで従来の 01AS として動作する）。
 *
 * 消えるのはモデルの状態だけ。利用者データ（設定・学習履歴・SIMULATION 設定）には触れない。
 */
export function deleteModel(state: ModelManagerState, modelId: string): ModelTransition {
  const entry = state.entries[modelId];
  if (!entry) return reject(state, 'unknown-model');
  if (entry.status !== 'DOWNLOADED' && entry.status !== 'ERROR') {
    return reject(state, 'invalid-transition');
  }
  const activeModelId = state.activeModelId === modelId ? null : state.activeModelId;
  return withEntry(state, modelId, AVAILABLE_ENTRY, activeModelId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 保存していた状態を、現在のカタログ・端末に合わせて復元する。
 *
 * - カタログから消えたモデルは捨てる（選択中なら選択を外す）
 * - 中断されたダウンロード（DOWNLOADING）は AVAILABLE へ戻す
 * - この端末で使えないモデルは UNSUPPORTED にし、選択中なら選択を外す
 * - 壊れた値は初期状態へ戻す（例外を投げない）
 */
export function restoreModelState(
  raw: unknown,
  catalog: LocalAiModelCatalog,
  environment: ModelEnvironment,
): ModelManagerState {
  const initial = createModelState(catalog, environment);
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.entries)) return initial;

  const entries: Record<string, ModelEntry> = { ...initial.entries };
  for (const definition of catalog.models) {
    const stored = raw.entries[definition.id];
    if (!isRecord(stored) || entries[definition.id].status === 'UNSUPPORTED') continue;
    if (stored.status === 'DOWNLOADED') {
      entries[definition.id] = { status: 'DOWNLOADED', progress: null, reason: null };
    } else if (stored.status === 'ERROR') {
      entries[definition.id] = {
        status: 'ERROR',
        progress: null,
        reason: typeof stored.reason === 'string' ? stored.reason : null,
      };
    }
  }
  const active = typeof raw.activeModelId === 'string' ? raw.activeModelId : null;
  const activeModelId = active !== null && entries[active]?.status === 'DOWNLOADED' ? active : null;
  return freezeState({ version: 1, entries, activeModelId });
}
