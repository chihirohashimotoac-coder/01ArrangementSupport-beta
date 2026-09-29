/**
 * Benchmark の crash checkpoint と、MOBILE_FEASIBILITY の段階の記録（AI MODEL LAB 専用）。
 *
 * iPhone（WebKit）ではメモリが足りないとタブごと終了し、try / catch で失敗を記録できない。そこで実行中の段階を
 * **とても小さく** localStorage（`01as-beta:` 名前空間。`storage/localJson.ts` を通す）へ書いておき、次に Lab を
 * 開いたときに残っていれば「前回の Benchmark は正常終了しなかった」ことを示す。
 *
 * - 書くのは段階の切り替わりだけ（読み込みの前後・各ケースの生成の前後・解放の前）。トークンごとには書かない
 * - 正常終了・明示的な中止・捕まえた失敗（読み込みの失敗など）では消す。消えずに残っているのは、ページが途中で
 *   終わった（タブの終了・再読み込み・閉じた等）ときだけ
 * - 残っていた checkpoint は **「前回の run が正常終了しなかった証拠」** であり、ブラウザ・タブの crash の証拠ではない。
 *   原因は断定しない
 * - localStorage への書き込みは best-effort（書けなくても Benchmark は止めない）
 *
 * 01AS の利用者データ（`01as-beta:oas.*`）・Benchmark の結果（`ai.benchmark.runs.v1`）とは別のキー。
 */
import type { FeasibilityStage, StageRecord } from '../ai/benchmark/profiles';
import { FEASIBILITY_STAGES } from '../ai/benchmark/profiles';
import { readJson, removeKey, writeJson } from '../storage/localJson';
import { namespacedKey } from '../storage/namespace';

export const BENCHMARK_CHECKPOINT_KEY = namespacedKey('ai.benchmark.checkpoint.v1');
export const FEASIBILITY_RECORDS_KEY = namespacedKey('ai.benchmark.feasibility.v1');
export const MAX_FEASIBILITY_RECORDS = 60;

export const CHECKPOINT_PHASES = ['loading', 'loaded', 'generating', 'validating', 'unloading'] as const;
export type CheckpointPhase = (typeof CHECKPOINT_PHASES)[number];

export interface BenchmarkCheckpoint {
  readonly schema: '01as-ai-benchmark-checkpoint';
  readonly version: 1;
  /** Benchmark の run ID（生成を始めるまでは null）。 */
  readonly runId: string | null;
  readonly candidateId: string;
  readonly candidateLabel: string;
  readonly runtimeModelId: string | null;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly contextWindowSize: number | null;
  /** MOBILE_FEASIBILITY の段階（STANDARD では null）。 */
  readonly stage: FeasibilityStage | null;
  readonly storageBackend: string | null;
  readonly phase: CheckpointPhase;
  /** 0 始まり。生成の段階だけ。 */
  readonly caseIndex: number | null;
  readonly caseTotal: number | null;
  readonly caseId: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

function isCheckpoint(value: unknown): value is BenchmarkCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<BenchmarkCheckpoint>;
  return item.schema === '01as-ai-benchmark-checkpoint' && item.version === 1 &&
    typeof item.candidateId === 'string' && typeof item.profileId === 'string' &&
    (CHECKPOINT_PHASES as readonly unknown[]).includes(item.phase) && typeof item.updatedAt === 'string';
}

/** 残っている checkpoint（無ければ null）。Lab を開いたとき、新しい run を始める前に読む。 */
export function readCheckpoint(): BenchmarkCheckpoint | null {
  const stored = readJson<unknown>(BENCHMARK_CHECKPOINT_KEY, null);
  return isCheckpoint(stored) ? stored : null;
}

export function clearCheckpoint(): void {
  removeKey(BENCHMARK_CHECKPOINT_KEY);
}

export type CheckpointBase = Omit<BenchmarkCheckpoint, 'schema' | 'version' | 'phase' | 'caseIndex' | 'caseTotal' | 'caseId' | 'runId' | 'startedAt' | 'updatedAt'>;

export interface CheckpointUpdate {
  readonly runId?: string | null;
  readonly caseIndex?: number | null;
  readonly caseTotal?: number | null;
  readonly caseId?: string | null;
}

