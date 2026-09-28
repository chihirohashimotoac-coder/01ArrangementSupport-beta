/**
 * Benchmark の自動検証。
 *
 * 01AS で最重要の指標は次の順（一般的な LLM benchmark より優先する）。
 *
 *   1. Engine contradiction rate   … engine の判断と矛盾する説明（`findContradictions`）
 *   2. Unsupported claim rate      … Evidence に無い的・推奨度・数値・reason code（`validation.ts`）
 *   3. Validation failure rate     … 形・根拠・矛盾のどれかで不合格
 *   4. Japanese explanation quality … 自動の style flag ＋ 人手評価（export）
 *   5. Latency
 *
 * ここの判定は**戦術判断をしない**。Evidence に書かれた値と、説明文の表現を突き合わせるだけ。
 * 矛盾の検出は既知のパターンだけを拾う保守的なもので、見逃しはあり得る
 * （`docs/AI_EVALUATION.md` のとおり人手確認を省略しない）。
 */
import { canonicalClaimText, checkOutputShape, findUnsupportedClaims } from '../validation';
import type { AiEvidence, DecisionEvidence, GameReviewEvidence, RouteEvidence } from '../types';
import { TARGET_EXPLANATION_CHARS } from './prompt';
import type { BenchmarkInput, StyleFlags, ThinkingMode } from './types';

// ---------------------------------------------------------------------------
// thinking の分離
// ---------------------------------------------------------------------------

export interface VisibleText {
  /** 利用者に見せる部分（think タグの外）。 */
  readonly text: string;
  /** think タグの中身（無ければ空）。 */
  readonly thinking: string;
  /** 閉じていない / 対応しない think タグがある。 */
  readonly malformedThinking: boolean;
}

/** `<think>…</think>` を取り除き、見せる本文と推論の本文に分ける。 */
export function splitThinking(raw: string): VisibleText {
  const thinking: string[] = [];
  let text = raw.replace(/<think>([\s\S]*?)<\/think>/g, (_, inner: string) => {
    thinking.push(inner.trim());
    return '';
  });
  let malformedThinking = false;
  const open = text.indexOf('<think>');
  if (open >= 0) {
    // 閉じずに終わった推論（max tokens で打ち切られた等）は見せない。
    thinking.push(text.slice(open + '<think>'.length).trim());
    text = text.slice(0, open);
    malformedThinking = true;
  }
  if (text.includes('</think>')) {
    malformedThinking = true;
    text = text.replace(/<\/think>/g, '');
  }
  return { text: text.trim(), thinking: thinking.filter(Boolean).join('\n'), malformedThinking };
}

// ---------------------------------------------------------------------------
// 説明文から的の並びを取り出す
// ---------------------------------------------------------------------------

const SEGMENT = /(?<![A-Za-z0-9])(?:[SDT](?:20|1[0-9]|[1-9])|S-BULL|SB|BULL)(?![A-Za-z0-9])/g;
/** 並びの区切りとして認める文字列（「T20 → T20 → BULL」「T20、D20」など）。 */
const SEQUENCE_GAP = /^\s*(?:→|->|⇒|>|、|,|・)?\s*$/;

interface DartSequence {
  readonly darts: readonly string[];
  readonly start: number;
  readonly end: number;
}

