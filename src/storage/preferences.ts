/**
 * ユーザー設定（MY ROUTE の得意ダブルなど）の永続化。
 *
 * 端末内保存のみ。ログイン・クラウド同期は行わない。
 * 将来サーバー同期を足せるよう、スキーマにバージョンを持たせている。
 */
import { DOUBLE_DARTS, INNER_BULL_DART, findDart } from '../domain/dart';
import { DEFAULT_SETUP_MAIN_TARGET } from '../data/rankingRules';
import { readJson, writeJson } from './localJson';
import { namespacedKey } from './namespace';

export const PREFERENCES_KEY = namespacedKey('oas.preferences.v1');

export type Theme = 'light' | 'dark';

export interface Preferences {
  readonly version: 1;
  /** MY ROUTE の得意ダブル（順位順）。BULL も指定できる。 */
  readonly preferredDoubles: readonly string[];
  /** SETUP で続けて狙う主目標。 */
  readonly setupMainTarget: string;
  /** 画面テーマ。端末の設定とは独立してユーザーが明示的に選ぶ。 */
  readonly theme: Theme;
}

/*
 * 得意ダブルの既定は **空**（何も選んでいない状態）。
 *
 * あらかじめ 5 件を選択済みにしていたため、ユーザーが何も設定していないのに
 * その順位が戦術判断を決めてしまっていた（130 / 2 本で 16 残しより
 * 40 残しが選ばれるなど）。得意ダブルは「本人が選んだときだけ効く設定」にする。
 */
export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  preferredDoubles: [],
  setupMainTarget: DEFAULT_SETUP_MAIN_TARGET,
  theme: 'dark',
};

/** MY ROUTE の得意ダブルとして選べるセグメント。 */
export const SELECTABLE_FINISH_TARGETS: readonly string[] = [
  ...DOUBLE_DARTS.map((dart) => dart.id),
  INNER_BULL_DART.id,
];

function sanitize(input: Preferences): Preferences {
  const seen = new Set<string>();
  const preferredDoubles = input.preferredDoubles.filter((id) => {
    if (seen.has(id)) return false;
    if (!SELECTABLE_FINISH_TARGETS.includes(id)) return false;
    seen.add(id);
    return true;
  });
  const mainTarget = findDart(input.setupMainTarget)
    ? input.setupMainTarget
    : DEFAULT_SETUP_MAIN_TARGET;
  const theme: Theme = input.theme === 'light' ? 'light' : 'dark';
  return { version: 1, preferredDoubles, setupMainTarget: mainTarget, theme };
}

export function loadPreferences(): Preferences {
  const stored = readJson<Preferences>(PREFERENCES_KEY, DEFAULT_PREFERENCES);
  if (typeof stored !== 'object' || stored === null || !Array.isArray(stored.preferredDoubles)) {
    return DEFAULT_PREFERENCES;
  }
  return sanitize({ ...DEFAULT_PREFERENCES, ...stored });
}

export function savePreferences(preferences: Preferences): boolean {
  return writeJson(PREFERENCES_KEY, sanitize(preferences));
}
