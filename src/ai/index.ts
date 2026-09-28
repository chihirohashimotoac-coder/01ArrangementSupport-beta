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
export { isAiFeatureEnabled, AI_FEATURES_DEFAULT_ENABLED } from './featureFlag';
export { templateProvider, TEMPLATE_PROVIDER_ID } from './templateProvider';
export { AI_EVIDENCE_SCHEMA_VERSION } from './types';
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
