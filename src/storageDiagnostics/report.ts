/**
 * 診断結果の比較（Case A〜D）と JSON export（`docs/BROWSER_STORAGE_DIAGNOSTICS.md`）。
 *
 * 比較するのは「同じ target size で、成功か失敗まで走った最新の結果」だけ。中止した結果と、
 * 書き込みの前の失敗（`failedPhase: 'prepare'`）は比べない。
 * Case の判定は**切り分けの手がかり**であって、原因の断定ではない。
 */
import { DIAGNOSTIC_BACKENDS, type DiagnosticBackend } from './constants';
import type { OriginStorageStatus, StorageDiagnosticResult } from './types';

export type ComparisonCase = 'A' | 'B' | 'C' | 'D' | 'other';

export interface StorageComparison {
  readonly targetBytes: number;
  readonly outcomes: Readonly<Record<DiagnosticBackend, 'success' | 'failed'>>;
  readonly case: ComparisonCase;
  readonly interpretationJa: string;
}

export const COMPARISON_INTERPRETATION_JA: Readonly<Record<ComparisonCase, string>> = {
  A: 'Case A: 3 方式とも成功。Browser Storage は正常。WebLLM Runtime / WebLLM の保存の実装を疑う。',
  B: 'Case B: 3 方式とも失敗。Browser / Chrome Profile / Storage quota management 側の可能性が高い（Failed at の位置が近いかも確認する）。',
  C: 'Case C: OPFS と Cache API は失敗、IndexedDB は成功。IndexedDB を WebLLM の保存方式の候補として検討する。',
  D: 'Case D: OPFS と IndexedDB は成功、Cache API だけ失敗。Cache API 固有の問題の可能性が高い。',
  other: 'Case A〜D のどれにも当てはまりません。各方式の errorName と Failed at を比べてください。',
};

/**
 * 3 方式の比較。どれかの方式に、その大きさで完了（成功・失敗）した結果が無ければ null。
 * 同じ target size の結果が複数あれば、最後のものを使う。
 */
export function compareBackends(results: readonly StorageDiagnosticResult[], targetBytes: number): StorageComparison | null {
  const latest: Partial<Record<DiagnosticBackend, 'success' | 'failed'>> = {};
  for (const result of results) {
    if (result.targetBytes !== targetBytes || result.status === 'aborted') continue;
    // 書き込みの前の失敗（前回の残りを消せない・開けない・削除が反映されない）は、その方式の容量の結果ではない。
    if (result.status === 'failed' && result.failedPhase === 'prepare') continue;
    latest[result.backend] = result.status;
  }
  if (!DIAGNOSTIC_BACKENDS.every((backend) => latest[backend] !== undefined)) return null;
  const outcomes = latest as Record<DiagnosticBackend, 'success' | 'failed'>;
  const ok = (backend: DiagnosticBackend) => outcomes[backend] === 'success';
  let comparisonCase: ComparisonCase = 'other';
  if (ok('opfs') && ok('indexeddb') && ok('cache')) comparisonCase = 'A';
  else if (!ok('opfs') && !ok('indexeddb') && !ok('cache')) comparisonCase = 'B';
  else if (!ok('opfs') && ok('indexeddb') && !ok('cache')) comparisonCase = 'C';
  else if (ok('opfs') && ok('indexeddb') && !ok('cache')) comparisonCase = 'D';
  return { targetBytes, outcomes, case: comparisonCase, interpretationJa: COMPARISON_INTERPRETATION_JA[comparisonCase] };
}

export interface BrowserDescription {
  readonly userAgent: string | null;
  readonly brands: readonly string[] | null;
  readonly platform: string | null;
}

export function describeBrowser(): BrowserDescription {
  if (typeof navigator === 'undefined') return { userAgent: null, brands: null, platform: null };
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: readonly { brand: string; version: string }[]; platform?: string };
  };
  return {
    userAgent: nav.userAgent ?? null,
    brands: nav.userAgentData?.brands ? nav.userAgentData.brands.map((item) => `${item.brand} ${item.version}`) : null,
    platform: nav.userAgentData?.platform ?? null,
  };
}

export interface StorageDiagnosticExport {
  readonly schema: '01as-browser-storage-diagnostic';
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly browser: BrowserDescription;
  /** export した時点の origin 全体の値。 */
  readonly storage: {
    readonly usageBytes: number | null;
    readonly quotaBytes: number | null;
    readonly persisted: boolean | null;
  };
  /** このブラウザが API を公開しているか。 */
  readonly support: Readonly<Record<DiagnosticBackend, boolean>>;
  readonly testMode: boolean;
  /** この画面で実行した順の結果（中止を含む）。 */
  readonly results: readonly StorageDiagnosticResult[];
  /** 3 方式を同じ target size で比べられるなら、その比較。 */
  readonly comparison: StorageComparison | null;
}

export function buildDiagnosticExport(input: {
  readonly exportedAt: string;
  readonly browser: BrowserDescription;
  readonly storage: OriginStorageStatus | null;
  readonly support: Readonly<Record<DiagnosticBackend, boolean>>;
  readonly testMode: boolean;
  readonly results: readonly StorageDiagnosticResult[];
  readonly comparisonTargetBytes: number;
}): StorageDiagnosticExport {
  return {
    schema: '01as-browser-storage-diagnostic',
    schemaVersion: 1,
    exportedAt: input.exportedAt,
    browser: input.browser,
    storage: {
      usageBytes: input.storage?.usageBytes ?? null,
      quotaBytes: input.storage?.quotaBytes ?? null,
      persisted: input.storage?.persisted ?? null,
    },
    support: input.support,
    testMode: input.testMode,
    results: input.results,
    comparison: compareBackends(input.results, input.comparisonTargetBytes),
  };
}
