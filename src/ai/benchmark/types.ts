/**
 * AI Model Benchmark Lab の型（Beta・開発者向け）。
 *
 * 目的は「モデルを採用すること」ではなく「モデルを公平に採用判断できる状態を作ること」。
 *
 *   Candidate Model → 同じ 01AS Evidence → 説明を生成 → 自動検証 → 性能計測 → 比較できる結果
 *
 * ここにある型は Evidence（engine の結果を写したもの）と、モデルが返した文字列と、
 * 計測値だけを扱う。モデルの出力を engine の型へ戻す経路は作らない。
 */
import type { DecisionEvidence, GameReviewEvidence } from '../types';
import type { ModelStorageBackend } from './modelStorage';

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/** ケースの主分類（場面の種類）。 */
export const BENCHMARK_CATEGORIES = [
  'CHECKOUT',
  'SETUP',
  'NEXT_VISIT',
  'RECOVERY',
  'SIMULATION_REVIEW',
] as const;
export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

/**
 * ケースの観点タグ。**Evidence の内容から機械的に導く**（`tags.ts`）。人手で付けない。
 * 1 ケースに複数付く。
 */
export const BENCHMARK_TAGS = [
  'one-dart-checkout',
  'two-dart-checkout',
  'three-dart-checkout',
  'low-score-checkout',
  'high-score-setup',
  'bull-finish',
  'single-miss-safety',
  'neighbor-safety',
  'bogey-avoidance',
  'ton-trap',
  'multiple-valid-routes',
  'good-better-distinction',
  'miss-recovery',
] as const;
export type BenchmarkTag = (typeof BENCHMARK_TAGS)[number];

/**
 * RECOVERY の場面で、直前の 1 投に起きたこと。
 *
 * 狙い（intendedDartId）は engine の第 1 候補の 1 投目、着弾（actualDartId）は
 * データセットの定義どおりの外れ方、leftAfter は着弾の得点を引いた値（算数）。
 */
export interface PreviousThrowEvidence {
  readonly leftBefore: number;
  readonly dartsLeftBefore: number;
  readonly intendedDartId: string;
  readonly actualDartId: string;
  /** single: 同じナンバーのシングル / neighbor: 隣のナンバー / outside: 盤外。 */
  readonly missKind: 'single' | 'neighbor' | 'outside';
  readonly leftAfter: number;
}

/** 1 ケースでモデルへ渡す Evidence。 */
export type BenchmarkInput =
  | {
      readonly kind: 'decision';
      readonly decision: DecisionEvidence;
      /** RECOVERY のときだけ。 */
      readonly previousThrow: PreviousThrowEvidence | null;
    }
  | {
      readonly kind: 'game-review';
      readonly review: GameReviewEvidence;
    };

export interface BenchmarkCase {
  /** データセット内で安定した ID（例: CO-170-3）。 */
  readonly id: string;
  readonly category: BenchmarkCategory;
  readonly tags: readonly BenchmarkTag[];
  /** 画面・export 用の短い説明（事実だけ）。 */
  readonly titleJa: string;
  readonly input: BenchmarkInput;
}

