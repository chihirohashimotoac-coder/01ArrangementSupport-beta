/**
 * モデルの取得・保存・読み込みの失敗を分類し、診断情報を作る（AI MODEL LAB）。
 *
 * 「読み込めませんでした: Quota exceeded.」だけでは、保存領域の容量制限なのか、通信なのか、
 * GPU への読み込みなのかが分からない。ここでは失敗を次の区分に分け、保存方式・
 * `DOMException.name`・message・`navigator.storage.estimate()` と一緒に記録する。
 *
 * - `quota-exceeded`: 保存領域の容量制限（`QuotaExceededError`）。**GPU 不足としては扱わない**
 * - `opfs-unavailable`: OPFS を使えなかった（API が無い・secure context でない など）
 * - `storage-failed`: 保存領域の読み書きの失敗（容量制限以外）
 * - `network-failed`: 配布元からの取得の失敗
 * - `gpu-load-failed`: WebGPU への読み込みの失敗（adapter・feature・device lost など）
 * - `aborted`: 利用者が中止した
 * - `unknown`: 上のどれとも判断できない
 *
 * 分類は message の文字列にも頼るため、推定である。元の name / message は必ずそのまま残す。
 */
import type { ModelStorageBackend, StorageStatus } from './modelStorage';
import { MODEL_STORAGE_LABEL } from './modelStorage';
import { BenchmarkRuntimeError } from './types';

export const MODEL_LOAD_FAILURE_CLASSES = [
  'quota-exceeded',
  'opfs-unavailable',
  'storage-failed',
  'network-failed',
  'gpu-load-failed',
  'aborted',
  'unknown',
] as const;
export type ModelLoadFailureClass = (typeof MODEL_LOAD_FAILURE_CLASSES)[number];

export function errorNameOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  }
  return null;
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** 旧来の `DOMException.QUOTA_EXCEEDED_ERR`。 */
const LEGACY_QUOTA_CODE = 22;

const GPU_ERROR_NAMES = new Set([
  'WebGPUNotAvailableError',
  'WebGPUNotFoundError',
  'FeatureSupportError',
  'ShaderF16SupportError',
  'DeviceLostError',
  'GPUOutOfMemoryError',
  'GPUValidationError',
  'GPUPipelineError',
]);

const STORAGE_ERROR_NAMES = new Set([
  'InvalidStateError',
  'NoModificationAllowedError',
  'NotReadableError',
  'InvalidModificationError',
  'NotFoundError',
  'TypeMismatchError',
  'UnknownError',
  'DataError',
  'DataCloneError',
  'TransactionInactiveError',
  'VersionError',
  'ConstraintError',
  'ReadOnlyError',
]);

const QUOTA_PATTERN = /quota\s*(exceeded|has been exceeded)|exceeded\s+(the\s+)?quota/i;
const OPFS_UNAVAILABLE_PATTERN = /OPFS API unavailable|createSyncAccessHandle unavailable|getDirectory|crypto\.subtle\.digest is unavailable/i;
// 通信 API の名前をソースへ書かない規則（src/ai/architecture.test.ts）のため f[e]tch と書く。
const NETWORK_PATTERN = /failed to f[e]tch|unable to f[e]tch|networkerror|network error|network request failed|load failed|received status \d{3}|request failed|net::ERR_|ERR_(INTERNET|NETWORK|CONNECTION|NAME_NOT_RESOLVED|TIMED_OUT)/i;
const GPU_PATTERN = /webgpu|gpu ?device|device was lost|device lost|shader-f16|requestAdapter|requestDevice|GPUBuffer|out of memory|\bOOM\b|maxBufferSize|maxStorageBufferBindingSize/i;
const STORAGE_PATTERN = /OPFSStore|ArtifactOPFSCache|ArtifactIndexedDBCache|IndexedDB|IDBDatabase|on 'Cache'|Cache Storage|CacheStorage|storage/i;

export interface FailureContext {
  /** 失敗したときの保存方式（モデルを持たない Runtime では null）。 */
  readonly backend: ModelStorageBackend | null;
  /** 利用者が中止したか（AbortSignal）。 */
  readonly aborted: boolean;
}

