/**
 * AI 説明の安全な呼び出し口のテスト。
 *
 * - Provider が throw / タイムアウト / 不正応答 / 未対応でも、例外を出さず決定論的な説明を返す
 * - Evidence に無い事実を含む AI 出力は採用しない
 * - Evidence が足りなければ Provider を呼ばず `insufficient-evidence` にする
 * - AI の返答内容によって engine の結果（推奨度・推奨ルート・残り・Bust・NEXT VISIT）が変わらない
 * - feature flag の既定は OFF
 */
import { describe, expect, it, vi } from 'vitest';
import { suggestFor } from '../engine/recovery/suggest';
import { applyDart } from '../domain/checkoutRules';
import { requireDart } from '../domain/dart';
import { MAX_PPR } from '../engine/simulation/accuracy';
import { advanceRound, createGame, submitScore, throwAt } from '../engine/simulation/game';
import { buildGameReview } from '../engine/simulation/review';
import { buildDecisionEvidence, buildGameReviewEvidence, buildTrainingEvidence } from './evidence';
import { explainDecision, summarizeSession } from './explain';
import { AI_FEATURES_DEFAULT_ENABLED, isAiFeatureEnabled } from './featureFlag';
import {
  explainDecisionDeterministically,
  summarizeSessionDeterministically,
  templateProvider,
} from './templateProvider';
import type { AiProvider, AiResult, AiTextOutput, DecisionEvidence } from './types';
import { checkDecisionEvidence, findUnsupportedClaims } from './validation';
import { computeStats } from '../storage/trainingHistory';

const ON = { enabled: true } as const;

function providerOf(explain: AiProvider['explainDecision'], extra: Partial<AiProvider> = {}): AiProvider {
  return { id: 'test-provider', kind: 'browser-local', explainDecision: explain, ...extra };
}

function expectFallback(result: AiResult, reason: string): void {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  expect(result.source).toBe('fallback');
  expect(result.fallbackReason).toBe(reason);
  expect(result.text.length).toBeGreaterThan(0);
}

/** engine の結果のうち、AI が変えてはいけない値をすべて並べた指紋。 */
function engineFingerprint(left: number, darts: number): string {
  const suggestion = suggestFor(left, darts);
  return JSON.stringify({
    mode: suggestion.mode,
    remaining: suggestion.remaining,
    dartsLeft: suggestion.dartsLeft,
    isBogey: suggestion.isBogey,
    checkout: suggestion.checkoutRoutes.map((route) => [route.key, route.grade, route.score, route.isStandard]),
    setup: suggestion.setupRoutes.map((route) => [route.key, route.grade, route.score, route.leave]),
    nextVisit: suggestion.nextVisitRoute?.key ?? null,
    proposals: suggestion.nextVisitProposals.map((item) => [item.kind, item.route.key, item.route.grade]),
    practical: suggestion.practicalLastDart?.dartId ?? null,
  });
}

function sampleGameReviewEvidence() {
  let game = createGame(
    { startScore: 100, first9Ppr: MAX_PPR, averagePpr: MAX_PPR, missDirection: 'even', maxMiss: 'medium' },
    1,
  );
  game = throwAt(throwAt(game, 'segment-t20'), 'segment-t20'); // 40 → BUST
  game = advanceRound(game);
  game = throwAt(throwAt(game, 'segment-t20'), 'segment-d20');
  game = advanceRound(submitScore(game, 100));
  return buildGameReviewEvidence(buildGameReview(game));
}