function sequencesOf(sentence: string): DartSequence[] {
  const matches = [...sentence.matchAll(SEGMENT)].map((match) => ({
    id: match[0] === 'S-BULL' ? 'SB' : match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const sequences: DartSequence[] = [];
  let current: { darts: string[]; start: number; end: number } | null = null;
  for (const match of matches) {
    if (current && SEQUENCE_GAP.test(sentence.slice(current.end, match.start))) {
      current.darts.push(match.id);
      current.end = match.end;
    } else {
      if (current) sequences.push(current);
      current = { darts: [match.id], start: match.start, end: match.end };
    }
  }
  if (current) sequences.push(current);
  return sequences;
}

function sentencesOf(text: string): string[] {
  return canonicalClaimText(text)
    .split(/[。！？!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function isPrefixOf(prefix: readonly string[], whole: readonly string[]): boolean {
  return prefix.length <= whole.length && prefix.every((id, index) => whole[index] === id);
}

function sameDarts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isPrefixOf(left, right);
}

/** 外れ方の仮定を述べている文（「外すと」「ズレても」）。その文の否定表現は矛盾に数えない。 */
const HYPOTHETICAL = /外|ズレ|ずれ|ミス|落ち|もし|場合/;

// ---------------------------------------------------------------------------
// Engine contradiction
// ---------------------------------------------------------------------------

/** 「第 1 候補」「おすすめ」など、engine の第 1 候補を指す言葉。 */
const RECOMMEND = /第\s*1\s*候補|第一候補|第\s*1\s*案|第一案|おすすめ|オススメ|推奨ルート|最善|ベスト|一番良い|いちばん良い/g;
const GRADE_CLAIM = /(?:推奨度|GRADE)\s*[:：]?\s*([SABC])(?![A-Z])/g;

function topRouteOf(evidence: DecisionEvidence): RouteEvidence | null {
  if (evidence.mode === 'NEXT_VISIT') return evidence.nextVisitProposals[0]?.route ?? null;
  if (evidence.mode === 'CHECKOUT' || evidence.mode === 'SETUP') return evidence.routes[0] ?? null;
  return null;
}

function routesOf(evidence: DecisionEvidence): RouteEvidence[] {
  return [...evidence.routes, ...evidence.nextVisitProposals.map((proposal) => proposal.route)];
}

function decisionContradictions(text: string, evidence: DecisionEvidence): string[] {
  const issues: string[] = [];
  const top = topRouteOf(evidence);
  const routes = routesOf(evidence);

  for (const sentence of sentencesOf(text)) {
    const sequences = sequencesOf(sentence);

    // 1. 第 1 候補以外を「第 1 候補 / おすすめ」と呼ぶ。
    if (top) {
      for (const keyword of sentence.matchAll(RECOMMEND)) {
        const at = keyword.index ?? 0;
        const after = sequences.find((sequence) => sequence.start >= at + keyword[0].length &&
          sequence.start - (at + keyword[0].length) <= 12);
        const before = [...sequences].reverse().find((sequence) => sequence.end <= at &&
          at - sequence.end <= 6);
        const named = after ?? before;
        if (named && !isPrefixOf(named.darts, top.dartIds)) {
          issues.push(`第 1 候補の取り違え: 「${keyword[0]}」が ${named.darts.join(' → ')} を指している（engine の第 1 候補は ${top.dartIds.join(' → ')}）`);
        }
      }
    }

    // 2. 推奨度の取り違え（ルートの直後に書いた推奨度が Evidence と違う）。
    for (const claim of sentence.matchAll(GRADE_CLAIM)) {
      const at = claim.index ?? 0;
      const named = [...sequences].reverse().find((sequence) => sequence.end <= at && at - sequence.end <= 8);
      if (!named) continue;
      const route = routes.find((candidate) => sameDarts(candidate.dartIds, named.darts));
      if (route && route.grade !== claim[1]) {
        issues.push(`推奨度の取り違え: ${named.darts.join(' → ')} は推奨度 ${route.grade}（説明では ${claim[1]}）`);
      }
    }

    // 3. 基準ルートではないルートを「基準ルート」と呼ぶ。
    for (const sequence of sequences) {
      const route = routes.find((candidate) => sameDarts(candidate.dartIds, sequence.darts));
      if (!route || route.isStandard !== false) continue;
      const following = sentence.slice(sequence.end, sequence.end + 16);
      if (/基準ルート/.test(following) && !/基準ルートで(?:は)?(?:ない|ありません)/.test(following)) {
        issues.push(`基準ルートの取り違え: ${sequence.darts.join(' → ')} は基準ルートではない`);
      }
    }

    const hypothetical = HYPOTHETICAL.test(sentence);

    // 4. CHECKOUT なのに「この残りは上がれない」と言う。
    if (evidence.mode === 'CHECKOUT' && !hypothetical &&
      /(?:残り|場面|ラウンド|ビジット)[^。]{0,10}(?:上がれ(?:ない|ません)|チェックアウト(?:でき|は)(?:ない|ません))/.test(sentence)) {
      issues.push('上がれる場面（CHECKOUT）なのに、上がれないと説明している');
    }

    // 5. 上がれない場面なのに「このラウンドで上がれる」と言う。
    if ((evidence.mode === 'NEXT_VISIT' || evidence.mode === 'SETUP') && !hypothetical &&
      !/次/.test(sentence) &&
      /(?:このラウンド|このビジット|この\s*[1-3]\s*本|今回)[^。]{0,10}(?:上がれ(?:る|ます)|チェックアウトでき(?:る|ます)|フィニッシュでき)/.test(sentence)) {
      issues.push(`上がれない場面（${evidence.mode}）なのに、このラウンドで上がれると説明している`);
    }

    // 6. Bogey 判定の否定・捏造。
    const remaining = String(evidence.remaining);
    const aboutRemaining = new RegExp(`(?<!\\d)${remaining}(?!\\d)\\s*(?:点)?\\s*(?:は|が)[^。]{0,10}(?:ボギー|BOGEY|ノーテン)`);
    if (aboutRemaining.test(sentence)) {
      const denied = /(?:ボギー|BOGEY|ノーテン)[^。]{0,6}(?:ではない|ではありません|じゃない|ではなく)/.test(sentence);
      if (evidence.isBogey && denied) {
        issues.push(`残り ${remaining} は Bogey なのに、Bogey ではないと説明している`);
      } else if (!evidence.isBogey && !denied && !hypothetical) {
        issues.push(`残り ${remaining} は Bogey ではないのに、Bogey と説明している`);
      }
    }

    // 7. CHECKOUT の本数の取り違え（「2 本で上がる」がどの候補の本数とも合わない）。
    if (evidence.mode === 'CHECKOUT' && !hypothetical) {
      const counts = new Set(evidence.routes.map((route) => route.dartIds.length));
      for (const claim of sentence.matchAll(/(?<!残り\s*)([1-3])\s*本で(?:上が|フィニッシュ|チェックアウト|決め)/g)) {
        const count = Number(claim[1]);
        if (count > evidence.dartsLeft || !counts.has(count)) {
          issues.push(`本数の取り違え: ${count} 本で上がる候補は Evidence に無い`);
        }
      }
    }
  }
  return [...new Set(issues)];
}

function reviewContradictions(text: string, evidence: GameReviewEvidence): string[] {
  const issues: string[] = [];
  const summary = evidence.summary;
  for (const sentence of sentencesOf(text)) {
    if (!summary.checkedOut && /上がりました|上がれました|チェックアウトしました|フィニッシュしました/.test(sentence)) {
      issues.push('上がっていないのに、上がったと説明している');
    }
    if (summary.checkedOut && /上がれませんでした|上がっていません|チェックアウトできませんでした/.test(sentence)) {
      issues.push('上がったのに、上がっていないと説明している');
    }
    for (const claim of sentence.matchAll(/BUST\s*(?:は|が)?\s*(\d+)\s*回/g)) {
      if (Number(claim[1]) !== summary.bustCount) {
        issues.push(`BUST の回数の取り違え: ${claim[1]} 回（Evidence は ${summary.bustCount} 回）`);
      }
    }
  }
  return [...new Set(issues)];
}

/** engine の判断と矛盾する説明を探す（既知のパターンだけ）。 */
export function findContradictions(text: string, input: BenchmarkInput): string[] {
  return input.kind === 'decision'
    ? decisionContradictions(text, input.decision)
    : reviewContradictions(text, input.review);
}

// ---------------------------------------------------------------------------
// Unsupported claim
// ---------------------------------------------------------------------------

/**
 * Evidence に無い的・推奨度・数値・reason code を探す。
 *
 * 実行時の検証（`validation.ts` の `findUnsupportedClaims`）と同じ関数を使う。
 * RECOVERY の previousThrow もモデルへ渡した Evidence の一部なので、根拠に含める。
 */
export function findBenchmarkUnsupportedClaims(text: string, input: BenchmarkInput): string[] {
  const grounding =
    input.kind === 'decision'
      ? { decision: input.decision, previousThrow: input.previousThrow }
      : input.review;
  // findUnsupportedClaims は Evidence を JSON にして値の有無を見るだけなので、
  // previousThrow を足した入れ物をそのまま渡せる。
  return findUnsupportedClaims({ text }, grounding as unknown as AiEvidence);
}

// ---------------------------------------------------------------------------
// 日本語の体裁（自動の目安。品質の判定は人手評価で行う）
// ---------------------------------------------------------------------------

export const MAX_EXPLANATION_CHARS = TARGET_EXPLANATION_CHARS * 2;
export const MIN_EXPLANATION_CHARS = 30;
export const MIN_JAPANESE_RATIO = 0.4;

const JAPANESE_CHAR = /[぀-ヿ㐀-鿿ｦ-ﾟ]/u;

export function japaneseRatio(text: string): number {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length === 0) return 0;
  return chars.filter((char) => JAPANESE_CHAR.test(char)).length / chars.length;
}

export function styleFlagsOf(visible: VisibleText, thinking: ThinkingMode): StyleFlags {
  const text = visible.text;
  return {
    tooLong: text.length > MAX_EXPLANATION_CHARS,
    tooShort: text.length < MIN_EXPLANATION_CHARS,
    lowJapaneseRatio: japaneseRatio(text) < MIN_JAPANESE_RATIO,
    markdown: /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s)|\*\*[^*]+\*\*|```/m.test(text),
    englishSentence: /[A-Za-z]{3,}(?:[\s,]+[A-Za-z']{2,}){3,}/.test(text),
    thinkingLeak: visible.malformedThinking || (thinking !== 'on' && visible.thinking.length > 0),
  };
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

export interface OutputInspection {
  readonly text: string;
  readonly shapeProblem: string | null;
  readonly unsupportedClaims: readonly string[];
  readonly contradictions: readonly string[];
  readonly style: StyleFlags;
  readonly mentionsTopTarget: boolean | null;
  readonly validationPassed: boolean;
}

function topTargetOf(input: BenchmarkInput): string | null {
  if (input.kind !== 'decision') return null;
  return topRouteOf(input.decision)?.dartIds[0] ?? null;
}

/** 1 件の出力を検証する。形 → 根拠 → 矛盾の順に見て、すべて通れば合格。 */
export function inspectOutput(rawText: string, input: BenchmarkInput, thinking: ThinkingMode): OutputInspection {
  const visible = splitThinking(rawText);
  const shapeProblem = checkOutputShape({ text: visible.text }) ??
    (visible.malformedThinking ? 'think タグが閉じていません。' : null);
  const unsupportedClaims = shapeProblem === null ? findBenchmarkUnsupportedClaims(visible.text, input) : [];
  const contradictions = shapeProblem === null ? findContradictions(visible.text, input) : [];
  const topTarget = topTargetOf(input);
  return {
    text: visible.text,
    shapeProblem,
    unsupportedClaims,
    contradictions,
    style: styleFlagsOf(visible, thinking),
    mentionsTopTarget: topTarget === null
      ? null
      : sequencesOf(canonicalClaimText(visible.text)).some((sequence) => sequence.darts.includes(topTarget)),
    validationPassed: shapeProblem === null && unsupportedClaims.length === 0 && contradictions.length === 0,
  };
}