export interface BenchmarkDataset {
  /** 例: 01as-core */
  readonly id: string;
  /** ケースの選び方・Evidence の形を変えたら上げる。 */
  readonly version: number;
  readonly labelJa: string;
  readonly cases: readonly BenchmarkCase[];
  /** 全ケースの Evidence から計算した指紋（`datasetFingerprint`）。 */
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface BuiltPrompt {
  /** 例: 01as-explain-ja@1 */
  readonly promptVersion: string;
  readonly messages: readonly ChatMessage[];
  /** messages から計算した指紋。同じ Evidence・同じ版なら同じ値。 */
  readonly promptHash: string;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export const BENCHMARK_RUNTIME_KINDS = [
  'webllm',
  'transformers-js',
  'other-browser-runtime',
  'not-currently-practical',
] as const;
/** 候補モデルを動かす Runtime の分類（`candidates.ts` の判定に使う）。 */
export type BenchmarkRuntimeKind = (typeof BENCHMARK_RUNTIME_KINDS)[number];

/**
 * thinking（推論の本文）を出すモデルでの扱い。
 *
 * - `off`: 01AS の既定。Evidence の説明に長い推論は不要で、latency と unsupported claim を増やすだけ
 * - `on`: 比較計測用
 * - `not-applicable`: thinking の切り替えを持たないモデル
 */
export type ThinkingMode = 'off' | 'on' | 'not-applicable';

export interface GenerationRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed: number;
  readonly thinking: ThinkingMode;
  readonly signal: AbortSignal;
  /**
   * ケースの Evidence。**決定論的な baseline（template）だけが読む**。
   * 実モデルの Runtime は messages だけを使う（同じ入力で比べるため）。
   */
  readonly input: BenchmarkInput;
}

export interface GenerationRecord {
  /** モデルが返した文字列そのまま（thinking を含むことがある）。 */
  readonly rawText: string;
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  /** 要求から最初のトークン（thinking を含む）までの時間（クライアント計測）。 */
  readonly timeToFirstTokenMs: number | null;
  /** 要求から、thinking の外の最初の文字までの時間（クライアント計測）。 */
  readonly timeToFirstVisibleTokenMs: number | null;
  /** 要求から最後のトークンまでの時間（クライアント計測）。 */
  readonly generationTimeMs: number;
  /** Runtime が報告した decode の tokens/s（無ければ null）。 */
  readonly runtimeDecodeTokensPerSecond: number | null;
  readonly finishReason: string | null;
}

/**
 * モデルの読み込みの種類。
 *
 * - `download`: 読み込み前にキャッシュが無かった（取得を含む）
 * - `cache-cold`: キャッシュはあり、このページで初めての読み込み
 * - `cache-warm`: このページで一度読み込んだことがある
 * - `already-loaded`: すでに読み込み済みで何もしなかった
 */
export type LoadKind = 'download' | 'cache-cold' | 'cache-warm' | 'already-loaded';

export interface LoadRecord {
  readonly candidateId: string;
  readonly kind: LoadKind;
  readonly loadTimeMs: number;
}

export interface LoadOptions {
  /**
   * キャッシュに無いときに取得してよいか。**利用者が Download を明示的に押したときだけ true**。
   * false でキャッシュに無ければ `not-downloaded` で失敗する。
   */
  readonly allowDownload: boolean;
  readonly signal: AbortSignal;
  readonly onProgress?: (fraction: number, text: string) => void;
}

/**
 * モデルのファイルを保存する Runtime の、保存方式に関する部分（`modelStorage.ts`）。
 *
 * 1 つの Runtime は 1 つの保存方式だけを使う（存在確認・取得・読み込み・削除で方式を混ぜない）。
 * 方式を変えるときは Runtime を作り直す。
 */
export interface RuntimeModelStorage {
  /** この Runtime が取得・読み込み・削除に使う保存方式。 */
  readonly backend: ModelStorageBackend;
  /**
   * 指定した方式に、その候補のモデルがあるか（**取得も保存領域の作成もしない**）。
   * 分からなければ null。保存方式が違えば、同じモデル ID でも保存場所は別。
   */
  isCachedIn(candidate: BenchmarkCandidate, backend: ModelStorageBackend): Promise<boolean | null>;
}

/** 候補モデルを Lab から動かす Runtime。実装は `runtimes/`。 */
export interface BenchmarkRuntime {
  readonly id: string;
  readonly kind: BenchmarkRuntimeKind | 'deterministic' | 'mock';
  readonly labelJa: string;
  /** この Runtime でその候補を扱えるか（WebGPU 等の端末判定は `device.ts`）。 */
  supports(candidate: BenchmarkCandidate): boolean;
  /** キャッシュに入っているか。判定できなければ null。**取得はしない**。 */
  isCached(candidate: BenchmarkCandidate): Promise<boolean | null>;
  load(candidate: BenchmarkCandidate, options: LoadOptions): Promise<LoadRecord>;
  generate(request: GenerationRequest): Promise<GenerationRecord>;
  unload(): Promise<void>;
  /** その候補のモデルのキャッシュだけを消す。利用者データへは触れない。 */
  deleteCache(candidate: BenchmarkCandidate): Promise<void>;
  /**
   * この Runtime の保存方式に保存されたモデルのサイズ（byte）。正確に数えられなければ null（不明）。
   * 誤った値（0 B など）より null を返す。
   */
  cachedSizeBytes(candidate: BenchmarkCandidate): Promise<number | null>;
  /** モデルのファイルを保存する Runtime だけが持つ（baseline には無い）。 */
  readonly modelStorage?: RuntimeModelStorage;
}

export type BenchmarkRuntimeErrorCode =
  | 'not-downloaded'
  | 'not-loaded'
  | 'unsupported'
  | 'runtime-unavailable'
  | 'aborted'
  | 'generation-failed';

export class BenchmarkRuntimeError extends Error {
  readonly code: BenchmarkRuntimeErrorCode;