describe('feature flag', () => {
  it('既定は OFF', () => {
    expect(AI_FEATURES_DEFAULT_ENABLED).toBe(false);
    expect(isAiFeatureEnabled({})).toBe(false);
    expect(isAiFeatureEnabled({ VITE_AI_FEATURES: 'off' })).toBe(false);
    expect(isAiFeatureEnabled({ VITE_AI_FEATURES: '1' })).toBe(false);
    expect(isAiFeatureEnabled({ VITE_AI_FEATURES: 'on' })).toBe(true);
    // このビルド（テスト環境）では設定していない。
    expect(isAiFeatureEnabled()).toBe(false);
  });

  it('OFF のとき Provider を呼ばず、決定論的な説明を返す', async () => {
    const explain = vi.fn(async () => ({ text: '呼ばれてはいけない' }));
    const evidence = buildDecisionEvidence(suggestFor(116, 3));
    const result = await explainDecision(evidence, { provider: providerOf(explain) });
    expect(explain).not.toHaveBeenCalled();
    expectFallback(result, 'disabled');
    if (result.status === 'ok') expect(result.text).toBe(explainDecisionDeterministically(evidence).text);
  });

  it('ON でも Provider が無ければ決定論的な説明を返す', async () => {
    const evidence = buildDecisionEvidence(suggestFor(116, 3));
    expectFallback(await explainDecision(evidence, { ...ON, provider: null }), 'disabled');
  });
});

