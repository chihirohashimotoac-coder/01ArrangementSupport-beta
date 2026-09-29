/**
 * crash checkpoint と段階の記録（localStorage・`01as-beta:` 名前空間）のテスト。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BENCHMARK_CHECKPOINT_KEY,
  FEASIBILITY_RECORDS_KEY,
  MAX_FEASIBILITY_RECORDS,
  appendStageRecord,
  loadStageRecords,
  readCheckpoint,
  stageRecordFromCheckpoint,
  startCheckpoint,
  type CheckpointBase,
  type StoredStageRecord,
} from './benchmarkCheckpoint';

const BASE: CheckpointBase = {
  candidateId: 'fixture-model',
  candidateLabel: 'Fixture Model',
  runtimeModelId: 'fixture-model-id',
  profileId: 'MOBILE_FEASIBILITY',
  profileVersion: 1,
  contextWindowSize: 2048,
  stage: 'QUICK_10',
  storageBackend: 'opfs',
};

let tick = 0;
const clock = () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;

beforeEach(() => {
  window.localStorage.clear();
  tick = 0;
});
afterEach(() => window.localStorage.clear());

describe('crash checkpoint', () => {
  it('キーは Beta の名前空間で、利用者データ・Benchmark の結果とは別', () => {
    expect(BENCHMARK_CHECKPOINT_KEY).toBe('01as-beta:ai.benchmark.checkpoint.v1');
    expect(FEASIBILITY_RECORDS_KEY).toBe('01as-beta:ai.benchmark.feasibility.v1');
  });

  it('start だけでは書かない。load 開始・load 完了・case 開始・case 完了で段階を書き換える', () => {
    const session = startCheckpoint(BASE, clock);
    expect(readCheckpoint()).toBeNull();
    session.update('loading');
    expect(readCheckpoint()).toMatchObject({ schema: '01as-ai-benchmark-checkpoint', version: 1, phase: 'loading', caseIndex: null, runId: null });
    session.update('loaded');
    expect(readCheckpoint()?.phase).toBe('loaded');
    session.update('generating', { runId: 'run-1', caseIndex: 3, caseTotal: 10, caseId: 'SU-301-3' });
    expect(readCheckpoint()).toMatchObject({ phase: 'generating', runId: 'run-1', caseIndex: 3, caseTotal: 10, caseId: 'SU-301-3', stage: 'QUICK_10' });
    session.update('validating', { caseIndex: 3 });
    // 省略した項目は前の値のまま。
    expect(readCheckpoint()).toMatchObject({ phase: 'validating', runId: 'run-1', caseId: 'SU-301-3' });
    const stored = window.localStorage.getItem(BENCHMARK_CHECKPOINT_KEY) ?? '';
    // とても小さい（生の応答・Evidence を書かない）。
    expect(stored.length).toBeLessThan(600);
  });

  it('正常終了・中止では消す（clear）', () => {
    const session = startCheckpoint(BASE, clock);
    session.update('generating', { caseIndex: 0, caseTotal: 1, caseId: 'A' });
    session.clear();
    expect(readCheckpoint()).toBeNull();
    expect(window.localStorage.getItem(BENCHMARK_CHECKPOINT_KEY)).toBeNull();
  });

  it('消えずに残っていれば次に読める。壊れた値は無視する', () => {
    startCheckpoint(BASE, clock).update('generating', { runId: 'r', caseIndex: 4, caseTotal: 10, caseId: 'X' });
    // ページが途中で終わった（clear が呼ばれない）ことを模擬して、読み直す。
    expect(readCheckpoint()).toMatchObject({ phase: 'generating', caseIndex: 4 });
    window.localStorage.setItem(BENCHMARK_CHECKPOINT_KEY, '{"schema":"other"}');
    expect(readCheckpoint()).toBeNull();
  });

  it('残っていた checkpoint は「正常終了しなかった」段階の記録になる（原因は断定しない）', () => {
    startCheckpoint(BASE, clock).update('generating', { runId: 'r', caseIndex: 4, caseTotal: 10, caseId: 'X' });
    const record = stageRecordFromCheckpoint(readCheckpoint()!);
    expect(record).toMatchObject({ stage: 'QUICK_10', status: 'incomplete', profileKey: 'MOBILE_FEASIBILITY@1', casesCompleted: 4, casesTotal: 10 });
    expect(record?.detail).toContain('正常終了しませんでした');
    expect(record?.detail).not.toMatch(/メモリ不足|crash|クラッシュ/);
    // STANDARD（段階なし）は段階の記録にしない。
    startCheckpoint({ ...BASE, profileId: 'STANDARD', stage: null }, clock).update('loading');
    expect(stageRecordFromCheckpoint(readCheckpoint()!)).toBeNull();
  });
});

describe('段階の記録', () => {
  const record = (at: string): StoredStageRecord => ({
    candidateId: 'fixture-model',
    profileKey: 'MOBILE_FEASIBILITY@1',
    storageBackend: 'opfs',
    stage: 'LOAD_ONLY',
    status: 'success',
    at,
    loadKind: 'cache-cold',
    loadTimeMs: 1000,
    casesTotal: 0,
    casesCompleted: 0,
    errors: 0,
    timeouts: 0,
    gpuError: false,
    detail: null,
    runId: null,
  });

  it('足して保存し、同じ時刻の同じ段階は重ねず、直近の件数だけ残す', () => {
    appendStageRecord(record('a'));
    appendStageRecord(record('a'));
    expect(loadStageRecords()).toHaveLength(1);
    for (let index = 0; index < MAX_FEASIBILITY_RECORDS + 5; index += 1) appendStageRecord(record(`t${index}`));
    const stored = loadStageRecords();
    expect(stored).toHaveLength(MAX_FEASIBILITY_RECORDS);
    expect(stored[stored.length - 1].at).toBe(`t${MAX_FEASIBILITY_RECORDS + 4}`);
  });
});
