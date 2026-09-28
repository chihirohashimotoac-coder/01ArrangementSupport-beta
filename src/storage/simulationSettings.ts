/**
 * SIMULATION のプレイヤー設定の永続化。
 *
 * 既存の設定キー（`PREFERENCES_KEY`）とは **別のキー**に保存する。
 * SIMULATION を追加したことで既存の設定・履歴が壊れないようにするため、
 * 既存スキーマへは 1 項目も足さない。
 */
import { readJson, writeJson } from './localJson';
import { namespacedKey } from './namespace';
import {
  MAX_MISS_LEVELS,
  MISS_DIRECTIONS,
  clampPpr,
  type MaxMissLevel,
  type MissDirection,
} from '../engine/simulation/accuracy';
import {
  DEFAULT_START_SCORE,
  MAX_START_SCORE,
  MIN_START_SCORE,
} from '../engine/simulation/game';

export const SIMULATION_SETTINGS_KEY = namespacedKey('oas.simulation.v1');

export interface SimulationPreferences {
  readonly version: 1;
  /** 最後に選んだ開始点数。 */
  readonly startScore: number;
  readonly first9Ppr: number;
  readonly averagePpr: number;
  readonly missDirection: MissDirection;
  readonly maxMiss: MaxMissLevel;
}

export const DEFAULT_SIMULATION_PREFERENCES: SimulationPreferences = {
  version: 1,
  startScore: DEFAULT_START_SCORE,
  first9Ppr: 60,
  averagePpr: 55,
  missDirection: 'even',
  maxMiss: 'medium',
};

function sanitize(input: SimulationPreferences): SimulationPreferences {
  const rawStart = Math.round(Number(input.startScore));
  const startScore = Number.isFinite(rawStart)
    ? Math.min(Math.max(rawStart, MIN_START_SCORE), MAX_START_SCORE)
    : DEFAULT_START_SCORE;
  return {
    version: 1,
    startScore,
    first9Ppr: clampPpr(Number(input.first9Ppr)),
    averagePpr: clampPpr(Number(input.averagePpr)),
    missDirection: MISS_DIRECTIONS.includes(input.missDirection)
      ? input.missDirection
      : DEFAULT_SIMULATION_PREFERENCES.missDirection,
    maxMiss: MAX_MISS_LEVELS.includes(input.maxMiss)
      ? input.maxMiss
      : DEFAULT_SIMULATION_PREFERENCES.maxMiss,
  };
}

export function loadSimulationPreferences(): SimulationPreferences {
  const stored = readJson<SimulationPreferences>(
    SIMULATION_SETTINGS_KEY,
    DEFAULT_SIMULATION_PREFERENCES,
  );
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SIMULATION_PREFERENCES;
  return sanitize({ ...DEFAULT_SIMULATION_PREFERENCES, ...stored });
}

export function saveSimulationPreferences(preferences: SimulationPreferences): boolean {
  return writeJson(SIMULATION_SETTINGS_KEY, sanitize(preferences));
}