describe('Provider の失敗でもアプリ本体は壊れない', () => {
  const evidence = buildDecisionEvidence(suggestFor(116, 3));
  const expectedFallback = explainDecisionDeterministically(evidence).text;

  it('throw（非同期）', async () => {
    const provider = providerOf(async () => {
      throw new Error('model failed to load');
    });
    const result = await explainDecision(evidence, { ...ON, provider });
    expectFallback(result, 'error');
    if (result.status === 'ok') expect(result.text).toBe(expectedFallback);
  });

  it('throw（同期）・ブラウザ非対応', async () => {
    const provider = providerOf(() => {
      throw new TypeError('WebGPU is not supported');
    });
    expectFallback(await explainDecision(evidence, { ...ON, provider }), 'error');
  });

  it('タイムアウト（応答が返らない）', async () => {
    let aborted = false;
    const provider = providerOf(
      (_evidence, context) =>
        new Promise<AiTextOutput>(() => {
          context.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    const result = await explainDecision(evidence, { ...ON, provider, timeoutMs: 20 });
    expectFallback(result, 'timeout');
    // タイムアウトしたら Provider へ中断を伝える。
    expect(aborted).toBe(true);
  });

  it.each([
    ['null', null],
    ['文字列そのもの', 'text only'],
    ['text が数値', { text: 116 }],
    ['text が空', { text: '   ' }],
    ['text が長すぎる', { text: 'あ'.repeat(5000) }],
    ['citedReasonCodes が配列でない', { text: 'ok', citedReasonCodes: 'STANDARD_ROUTE' }],
  ])('不正な応答: %s', async (_label, response) => {
    const provider = providerOf(async () => response as unknown as AiTextOutput);
    expectFallback(await explainDecision(evidence, { ...ON, provider }), 'invalid-response');
  });

  it('未対応の機能（summarizeSession が無い）', async () => {
    const provider = providerOf(async () => ({ text: 'x' }));
    const result = await summarizeSession(sampleGameReviewEvidence(), { ...ON, provider });
    expectFallback(result, 'unsupported');
  });

  it('どの失敗でも例外を外へ出さない', async () => {
    const providers: AiProvider[] = [
      providerOf(async () => {
        throw new Error('x');
      }),
      providerOf(() => {
        throw 'not an error object';
      }),
      providerOf(async () => undefined as unknown as AiTextOutput),
    ];
    for (const provider of providers) {
      await expect(explainDecision(evidence, { ...ON, provider, timeoutMs: 20 })).resolves.toMatchObject({
        status: 'ok',
        source: 'fallback',
      });
    }
  });
});

describe('Evidence に無い主張は採用しない', () => {
  // 116 / 3 本の Evidence（上位 3 件）に T17 と D10 は出てこない。
  const evidence = buildDecisionEvidence(suggestFor(116, 3));

  it.each([
    ['根拠の無い的', '116 なら T17 → D10 が最善です。'],
    ['根拠の無い推奨度', 'T20 → S16 → D20 は推奨度 C です。'],
    ['根拠の無い数値', 'T20 を外すと 77 が残ります。'],
  ])('%s', async (_label, text) => {
    const provider = providerOf(async () => ({ text }));
    const result = await explainDecision(evidence, { ...ON, provider });
    expectFallback(result, 'unsupported-claim');
    if (result.status === 'ok') expect(result.issues.length).toBeGreaterThan(0);
  });

  it('Evidence に無い reason code を根拠に挙げたら不採用', async () => {
    const provider = providerOf(async () => ({
      text: 'T20 → S16 → D20 は基準ルートです。',
      citedReasonCodes: ['AI_INVENTED_REASON'],
    }));
    expectFallback(await explainDecision(evidence, { ...ON, provider }), 'unsupported-claim');
  });

  it('Evidence の事実だけを使った説明は採用する', async () => {
    const provider = providerOf(async () => ({
      text: 'T20 → S16 → D20（推奨度 S）は基準ルートです。T20 を外して S20 に落ちても 96 が残ります。',
      citedReasonCodes: ['STANDARD_ROUTE', 'SINGLE_MISS_SAFE'],
    }));
    const result = await explainDecision(evidence, { ...ON, provider });
    expect(result).toMatchObject({ status: 'ok', source: 'provider', providerId: 'test-provider' });
  });

  it('決定論的な説明は 2〜350 × 1〜3 本のすべてで Evidence だけから組み立てられる', () => {
    const problems: string[] = [];
    for (let left = 2; left <= 350; left += 1) {
      for (let darts = 1; darts <= 3; darts += 1) {
        const scene = buildDecisionEvidence(suggestFor(left, darts));
        const check = checkDecisionEvidence(scene);
        if (!check.ok) {
          problems.push(`${left}/${darts}: insufficient ${check.missing.join(',')}`);
          continue;
        }
        const issues = findUnsupportedClaims(explainDecisionDeterministically(scene), scene);
        if (issues.length > 0) problems.push(`${left}/${darts}: ${issues.join(',')}`);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('Evidence が足りないときは補わない', () => {
  const base = buildDecisionEvidence(suggestFor(116, 3));

  it.each<[string, DecisionEvidence]>([
    ['候補が空', { ...base, routes: [] }],
    ['場面の種類が不明', { ...base, mode: 'UNKNOWN' as DecisionEvidence['mode'] }],
    ['残りが不正', { ...base, remaining: Number.NaN }],
    ['本数が不正', { ...base, dartsLeft: 4 }],
    ['スキーマが違う', { ...base, schemaVersion: 2 as unknown as 1 }],
    [
      '推奨度が欠けている',
      { ...base, routes: [{ ...base.routes[0], grade: undefined as unknown as 'S' }] },
    ],
    [
      '未知の reason code',
      {
        ...base,
        routes: [
          {
            ...base.routes[0],
            reasons: [{ code: 'MADE_UP', polarity: 'positive', label: 'x', summaryJa: 'x' }],
          },
        ],
      },
    ],
    ['NEXT VISIT の提案が無い', { ...base, mode: 'NEXT_VISIT', nextVisitProposals: [] }],
    ['対象外の理由が無い', { ...base, mode: 'UNAVAILABLE', engineNoteJa: null }],
  ])('%s', async (_label, evidence) => {
    const explain = vi.fn(async () => ({ text: 'x' }));
    const result = await explainDecision(evidence, { ...ON, provider: providerOf(explain) });
    expect(result.status).toBe('insufficient-evidence');
    if (result.status === 'insufficient-evidence') expect(result.missing.length).toBeGreaterThan(0);
    // 足りない事実を AI に補わせない（Provider を呼ばない）。
    expect(explain).not.toHaveBeenCalled();
  });

  it('記録の無い TRAINING・投げていない GAME REVIEW も insufficient-evidence', async () => {
    const empty = buildTrainingEvidence(
      computeStats({ version: 2, records: [], migrationSkippedCount: 0 }),
    );
    expect((await summarizeSession(empty)).status).toBe('insufficient-evidence');
    const notPlayed = buildGameReviewEvidence(
      buildGameReview(
        createGame(
          { startScore: 501, first9Ppr: 60, averagePpr: 55, missDirection: 'even', maxMiss: 'medium' },
          1,
        ),
      ),
    );
    expect((await summarizeSession(notPlayed)).status).toBe('insufficient-evidence');
  });
});

describe('AI の返答は engine の結果を変えない', () => {
  const scenes: ReadonlyArray<readonly [number, number]> = [
    [116, 3], [103, 3], [150, 1], [119, 2], [301, 3], [159, 3], [41, 1],
  ];

  it('推奨度・推奨ルート・残り・NEXT VISIT が、AI の返答内容にかかわらず同じ', async () => {
    const before = scenes.map(([left, darts]) => engineFingerprint(left, darts));

    // Evidence を書き換えようとし、engine と矛盾する主張をする悪い Provider。
    const hostile = providerOf(async (evidence) => {
      const mutable = evidence as unknown as { routes: Array<{ grade: string }>; remaining: number };
      try {
        mutable.remaining = 999;
      } catch {
        // 凍結されている
      }
      try {
        mutable.routes[0].grade = 'C';
      } catch {
        // 凍結されている
      }
      return { text: 'すべて推奨度 C です。T1 → T1 → D1 が最善で、残りは 777 です。' };
    });
    const obedient = templateProvider;

    for (const [left, darts] of scenes) {
      const suggestion = suggestFor(left, darts);
      const evidence = buildDecisionEvidence(suggestion);
      const snapshot = JSON.stringify(evidence);
      const hostileResult = await explainDecision(evidence, { ...ON, provider: hostile });
      const obedientResult = await explainDecision(evidence, { ...ON, provider: obedient });
      // AI の結果はどちらも「説明文」だけ。engine の値を返さない。
      for (const result of [hostileResult, obedientResult]) {
        expect(Object.keys(result).sort()).toEqual(
          ['citedReasonCodes', 'fallbackReason', 'issues', 'providerId', 'source', 'status', 'text'],
        );
      }
      expect(hostileResult).toMatchObject({ source: 'fallback', fallbackReason: 'unsupported-claim' });
      // 渡した Evidence も変わっていない。
      expect(JSON.stringify(evidence)).toBe(snapshot);
    }

    const after = scenes.map(([left, darts]) => engineFingerprint(left, darts));
    expect(after).toEqual(before);
  });

  it('Bust・得点計算は AI と無関係に domain のルールで決まる', async () => {
    const evidence = buildDecisionEvidence(suggestFor(40, 1));
    const bustBefore = applyDart(40, requireDart('T20'));
    await explainDecision(evidence, {
      ...ON,
      provider: providerOf(async () => ({ text: 'T20 は BUST しません。' })),
    });
    expect(applyDart(40, requireDart('T20'))).toEqual(bustBefore);
    expect(bustBefore.outcome).toBe('bust');
  });
});

describe('決定論的な要約', () => {
  it('GAME REVIEW を Evidence の値だけで要約する', async () => {
    const evidence = sampleGameReviewEvidence();
    const result = await summarizeSession(evidence);
    expectFallback(result, 'disabled');
    if (result.status === 'ok') {
      expect(result.text).toBe(summarizeSessionDeterministically(evidence).text);
      expect(result.text).toContain('100 スタート');
      expect(result.text).toContain('BUST は 1 回');
      expect(findUnsupportedClaims({ text: result.text }, evidence)).toEqual([]);
    }
  });

  it('TRAINING 履歴を Evidence の値だけで要約する', async () => {
    const stats = computeStats({
      version: 2,
      migrationSkippedCount: 0,
      records: [81, 103, 103].map((left, index) => ({
        id: String(index),
        at: index,
        kind: 'checkout' as const,
        format: 'checkout-route' as const,
        problemKey: `checkout|v2|left=${left}|darts=3`,
        difficulty: 'medium' as const,
        primaryCategory: null,
        learningTags: [],
        startRemaining: left,
        currentRemaining: left,
        contextualThrows: [],
        dartsAvailable: 3,
        answer: [],
        ruleValid: true,
        learningCorrect: index !== 1,
        grade: 'S' as const,
        failureCode: null,
        finishDouble: null,
        elapsedMs: 1000,
      })),
    });
    const evidence = buildTrainingEvidence(stats);
    const result = await summarizeSession(evidence);
    expectFallback(result, 'disabled');
    if (result.status === 'ok') {
      expect(result.text).toContain('3 問のうち 2 問が正解（正答率 67%）');
      expect(result.text).toContain('正答率が低い残り: 103');
      expect(findUnsupportedClaims({ text: result.text }, evidence)).toEqual([]);
    }
  });
});
