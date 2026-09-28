/**
 * Benchmark の自動検証（unsupported claim・engine contradiction・thinking・体裁）のテスト。
 *
 * 誤検出（Evidence どおりの説明を不合格にする）と見逃し（既知の矛盾を合格にする）の両方を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { suggestFor } from '../../engine/recovery/suggest';
import { buildDecisionEvidence } from '../evidence';
import {
  inspectOutput,
  findBenchmarkUnsupportedClaims,
  findContradictions,
  japaneseRatio,
  splitThinking,
  styleFlagsOf,
} from './checks';
import type { BenchmarkInput } from './types';

function decision(left: number, darts: number): BenchmarkInput {
  return { kind: 'decision', decision: buildDecisionEvidence(suggestFor(left, darts)), previousThrow: null };
}

describe('thinking の分離', () => {
  it('think タグの中身は本文から外す', () => {
    const visible = splitThinking('<think>\n考え中\n</think>\n\nT20 を狙います。');
    expect(visible).toEqual({ text: 'T20 を狙います。', thinking: '考え中', malformedThinking: false });
  });

  it('空の think タグ（thinking OFF の出力）は漏れに数えない', () => {
    const visible = splitThinking('<think>\n\n</think>\n\n説明です。');
    expect(styleFlagsOf(visible, 'off').thinkingLeak).toBe(false);
  });

  it('thinking OFF なのに推論が出た / 閉じていない think は漏れとして扱う', () => {
    expect(styleFlagsOf(splitThinking('<think>長い推論</think>説明'), 'off').thinkingLeak).toBe(true);
    expect(styleFlagsOf(splitThinking('<think>長い推論</think>説明'), 'on').thinkingLeak).toBe(false);
    const unclosed = splitThinking('説明の前半<think>打ち切られた推論');
    expect(unclosed.text).toBe('説明の前半');
    expect(unclosed.malformedThinking).toBe(true);
  });

  it('閉じていない think は形の不合格になる', () => {
    const result = inspectOutput('<think>打ち切られた推論', decision(170, 3), 'on');
    expect(result.validationPassed).toBe(false);
    expect(result.shapeProblem).not.toBeNull();
  });
});

describe('unsupported claim（validation.ts と同じ判定）', () => {
  it('Evidence に無い的・数値・推奨度を拾う', () => {
    const issues = findBenchmarkUnsupportedClaims('T19 → T19 → D16 で 170 を上がれます。推奨度 C です。', decision(170, 3));
    expect(issues).toEqual(
      expect.arrayContaining(['根拠の無い的: T19', '根拠の無い的: D16', '根拠の無い推奨度: C']),
    );
  });

  it('RECOVERY の previousThrow に書かれた値は根拠に含める', () => {
    const input: BenchmarkInput = {
      kind: 'decision',
      decision: buildDecisionEvidence(suggestFor(150, 2)),
      previousThrow: {
        leftBefore: 170,
        dartsLeftBefore: 3,
        intendedDartId: 'T20',
        actualDartId: 'S20',
        missKind: 'single',
        leftAfter: 150,
      },
    };
    expect(findBenchmarkUnsupportedClaims('170 から T20 を狙って S20 に入り、残りは 150 です。', input)).toEqual([]);
  });
});

describe('engine contradiction', () => {
  it('第 2 候補を「第 1 候補 / おすすめ」と呼ぶと矛盾', () => {
    // 100・2 本: engine の第 1 候補は T20 → D20、第 2 候補は BULL → BULL。
    const input = decision(100, 2);
    expect(findContradictions('第 1 候補は BULL → BULL です。', input)).toHaveLength(1);
    expect(findContradictions('BULL → BULL がおすすめです。', input)).toHaveLength(1);
    expect(findContradictions('第 1 候補は T20 → D20 です。BULL → BULL も推奨度 S です。', input)).toEqual([]);
    // 1 投目だけに触れるのは矛盾ではない。
    expect(findContradictions('おすすめは T20 から入るルートです。', input)).toEqual([]);
  });

  it('推奨度の取り違え・基準ルートの取り違えを拾う', () => {
    const input = decision(100, 2);
    expect(findContradictions('T20 → D20（推奨度 A）が第 1 候補です。', input)).toEqual([
      '推奨度の取り違え: T20 → D20 は推奨度 S（説明では A）',
    ]);
    expect(findContradictions('BULL → BULL は基準ルートです。', input)).toEqual([
      '基準ルートの取り違え: BULL → BULL は基準ルートではない',
    ]);
    expect(findContradictions('BULL → BULL は基準ルートではありません。', input)).toEqual([]);
  });

  it('CHECKOUT で「上がれない」、NEXT VISIT で「このラウンドで上がれる」は矛盾', () => {
    expect(findContradictions('この残りは上がれません。', decision(170, 3))).toHaveLength(1);
    // 外れた場合の仮定は矛盾に数えない。
    expect(findContradictions('1 投目をシングルへ外すと、残りの本数では上がれません。', decision(170, 3))).toEqual([]);
    expect(findContradictions('このラウンドで上がれます。', decision(169, 3))).toHaveLength(1);
    expect(findContradictions('次のラウンドで上がれる残りを作ります。', decision(169, 3))).toEqual([]);
  });

  it('Bogey 判定の否定・捏造を拾う', () => {
    expect(findContradictions('169 は Bogey ではありません。', decision(169, 3))).toHaveLength(1);
    expect(findContradictions('169 は Bogey です。', decision(169, 3))).toEqual([]);
    expect(findContradictions('170 はボギーです。', decision(170, 3))).toHaveLength(1);
  });

  it('CHECKOUT の本数の取り違えを拾う', () => {
    // 170・3 本は 3 本の上がりしかない。
    expect(findContradictions('170 は 2 本で上がれます。', decision(170, 3))).toHaveLength(1);
    expect(findContradictions('170 は 3 本で上がれます。', decision(170, 3))).toEqual([]);
  });
});

describe('体裁（自動の目安）', () => {
  it('日本語の割合・Markdown・英文を拾う', () => {
    expect(japaneseRatio('T20 を狙います。')).toBeGreaterThan(0.4);
    expect(japaneseRatio('Aim for T20 then D20.')).toBe(0);
    const flags = styleFlagsOf(splitThinking('## 説明\n- **T20** を狙う\nThis route is the best one here.'), 'off');
    expect(flags.markdown).toBe(true);
    expect(flags.englishSentence).toBe(true);
  });
});
