/**
 * Evidence と AI 出力の検証。
 *
 * - Evidence が足りなければ、AI にも template にも事実を補わせず `insufficient-evidence` にする。
 * - AI の説明文が Evidence に無い事実（的・推奨度・数値・reason code）を含んでいたら不採用にする。
 *
 * どちらも**戦術判断はしない**。Evidence にその値が「あるか・ないか」だけを見る。
 */
import { CHECKOUT_REASON_CODES, SETUP_REASON_CODES } from '../domain/reasonCodes';
import { THROW_VERDICTS } from '../engine/simulation/review';
import { serializeEvidence } from './evidence';
import {
  AI_EVIDENCE_SCHEMA_VERSION,
  type AiEvidence,
  type AiTextOutput,
  type DecisionEvidence,
  type RouteEvidence,
} from './types';

export type EvidenceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly string[] };

const KNOWN_REASON_CODES: ReadonlySet<string> = new Set([
  ...CHECKOUT_REASON_CODES,
  ...SETUP_REASON_CODES,
]);
const GRADES: ReadonlySet<string> = new Set(['S', 'A', 'B', 'C']);
const MODES: ReadonlySet<string> = new Set(['CHECKOUT', 'SETUP', 'NEXT_VISIT', 'UNAVAILABLE']);

/** AI の説明文として受け付ける最大文字数。 */
export const MAX_AI_TEXT_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function result(missing: string[]): EvidenceCheck {
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function checkRoute(route: unknown, path: string, missing: string[]): void {
  if (!isRecord(route)) {
    missing.push(path);
    return;
  }
  const candidate = route as Partial<RouteEvidence>;
  if (!Array.isArray(candidate.dartIds) || candidate.dartIds.length === 0) {
    missing.push(`${path}.dartIds`);
  }
  if (typeof candidate.routeText !== 'string' || candidate.routeText.length === 0) {
    missing.push(`${path}.routeText`);
  }
  if (typeof candidate.grade !== 'string' || !GRADES.has(candidate.grade)) {
    missing.push(`${path}.grade`);
  }
  if (!isNonNegativeInteger(candidate.leave)) missing.push(`${path}.leave`);
  if (!Array.isArray(candidate.reasons)) {
    missing.push(`${path}.reasons`);
    return;
  }
  candidate.reasons.forEach((reason, index) => {
    if (
      !isRecord(reason) ||
      typeof reason.code !== 'string' ||
      !KNOWN_REASON_CODES.has(reason.code) ||
      typeof reason.summaryJa !== 'string'
    ) {
      missing.push(`${path}.reasons[${index}]`);
    }
  });
}

/** CHECKOUT / SETUP の Evidence が、説明を組み立てるのに足りているか。 */
export function checkDecisionEvidence(evidence: unknown): EvidenceCheck {
  const missing: string[] = [];
  if (!isRecord(evidence)) return result(['evidence']);
  const candidate = evidence as Partial<DecisionEvidence>;
  if (candidate.schemaVersion !== AI_EVIDENCE_SCHEMA_VERSION) missing.push('schemaVersion');
  if (candidate.kind !== 'decision') missing.push('kind');
  if (typeof candidate.mode !== 'string' || !MODES.has(candidate.mode)) missing.push('mode');
  if (!isNonNegativeInteger(candidate.remaining)) missing.push('remaining');
  if (!isNonNegativeInteger(candidate.dartsLeft) || candidate.dartsLeft > 3) {
    missing.push('dartsLeft');
  }
  if (typeof candidate.isBogey !== 'boolean') missing.push('isBogey');
  if (!Array.isArray(candidate.routes)) missing.push('routes');
  if (!Array.isArray(candidate.nextVisitProposals)) missing.push('nextVisitProposals');
  if (missing.length > 0) return result(missing);

  const routes = candidate.routes as readonly unknown[];
  const proposals = candidate.nextVisitProposals as readonly unknown[];
  switch (candidate.mode) {
    case 'CHECKOUT':
    case 'SETUP':
      if (routes.length === 0) missing.push('routes[0]');
      routes.forEach((route, index) => checkRoute(route, `routes[${index}]`, missing));
      break;
    case 'NEXT_VISIT':
      if (proposals.length === 0) missing.push('nextVisitProposals[0]');
      proposals.forEach((proposal, index) =>
        checkRoute(
          isRecord(proposal) ? proposal.route : undefined,
          `nextVisitProposals[${index}].route`,
          missing,
        ),
      );
      break;
    case 'UNAVAILABLE':
      if (typeof candidate.engineNoteJa !== 'string' || candidate.engineNoteJa.length === 0) {
        missing.push('engineNoteJa');
      }
      break;
  }
  return result(missing);
}

/** GAME REVIEW / TRAINING の Evidence が、要約を組み立てるのに足りているか。 */
export function checkSessionEvidence(evidence: unknown): EvidenceCheck {
  const missing: string[] = [];
  if (!isRecord(evidence)) return result(['evidence']);
  if (evidence.schemaVersion !== AI_EVIDENCE_SCHEMA_VERSION) missing.push('schemaVersion');

  if (evidence.kind === 'game-review') {
    const summary = evidence.summary;
    if (!isRecord(summary)) {
      missing.push('summary');
    } else {
      for (const key of ['startScore', 'totalDarts', 'bustCount'] as const) {
        if (!isNonNegativeInteger(summary[key])) missing.push(`summary.${key}`);
      }
      if (typeof summary.ppr !== 'number' || !Number.isFinite(summary.ppr)) {
        missing.push('summary.ppr');
      }
      if (typeof summary.checkedOut !== 'boolean') missing.push('summary.checkedOut');
      if (summary.totalDarts === 0) missing.push('summary.totalDarts（投げていない）');
    }
    const counts = evidence.verdictCounts;
    if (!isRecord(counts) || !THROW_VERDICTS.every((verdict) => isNonNegativeInteger(counts[verdict]))) {
      missing.push('verdictCounts');
    }
    if (!Array.isArray(evidence.throws)) missing.push('throws');
    return result(missing);
  }

  if (evidence.kind === 'training') {
    if (!isNonNegativeInteger(evidence.attempts) || evidence.attempts === 0) {
      missing.push('attempts（記録が無い）');
    }
    if (!isNonNegativeInteger(evidence.correct)) missing.push('correct');
    if (!isNonNegativeInteger(evidence.accuracyPercent)) missing.push('accuracyPercent');
    if (!Array.isArray(evidence.byCategory)) missing.push('byCategory');
    return result(missing);
  }

  missing.push('kind');
  return result(missing);
}

// ---------------------------------------------------------------------------
// AI 出力の検証
// ---------------------------------------------------------------------------

/** 説明文に現れた「的」の表記（T20 / D16 / S5 / SB / BULL など）。 */
const SEGMENT_PATTERN = /(?<![A-Za-z0-9])(?:[SDT](?:20|1[0-9]|[1-9])|S-BULL|SB|BULL)(?![A-Za-z0-9])/g;
/** 推奨度の主張（「推奨度 S」「推奨度：A」「grade B」）。 */
const GRADE_PATTERN = /(?:推奨度|grade)\s*[:：]?\s*([SABC])(?![A-Za-z])/gi;
/** 数値（整数・小数）。 */
const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;
/** 本数・何投目などに使う小さな数は、Evidence に無くても主張とみなさない。 */
const FREE_NUMBER_MAX = 3;

/**
 * 表記ゆれで検証をすり抜けないよう、比べる前に正規化する。
 * NFKC で全角英数字（Ｔ２０・７７・Ｃ）を半角へ、大文字化で小文字の的（t20・d16・bull）を揃える。
 */
function normalizeForClaims(text: string): string {
  return text.normalize('NFKC').toUpperCase();
}

function tokensOf(text: string, pattern: RegExp): Set<string> {
  return new Set([...text.matchAll(pattern)].map((match) => match[1] ?? match[0]));
}

function reasonCodesOf(evidence: AiEvidence): Set<string> {
  const codes = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'code' || key === 'reasonCode') && typeof child === 'string') codes.add(child);
        else collect(child);
      }
    }
  };
  collect(evidence);
  return codes;
}

