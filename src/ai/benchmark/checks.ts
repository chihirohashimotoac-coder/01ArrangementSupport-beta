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
import type {
  BenchmarkInput,
  OutputLimitFinding,
  StyleFlags,
  ThinkingMode,
  ValidationFailureCode,
} from './types';

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
// 反復（repetition）
// ---------------------------------------------------------------------------

/**
 * 反復の判定の規則（しきい値はテストで固定する。`checks.test.ts`）。
 *
 * 正常なダーツの表現（`T20 → T20 → D20`・「T20 を 2 本」・同じ的に 2 回触れる）は誤検出しないよう、
 * 「単語が 2 回出た」ではなく、**1 ビジット（最大 3 本）や Evidence（GAME REVIEW の投は最大 12 件）では
 * 起こり得ない長さ**の繰り返しだけを拾う。
 */
export const REPETITION_RULES = {
  /** 的の列の周期（1〜4 本の並び）の上限。 */
  dartPeriodMax: 4,
  /** 同じ並びが連続する回数の下限。 */
  dartMinRepeats: 3,
  /** 繰り返した部分の的の本数の下限（3 本のビジットを 2 回並べても 6 本なので届かない）。 */
  dartMinSpan: 8,
  /** 1 つの列に並ぶ的の本数の上限を超えたら反復とみなす（Evidence の投は最大 12 件）。 */
  longDartList: 16,
  /** 連続して繰り返す文字列の長さ（空白を除いた文字数）。 */
  substringMinLength: 8,
  substringMaxLength: 80,
  /** 同じ文字列が連続する回数の下限。 */
  substringMinRepeats: 3,
  /** 同じ文（空白を除いて 8 文字以上）が現れる回数の下限。2 回までは言い直しとして許す。 */
  sentenceMinLength: 8,
  sentenceMinRepeats: 3,
} as const;

function periodicRunOf(darts: readonly string[]): { period: number; repeats: number; start: number } | null {
  const rules = REPETITION_RULES;
  for (let period = 1; period <= rules.dartPeriodMax; period += 1) {
    for (let start = 0; start + period * rules.dartMinRepeats <= darts.length; start += 1) {
      let repeats = 1;
      while (start + (repeats + 1) * period <= darts.length &&
        darts.slice(start + repeats * period, start + (repeats + 1) * period)
          .every((id, offset) => id === darts[start + offset])) {
        repeats += 1;
      }
      if (repeats >= rules.dartMinRepeats && repeats * period >= rules.dartMinSpan) return { period, repeats, start };
    }
  }
  return null;
}

/**
 * 不自然な反復を探す（`S20、S18、S20、S18…` のような暴走・同じ文字列や文の繰り返し）。無ければ null。
 */