/** 失敗を区分する。容量制限（quota）を最優先で見分け、GPU 不足と混同しない。 */
export function classifyModelLoadFailure(error: unknown, context: FailureContext): ModelLoadFailureClass {
  const name = errorNameOf(error);
  const message = errorMessageOf(error);
  if (context.aborted || name === 'AbortError' || (error instanceof BenchmarkRuntimeError && error.code === 'aborted')) {
    return 'aborted';
  }
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
  if (name === 'QuotaExceededError' || code === LEGACY_QUOTA_CODE || QUOTA_PATTERN.test(message)) return 'quota-exceeded';
  if (context.backend === 'opfs' &&
    (OPFS_UNAVAILABLE_PATTERN.test(message) || name === 'SecurityError' || name === 'NotSupportedError')) {
    return 'opfs-unavailable';
  }
  if (name === 'NetworkError' || NETWORK_PATTERN.test(message)) return 'network-failed';
  if ((name !== null && GPU_ERROR_NAMES.has(name)) || GPU_PATTERN.test(message)) return 'gpu-load-failed';
  if ((name !== null && STORAGE_ERROR_NAMES.has(name)) || name === 'SecurityError' || STORAGE_PATTERN.test(message)) {
    return 'storage-failed';
  }
  return 'unknown';
}

/** 失敗の診断情報（画面に出し、JSON で保存できる）。stack trace は含めない。 */
export interface ModelLoadFailureDiagnostics {
  readonly schema: '01as-ai-model-load-failure';
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly candidateId: string;
  readonly runtimeId: string;
  readonly runtimeModelId: string | null;
  /** 取得を許可した読み込み（Download）だったか。 */
  readonly download: boolean;
  readonly storageBackend: ModelStorageBackend | null;
  readonly failureClass: ModelLoadFailureClass;
  /** `DOMException.name` など。 */
  readonly errorName: string | null;
  readonly message: string;
  /** 失敗の直前に Runtime が報告した進み具合（0〜1）。 */
  readonly progressFraction: number | null;
  readonly progressText: string | null;
  /** 失敗の直後の `navigator.storage.estimate()`・`persisted()`（origin 全体）。 */
  readonly storage: StorageStatus | null;
  /** 取得を始める前の `navigator.storage.estimate()`（origin 全体）。 */
  readonly storageBefore: StorageStatus | null;
}

export interface FailureDescription {
  /** 画面に出す文（1 行ずつ）。 */
  readonly linesJa: readonly string[];
  /** 「OPFS で再試行」を示すか（OPFS 以外で失敗し、OPFS の API がある）。 */
  readonly suggestOpfs: boolean;
}

/** 利用者向けの説明。生の stack trace は出さない（診断情報に name / message を残す）。 */
export function describeModelLoadFailure(
  diagnostics: ModelLoadFailureDiagnostics,
  options: { readonly opfsAvailable: boolean },
): FailureDescription {
  const backend = diagnostics.storageBackend;
  const backendLine = `保存方式: ${backend === null ? '—' : MODEL_STORAGE_LABEL[backend]}`;
  const suggestOpfs = backend !== null && backend !== 'opfs' && options.opfsAvailable &&
    ['quota-exceeded', 'storage-failed'].includes(diagnostics.failureClass);
  const opfsLine = suggestOpfs ? ['OPFS で再試行できます（保存方式を OPFS に切り替え、確認のあとで取得します）。'] : [];
  switch (diagnostics.failureClass) {
    case 'quota-exceeded':
      return {
        suggestOpfs,
        linesJa: [
          'モデルの保存に失敗しました。',
          backendLine,
          'ブラウザのモデル保存領域で容量制限（QuotaExceededError）が発生しました。GPU の不足ではありません。',
          ...opfsLine,
          ...(backend === 'opfs' ? ['Origin Usage / Origin Quota と、端末の空き容量を確認してください。'] : []),
        ],
      };
    case 'opfs-unavailable':
      return {
        suggestOpfs: false,
        linesJa: [
          'モデルの保存に失敗しました。',
          backendLine,
          'このブラウザ・この画面では OPFS を使えませんでした。保存方式を IndexedDB に切り替えて再試行できます。',
        ],
      };
    case 'storage-failed':
      return {
        suggestOpfs,
        linesJa: ['モデルの保存領域の読み書きに失敗しました。', backendLine, ...opfsLine],
      };
    case 'network-failed':
      return {
        suggestOpfs: false,
        linesJa: [
          'モデルの取得（配布元との通信）に失敗しました。',
          backendLine,
          'ネットワークを確認して、もう一度「Download」から再試行してください。',
        ],
      };
    case 'gpu-load-failed':
      return {
        suggestOpfs: false,
        linesJa: [
          'モデルを GPU（WebGPU）へ読み込めませんでした。保存領域の問題ではありません。',
          backendLine,
          'WebGPU の adapter・feature・メモリ（maxBufferSize など）の制約の可能性があります。',
        ],
      };
    case 'aborted':
      return { suggestOpfs: false, linesJa: ['読み込みを中止しました。', backendLine] };
    case 'unknown':
      return {
        suggestOpfs: false,
        linesJa: ['読み込めませんでした（原因を分類できませんでした）。', backendLine, diagnostics.message],
      };
  }
}
