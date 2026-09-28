/**
 * AI 説明層（Beta）の公開 API。
 *
 * 画面や将来の AI Coach はここからだけ import する。
 * 依存の向きは engine → evidence → provider → presentation の一方向で、
 * engine / domain / data / storage からこのディレクトリを import してはいけない。
 */
export {
  buildDecisionEvidence,
  buildGameReviewEvidence,
  buildTrainingEvidence,
  serializeEvidence,
} from './evidence';
export { explainDecision, summarizeSession, DEFAULT_AI_TIMEOUT_MS } from './explain';
export type { ExplainOptions } from './explain';
export { isAiDeveloperGateOpen, AI_DEVELOPER_GATE_DEFAULT_OPEN } from './developerGate';
export { templateProvider, TEMPLATE_PROVIDER_ID } from './templateProvider';
export { AI_EVIDENCE_SCHEMA_VERSION } from './types';
export {
  DEFAULT_MODEL_CATALOG,
  LOCAL_AI_MODEL_CLASSES,
  LOCAL_AI_MODEL_CLASS_PROFILES,
  createModelCatalog,
} from './models/catalog';
export type {
  LocalAiModelCatalog,
  LocalAiModelClass,
  LocalAiModelDefinition,
} from './models/catalog';
export {
  activateModel,
  cancelDownload,
  clearActiveModel,
  completeDownload,
  createModelState,
  deleteModel,
  failDownload,
  modelStatusOf,
  restoreModelState,
  startDownload,
  updateDownloadProgress,
  MODEL_STATE_STORAGE_NAME,
} from './models/state';
export type { ModelManagerState, ModelRuntimeStatus } from './models/state';
export {
  AI_MODEL_CACHE_NAMESPACE,
  modelCacheNameOf,
  removeModel,
  resolveActiveProvider,
} from './models/runtime';
export type { LocalModelRuntime } from './models/runtime';
export type {
  AiCallContext,
  AiFallbackReason,
  AiProvider,
  AiProviderKind,
  AiResult,
  AiTextOutput,
  DecisionEvidence,
  GameReviewEvidence,
  SessionEvidence,
  TrainingEvidence,
} from './types';
