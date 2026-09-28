/**
 * 同期・依存なしの指紋（FNV-1a 32bit を 2 系統つないだ 16 桁の 16 進）。
 *
 * 暗号用途ではない。「同じ Evidence・同じ prompt なら同じ値」を確かめ、
 * モデル間で同じ入力を使ったことを記録するためだけに使う。
 */
function fnv1a(text: string, offset: number): number {
  let hash = offset >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fingerprint(text: string): string {
  const first = fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0');
  const second = fnv1a(text, 0x01000193 ^ 0x9e3779b9).toString(16).padStart(8, '0');
  return `${first}${second}`;
}