/**
 * AI 出力を検証し、問題点を返す（空なら採用してよい）。
 *
 * 「Evidence に書かれていない的・推奨度・数値・reason code」を unsupported claim として扱う。
 * Evidence の文字列（engine が組み立てた説明文を含む）に現れる値は根拠ありとみなす。
 */
export function findUnsupportedClaims(output: AiTextOutput, evidence: AiEvidence): string[] {
  const issues: string[] = [];
  const source = serializeEvidence(evidence);
  const normalizedSource = normalizeForClaims(source);
  const text = normalizeForClaims(output.text);

  const allowedSegments = tokensOf(normalizedSource, SEGMENT_PATTERN);
  for (const segment of tokensOf(text, SEGMENT_PATTERN)) {
    if (!allowedSegments.has(segment)) issues.push(`根拠の無い的: ${segment}`);
  }

  const allowedGrades = new Set(
    [...source.matchAll(/"grade":"([SABC])"/g)].map((match) => match[1]),
  );
  for (const grade of tokensOf(text, GRADE_PATTERN)) {
    if (!allowedGrades.has(grade.toUpperCase())) issues.push(`根拠の無い推奨度: ${grade}`);
  }

  const allowedNumbers = tokensOf(normalizedSource, NUMBER_PATTERN);
  for (const value of tokensOf(text, NUMBER_PATTERN)) {
    if (Number(value) <= FREE_NUMBER_MAX) continue;
    if (!allowedNumbers.has(value)) issues.push(`根拠の無い数値: ${value}`);
  }

  const allowedCodes = reasonCodesOf(evidence);
  for (const code of output.citedReasonCodes ?? []) {
    if (!allowedCodes.has(code)) issues.push(`Evidence に無い reason code: ${code}`);
  }
  return issues;
}

/** Provider の返り値の形を確かめる。問題があれば理由を返す。 */
export function checkOutputShape(output: unknown): string | null {
  if (!isRecord(output)) return '返り値がオブジェクトではありません。';
  if (typeof output.text !== 'string') return 'text が文字列ではありません。';
  if (output.text.trim().length === 0) return 'text が空です。';
  if (output.text.length > MAX_AI_TEXT_LENGTH) return `text が ${MAX_AI_TEXT_LENGTH} 文字を超えています。`;
  if (
    output.citedReasonCodes !== undefined &&
    (!Array.isArray(output.citedReasonCodes) ||
      !output.citedReasonCodes.every((code) => typeof code === 'string'))
  ) {
    return 'citedReasonCodes が文字列の配列ではありません。';
  }
  return null;
}