  constructor(code: BenchmarkRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'BenchmarkRuntimeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/** 採用の状態。**結果が出る前に STANDARD などへ固定しない**。 */
export type AdoptionStatus =
  /** 未計測。 */
  | 'NOT_EVALUATED'
  /** 計測中・計測済みで判断待ち。 */
  | 'UNDER_EVALUATION'
  /** 人間が採用を承認した（docs/APPROVALS.md へ記録）。 */
  | 'ADOPTED'
  | 'REJECTED';

/** Lab での扱い。 */
export type LabAvailability =
  /** Lab から Download・Benchmark を実行できる。 */
  | 'RUNNABLE'
  /** 追加の Runtime が必要。評価対象として記録だけ残す。 */
  | 'EXPERIMENTAL'
  /** いまはブラウザで現実的に動かせない。 */
  | 'NOT_CURRENTLY_PRACTICAL';

export type ProvisionalModelClass = 'ULTRA_LIGHT' | 'LIGHT' | 'STANDARD' | 'QUALITY' | 'EXPERIMENTAL';

export interface BenchmarkCandidate {
  /** Lab 内の安定 ID。 */
  readonly id: string;
  readonly displayName: string;
  readonly family: string;
  /** 表示用のパラメータ規模（例: 1.7B）。 */
  readonly parameterSize: string;
  /** 量子化方式（例: q4f16_1）。分からなければ null。 */
  readonly quantization: string | null;
  /** `deterministic` は比較の基準線（モデルを使わない template）。 */
  readonly runtime: BenchmarkRuntimeKind | 'deterministic';
  /** Runtime に渡すモデル ID。Lab で動かせない候補は null。 */
  readonly runtimeModelId: string | null;
  readonly labAvailability: LabAvailability;
  /**
   * 想定 class（**仮説**）。計測結果と人間の承認で確定するまで、Model Catalog の class にはしない。
   */
  readonly provisionalClass: ProvisionalModelClass;
  readonly license: string;
  /** 日本語対応の記述（出典つきの要約。docs/AI_MODEL_BENCHMARK.md）。 */
  readonly japaneseSupport: 'listed' | 'not-listed' | 'unknown';
  /** 取得サイズ（byte）。未計測なら null（取得後に Cache から計測する）。 */
  readonly downloadSizeBytes: number | null;
  /** Runtime の設定が示す VRAM の目安（byte）。無ければ null。 */
  readonly estimatedVramBytes: number | null;
  /** WebGPU の必須 feature（例: shader-f16）。 */
  readonly requiredGpuFeatures: readonly string[];
  /** Runtime の設定が「低リソース端末向け」としているか。不明なら null。 */
  readonly lowResourceRequired: boolean | null;
  readonly contextWindow: number | null;
  /** thinking の ON / OFF を切り替えられるか。 */
  readonly supportsThinkingToggle: boolean;
  readonly adoptionStatus: AdoptionStatus;
  readonly notesJa: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface StyleFlags {
  /** 出力が長すぎる（`MAX_EXPLANATION_CHARS` 超）。 */
  readonly tooLong: boolean;
  readonly tooShort: boolean;
  /** 日本語の文字の割合が低い。 */
  readonly lowJapaneseRatio: boolean;
  /** 見出し・箇条書き・強調などの Markdown を使っている。 */
  readonly markdown: boolean;
  /** 英語の文が混ざっている。 */
  readonly englishSentence: boolean;
  /** thinking OFF なのに推論の本文が出た / 閉じていない think タグがある。 */
  readonly thinkingLeak: boolean;
}

export interface CaseResult {
  readonly caseId: string;
  readonly category: BenchmarkCategory;
  readonly tags: readonly BenchmarkTag[];
  readonly promptHash: string;
  /** human evaluation・export で使う ID（run と case から決まる）。 */
  readonly responseId: string;
  /** 利用者に見せる部分（thinking を除いた本文）。失敗時は null。 */
  readonly text: string | null;
  readonly rawText: string | null;
  readonly error: string | null;
  readonly timedOut: boolean;
  readonly shapeProblem: string | null;
  readonly unsupportedClaims: readonly string[];
  readonly contradictions: readonly string[];
  readonly style: StyleFlags | null;
  /** 第 1 候補（または NEXT VISIT の第 1 案）の 1 投目に触れているか。場面が無ければ null。 */
  readonly mentionsTopTarget: boolean | null;
  /** 形・根拠・矛盾のすべてを通ったか。 */
  readonly validationPassed: boolean;
  readonly outputLength: number | null;
  readonly outputTokens: number | null;
  readonly promptTokens: number | null;
  readonly timeToFirstTokenMs: number | null;
  readonly timeToFirstVisibleTokenMs: number | null;
  readonly generationTimeMs: number | null;
  readonly tokensPerSecond: number | null;
}

export interface GenerationSettings {
  readonly thinking: ThinkingMode;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed: number;
  readonly timeoutMs: number;
}

export interface BenchmarkRun {
  readonly schema: '01as-ai-benchmark-run';
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly candidateId: string;
  readonly runtimeId: string;
  readonly runtimeModelId: string | null;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly datasetFingerprint: string;
  readonly promptVersion: string;
  readonly settings: GenerationSettings;
  readonly load: LoadRecord | null;
  readonly modelSizeBytes: number | null;
  readonly estimatedVramBytes: number | null;
  /** 実行した端末の情報（`device.ts` の報告をそのまま）。 */
  readonly device: unknown;
  readonly aborted: boolean;
  readonly results: readonly CaseResult[];
}
