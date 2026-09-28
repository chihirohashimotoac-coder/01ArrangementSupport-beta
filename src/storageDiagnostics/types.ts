/**
 * BROWSER STORAGE DIAGNOSTICS の型。
 *
 * 保存方式ごとの差は Adapter（`browserAdapters.ts`）に閉じ込め、書き込みの手順・計測・後片付けは
 * Runner（`runner.ts`）が方式によらず同じ順で行う。unit test では Fake Adapter を渡す。
 */
import type { DiagnosticBackend } from './constants';

/** 開いている書き込み先（1 回のテストの間だけ使う）。 */
export interface DiagnosticWriter {
  /** chunk を 1 つ書く。resolve したら、その chunk は保存領域に受け取られた。 */
  write(chunk: Uint8Array, index: number): Promise<void>;
  /** 書き込みを確定する（OPFS では close。確定しない方式では何もしない）。 */
  finish(): Promise<void>;
  /** 途中で止めたときに、開いている資源を閉じる（OPFS の writable の破棄・IndexedDB の接続）。 */
  dispose(): Promise<void>;
}

/**
 * 保存方式ごとの Adapter。**診断用の名前（`constants.ts`）の保存領域だけ**を作成・書き込み・削除する。
 */
export interface DiagnosticStorageAdapter {
  readonly backend: DiagnosticBackend;
  /** 書き込みの方法（結果と export に残す説明）。 */
  readonly writeMethod: string;
  /** このブラウザがその方式の API を公開しているか（使えることの保証ではない）。 */
  isAvailable(): boolean;
  /** 診断用の保存領域を作り、書き込み先を開く。 */
  open(): Promise<DiagnosticWriter>;
  /** 診断用の保存領域だけを削除する。無ければ何もしない。失敗したら throw する（黙って成功にしない）。 */
  cleanup(): Promise<void>;
  /** 診断用の保存領域が残っているか。保存領域を作らずに調べる。分からなければ null。 */
  hasLeftovers(): Promise<boolean | null>;
}

/** `navigator.storage` から読む origin 全体の値。 */
export interface OriginStorageStatus {
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
  readonly persisted: boolean | null;
}

export type DiagnosticStatus = 'success' | 'failed' | 'aborted';
/** 失敗した段階。`prepare` は前回の残りの削除と、保存領域を開くところ。 */
export type DiagnosticPhase = 'prepare' | 'write' | 'finalize';

export interface DiagnosticCleanup {
  /** `ok`: 診断用のデータを削除した（または無かった）。`failed`: 削除できなかった（diagnostic cleanup failed）。 */
  readonly status: 'ok' | 'failed';
  readonly errorName: string | null;
  readonly errorMessage: string | null;
}

export interface StorageDiagnosticResult {
  readonly backend: DiagnosticBackend;
  readonly writeMethod: string;
  readonly status: DiagnosticStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly targetBytes: number;
  readonly chunkBytes: number;
  /** 書き込みが resolve した chunk の合計（書き込みの段階の終わりの値）。 */
  readonly writtenBytes: number;
  /** 最後に成功した chunk の終端（逐次書き込みなので通常は writtenBytes と同じ）。 */
  readonly lastSuccessfulBytes: number;
  /** 失敗した chunk を書き終えていたはずの位置（`write` の失敗）。確定（finalize）の失敗なら書いた量。成功・中止なら null。 */
  readonly failedAtBytes: number | null;
  readonly failedPhase: DiagnosticPhase | null;
  /** 書き込みの段階（開く〜確定）にかかった時間。後片付けは含まない。 */
  readonly durationMs: number;
  readonly bytesPerSecond: number | null;
  readonly errorName: string | null;
  readonly errorMessage: string | null;
  /** 書き始めた時点（前回の残りを削除したあと）。削除の反映（usageReclaimed）の基準にもする。 */
  readonly originUsageBefore: number | null;
  /** 書き込みの段階の直後（後片付けの前）。 */
  readonly originUsageAfter: number | null;
  readonly originQuotaBefore: number | null;
  readonly originQuotaAfter: number | null;
  /** 後片付けのあと（反映を待った最後の値）。 */
  readonly originUsageAfterCleanup: number | null;
  /**
   * 削除した分が Origin Usage から減ったか（`originUsageBefore` ＋ 1 chunk 以内に戻ったか）。
   * Chromium では削除（特に Cache API）が、ページを再読み込みするまで usage に反映されないことがある。
   * 反映されていないと、同じページで続けて測る方式の容量がずれる。usage が分からなければ null。
   */
  readonly usageReclaimed: boolean | null;
  /** 反映を待った時間。 */
  readonly reclaimWaitMs: number;
  /** テスト開始時の `navigator.storage.persisted()`。 */
  readonly persisted: boolean | null;
  readonly cleanup: DiagnosticCleanup;
}

export interface DiagnosticProgress {
  readonly backend: DiagnosticBackend;
  readonly writtenBytes: number;
  readonly targetBytes: number;
}
