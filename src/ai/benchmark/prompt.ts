/**
 * Benchmark 用のプロンプト（版管理つき）。
 *
 * モデルに**戦術判断をさせない**。engine がすでに計算・検証した事実（Evidence）だけを渡し、
 * 「なぜこの判断なのか」を自然な日本語で短く説明させる。
 *
 * - 同じケース・同じ版からは常に同じ messages になる（決定論的。時刻・乱数を使わない）
 * - 文面を変えたら `PROMPT_VERSION` を上げる。版が違う結果どうしは比べない
 * - thinking の ON / OFF はここでは変えない（同じ prompt で Runtime 側の設定だけを変える）
 */
import { serializeEvidence } from '../evidence';
import { fingerprint } from './hash';
import type { BenchmarkCase, BenchmarkCategory, BuiltPrompt, ChatMessage } from './types';

export const PROMPT_ID = '01as-explain-ja';
export const PROMPT_VERSION = 1;
export const PROMPT_VERSION_LABEL = `${PROMPT_ID}@${PROMPT_VERSION}`;

/** 説明文の目安の長さ（全角換算の文字数）。自動の style flag にも使う。 */
export const TARGET_EXPLANATION_CHARS = 200;

export const SYSTEM_PROMPT = [
  'あなたはスティールダーツの 01 アレンジ学習支援 AI です。',
  '',
  '以下は 01 Arrangement Support の決定論的 Engine が、すでに計算・検証した事実（Evidence）です。',
  'この Evidence に含まれる情報だけを使用してください。',
  '',
  '新しいルート、新しい評価、新しい得点、新しい戦術判断を追加してはいけません。',
  'Evidence の順位（rank）・推奨度（grade）・残り（leave）・理由（reasons）を変えたり、並べ替えたりしてはいけません。',
  '的の表記（T20・D16・S5・BULL など）と数値は、Evidence に書かれているものだけを、そのままの表記で使ってください。',
  'Evidence に無いことは推測で補わず、触れないでください。',
  '',
  'ユーザーが「なぜこの判断なのか」を理解できるよう、自然な日本語で簡潔に説明してください。',
  `- ${TARGET_EXPLANATION_CHARS} 文字程度、2〜4 文で書く`,
  '- 見出し・箇条書き・Markdown・英語の文は使わない',
  '- 説明文だけを出力する（前置きや確認の文は書かない）',
].join('\n');

const SCENE_INSTRUCTION: Readonly<Record<BenchmarkCategory, string>> = {
  CHECKOUT:
    '場面: CHECKOUT（残り本数で上がれる場面）。アプリの第 1 候補（rank 1）のルートを中心に、なぜそのルートなのかを reasons に沿って説明してください。',
  SETUP:
    '場面: SETUP（171〜350 の残りを整える場面）。アプリの第 1 候補（rank 1）で何点を取り（scored）、何を残すか（leave）、なぜその残りなのかを reasons に沿って説明してください。',
  NEXT_VISIT:
    '場面: NEXT VISIT（このラウンドの残り本数では上がれない場面）。次のラウンドへの残し方の第 1 案（nextVisitProposals の 1 件目）と、その理由を reasons に沿って説明してください。',
  RECOVERY:
    '場面: RECOVERY（直前の 1 投が狙いから外れたあとの場面）。previousThrow に書かれた外れ方を踏まえ、いまの第 1 候補（CHECKOUT / SETUP なら routes の rank 1、NEXT_VISIT なら nextVisitProposals の 1 件目）と、その理由を reasons に沿って説明してください。',
  SIMULATION_REVIEW:
    '場面: SIMULATION の GAME REVIEW（1 ゲームの振り返り）。summary の結果と、verdict が GOOD_DECISION 以外の投のうち見直すとよいものを、Evidence の値だけで要約してください。',
};

/** ケースの Evidence を、キー順を固定した JSON にする（同じケース → 同じ文字列）。 */
export function evidenceJsonOf(benchmarkCase: BenchmarkCase): string {
  const input = benchmarkCase.input;
  return input.kind === 'decision'
    ? serializeEvidence({ decision: input.decision, previousThrow: input.previousThrow })
    : serializeEvidence({ review: input.review });
}

export function buildUserPrompt(benchmarkCase: BenchmarkCase): string {
  return [
    SCENE_INSTRUCTION[benchmarkCase.category],
    '',
    '次の Evidence（JSON）だけを根拠に説明してください。',
    '<evidence>',
    evidenceJsonOf(benchmarkCase),
    '</evidence>',
  ].join('\n');
}

export function buildPrompt(benchmarkCase: BenchmarkCase): BuiltPrompt {
  const messages: readonly ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(benchmarkCase) },
  ];
  return {
    promptVersion: PROMPT_VERSION_LABEL,
    messages,
    promptHash: fingerprint(messages.map((message) => `${message.role}\n${message.content}`).join('\n\n')),
  };
}
