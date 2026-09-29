/**
 * Benchmark の自動検証（unsupported claim・engine contradiction・thinking・体裁）のテスト。
 *
 * 誤検出（Evidence どおりの説明を不合格にする）と見逃し（既知の矛盾を合格にする）の両方を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { suggestFor } from '../../engine/recovery/suggest';
import { buildDecisionEvidence } from '../evidence';
import {
  INTERNAL_CODE_ALLOWLIST,
  INTERNAL_CODE_PATTERN,
  OUTPUT_LIMIT_TOKEN_MARGIN,
  REPETITION_RULES,
  detectOutputLimit,
  detectRepetition,
  findInternalCodeLeaks,
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

describe('反復（REPETITION）', () => {
  it('しきい値を固定する', () => {
    expect(REPETITION_RULES).toEqual({
      dartPeriodMax: 4,
      dartMinRepeats: 3,
      dartMinSpan: 8,
      longDartList: 16,
      substringMinLength: 8,
      substringMaxLength: 80,
      substringMinRepeats: 3,
      sentenceMinLength: 8,
      sentenceMinRepeats: 3,
    });
  });

  it('SIMULATION_REVIEW の暴走（S20、S18、S20、S18…）を拾う', () => {
    const runaway = `見直すとよい投は ${Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? 'S20' : 'S18')).join('、')} です。`;
    expect(detectRepetition(runaway)).toMatch(/繰り返して/);
    // 全角・小文字でもすり抜けない。
    expect(detectRepetition('ｓ２０、ｓ１８、ｓ２０、ｓ１８、ｓ２０、ｓ１８、ｓ２０、ｓ１８')).not.toBeNull();
    const result = inspectOutput(runaway, decision(170, 3), 'off');
    expect(result.failureCodes).toContain('REPETITION');
    expect(result.validationPassed).toBe(false);
  });

  it('同じ的の並び（周期 1〜4）が 3 回以上・8 本以上続くと拾う', () => {
    expect(detectRepetition('T20、T20、T20、T20、T20、T20、T20、T20')).toMatch(/T20 × 8 回/);
    expect(detectRepetition('T20 → T19 → D12、T20 → T19 → D12、T20 → T19 → D12')).toMatch(/T20、T19、D12 × 3 回/);
    // 3 回・6 本（周期 2）は、GAME REVIEW で実際の投を並べることがあるので拾わない。
    expect(detectRepetition('S20、S18、S20、S18、S20、S18')).toBeNull();
  });

  it('1 つの列に 16 本以上の的が並ぶと拾う（Evidence の投は最大 12 件）', () => {
    const darts = ['T20', 'T19', 'T18', 'T17', 'S20', 'S19', 'S18', 'S17', 'D20', 'D19', 'D18', 'D17', 'S1', 'S5', 'S12', 'S9'];
    expect(detectRepetition(darts.join('、'))).toMatch(/16 本/);
    expect(detectRepetition(darts.slice(0, 12).join('、'))).toBeNull();
  });

  it('同じ文字列の連続・同じ文の繰り返しを拾う', () => {
    // 8 文字（空白を除く）の文字列が 3 回連続すると拾う。7 文字の 3 回は拾わない（境界）。
    expect(detectRepetition('残りを整えます、残りを整えます、残りを整えます、')).toMatch(/同じ文字列/);
    expect(detectRepetition('ことができますことができますことができます')).toBeNull();
    expect(detectRepetition('残りを整えます、残りを整えます、')).toBeNull();
    const sentence = 'T20 を狙うと次のラウンドに良い残りを作れます。';
    expect(detectRepetition(`${sentence}${sentence}${sentence}`)).not.toBeNull();
    expect(detectRepetition(`${sentence}BULL も推奨度 S です。${sentence}理由は同じです。${sentence}`)).toMatch(/同じ文が 3 回/);
  });

  it('正常なダーツの表現は誤検出しない', () => {
    const normal = [
      'T20 → T20 → D20 で 140 を上がれます。',
      '170 は T20 → T20 → BULL で上がる基準ルートです。',
      'T20 を 2 本入れて、最後は BULL で上がります。T20 がシングルに落ちても S20 で残りを整えられます。',
      'T20、T20、D20 の順に狙います。外れても T20 → D20 の形が残ります。',
      '1 投目は T20、2 投目も T20 です。',
      'BULL → BULL が第 2 候補です。BULL → BULL も推奨度 S です。',
      // 同じ文の言い直し（2 回まで）は許す。
      'T20 を狙いましょう。T20 を狙いましょう。',
    ];
    expect(normal.filter((text) => detectRepetition(text) !== null)).toEqual([]);
  });
});

describe('出力の上限（OUTPUT_LIMIT_REACHED）', () => {
  it('Runtime の finish_reason: length を優先する', () => {
    expect(detectOutputLimit({ finishReason: 'length', outputTokens: 120, maxTokens: 384 })).toEqual({
      basis: 'finish-reason',
      outputTokens: 120,
      maxTokens: 384,
    });
    // Runtime が stop と言えば、上限の近くでも打ち切りとはみなさない。
    expect(detectOutputLimit({ finishReason: 'stop', outputTokens: 384, maxTokens: 384 })).toBeNull();
  });

  it('finish_reason が分からないときだけ、トークン数で安全側に判断する（上限 − 8 以上）', () => {
    expect(OUTPUT_LIMIT_TOKEN_MARGIN).toBe(8);
    expect(detectOutputLimit({ finishReason: null, outputTokens: 379, maxTokens: 384 })?.basis).toBe('token-count');
    expect(detectOutputLimit({ finishReason: null, outputTokens: 376, maxTokens: 384 })?.basis).toBe('token-count');
    expect(detectOutputLimit({ finishReason: null, outputTokens: 375, maxTokens: 384 })).toBeNull();
    expect(detectOutputLimit({ finishReason: null, outputTokens: null, maxTokens: 384 })).toBeNull();
  });

  it('上限に達した応答は、文面が正しくても合格にしない', () => {
    const faithful = 'T20 → T20 → BULL で 170 を上がれます。';
    const result = inspectOutput(faithful, decision(170, 3), 'off', { finishReason: 'length', outputTokens: 384, maxTokens: 384 });
    expect(result.failureCodes).toEqual(['OUTPUT_LIMIT_REACHED']);
    expect(result.validationPassed).toBe(false);
    expect(inspectOutput(faithful, decision(170, 3), 'off', { finishReason: 'stop', outputTokens: 20, maxTokens: 384 }).validationPassed).toBe(true);
  });
});

describe('内部の code の漏れ（INTERNAL_CODE_LEAK）', () => {
  it('reason code・判定の enum を拾う（全角・小文字でも）', () => {
    expect(findInternalCodeLeaks('理由は STANDARD_ROUTE と LEAVES_CHECKOUTABLE です。判定は GOOD_DECISION。')).toEqual([
      'STANDARD_ROUTE',
      'LEAVES_CHECKOUTABLE',
      'GOOD_DECISION',
    ]);
    expect(findInternalCodeLeaks('ＧＯＯＤ＿ＤＥＣＩＳＩＯＮ と good_decision')).toEqual(['GOOD_DECISION']);
    expect(findInternalCodeLeaks('SINGLE_MISS_SAFE のため')).toEqual(['SINGLE_MISS_SAFE']);
    const result = inspectOutput('T20 → T20 → BULL は STANDARD_ROUTE です。', decision(170, 3), 'off');
    expect(result.failureCodes).toContain('INTERNAL_CODE_LEAK');
  });

  it('的・画面の用語は誤検出しない（形・allowlist を明示）', () => {
    expect(INTERNAL_CODE_PATTERN.source).toBe('(?<![A-Z0-9_])[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+(?![A-Z0-9_])');
    expect([...INTERNAL_CODE_ALLOWLIST]).toEqual([]);
    const terms = 'T20 D20 D16 S5 S20 BULL S-BULL SB PPR BUST NEXT VISIT GOOD BETTER BAD CHECKOUT SETUP 3DA T20→T20→D20 Ｔ２０';
    expect(findInternalCodeLeaks(terms)).toEqual([]);
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