export function detectRepetition(text: string): string | null {
  const rules = REPETITION_RULES;
  const canonical = canonicalClaimText(text);

  // 1. 的の列（「、」「→」などでつながった並び）。
  for (const sequence of sequencesOf(canonical)) {
    if (sequence.darts.length >= rules.longDartList) {
      return `的の列が長すぎます（${sequence.darts.length} 本: ${sequence.darts.slice(0, 6).join('、')}…）`;
    }
    const run = periodicRunOf(sequence.darts);
    if (run) {
      const unit = sequence.darts.slice(run.start, run.start + run.period).join('、');
      return `同じ的の並びが繰り返しています（${unit} × ${run.repeats} 回）`;
    }
  }

  // 2. 同じ文字列が連続する（空白を除いて比べる）。
  const compact = canonical.replace(/\s+/g, '');
  const substring = new RegExp(
    `(.{${rules.substringMinLength},${rules.substringMaxLength}}?)\\1{${rules.substringMinRepeats - 1},}`,
    'su',
  ).exec(compact);
  if (substring) {
    return `同じ文字列が繰り返しています（「${substring[1].slice(0, 20)}」× ${Math.floor(substring[0].length / substring[1].length)} 回）`;
  }

  // 3. 同じ文が何度も現れる（離れていても数える）。
  const counts = new Map<string, number>();
  for (const sentence of canonical.split(/[。！？!?\n]+/)) {
    const key = sentence.replace(/\s+/g, '');
    if (key.length < rules.sentenceMinLength) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [sentence, count] of counts) {
    if (count >= rules.sentenceMinRepeats) return `同じ文が ${count} 回現れます（「${sentence.slice(0, 20)}」）`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 出力の上限（output limit / truncation）
// ---------------------------------------------------------------------------

/**
 * finish_reason が分からないとき、出力トークン数が `maxTokens - この値` 以上なら上限に達したとみなす（安全側）。
 * 実測（max_tokens 384）で 379〜384 tokens に張り付いた応答があったため、少し手前から拾う。
 */
export const OUTPUT_LIMIT_TOKEN_MARGIN = 8;

export interface GenerationFacts {
  /** Runtime が返した finish_reason。分からなければ null。 */
  readonly finishReason: string | null;
  readonly outputTokens: number | null;
  readonly maxTokens: number;
}

/**
 * 生成が出力の上限で打ち切られたか。Runtime の finish_reason を優先し、分からないときだけトークン数で判断する。
 * WebLLM 0.2.85 は max_tokens・context window のどちらで止まっても `finish_reason: "length"` を返す。
 */
export function detectOutputLimit(facts: GenerationFacts): OutputLimitFinding | null {
  if (facts.finishReason === 'length') {
    return { basis: 'finish-reason', outputTokens: facts.outputTokens, maxTokens: facts.maxTokens };
  }
  if (facts.finishReason === null && facts.outputTokens !== null &&
    facts.outputTokens >= facts.maxTokens - OUTPUT_LIMIT_TOKEN_MARGIN) {
    return { basis: 'token-count', outputTokens: facts.outputTokens, maxTokens: facts.maxTokens };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内部の reason code の漏れ
// ---------------------------------------------------------------------------

/**
 * 内部の code の形（大文字・数字を `_` でつないだもの。例: `STANDARD_ROUTE`・`GOOD_DECISION`・`LEAVES_CHECKOUTABLE`）。
 * `_` を 1 つ以上含むものだけを拾うので、的（`T20`・`D16`・`S5`・`BULL`・`S-BULL`・`SB`）や
 * 画面の用語（`PPR`・`BUST`・`NEXT VISIT`・`GOOD`・`BETTER`）は形の上で当たらない。
 * 検証用の正規化（NFKC・大文字化）のあとで調べるので、全角・小文字（`good_decision`）でも拾う。
 */
export const INTERNAL_CODE_PATTERN = /(?<![A-Z0-9_])[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+(?![A-Z0-9_])/g;

/**
 * 形は内部の code でも、利用者向けの文に出てよい語。現時点では**該当なし**（01AS の画面の用語に `_` を含む語は無い）。
 * 追加するときは理由とテストを添える。
 */
export const INTERNAL_CODE_ALLOWLIST: ReadonlySet<string> = new Set<string>();

/** 本文に出た内部の code（重複を除く）。 */
export function findInternalCodeLeaks(text: string): string[] {
  const found = [...canonicalClaimText(text).matchAll(INTERNAL_CODE_PATTERN)].map((match) => match[0]);
  return [...new Set(found)].filter((code) => !INTERNAL_CODE_ALLOWLIST.has(code));
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

/**
 * 自動検証の版。検証の規則を変えたら上げる（run に記録し、古い run は再評価で新しい版の結果を別に作る）。
 *
 * - 1: 形・unsupported claim・engine contradiction（PR #2〜#4）
 * - 2: 反復・出力の上限・内部の code の漏れを追加（PR #5）
 */
export const BENCHMARK_VALIDATOR_VERSION = 2;

export interface OutputInspection {
  readonly text: string;
  readonly shapeProblem: string | null;
  readonly unsupportedClaims: readonly string[];
  readonly contradictions: readonly string[];
  readonly style: StyleFlags;
  readonly mentionsTopTarget: boolean | null;
  readonly repetition: string | null;
  readonly outputLimit: OutputLimitFinding | null;
  readonly internalCodeLeaks: readonly string[];
  readonly failureCodes: readonly ValidationFailureCode[];
  readonly validationPassed: boolean;
}

function topTargetOf(input: BenchmarkInput): string | null {
  if (input.kind !== 'decision') return null;
  return topRouteOf(input.decision)?.dartIds[0] ?? null;
}

/**
 * 1 件の出力を検証する。形 → 根拠 → 矛盾を見て、反復・出力の上限・内部の code の漏れも調べる。
 * すべて通れば合格（`failureCodes` が空）。
 *
 * `generation` は Runtime の finish_reason・出力トークン数と、その run の max_tokens。
 * 省略すると出力の上限は調べない（Runtime の情報が無い呼び出し。Benchmark の runner・再評価は必ず渡す）。
 */
export function inspectOutput(
  rawText: string,
  input: BenchmarkInput,
  thinking: ThinkingMode,
  generation?: GenerationFacts,
): OutputInspection {
  const visible = splitThinking(rawText);
  const shapeProblem = checkOutputShape({ text: visible.text }) ??
    (visible.malformedThinking ? 'think タグが閉じていません。' : null);
  const unsupportedClaims = shapeProblem === null ? findBenchmarkUnsupportedClaims(visible.text, input) : [];
  const contradictions = shapeProblem === null ? findContradictions(visible.text, input) : [];
  const repetition = detectRepetition(visible.text);
  const outputLimit = generation ? detectOutputLimit(generation) : null;
  const internalCodeLeaks = findInternalCodeLeaks(visible.text);
  const failureCodes: ValidationFailureCode[] = [];
  if (shapeProblem !== null) failureCodes.push('SHAPE_PROBLEM');
  if (contradictions.length > 0) failureCodes.push('ENGINE_CONTRADICTION');
  if (unsupportedClaims.length > 0) failureCodes.push('UNSUPPORTED_CLAIM');
  if (repetition !== null) failureCodes.push('REPETITION');
  if (outputLimit !== null) failureCodes.push('OUTPUT_LIMIT_REACHED');
  if (internalCodeLeaks.length > 0) failureCodes.push('INTERNAL_CODE_LEAK');
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
    repetition,
    outputLimit,
    internalCodeLeaks,
    failureCodes,
    validationPassed: failureCodes.length === 0,
  };
}
