/**
 * 端末・ブラウザの確認（Device Check）。
 *
 * **API で取得できる値だけ**を記録する。取得できないハードウェア情報（GPU の VRAM 量・
 * 端末の正確なメモリ量など）を推測して断定しない。
 *
 * - `navigator.gpu` の有無（WebGPU が公開されているか）
 * - `requestAdapter()` の結果（adapter の有無・features・limits・adapter.info）
 * - `navigator.userAgent` / `navigator.userAgentData`（ブラウザ情報）
 * - `navigator.deviceMemory`（Chromium 系だけ。0.25〜8 GiB に丸められ、上限 8 で打ち切られる）
 * - `navigator.storage.estimate()`（この origin の保存容量の目安）
 *
 * 判定（`judgeCompatibility`）は「実行できる」とは言わない。明らかに無理な場合だけ
 * `UNSUPPORTED`、大きすぎる恐れがある場合は `MAY_BE_TOO_LARGE`、それ以外は `CAN_TRY`
 * （試してよい。実行できる保証ではない）か `UNKNOWN` を返す。
 */
import type { BenchmarkCandidate } from './types';

const GIB = 1024 ** 3;

export interface DeviceReport {
  readonly userAgent: string | null;
  /** `navigator.userAgentData.brands`（Chromium 系だけ）。 */
  readonly browserBrands: readonly string[] | null;
  readonly platform: string | null;
  readonly mobile: boolean | null;
  /** `navigator.gpu` が存在するか。 */
  readonly webGpuExposed: boolean;
  /** `requestAdapter()` の結果。 */
  readonly adapter: 'available' | 'unavailable' | 'error' | 'not-checked';
  readonly adapterError: string | null;
  readonly adapterInfo: {
    readonly vendor: string | null;
    readonly architecture: string | null;
    readonly device: string | null;
    readonly description: string | null;
  } | null;
  readonly isFallbackAdapter: boolean | null;
  readonly gpuFeatures: readonly string[];
  readonly gpuLimits: {
    readonly maxBufferSize: number | null;
    readonly maxStorageBufferBindingSize: number | null;
  } | null;
  /** `navigator.deviceMemory`（GiB。丸め・上限 8 あり）。取得できなければ null。 */
  readonly deviceMemoryGiB: number | null;
  readonly hardwareConcurrency: number | null;
  readonly storage: { readonly usageBytes: number | null; readonly quotaBytes: number | null } | null;
}

// WebGPU の型はプロジェクトの lib に無いので、読む値だけを最小限に定義する。
interface GpuAdapterLike {
  readonly features?: { forEach(callback: (value: string) => void): void };
  readonly limits?: { readonly maxBufferSize?: number; readonly maxStorageBufferBindingSize?: number };
  readonly info?: { readonly vendor?: string; readonly architecture?: string; readonly device?: string; readonly description?: string };
  readonly isFallbackAdapter?: boolean;
}

interface NavigatorLike {
  readonly userAgent?: string;
  readonly userAgentData?: { readonly brands?: readonly { brand: string; version: string }[]; readonly mobile?: boolean; readonly platform?: string };
  readonly platform?: string;
  readonly gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapterLike | null> };
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
  readonly storage?: { estimate?(): Promise<{ usage?: number; quota?: number }> };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 端末を調べる。例外を投げない。 */
export async function probeDevice(
  navigatorLike: NavigatorLike | undefined = typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavigatorLike),
): Promise<DeviceReport> {
  const nav = navigatorLike ?? {};
  const uaData = nav.userAgentData;
  let adapter: DeviceReport['adapter'] = 'not-checked';
  let adapterError: string | null = null;
  let found: GpuAdapterLike | null = null;
  if (nav.gpu) {
    try {
      found = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
      adapter = found ? 'available' : 'unavailable';
    } catch (error) {
      adapter = 'error';
      adapterError = String(error);
    }
  }
  const features: string[] = [];
  found?.features?.forEach((feature) => features.push(feature));
  features.sort();

  let storage: DeviceReport['storage'] = null;
  try {
    const estimate = await nav.storage?.estimate?.();
    if (estimate) storage = { usageBytes: numberOrNull(estimate.usage), quotaBytes: numberOrNull(estimate.quota) };
  } catch {
    storage = null;
  }

  return {
    userAgent: stringOrNull(nav.userAgent),
    browserBrands: uaData?.brands ? uaData.brands.map((item) => `${item.brand} ${item.version}`) : null,
    platform: stringOrNull(uaData?.platform) ?? stringOrNull(nav.platform),
    mobile: typeof uaData?.mobile === 'boolean' ? uaData.mobile : null,
    webGpuExposed: Boolean(nav.gpu),
    adapter,
    adapterError,
    adapterInfo: found?.info
      ? {
          vendor: stringOrNull(found.info.vendor),
          architecture: stringOrNull(found.info.architecture),
          device: stringOrNull(found.info.device),
          description: stringOrNull(found.info.description),
        }
      : null,
    isFallbackAdapter: typeof found?.isFallbackAdapter === 'boolean' ? found.isFallbackAdapter : null,
    gpuFeatures: features,
    gpuLimits: found?.limits
      ? {
          maxBufferSize: numberOrNull(found.limits.maxBufferSize),
          maxStorageBufferBindingSize: numberOrNull(found.limits.maxStorageBufferBindingSize),
        }
      : null,
    deviceMemoryGiB: numberOrNull(nav.deviceMemory),
    hardwareConcurrency: numberOrNull(nav.hardwareConcurrency),
    storage,
  };
}

