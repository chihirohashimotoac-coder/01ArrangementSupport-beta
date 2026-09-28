/**
 * localStorage への安全な読み書き。
 *
 * プライベートブラウジングや容量超過で例外が出る環境があるため、
 * 失敗しても呼び出し側が壊れないようにする。
 *
 * Beta では、Beta の名前空間（`namespace.ts`）に属さないキーは
 * **読まない・書かない・消さない**。Production の保存データ（`oas.*`）へ
 * 誤って触れる経路を、この唯一の入口で塞ぐ。
 */
import { isNamespacedKey } from './namespace';

export function readJson<T>(key: string, fallback: T): T {
  if (!isNamespacedKey(key)) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  if (!isNamespacedKey(key)) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): void {
  if (!isNamespacedKey(key)) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 何もしない（保存できない環境でもアプリは動かす）
  }
}
