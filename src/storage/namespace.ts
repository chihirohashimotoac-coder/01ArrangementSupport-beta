/**
 * Beta 専用の保存キー。
 *
 * Production と Beta は GitHub Pages 上で同じ origin を共有するので、
 * localStorage も共有される。Beta が Production の保存データを
 * 読む・書き換える・消すことが無いよう、キーはすべてこの関数で作る。
 * 取り込み（migration）も行わない。Beta は空の状態から始まる。
 */
import { STORAGE_NAMESPACE } from '../config/releaseChannel';

export { STORAGE_NAMESPACE };

export function namespacedKey(name: string): string {
  return `${STORAGE_NAMESPACE}${name}`;
}

export function isNamespacedKey(key: string): boolean {
  return key.startsWith(STORAGE_NAMESPACE) && key.length > STORAGE_NAMESPACE.length;
}