/** 1 回の実行（読み込み〜解放）の checkpoint を書く。書くのは `update` を呼んだときだけ。 */
export interface CheckpointSession {
  update(phase: CheckpointPhase, update?: CheckpointUpdate): void;
  /** 正常終了・明示的な中止・捕まえた失敗のあとで呼ぶ。 */
  clear(): void;
}

export function startCheckpoint(base: CheckpointBase, now: () => string = () => new Date().toISOString()): CheckpointSession {
  const startedAt = now();
  let current: BenchmarkCheckpoint | null = null;
  return {
    update(phase, update = {}) {
      current = {
        schema: '01as-ai-benchmark-checkpoint',
        version: 1,
        ...base,
        runId: update.runId !== undefined ? update.runId : current?.runId ?? null,
        phase,
        caseIndex: update.caseIndex !== undefined ? update.caseIndex : current?.caseIndex ?? null,
        caseTotal: update.caseTotal !== undefined ? update.caseTotal : current?.caseTotal ?? null,
        caseId: update.caseId !== undefined ? update.caseId : current?.caseId ?? null,
        startedAt,
        updatedAt: now(),
      };
      writeJson(BENCHMARK_CHECKPOINT_KEY, current);
    },
    clear() {
      current = null;
      clearCheckpoint();
    },
  };
}

// ---------------------------------------------------------------------------
// MOBILE_FEASIBILITY の段階の記録
// ---------------------------------------------------------------------------

/** 段階の記録は「候補 × profile（id@version）× 保存方式」ごとに分ける。 */
export interface StoredStageRecord extends StageRecord {
  readonly candidateId: string;
  readonly profileKey: string;
  readonly storageBackend: string | null;
}

function isStoredStageRecord(value: unknown): value is StoredStageRecord {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<StoredStageRecord>;
  return typeof item.candidateId === 'string' && typeof item.profileKey === 'string' &&
    (FEASIBILITY_STAGES as readonly unknown[]).includes(item.stage) &&
    ['success', 'failed', 'aborted', 'incomplete'].includes(item.status as string) && typeof item.at === 'string';
}

export function loadStageRecords(): StoredStageRecord[] {
  const stored = readJson<unknown>(FEASIBILITY_RECORDS_KEY, null);
  if (typeof stored !== 'object' || stored === null || (stored as { version?: unknown }).version !== 1) return [];
  const records = (stored as { records?: unknown }).records;
  return Array.isArray(records) ? records.filter(isStoredStageRecord) : [];
}

/** 記録を足して保存する（古い順・直近 MAX 件。同じ段階・同じ時刻の記録は重ねない）。 */
export function appendStageRecord(record: StoredStageRecord): StoredStageRecord[] {
  const existing = loadStageRecords().filter((item) =>
    !(item.candidateId === record.candidateId && item.profileKey === record.profileKey &&
      item.storageBackend === record.storageBackend && item.stage === record.stage && item.at === record.at));
  const next = [...existing, record].slice(-MAX_FEASIBILITY_RECORDS);
  writeJson(FEASIBILITY_RECORDS_KEY, { version: 1, records: next });
  return next;
}

export function clearStageRecords(): void {
  removeKey(FEASIBILITY_RECORDS_KEY);
}

/**
 * 残っていた checkpoint を、その段階の「正常終了しなかった」記録にする（MOBILE_FEASIBILITY の段階だけ）。
 * 原因は断定しないので、detail には最後に記録した段階（phase・ケース）だけを書く。
 */
export function stageRecordFromCheckpoint(checkpoint: BenchmarkCheckpoint): StoredStageRecord | null {
  if (checkpoint.stage === null) return null;
  const casePart = checkpoint.caseIndex === null ? '' : `・case ${checkpoint.caseIndex + 1} / ${checkpoint.caseTotal ?? '?'}（${checkpoint.caseId ?? '?'}）`;
  return {
    candidateId: checkpoint.candidateId,
    profileKey: `${checkpoint.profileId}@${checkpoint.profileVersion}`,
    storageBackend: checkpoint.storageBackend,
    stage: checkpoint.stage,
    status: 'incomplete',
    at: checkpoint.updatedAt,
    loadKind: null,
    loadTimeMs: null,
    casesTotal: checkpoint.caseTotal ?? 0,
    casesCompleted: checkpoint.caseIndex ?? 0,
    errors: 0,
    timeouts: 0,
    gpuError: false,
    detail: `前回の実行が正常終了しませんでした（最後の記録: phase ${checkpoint.phase}${casePart}）`,
    runId: checkpoint.runId,
  };
}
