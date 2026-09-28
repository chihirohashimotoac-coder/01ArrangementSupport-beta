/**
 * 学習履歴の保存と集計（V2）。
 *
 * 端末内（localStorage）のみ。
 *
 * V2 で変わった点:
 *  - 主正答率を `learningCorrect` で数える（SETUP でノーテン / 170 超えを正解にしない）
 *  - 問題を `problemKey` / カテゴリ / 学習タグで識別し、復習に使えるようにする
 *  - V1 の履歴を捨てずに移行する。ただし **正しく再評価できない記録を
 *    「不正解」として正答率へ混ぜない**（本仕様 44 節）。除外件数だけを残す。
 */
import type { RouteGrade } from '../data/rankingRules';
import { findDart } from '../domain/dart';
import { DARTS_PER_VISIT, isCheckoutable } from '../domain/checkoutRules';
import type { FailureCode } from '../engine/training/grade';
import {
  reviewTargetFromScore,
  type ContextualThrow,
  type ReviewTarget,
  type TrainingCategory,
  type TrainingDifficulty,
  type TrainingFormat,
  type TrainingKind,
} from '../engine/training/model';
import { readJson, removeKey, writeJson } from './localJson';
import { namespacedKey } from './namespace';

export const TRAINING_HISTORY_KEY = namespacedKey('oas.training.v1');

/** 保存するレコードの上限（localStorage を圧迫しないため）。 */
export const MAX_RECORDS = 500;

export interface TrainingRecord {
  readonly id: string;
  /** 記録時刻（epoch ミリ秒）。 */
  readonly at: number;
  readonly kind: TrainingKind;
  readonly format: TrainingFormat;
  readonly problemKey: string;
  readonly difficulty: TrainingDifficulty;
  readonly primaryCategory: TrainingCategory | null;
  readonly learningTags: readonly string[];
  readonly startRemaining: number;
  readonly currentRemaining: number;
  readonly contextualThrows: readonly ContextualThrow[];
  readonly dartsAvailable: number;
  /** 回答したセグメント表記。 */
  readonly answer: readonly string[];
  /** ルールとして成立したか。 */
  readonly ruleValid: boolean;
  /** 学習目的として正解か。 */
  readonly learningCorrect: boolean;
  readonly grade: RouteGrade | null;
  readonly failureCode: FailureCode | null;
  /** 上がりに使ったダブル（SETUP では null）。 */
  readonly finishDouble: string | null;
  readonly elapsedMs: number;
}

export interface TrainingHistory {
  readonly version: 2;
  readonly records: readonly TrainingRecord[];
  /** 正しく再評価できず、統計から除外した legacy 記録の件数。 */
  readonly migrationSkippedCount: number;
}

const EMPTY_HISTORY: TrainingHistory = { version: 2, records: [], migrationSkippedCount: 0 };

const KINDS: readonly TrainingKind[] = ['checkout', 'setup', 'recovery'];
const GRADES: readonly RouteGrade[] = ['S', 'A', 'B', 'C'];
const DIFFICULTIES: readonly TrainingDifficulty[] = ['easy', 'medium', 'hard'];
/**
 * 保存済みレコードで受け付ける形式。
 * `setup-full` は新規出題を停止したが、**過去の履歴を読めるよう残す**。
 */
const FORMATS: readonly TrainingFormat[] = [
  'checkout-route',
  'setup-adjustment',
  'setup-full',
  'setup-first-dart',
  'recovery-route',
];

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  return value as string[];
}

function asGrade(value: unknown): RouteGrade | null {
  return typeof value === 'string' && (GRADES as readonly string[]).includes(value)
    ? (value as RouteGrade)
    : null;
}

/** 回答セグメントの合計得点。未知の表記が混ざっていたら null。 */
function answerScore(answer: readonly string[]): number | null {
  let total = 0;
  for (const id of answer) {
    const dart = findDart(id);
    if (!dart) return null;
    total += dart.score;
  }
  return total;
}

/**
 * 1 件の保存済みレコードを V2 へ移行する。
 * 正しく再評価できないものは null を返し、統計から除外する。
 */
