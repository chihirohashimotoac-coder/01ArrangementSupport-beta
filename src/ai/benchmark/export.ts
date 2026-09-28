/**
 * Benchmark 結果の export と、人手評価（human evaluation）の型。
 *
 * 人が各回答を後から 5 段階で評価できるよう、JSON（全情報）と CSV（評価シート）を出す。
 *
 * - CSV は 1 行 1 応答。評価欄は保存済みの評価で埋め、未評価なら空欄
 * - blind（伏せ字）では、どのモデル・Runtime・run の出力かが分かる列を出さず、
 *   応答 ID（run と case から決まる指紋）の順に並べる（`docs/AI_EVALUATION.md`：評価者に Provider を伏せる）
 * - JSON にはデータセット（Evidence・prompt の指紋）も入れ、後から同じ入力を確認できるようにする
 */
import { summarizeRun, type RunSummary } from './metrics';
import { buildPrompt } from './prompt';
import type { BenchmarkDataset, BenchmarkRun, CaseResult } from './types';

export const HUMAN_RATING_KEYS = [
  'japaneseNaturalness',
  'clarity',
  'conciseness',
  'educationalValue',
  'dartsPlayerNaturalness',
] as const;
export type HumanRatingKey = (typeof HUMAN_RATING_KEYS)[number];

export const HUMAN_RATING_LABEL_JA: Readonly<Record<HumanRatingKey, string>> = {
  japaneseNaturalness: '日本語の自然さ',
  clarity: '分かりやすさ',
  conciseness: '簡潔さ',
  educationalValue: '学習上の価値',
  dartsPlayerNaturalness: 'ダーツプレイヤーとしての自然さ',
};

const HUMAN_RATING_CSV_COLUMN: Readonly<Record<HumanRatingKey, string>> = {
  japaneseNaturalness: 'rating_japanese_naturalness',
  clarity: 'rating_clarity',
  conciseness: 'rating_conciseness',
  educationalValue: 'rating_educational_value',
  dartsPlayerNaturalness: 'rating_darts_player_naturalness',
};

export type RatingValue = 1 | 2 | 3 | 4 | 5;

export type HumanRating = {
  readonly [key in HumanRatingKey]?: RatingValue;
} & { readonly note?: string };

/** responseId → 評価。 */
export type HumanRatings = Readonly<Record<string, HumanRating>>;

