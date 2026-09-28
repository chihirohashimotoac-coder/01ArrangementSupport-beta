/**
 * AI 説明層（Beta）の型。
 *
 * Deterministic Engine decides. AI explains.
 *
 * ここにある型は「engine が決めた結果を、AI へ渡してよい形にしたもの（Evidence）」と
 * 「AI が返してよいもの（説明文）」だけ。AI の出力を engine の型へ戻す経路は作らない。
 * モデル固有の型（トークン・プロンプト形式・SDK の型）をアプリ全体へ漏らさないため、
 * Provider との境界はプレーンな文字列と Evidence に限定する。
 */
import type { RouteGrade } from '../data/rankingRules';
import type { ReasonPolarity } from '../domain/reasonCodes';
import type { NextVisitProposalKind } from '../engine/recovery/nextVisitSelection';
import type { ThrowReviewReason, ThrowVerdict } from '../engine/simulation/review';

/** Evidence の形を変えたら上げる。Provider 側のプロンプトやキャッシュの互換判定に使う。 */
export const AI_EVIDENCE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Evidence（engine → AI）
// ---------------------------------------------------------------------------

/** engine が付けた評価理由 1 つ。文面は data/explanations.ts が engine の値から組み立てたもの。 */
export interface EvidenceReason {
  /** CheckoutReasonCode | SetupReasonCode。 */
  readonly code: string;
  readonly polarity: ReasonPolarity;
  readonly label: string;
  readonly summaryJa: string;
}

/** engine が評価したルート 1 本。 */
export interface RouteEvidence {
  /** engine が返した順位（1 始まり）。Evidence 側で並べ替えない。 */
  readonly rank: number;
  readonly dartIds: readonly string[];
  readonly routeText: string;
  readonly grade: RouteGrade;
  /** CHECKOUT の基準ルートか。SETUP / NEXT VISIT では null。 */
  readonly isStandard: boolean | null;
  /** このビジットで取る点数（SETUP / NEXT VISIT）。CHECKOUT では null。 */
  readonly scored: number | null;
  /** ルートを投げ切ったあとの残り。CHECKOUT（上がり）では 0。 */
  readonly leave: number;
  readonly reasons: readonly EvidenceReason[];
}

export interface NextVisitProposalEvidence {
  readonly kind: NextVisitProposalKind;
  readonly finishDoubleId: string | null;
  readonly sameTarget: boolean;
  readonly route: RouteEvidence;
}

/**
 * 場面の種類。
 *
 * - `CHECKOUT`: 2〜170 で、残り本数で上がれる
 * - `SETUP`: 171〜350
 * - `NEXT_VISIT`: 2〜170 だが残り本数では上がれない（次ラウンドへの残し）
 * - `UNAVAILABLE`: engine が提案を出さない場面
 */
export type DecisionMode = 'CHECKOUT' | 'SETUP' | 'NEXT_VISIT' | 'UNAVAILABLE';

/** CHECKOUT / SETUP の 1 場面について、AI が説明に使ってよい事実。 */
export interface DecisionEvidence {
  readonly schemaVersion: typeof AI_EVIDENCE_SCHEMA_VERSION;
  readonly kind: 'decision';
  readonly mode: DecisionMode;
  readonly remaining: number;
  readonly dartsLeft: number;
  readonly isBogey: boolean;
  /** SETUP でテンパイを作れるか（engine の判定）。CHECKOUT では null。 */
  readonly canReachTenpai: boolean | null;
  /** ちょうど 100 点を取ると Bogey になる場合の残り。 */
  readonly tonTrapLeave: number | null;
  /** engine が出した注意書き（上がれない・テンパイを作れない等）。 */
  readonly engineNoteJa: string | null;
  /** 最後の 1 本で、基準例より実戦的な的（engine の判定）。 */
  readonly practicalLastDartId: string | null;
  /** engine が返した候補の総数（`routes` は先頭から切り詰めることがある）。 */
  readonly totalRouteCount: number;
  /** CHECKOUT / SETUP の候補（engine の順）。 */
  readonly routes: readonly RouteEvidence[];
  /** NEXT VISIT の提案（engine の順）。 */
  readonly nextVisitProposals: readonly NextVisitProposalEvidence[];
}

/** GAME REVIEW の 1 投。 */
export interface ThrowEvidence {
  readonly round: number;
  readonly dartNumber: number;
  readonly leftBefore: number;
  readonly intendedDartId: string;
  readonly actualDartId: string;
  readonly leftAfter: number;
  readonly bust: boolean;
  readonly checkout: boolean;
  readonly verdict: ThrowVerdict;
  readonly verdictJa: string;
  readonly grade: RouteGrade | null;
  readonly recommendedDartId: string | null;
  /** 判定の決め手（構造化されている経路だけ）。 */
  readonly reasonCode: ThrowReviewReason['code'] | null;
}