export type CompatibilityVerdict = 'CAN_TRY' | 'MAY_BE_TOO_LARGE' | 'UNSUPPORTED' | 'UNKNOWN';

export interface Compatibility {
  readonly verdict: CompatibilityVerdict;
  readonly reasonsJa: readonly string[];
}

/** `navigator.deviceMemory` の上限値。これ以上は「8 GiB 以上」としか分からない。 */
export const DEVICE_MEMORY_CAP_GIB = 8;

/**
 * 候補がこの端末で動かせそうかを判定する。
 *
 * 取得できた値だけで判断し、分からないことは分からないまま（UNKNOWN / 理由に明記）にする。
 */
export function judgeCompatibility(candidate: BenchmarkCandidate, report: DeviceReport | null): Compatibility {
  if (candidate.runtime === 'deterministic') return { verdict: 'CAN_TRY', reasonsJa: ['モデルを使わない baseline です。'] };
  if (candidate.labAvailability !== 'RUNNABLE') {
    return {
      verdict: 'UNSUPPORTED',
      reasonsJa: [candidate.labAvailability === 'EXPERIMENTAL'
        ? 'この候補の Runtime は Lab にまだ組み込んでいません（EXPERIMENTAL）。'
        : 'この候補は現時点でブラウザ実行が現実的ではありません。'],
    };
  }
  if (report === null) return { verdict: 'UNKNOWN', reasonsJa: ['端末をまだ確認していません。'] };
  if (!report.webGpuExposed) {
    return { verdict: 'UNSUPPORTED', reasonsJa: ['このブラウザは WebGPU（navigator.gpu）を公開していません。'] };
  }
  if (report.adapter !== 'available') {
    return {
      verdict: 'UNSUPPORTED',
      reasonsJa: [report.adapter === 'error'
        ? `WebGPU adapter の取得でエラーになりました: ${report.adapterError ?? '不明'}`
        : 'WebGPU adapter を取得できませんでした。'],
    };
  }
  const missing = candidate.requiredGpuFeatures.filter((feature) => !report.gpuFeatures.includes(feature));
  if (missing.length > 0) {
    return { verdict: 'UNSUPPORTED', reasonsJa: [`WebGPU の必須 feature がありません: ${missing.join(', ')}`] };
  }

  const reasons: string[] = [];
  let tooLarge = false;
  const vram = candidate.estimatedVramBytes;
  if (vram !== null && report.deviceMemoryGiB !== null && report.deviceMemoryGiB < DEVICE_MEMORY_CAP_GIB &&
    vram > report.deviceMemoryGiB * GIB) {
    tooLarge = true;
    reasons.push(`推定 VRAM（${(vram / GIB).toFixed(1)} GiB）が、ブラウザが報告した端末メモリ（${report.deviceMemoryGiB} GiB）を超えています。`);
  }
  if (report.mobile === true && candidate.lowResourceRequired === false) {
    tooLarge = true;
    reasons.push('モバイル端末で、Runtime の設定が低リソース向けとしていない候補です。');
  }
  const free = report.storage && report.storage.quotaBytes !== null && report.storage.usageBytes !== null
    ? report.storage.quotaBytes - report.storage.usageBytes
    : null;
  if (candidate.downloadSizeBytes !== null && free !== null && candidate.downloadSizeBytes > free) {
    tooLarge = true;
    reasons.push('この origin の保存容量の残り（storage.estimate）がダウンロードサイズより小さい可能性があります。');
  }
  if (report.isFallbackAdapter === true) {
    reasons.push('WebGPU がソフトウェア（fallback adapter）で動いています。非常に遅い可能性があります。');
  }
  if (tooLarge) return { verdict: 'MAY_BE_TOO_LARGE', reasonsJa: reasons };

  if (report.deviceMemoryGiB === null) reasons.push('端末メモリはこのブラウザから取得できません（VRAM 量は API で取得できません）。');
  else if (report.deviceMemoryGiB >= DEVICE_MEMORY_CAP_GIB) reasons.push('端末メモリは「8 GiB 以上」としか分かりません（VRAM 量は API で取得できません）。');
  reasons.push('試してよい状態です。実行できることの保証ではありません。');
  return { verdict: 'CAN_TRY', reasonsJa: reasons };
}
