/**
 * Beta と Production の保存データ分離。
 *
 * Production（/01ArrangementSupport/）と Beta（/01ArrangementSupport-beta/）は
 * GitHub Pages 上で同じ origin を共有するため、localStorage も共有される。
 * Beta は Production の保存データを **読まない・書き換えない・消さない・取り込まない**。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson, removeKey, writeJson } from './localJson';
import { STORAGE_NAMESPACE, isNamespacedKey, namespacedKey } from './namespace';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  savePreferences,
} from './preferences';
import {
  DEFAULT_SIMULATION_PREFERENCES,
  SIMULATION_SETTINGS_KEY,
  loadSimulationPreferences,
  saveSimulationPreferences,
} from './simulationSettings';
import {
  TRAINING_HISTORY_KEY,
  appendRecord,
  clearHistory,
  loadHistory,
  type TrainingRecord,
} from './trainingHistory';

/** Production 版（main）が使う保存キー。Beta から触れてはいけない。 */
const PRODUCTION_KEYS = ['oas.preferences.v1', 'oas.training.v1', 'oas.simulation.v1'] as const;

/** Production 側に既に保存されている想定のデータ（中身が 1 文字でも変わったら失敗）。 */
const PRODUCTION_DATA: Readonly<Record<(typeof PRODUCTION_KEYS)[number], string>> = {
  'oas.preferences.v1': JSON.stringify({
    version: 1,
    preferredDoubles: ['D16', 'D8'],
    setupMainTarget: 'T19',
    theme: 'light',
  }),
  'oas.training.v1': JSON.stringify({
    version: 2,
    migrationSkippedCount: 0,
    records: [
      {
        id: 'production-record',
        at: 1,
        kind: 'checkout',
        format: 'checkout-route',
        problemKey: 'checkout|v2|left=81|darts=3',
        difficulty: 'medium',
        primaryCategory: null,
        learningTags: [],
        startRemaining: 81,
        currentRemaining: 81,
        contextualThrows: [],
        dartsAvailable: 3,
        answer: ['T19', 'D12'],
        ruleValid: true,
        learningCorrect: true,
        grade: 'S',
        failureCode: null,
        finishDouble: 'D12',
        elapsedMs: 1000,
      },
    ],
  }),
  'oas.simulation.v1': JSON.stringify({
    version: 1,
    startScore: 301,
    first9Ppr: 90,
    averagePpr: 80,
    missDirection: 'left',
    maxMiss: 'small',
  }),
};

function seedProduction(): void {
  for (const key of PRODUCTION_KEYS) window.localStorage.setItem(key, PRODUCTION_DATA[key]);
}

function expectProductionUntouched(): void {
  for (const key of PRODUCTION_KEYS) {
    expect(window.localStorage.getItem(key), key).toBe(PRODUCTION_DATA[key]);
  }
}

function betaRecord(): TrainingRecord {
  return {
    id: 'beta-record',
    at: 2,
    kind: 'checkout',
    format: 'checkout-route',
    problemKey: 'checkout|v2|left=40|darts=3',
    difficulty: 'easy',
    primaryCategory: null,
    learningTags: [],
    startRemaining: 40,
    currentRemaining: 40,
    contextualThrows: [],
    dartsAvailable: 3,
    answer: ['D20'],
    ruleValid: true,
    learningCorrect: true,
    grade: 'S',
    failureCode: null,
    finishDouble: 'D20',
    elapsedMs: 500,
  };
}

/** Storage への全アクセスを記録する（Production キーへの read も検出するため）。 */
function spyStorage() {
  return {
    get: vi.spyOn(Storage.prototype, 'getItem'),
    set: vi.spyOn(Storage.prototype, 'setItem'),
    remove: vi.spyOn(Storage.prototype, 'removeItem'),
    clear: vi.spyOn(Storage.prototype, 'clear'),
  };
}

function touchedKeys(spy: ReturnType<typeof spyStorage>): string[] {
  return [
    ...spy.get.mock.calls.map(([key]) => String(key)),
    ...spy.set.mock.calls.map(([key]) => String(key)),
    ...spy.remove.mock.calls.map(([key]) => String(key)),
  ];
}