export interface GameReviewEvidence {
  readonly schemaVersion: typeof AI_EVIDENCE_SCHEMA_VERSION;
  readonly kind: 'game-review';
  readonly summary: {
    readonly startScore: number;
    readonly totalDarts: number;
    /** 小数第 1 位へ丸めた 3 ダーツ平均。 */
    readonly ppr: number;
    readonly first9Ppr: number;
    readonly bustCount: number;
    readonly calculationMissCount: number;
    readonly checkedOut: boolean;
    readonly checkoutDarts: number | null;
    readonly checkoutScore: number | null;
    readonly abandoned: boolean;
  };
  readonly verdictCounts: Readonly<Record<ThrowVerdict, number>>;
  /** 採点対象（SCORING_PHASE 以外）の投。 */
  readonly throws: readonly ThrowEvidence[];
  readonly omittedThrowCount: number;
}

export interface TrainingBreakdownEvidence {
  readonly key: string;
  readonly attempts: number;
  readonly correct: number;
  /** 0〜100 の整数。 */
  readonly accuracyPercent: number;
}

export interface TrainingEvidence {
  readonly schemaVersion: typeof AI_EVIDENCE_SCHEMA_VERSION;
  readonly kind: 'training';
  readonly attempts: number;
  readonly correct: number;
  readonly accuracyPercent: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
  readonly discouragedChoices: number;
  readonly byGrade: Readonly<Record<RouteGrade | 'invalid', number>>;
  readonly byCategory: readonly TrainingBreakdownEvidence[];
  /** 正答率が低い残り点（集計側の順）。 */
  readonly weakScores: readonly number[];
  /** 直近で間違えた残り点（集計側の順）。 */
  readonly recentMistakes: readonly number[];
}

export type SessionEvidence = GameReviewEvidence | TrainingEvidence;

export type AiEvidence = DecisionEvidence | SessionEvidence;

// ---------------------------------------------------------------------------
// Provider（AI → 説明文）
// ---------------------------------------------------------------------------

/** どこで推論するか。モデル名ではなく実行場所で分類する。 */
export type AiProviderKind = 'deterministic' | 'browser-local' | 'remote';

export interface AiCallContext {
  /** タイムアウト・画面遷移で中断されたら abort される。 */
  readonly signal: AbortSignal;
  readonly locale: 'ja';
}

/** Provider が返してよいもの。説明文と、根拠にした reason code だけ。 */
export interface AiTextOutput {
  readonly text: string;
  /** 説明の根拠にした reason code。Evidence に無いコードを挙げたら不採用。 */
  readonly citedReasonCodes?: readonly string[];
}

/**
 * AI Provider の境界。
 *
 * Provider は Evidence を受け取り、説明文を返すだけ。engine の関数・state・戦術データへは
 * 触れない（受け取る Evidence は凍結された複製）。必須は `explainDecision` だけで、
 * それ以外は対応していなければ省略してよい（呼び出し側が決定論的な説明へ切り替える）。
 */
export interface AiProvider {
  readonly id: string;
  readonly kind: AiProviderKind;
  explainDecision(evidence: DecisionEvidence, context: AiCallContext): Promise<AiTextOutput>;
  summarizeSession?(evidence: SessionEvidence, context: AiCallContext): Promise<AiTextOutput>;
}

// ---------------------------------------------------------------------------
// 呼び出し結果
// ---------------------------------------------------------------------------

/** Provider の説明を使わず、決定論的な説明へ切り替えた理由。 */
export type AiFallbackReason =
  /** feature flag が OFF、または Provider が設定されていない。 */
  | 'disabled'
  /** Provider がその機能に対応していない。 */
  | 'unsupported'
  /** Provider が例外を投げた（読み込み失敗・ブラウザ非対応を含む）。 */
  | 'error'
  | 'timeout'
  /** 返り値の形が不正（文字列でない・空・長すぎる）。 */
  | 'invalid-response'
  /** Evidence に無い事実（的・推奨度・数値・reason code）を含む。 */
  | 'unsupported-claim';

export type AiResult =
  | {
      readonly status: 'ok';
      readonly text: string;
      /** `provider`: Provider の説明を採用 / `fallback`: 決定論的な説明。 */
      readonly source: 'provider' | 'fallback';
      readonly providerId: string;
      readonly fallbackReason: AiFallbackReason | null;
      /** 不採用にした Provider 出力の問題点（fallback のときだけ）。 */
      readonly issues: readonly string[];
      readonly citedReasonCodes: readonly string[];
    }
  | {
      /** Evidence が足りない。AI にも template にも事実を補わせない。 */
      readonly status: 'insufficient-evidence';
      readonly missing: readonly string[];
    };
