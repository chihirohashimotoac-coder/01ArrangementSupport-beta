/**
 * AI 説明の安全な呼び出し口。
 *
 * UI や将来の AI Coach は Provider を直接呼ばず、必ずここを通す。
 *
 *   1. Evidence を検証する（足りなければ `insufficient-evidence`。事実を補わない）
 *   2. feature flag が OFF / Provider 未設定なら、決定論的な説明を返す
 *   3. Provider を凍結した Evidence の複製で呼ぶ（タイムアウト付き）
 *   4. 返り値の形と、Evidence に無い主張が無いかを検証する
 *   5. どこかで失敗したら決定論的な説明へ切り替える
 *
 * この関数は**例外を投げない**。AI 側で何が起きても、アプリ本体（engine・画面）は
 * これまでどおり動く。返すのは説明文だけで、engine の結果を書き換える値は返さない。
 */
import { deepFreeze } from './evidence';
import { isAiFeatureEnabled } from './featureFlag';
import {
  explainDecisionDeterministically,
  summarizeSessionDeterministically,
  TEMPLATE_PROVIDER_ID,
} from './templateProvider';
import type {
  AiCallContext,
  AiEvidence,
  AiFallbackReason,
  AiProvider,
  AiResult,
  AiTextOutput,
  DecisionEvidence,
  SessionEvidence,
} from './types';
import {
  checkDecisionEvidence,
  checkOutputShape,
  checkSessionEvidence,
  findUnsupportedClaims,
  type EvidenceCheck,
} from './validation';

/** Provider の応答を待つ上限。超えたら決定論的な説明へ切り替える。 */
export const DEFAULT_AI_TIMEOUT_MS = 8000;

export interface ExplainOptions {
  /** 使う Provider。未設定なら決定論的な説明だけを返す。 */
  readonly provider?: AiProvider | null;
  /** feature flag。省略時はビルド設定（既定 OFF）。 */
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
}

class AiTimeoutError extends Error {}

function cloneForProvider<T extends AiEvidence>(evidence: T): T {
  // Evidence は JSON で表せる形に限っている。複製して凍結し、engine 側の値と切り離す。
  return deepFreeze(JSON.parse(JSON.stringify(evidence)) as T);
}

async function withTimeout(
  call: (context: AiCallContext) => Promise<AiTextOutput>,
  timeoutMs: number,
): Promise<AiTextOutput> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiTimeoutError());
    }, timeoutMs);
  });
  try {
    // 同期的に throw する Provider も Promise の失敗として扱う。
    const pending = Promise.resolve().then(() =>
      call({ signal: controller.signal, locale: 'ja' }),
    );
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Route<E extends AiEvidence> {
  readonly check: (evidence: unknown) => EvidenceCheck;
  readonly fallback: (evidence: E) => AiTextOutput;
  readonly method: (provider: AiProvider) =>
    | ((evidence: E, context: AiCallContext) => Promise<AiTextOutput>)
    | undefined;
}

function fallbackResult<E extends AiEvidence>(
  route: Route<E>,
  evidence: E,
  reason: AiFallbackReason,
  issues: readonly string[] = [],
): AiResult {
  const output = route.fallback(evidence);
  return {
    status: 'ok',
    text: output.text,
    source: 'fallback',
    providerId: TEMPLATE_PROVIDER_ID,
    fallbackReason: reason,
    issues,
    citedReasonCodes: output.citedReasonCodes ?? [],
  };
}

async function run<E extends AiEvidence>(
  route: Route<E>,
  evidence: E,
  options: ExplainOptions,
): Promise<AiResult> {
  const check = route.check(evidence);
  if (!check.ok) return { status: 'insufficient-evidence', missing: check.missing };

  const enabled = options.enabled ?? isAiFeatureEnabled();
  const provider = options.provider ?? null;
  if (!enabled || provider === null) return fallbackResult(route, evidence, 'disabled');

  const method = route.method(provider);
  if (typeof method !== 'function') return fallbackResult(route, evidence, 'unsupported');

  const frozen = cloneForProvider(evidence);
  let output: unknown;
  try {
    output = await withTimeout(
      (context) => method.call(provider, frozen, context),
      options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
    );
  } catch (error) {
    const reason = error instanceof AiTimeoutError ? 'timeout' : 'error';
    return fallbackResult(route, evidence, reason, [String(error)]);
  }

  const shapeProblem = checkOutputShape(output);
  if (shapeProblem !== null) {
    return fallbackResult(route, evidence, 'invalid-response', [shapeProblem]);
  }
  const accepted = output as AiTextOutput;
  const issues = findUnsupportedClaims(accepted, evidence);
  if (issues.length > 0) return fallbackResult(route, evidence, 'unsupported-claim', issues);

  return {
    status: 'ok',
    text: accepted.text,
    source: 'provider',
    providerId: provider.id,
    fallbackReason: null,
    issues: [],
    citedReasonCodes: [...(accepted.citedReasonCodes ?? [])],
  };
}

const DECISION_ROUTE: Route<DecisionEvidence> = {
  check: checkDecisionEvidence,
  fallback: explainDecisionDeterministically,
  method: (provider) => provider.explainDecision,
};

const SESSION_ROUTE: Route<SessionEvidence> = {
  check: checkSessionEvidence,
  fallback: summarizeSessionDeterministically,
  method: (provider) => provider.summarizeSession,
};

/** CHECKOUT / SETUP の 1 場面について、engine の判断を説明する。 */
export function explainDecision(
  evidence: DecisionEvidence,
  options: ExplainOptions = {},
): Promise<AiResult> {
  return run(DECISION_ROUTE, evidence, options).catch(() => safetyNet(DECISION_ROUTE, evidence));
}

/** GAME REVIEW / TRAINING 履歴を要約する。 */
export function summarizeSession(
  evidence: SessionEvidence,
  options: ExplainOptions = {},
): Promise<AiResult> {
  return run(SESSION_ROUTE, evidence, options).catch(() => safetyNet(SESSION_ROUTE, evidence));
}

/** 想定外の失敗でも例外を外へ出さない最後の受け皿。 */
function safetyNet<E extends AiEvidence>(route: Route<E>, evidence: E): AiResult {
  try {
    return fallbackResult(route, evidence, 'error');
  } catch {
    return { status: 'insufficient-evidence', missing: ['evidence'] };
  }
}