beforeEach(() => {
  window.localStorage.clear();
  seedProduction();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Beta の保存キー', () => {
  it('すべて Beta の名前空間に属し、Production のキーと一致しない', () => {
    expect(STORAGE_NAMESPACE).toBe('01as-beta:');
    for (const key of [PREFERENCES_KEY, TRAINING_HISTORY_KEY, SIMULATION_SETTINGS_KEY]) {
      expect(isNamespacedKey(key), key).toBe(true);
      expect(PRODUCTION_KEYS as readonly string[]).not.toContain(key);
    }
    expect(PREFERENCES_KEY).toBe('01as-beta:oas.preferences.v1');
    expect(TRAINING_HISTORY_KEY).toBe('01as-beta:oas.training.v1');
    expect(SIMULATION_SETTINGS_KEY).toBe('01as-beta:oas.simulation.v1');
  });

  it('名前空間だけのキーや Production のキーは Beta のキーとして扱わない', () => {
    expect(isNamespacedKey(STORAGE_NAMESPACE)).toBe(false);
    for (const key of PRODUCTION_KEYS) expect(isNamespacedKey(key)).toBe(false);
    expect(namespacedKey('x')).toBe('01as-beta:x');
  });
});

describe('Production の保存データを読まない', () => {
  it('Production に設定・履歴・SIMULATION 設定があっても、Beta は既定値から始まる', () => {
    const spy = spyStorage();

    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(loadHistory().records).toEqual([]);
    expect(loadSimulationPreferences()).toEqual(DEFAULT_SIMULATION_PREFERENCES);

    // Production のキーは 1 度も参照していない（取り込み・migration もしない）。
    const touched = touchedKeys(spy);
    for (const key of PRODUCTION_KEYS) expect(touched).not.toContain(key);
    expectProductionUntouched();
  });
});

describe('Production の保存データを書き換えない・消さない', () => {
  it('Beta で設定・履歴・SIMULATION 設定を保存しても Production は変わらない', () => {
    const spy = spyStorage();

    savePreferences({ ...DEFAULT_PREFERENCES, preferredDoubles: ['D20'], theme: 'dark' });
    appendRecord(betaRecord());
    saveSimulationPreferences({ ...DEFAULT_SIMULATION_PREFERENCES, startScore: 701 });

    expect(loadPreferences().preferredDoubles).toEqual(['D20']);
    expect(loadHistory().records.map((record) => record.id)).toEqual(['beta-record']);
    expect(loadSimulationPreferences().startScore).toBe(701);

    const touched = touchedKeys(spy);
    for (const key of PRODUCTION_KEYS) expect(touched).not.toContain(key);
    expect(spy.clear).not.toHaveBeenCalled();
    expectProductionUntouched();
  });

  it('Beta の学習履歴を消しても Production の履歴は残る', () => {
    appendRecord(betaRecord());
    clearHistory();
    expect(window.localStorage.getItem(TRAINING_HISTORY_KEY)).toBeNull();
    expectProductionUntouched();
  });
});

describe('保存の入口（localJson）は Beta 以外のキーを拒否する', () => {
  it('Production のキーを渡しても読まない・書かない・消さない', () => {
    const spy = spyStorage();
    for (const key of PRODUCTION_KEYS) {
      expect(readJson(key, 'fallback')).toBe('fallback');
      expect(writeJson(key, { overwritten: true })).toBe(false);
      removeKey(key);
    }
    const touched = touchedKeys(spy);
    for (const key of PRODUCTION_KEYS) expect(touched).not.toContain(key);
    expectProductionUntouched();
  });

  it('Beta のキーは通常どおり読み書きできる', () => {
    const key = namespacedKey('test.v1');
    expect(writeJson(key, { ok: true })).toBe(true);
    expect(readJson(key, null)).toEqual({ ok: true });
    removeKey(key);
    expect(window.localStorage.getItem(key)).toBeNull();
  });
});

describe('index.html の初期テーマ読み込み', () => {
  /*
   * 初回描画のちらつきを避けるため、index.html はバンドル前にテーマを直接読む。
   * ここだけ定数を import できないので、キーが PREFERENCES_KEY と一致し、
   * Production のキーを読まないことを固定する。
   */
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

  it('Beta の設定キーを読む', () => {
    expect(html).toContain(`localStorage.getItem('${PREFERENCES_KEY}')`);
  });

  it('Production の設定キーを読まない', () => {
    expect(html).not.toContain("localStorage.getItem('oas.preferences.v1')");
  });
});
