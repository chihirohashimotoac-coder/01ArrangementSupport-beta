/**
 * AI 出力の根拠チェック（表記ゆれ）のテスト。
 *
 * 小文字・全角・Unicode 互換表記の的や数値で、Evidence に無い主張が検証をすり抜けないこと。
 * 正規化は**検証用の canonical form** にだけ使い、表示する原文は書き換えないこと。
 */
import { describe, expect, it } from 'vitest';
import { suggestFor } from '../engine/recovery/suggest';
import { buildDecisionEvidence, serializeEvidence } from './evidence';
import { explainDecision } from './explain';
import type { AiProvider } from './types';
import { canonicalClaimText, findUnsupportedClaims } from './validation';

// 116 / 3 本の Evidence（上位 3 件）: T20 → S16 → D20 / T19 → S19 → D20 / T12 → T16 → D16。
const evidence116 = buildDecisionEvidence(suggestFor(116, 3));
// 40 / 1 本の Evidence: D20 だけ。BULL は出てこない。
const evidence40 = buildDecisionEvidence(suggestFor(40, 1));

function issuesOf(text: string, evidence = evidence116): string[] {
  return findUnsupportedClaims({ text }, evidence);
}

describe('前提: Evidence の中身', () => {
  it('116 / 3 本の Evidence に T20 はあり、T1 は無い', () => {
    const source = serializeEvidence(evidence116);
    expect(source).toContain('T20');
    expect(source).not.toMatch(/(?<![A-Za-z0-9])T1(?![0-9])/);
  });

  it('40 / 1 本の Evidence に BULL は無い', () => {
    expect(serializeEvidence(evidence40)).not.toContain('BULL');
  });
});

describe('canonical form', () => {
  it.each([
    ['T1', 'T1'],
    ['t1', 'T1'],
    ['Ｔ１', 'T1'],
    ['ｔ１', 'T1'],
    ['T１', 'T1'],
    ['𝐭𝟏', 'T1'],
    ['ｂｕｌｌ', 'BULL'],
    ['７７', '77'],
    ['推奨度 Ｃ', '推奨度 C'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalClaimText(input)).toBe(expected);
  });

  it('大文字化するのは ASCII 英字だけ（日本語・記号はそのまま）', () => {
    expect(canonicalClaimText('残り 96 → d20 で上がり。')).toBe('残り 96 → D20 で上がり。');
  });
});

describe('Evidence に無い的は、表記にかかわらず検出する', () => {
  it.each([
    ['uppercase', 'T1 が最善です'],
    ['lowercase', 't1 が最善です'],
    ['full-width uppercase', 'Ｔ１ が最善です'],
    ['full-width lowercase', 'ｔ１ が最善です'],
    ['full-width digit only', 'T１ が最善です'],
    ['mathematical alphanumeric', '𝐭𝟏 が最善です'],
  ])('%s: %s', (_label, text) => {
    expect(issuesOf(text)).toContain('根拠の無い的: T1');
  });

  it('BULL も小文字・全角で検出する', () => {
    expect(issuesOf('bull で上がります', evidence40)).toContain('根拠の無い的: BULL');
    expect(issuesOf('ｂｕｌｌ で上がります', evidence40)).toContain('根拠の無い的: BULL');
  });
});

describe('Evidence にある的は、表記にかかわらず受け付ける', () => {
  it.each([
    ['uppercase', 'T20 が第 1 候補です'],
    ['lowercase', 't20 が第 1 候補です'],
    ['full-width uppercase', 'Ｔ２０ が第 1 候補です'],
    ['full-width lowercase', 'ｔ２０ が第 1 候補です'],
    ['route', 'ｔ２０ → ｓ１６ → ｄ２０ です'],
  ])('%s: %s', (_label, text) => {
    expect(issuesOf(text)).toEqual([]);
  });
});

describe('数値と推奨度', () => {
  it('全角の数値も Evidence と照合する', () => {
    expect(issuesOf('外すと ７７ が残ります')).toContain('根拠の無い数値: 77');
    // 96 は Evidence の理由文にある（T20 → S20 で 96 残り）。
    expect(issuesOf('外しても ９６ が残ります')).toEqual([]);
  });

  it('本数などの小さな数（FREE_NUMBER_MAX 以下）は、全角でも主張とみなさない', () => {
    expect(issuesOf('残り ３ 本で上がれます')).toEqual([]);
    expect(issuesOf('残り 2 本で上がれます')).toEqual([]);
    expect(issuesOf('１ 投目を外しても大丈夫です')).toEqual([]);
  });

  it('全角の推奨度も照合する', () => {
    expect(issuesOf('推奨度 Ｃ です')).toContain('根拠の無い推奨度: C');
    expect(issuesOf('推奨度 Ｓ です')).toEqual([]);
  });
});

describe('表示する原文は書き換えない', () => {
  it('全角・小文字で書かれた正しい説明は、原文のまま表示する', async () => {
    const text = 'ｔ２０ → ｓ１６ → ｄ２０（推奨度 Ｓ）が第 1 候補です。';
    const provider: AiProvider = {
      id: 'mock',
      kind: 'browser-local',
      explainDecision: async () => ({ text }),
    };
    const result = await explainDecision(evidence116, { developerGate: true, provider });
    expect(result).toMatchObject({ status: 'ok', source: 'provider', text });
  });

  it('EvidenceにT1が無いとき「ｔ１ が最善です」は unsupported claim として不採用', async () => {
    const provider: AiProvider = {
      id: 'mock',
      kind: 'browser-local',
      explainDecision: async () => ({ text: 'ｔ１ が最善です' }),
    };
    const result = await explainDecision(evidence116, { developerGate: true, provider });
    expect(result).toMatchObject({ status: 'ok', source: 'fallback', fallbackReason: 'unsupported-claim' });
    if (result.status === 'ok') expect(result.issues).toContain('根拠の無い的: T1');
  });
});