export function migrateRecord(raw: unknown): TrainingRecord | null {
  if (!isRecordLike(raw)) return null;

  const kind = raw.kind;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
  const trainingKind = kind as TrainingKind;

  const answer = asStringArray(raw.answer) ?? [];
  const at = asFiniteNumber(raw.at, Date.now()) ?? Date.now();
  const elapsedMs = Math.max(0, asFiniteNumber(raw.elapsedMs, 0) ?? 0);
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `${trainingKind}-${at}`;
  const grade = asGrade(raw.grade);

  // --- すでに V2 -----------------------------------------------------------
  if (typeof raw.learningCorrect === 'boolean' && typeof raw.problemKey === 'string') {
    const currentRemaining = asFiniteNumber(raw.currentRemaining, null);
    if (currentRemaining === null) return null;
    const startRemaining = asFiniteNumber(raw.startRemaining, currentRemaining) ?? currentRemaining;
    const dartsAvailable = asFiniteNumber(raw.dartsAvailable, DARTS_PER_VISIT) ?? DARTS_PER_VISIT;
    const format =
      typeof raw.format === 'string' && (FORMATS as readonly string[]).includes(raw.format)
        ? (raw.format as TrainingFormat)
        : defaultFormatOf(trainingKind);
    const difficulty =
      typeof raw.difficulty === 'string' &&
      (DIFFICULTIES as readonly string[]).includes(raw.difficulty)
        ? (raw.difficulty as TrainingDifficulty)
        : 'medium';
    return {
      id,
      at,
      kind: trainingKind,
      format,
      problemKey: raw.problemKey,
      difficulty,
      primaryCategory:
        typeof raw.primaryCategory === 'string'
          ? (raw.primaryCategory as TrainingCategory)
          : null,
      learningTags: asStringArray(raw.learningTags) ?? [],
      startRemaining,
      currentRemaining,
      contextualThrows: normalizeContextualThrows(raw.contextualThrows),
      dartsAvailable,
      answer,
      ruleValid: raw.ruleValid === true,
      learningCorrect: raw.learningCorrect,
      grade,
      failureCode:
        typeof raw.failureCode === 'string' ? (raw.failureCode as FailureCode) : null,
      finishDouble: typeof raw.finishDouble === 'string' ? raw.finishDouble : null,
      elapsedMs,
    };
  }

  // --- V1 -------------------------------------------------------------------
  const remaining = asFiniteNumber(raw.remaining, null);
  if (remaining === null) return null;
  if (typeof raw.valid !== 'boolean') return null;
  const dartsAvailable = asFiniteNumber(raw.dartsAvailable, null);
  if (dartsAvailable === null) return null;

  const ruleValid = raw.valid;
  let learningCorrect: boolean;

  if (trainingKind === 'setup') {
    if (!ruleValid) {
      // 合法に投げられていない = ユーザーの回答そのものが不成立。再評価の必要がない。
      learningCorrect = false;
    } else {
      const scored = answerScore(answer);
      if (scored === null || answer.length === 0) return null;
      const leave = remaining - scored;
      if (!Number.isFinite(leave) || leave < 0) return null;
      learningCorrect = isCheckoutable(leave, DARTS_PER_VISIT);
    }
  } else {
    learningCorrect = ruleValid;
  }

  return {
    id,
    at,
    kind: trainingKind,
    format: defaultFormatOf(trainingKind),
    problemKey: legacyProblemKey(trainingKind, remaining, dartsAvailable),
    difficulty: 'medium',
    primaryCategory: null,
    learningTags: [],
    startRemaining: remaining,
    currentRemaining: remaining,
    contextualThrows: [],
    dartsAvailable,
    answer,
    ruleValid,
    learningCorrect,
    grade,
    failureCode: null,
    finishDouble: typeof raw.finishDouble === 'string' ? raw.finishDouble : null,
    elapsedMs,
  };
}

function defaultFormatOf(kind: TrainingKind): TrainingFormat {
  if (kind === 'setup') return 'setup-full';
  if (kind === 'recovery') return 'recovery-route';
  return 'checkout-route';
}

function legacyProblemKey(kind: TrainingKind, remaining: number, darts: number): string {
  return `${kind}|v1|left=${remaining}|darts=${darts}`;
}

function normalizeContextualThrows(value: unknown): ContextualThrow[] {
  if (!Array.isArray(value)) return [];
  const result: ContextualThrow[] = [];
  for (const item of value) {
    if (!isRecordLike(item)) continue;
    if (typeof item.actualDartId !== 'string') continue;
    result.push({
      intendedDartId: typeof item.intendedDartId === 'string' ? item.intendedDartId : null,
      actualDartId: item.actualDartId,
    });
  }
  return result;
}

