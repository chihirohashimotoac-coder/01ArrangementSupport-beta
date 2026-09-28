/**
 * Benchmark Dataset「01AS Core v1」のテスト。
 *
 * - 100 ケース・カテゴリと観点が偏らない
 * - engine から決定論的に作られ、指紋（Evidence 全体）が固定されている
 * - 決定論的な baseline（アプリの fallback と同じ文面）が全ケースで自動検証を通る
 *   （= 自動検証が Evidence どおりの説明を誤って不合格にしない）
 */
import { describe, expect, it } from 'vitest';
import { inspectOutput } from '../ai/benchmark/checks';
import { buildPrompt } from '../ai/benchmark/prompt';
import { faithfulResponse } from '../ai/benchmark/runtimes/mockRuntime';
import { deriveTags } from '../ai/benchmark/tags';
import { BENCHMARK_CATEGORIES, BENCHMARK_TAGS, type GenerationRequest } from '../ai/benchmark/types';
import { suggestFor } from '../engine/recovery/suggest';
import {
  CORE_DATASET_LABEL,
  buildCoreDatasetDrafts,
  coreDataset,
  missedDartOf,
} from './benchmarkDataset';
import { requireDart } from '../domain/dart';

/**
 * Evidence 全体の指紋。engine の結果・場面の定義・Evidence の形のどれかが変わると変わる。
 * 意図した変更なら `CORE_DATASET_VERSION` を上げ、ここを更新する（版の違う結果どうしは比べない）。
 */
const CORE_V1_FINGERPRINT = 'd8bcc5db4101150e';

const dataset = coreDataset();

describe('01AS Core v1', () => {
  it('100 ケースあり、ID が一意で、名前が付いている', () => {
    expect(dataset.labelJa).toBe(CORE_DATASET_LABEL);
    expect(dataset.cases).toHaveLength(100);
    expect(new Set(dataset.cases.map((item) => item.id)).size).toBe(100);
  });

  it('すべてのカテゴリ・観点を含み、偏らない', () => {
    const byCategory = Object.fromEntries(
      BENCHMARK_CATEGORIES.map((category) => [category, dataset.cases.filter((item) => item.category === category).length]),
    );
    expect(byCategory).toEqual({ CHECKOUT: 32, SETUP: 22, NEXT_VISIT: 14, RECOVERY: 20, SIMULATION_REVIEW: 12 });
    // 1 つのカテゴリが半分を超えない。
    expect(Math.max(...Object.values(byCategory))).toBeLessThanOrEqual(50);

    const lacking = BENCHMARK_TAGS.filter(
      (tag) => dataset.cases.filter((item) => item.tags.includes(tag)).length < 3,
    );
    expect(lacking).toEqual([]);
  });

  it('engine の state を変えずに、何度作っても同じ Evidence になる（指紋が固定）', () => {
    expect(dataset.fingerprint).toBe(CORE_V1_FINGERPRINT);
    const again = buildCoreDatasetDrafts();
    expect(again.map((draft) => draft.input)).toEqual(dataset.cases.map((item) => item.input));
    expect(Object.isFrozen(dataset.cases[0].input)).toBe(true);
  });

  it('観点タグは Evidence から導いた値そのもの', () => {
    const drifted = dataset.cases.filter(
      (item) => JSON.stringify(item.tags) !== JSON.stringify(deriveTags(item.input)),
    );
    expect(drifted).toEqual([]);
  });

  it('Evidence は engine の結果をそのまま写している（第 1 候補・mode）', () => {
    const differences: string[] = [];
    for (const item of dataset.cases) {
      if (item.input.kind !== 'decision' || item.input.previousThrow !== null) continue;
      const suggestion = suggestFor(item.input.decision.remaining, item.input.decision.dartsLeft);
      const top = suggestion.checkoutRoutes[0] ?? suggestion.setupRoutes[0] ?? suggestion.nextVisitProposals[0]?.route;
      const evidenceTop = item.input.decision.routes[0] ?? item.input.decision.nextVisitProposals[0]?.route;
      if (top?.routeText !== evidenceTop?.routeText) differences.push(item.id);
    }
    expect(differences).toEqual([]);
  });

  it('RECOVERY は第 1 候補の 1 投目からの外れで、残りは着弾の得点を引いた値', () => {
    const problems: string[] = [];
    for (const item of dataset.cases.filter((candidate) => candidate.category === 'RECOVERY')) {
      if (item.input.kind !== 'decision' || item.input.previousThrow === null) {
        problems.push(item.id);
        continue;
      }
      const previous = item.input.previousThrow;
      const actual = requireDart(previous.actualDartId);
      if (previous.leftBefore - actual.score !== previous.leftAfter) problems.push(`${item.id}: 残り`);
      if (previous.intendedDartId === previous.actualDartId) problems.push(`${item.id}: 外れていない`);
      if (item.input.decision.remaining !== previous.leftAfter) problems.push(`${item.id}: 場面`);
      if (item.input.decision.dartsLeft !== previous.dartsLeftBefore - 1) problems.push(`${item.id}: 本数`);
    }
    expect(problems).toEqual([]);
    expect(missedDartOf(requireDart('T20'), 'neighbor-cw').dart.id).toBe('T1');
    expect(missedDartOf(requireDart('T20'), 'neighbor-ccw').dart.id).toBe('T5');
    expect(missedDartOf(requireDart('BULL'), 'single').dart.id).toBe('SB');
    expect(() => missedDartOf(requireDart('S20'), 'single')).toThrow();
  });

  it('決定論的な baseline は全ケースで自動検証を通る（誤検出が無い）', () => {
    const failures = dataset.cases
      .map((item) => ({ item, result: inspectOutput(faithfulResponse({ input: item.input } as GenerationRequest), item.input, 'off') }))
      .filter(({ result }) => !result.validationPassed || result.mentionsTopTarget === false)
      .map(({ item, result }) => `${item.id}: ${[...result.unsupportedClaims, ...result.contradictions].join(' / ')}`);
    expect(failures).toEqual([]);
  });

  it('prompt は 4K context のモデルにも収まる長さ（文字数の上限）', () => {
    const lengths = dataset.cases.map((item) =>
      buildPrompt(item).messages.reduce((sum, message) => sum + message.content.length, 0),
    );
    expect(Math.max(...lengths)).toBeLessThan(4500);
  });
});