export function isRatingValue(value: unknown): value is RatingValue {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** 保存値を検証して復元する（壊れた項目は捨てる。例外を投げない）。 */
export function sanitizeRatings(raw: unknown): Record<string, HumanRating> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const ratings: Record<string, HumanRating> = {};
  for (const [responseId, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const rating: Record<string, unknown> = {};
    for (const key of HUMAN_RATING_KEYS) if (isRatingValue(record[key])) rating[key] = record[key];
    if (typeof record.note === 'string' && record.note.length > 0) rating.note = record.note.slice(0, 1000);
    if (Object.keys(rating).length > 0) ratings[responseId] = rating as HumanRating;
  }
  return ratings;
}

export interface HumanRatingSummary {
  readonly ratedResponses: number;
  readonly means: Readonly<Record<HumanRatingKey, number | null>>;
}

export function summarizeRatings(results: readonly CaseResult[], ratings: HumanRatings): HumanRatingSummary {
  const rated = results.map((result) => ratings[result.responseId]).filter((rating) => rating !== undefined);
  const means = Object.fromEntries(
    HUMAN_RATING_KEYS.map((key) => {
      const values = rated.map((rating) => rating[key]).filter(isRatingValue);
      return [key, values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length];
    }),
  ) as Record<HumanRatingKey, number | null>;
  return {
    ratedResponses: rated.filter((rating) => HUMAN_RATING_KEYS.some((key) => isRatingValue(rating[key]))).length,
    means,
  };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export interface BenchmarkExport {
  readonly schema: '01as-ai-benchmark-export';
  readonly schemaVersion: 1;
  readonly dataset: {
    readonly id: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly cases: readonly {
      readonly id: string;
      readonly category: string;
      readonly tags: readonly string[];
      readonly titleJa: string;
      readonly promptHash: string;
      readonly input: unknown;
    }[];
  } | null;
  readonly runs: readonly (BenchmarkRun & { readonly summary: RunSummary })[];
  readonly ratings: HumanRatings;
  readonly ratingScale: Readonly<Record<HumanRatingKey, string>>;
}

/**
 * run を作ったデータセットと ID・版・指紋が一致するときだけ返す。
 * 保存済みの古い run に、別の版・指紋のデータセット（Evidence・promptHash）を付けて export しないため。
 */
export function datasetMatchingRun(dataset: BenchmarkDataset | null, run: BenchmarkRun): BenchmarkDataset | null {
  if (dataset === null) return null;
  return dataset.id === run.datasetId && dataset.version === run.datasetVersion && dataset.fingerprint === run.datasetFingerprint
    ? dataset
    : null;
}

export function buildJsonExport(
  runs: readonly BenchmarkRun[],
  ratings: HumanRatings,
  dataset: BenchmarkDataset | null,
): BenchmarkExport {
  // 渡されたデータセットが run のものと違えば入れない（run が 1 件のときの呼び出しを想定した安全策）。
  const matched = runs.length > 0 && runs.every((run) => datasetMatchingRun(dataset, run) !== null) ? dataset : null;
  const responseIds = new Set(runs.flatMap((run) => run.results.map((result) => result.responseId)));
  return {
    schema: '01as-ai-benchmark-export',
    schemaVersion: 1,
    dataset: matched
      ? {
          id: matched.id,
          version: matched.version,
          fingerprint: matched.fingerprint,
          cases: matched.cases.map((item) => ({
            id: item.id,
            category: item.category,
            tags: item.tags,
            titleJa: item.titleJa,
            promptHash: buildPrompt(item).promptHash,
            input: item.input,
          })),
        }
      : null,
    runs: runs.map((run) => ({ ...run, summary: summarizeRun(run) })),
    ratings: Object.fromEntries(Object.entries(ratings).filter(([id]) => responseIds.has(id))),
    ratingScale: HUMAN_RATING_LABEL_JA,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  // 表計算ソフトで式として解釈されないよう、先頭の = + - @ を無害化する。
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvOptions {
  /** モデル・Runtime・run を伏せる。 */
  readonly blind?: boolean;
}

const RESULT_COLUMNS = [
  'response_id',
  'case_id',
  'category',
  'tags',
  'validation_passed',
  'unsupported_claim_count',
  'contradiction_count',
  'unsupported_claims',
  'contradictions',
  'error',
  'ttft_ms',
  'generation_time_ms',
  'tokens_per_second',
  'output_tokens',
  'output_length',
  'text',
] as const;

const IDENTITY_COLUMNS = ['run_id', 'candidate_id', 'runtime_id', 'runtime_model_id', 'thinking', 'prompt_version', 'dataset_version'] as const;

function round(value: number | null, digits = 1): string {
  return value === null ? '' : value.toFixed(digits);
}

/** 人手評価シート（CSV）。1 行 1 応答。 */
export function buildRatingCsv(
  runs: readonly BenchmarkRun[],
  ratings: HumanRatings,
  options: CsvOptions = {},
): string {
  const blind = options.blind ?? false;
  const header = [
    ...(blind ? [] : IDENTITY_COLUMNS),
    ...RESULT_COLUMNS,
    ...HUMAN_RATING_KEYS.map((key) => HUMAN_RATING_CSV_COLUMN[key]),
    'rater_note',
  ];
  const rows = runs.flatMap((run) =>
    run.results.map((result) => {
      const rating = ratings[result.responseId] ?? {};
      const identity = blind
        ? []
        : [run.runId, run.candidateId, run.runtimeId, run.runtimeModelId, run.settings.thinking, run.promptVersion, run.datasetVersion];
      return {
        responseId: result.responseId,
        cells: [
          ...identity,
          result.responseId,
          result.caseId,
          result.category,
          result.tags.join(' '),
          result.validationPassed ? 'true' : 'false',
          result.unsupportedClaims.length,
          result.contradictions.length,
          result.unsupportedClaims.join(' / '),
          result.contradictions.join(' / '),
          result.error ?? '',
          round(result.timeToFirstTokenMs),
          round(result.generationTimeMs),
          round(result.tokensPerSecond, 2),
          result.outputTokens,
          result.outputLength,
          result.text ?? '',
          ...HUMAN_RATING_KEYS.map((key) => rating[key] ?? ''),
          rating.note ?? '',
        ],
      };
    }),
  );
  if (blind) rows.sort((a, b) => (a.responseId < b.responseId ? -1 : a.responseId > b.responseId ? 1 : 0));
  // Excel で UTF-8 として開けるよう BOM を付ける。
  return `\uFEFF${[header, ...rows.map((row) => row.cells)].map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