export function loadHistory(): TrainingHistory {
  const stored = readJson<unknown>(TRAINING_HISTORY_KEY, null);
  if (!isRecordLike(stored) || !Array.isArray(stored.records)) return EMPTY_HISTORY;

  const records: TrainingRecord[] = [];
  let skipped = 0;
  for (const raw of stored.records) {
    const record = migrateRecord(raw);
    if (record === null) skipped += 1;
    else records.push(record);
  }

  const previouslySkipped = asFiniteNumber(stored.migrationSkippedCount, 0) ?? 0;
  return {
    version: 2,
    records: records.slice(-MAX_RECORDS),
    migrationSkippedCount: Math.max(0, previouslySkipped) + skipped,
  };
}

export function appendRecord(record: TrainingRecord): TrainingHistory {
  const history = loadHistory();
  const records = [...history.records, record].slice(-MAX_RECORDS);
  const next: TrainingHistory = {
    version: 2,
    records,
    migrationSkippedCount: history.migrationSkippedCount,
  };
  writeJson(TRAINING_HISTORY_KEY, next);
  return next;
}

export function clearHistory(): void {
  removeKey(TRAINING_HISTORY_KEY);
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

export interface Breakdown {
  readonly key: string;
  readonly attempts: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly averageMs: number;
}

export interface TrainingStats {
  readonly attempts: number;
  readonly correct: number;
  /** 主正答率（learningCorrect）。 */
  readonly accuracy: number;
  /** 内部指標: ルール上成立した割合。 */
  readonly ruleValidRate: number;
  readonly averageMs: number;
  /** 現在の連続正解数。 */
  readonly currentStreak: number;
  readonly bestStreak: number;
  /** 非推奨（C ランク）を選んだ回数。 */
  readonly discouragedChoices: number;
  readonly byGrade: Readonly<Record<RouteGrade | 'invalid', number>>;
  /** 残り点ごとの成績。 */
  readonly byScore: readonly Breakdown[];
  /** スコア帯（20 点刻み）ごとの成績。 */
  readonly byScoreBand: readonly Breakdown[];
  /** 上がりダブルごとの成績。 */
  readonly byFinishDouble: readonly Breakdown[];
  /** 教育カテゴリごとの成績。 */
  readonly byCategory: readonly Breakdown[];
  /** 学習タグごとの成績。 */
  readonly byLearningTag: readonly Breakdown[];
  /** 問題ごとの成績。 */
  readonly byProblemKey: readonly Breakdown[];
  /** 苦手スコア（正答率が低い順）。 */
  readonly weakScores: readonly number[];
  /** 直近で間違えた問題の残り点。 */
  readonly recentMistakes: readonly number[];
  /** 直近で間違えた問題そのもの。 */
  readonly recentMistakeRecords: readonly TrainingRecord[];
  readonly migrationSkippedCount: number;
}

function summarize(records: readonly TrainingRecord[], key: string): Breakdown {
  const attempts = records.length;
  const correct = records.filter((record) => record.learningCorrect).length;
  const totalMs = records.reduce((sum, record) => sum + record.elapsedMs, 0);
  return {
    key,
    attempts,
    correct,
    accuracy: attempts === 0 ? 0 : correct / attempts,
    averageMs: attempts === 0 ? 0 : Math.round(totalMs / attempts),
  };
}

function groupBy(
  records: readonly TrainingRecord[],
  keysOf: (record: TrainingRecord) => readonly string[],
): Breakdown[] {
  const groups = new Map<string, TrainingRecord[]>();
  for (const record of records) {
    for (const key of keysOf(record)) {
      const bucket = groups.get(key);
      if (bucket) bucket.push(record);
      else groups.set(key, [record]);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => summarize(group, key))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** スコア帯（20 点刻み）のラベル。 */
export function scoreBandOf(remaining: number): string {
  const start = Math.floor(remaining / 20) * 20;
  return `${start === 0 ? 2 : start}〜${start + 19}`;
}

export function computeStats(history: TrainingHistory): TrainingStats {
  const records = history.records;
  const attempts = records.length;
  const correct = records.filter((record) => record.learningCorrect).length;
  const ruleValidCount = records.filter((record) => record.ruleValid).length;
  const totalMs = records.reduce((sum, record) => sum + record.elapsedMs, 0);

  let currentStreak = 0;
  let bestStreak = 0;
  for (const record of records) {
    if (record.learningCorrect) {
      currentStreak += 1;
      bestStreak = Math.max(bestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  const byGrade: Record<RouteGrade | 'invalid', number> = { S: 0, A: 0, B: 0, C: 0, invalid: 0 };
  for (const record of records) {
    if (!record.ruleValid || record.grade === null) byGrade.invalid += 1;
    else byGrade[record.grade] += 1;
  }

  const byScore = groupBy(records, (record) => [String(record.startRemaining)]);
  const weakScores = [...byScore]
    .filter((item) => item.attempts >= 1 && item.accuracy < 1)
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
    .map((item) => Number(item.key));

  const recentMistakeRecords: TrainingRecord[] = [];
  for (let i = records.length - 1; i >= 0 && recentMistakeRecords.length < 20; i -= 1) {
    const record = records[i];
    if (!record.learningCorrect || record.grade === 'C') recentMistakeRecords.push(record);
  }

  return {
    attempts,
    correct,
    accuracy: attempts === 0 ? 0 : correct / attempts,
    ruleValidRate: attempts === 0 ? 0 : ruleValidCount / attempts,
    averageMs: attempts === 0 ? 0 : Math.round(totalMs / attempts),
    currentStreak,
    bestStreak,
    discouragedChoices: records.filter((record) => record.ruleValid && record.grade === 'C').length,
    byGrade,
    byScore,
    byScoreBand: groupBy(records, (record) => [scoreBandOf(record.startRemaining)]),
    byFinishDouble: groupBy(records, (record) =>
      record.finishDouble === null ? [] : [record.finishDouble],
    ),
    byCategory: groupBy(records, (record) =>
      record.primaryCategory === null ? [] : [record.primaryCategory],
    ),
    byLearningTag: groupBy(records, (record) => record.learningTags),
    byProblemKey: groupBy(records, (record) => [record.problemKey]),
    weakScores,
    recentMistakes: [...new Set(recentMistakeRecords.map((record) => record.startRemaining))],
    recentMistakeRecords,
    migrationSkippedCount: history.migrationSkippedCount,
  };
}

/**
 * 重点的に再出題したい対象（本仕様 31 節の優先順）。
 *
 *  1. learningCorrect = false だった問題そのもの
 *  2. C ランクを選んだ問題
 *  3. 正答率の低いカテゴリ / 学習タグ
 *  4. 回答が遅かった問題
 */
export function reviewTargetsOf(stats: TrainingStats, limit = 12): ReviewTarget[] {
  const targets: ReviewTarget[] = [];
  const seen = new Set<string>();

  const push = (target: ReviewTarget, dedupeKey: string): void => {
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    targets.push(target);
  };

  for (const record of stats.recentMistakeRecords) {
    push(
      {
        kind: record.kind,
        problemKey: record.problemKey,
        startRemaining: record.startRemaining,
        primaryCategory: record.primaryCategory,
        learningTags: record.learningTags,
        weight: record.learningCorrect ? 60 : 100,
      },
      `problem:${record.problemKey}`,
    );
  }

  for (const item of stats.byCategory) {
    if (item.attempts < 2 || item.accuracy >= 0.7) continue;
    push(
      {
        kind: null,
        problemKey: null,
        startRemaining: null,
        primaryCategory: item.key as ReviewTarget['primaryCategory'],
        learningTags: [],
        weight: 40,
      },
      `category:${item.key}`,
    );
  }

  for (const item of stats.byLearningTag) {
    if (item.attempts < 2 || item.accuracy >= 0.7) continue;
    push(
      {
        kind: null,
        problemKey: null,
        startRemaining: null,
        primaryCategory: null,
        learningTags: [item.key],
        weight: 30,
      },
      `tag:${item.key}`,
    );
  }

  // 回答が遅かった問題（平均の 1.5 倍以上）。
  if (stats.averageMs > 0) {
    for (const item of stats.byProblemKey) {
      if (item.averageMs < stats.averageMs * 1.5) continue;
      push(
        {
          kind: null,
          problemKey: item.key,
          startRemaining: null,
          primaryCategory: null,
          learningTags: [],
          weight: 20,
        },
        `slow:${item.key}`,
      );
    }
  }

  for (const score of stats.weakScores) {
    push(reviewTargetFromScore(score, 10), `score:${score}`);
  }

  return targets.slice(0, limit);
}
