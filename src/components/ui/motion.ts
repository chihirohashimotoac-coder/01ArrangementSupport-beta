import { useEffect, useRef, useState } from 'react';

/**
 * 表示用のモーション補助（UI 専用）。
 *
 * 計算・判定・保存には一切関与しない。見た目の演出を「いつ始めるか」だけを決める。
 */

/**
 * 動きを減らす設定か。
 *
 * `matchMedia` が無い環境（jsdom など）では「減らす」として扱う。
 * 退場アニメーションの待ち時間を 0 にし、テストや古い端末で表示が遅れないようにする。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 要素が一度でも画面に入ったか。インフォグラフィックの「伸びる」演出の開始合図に使う。
 *
 * IntersectionObserver が無い環境では最初から true を返す（演出なしで最終形を出す）。
 * 一度 true になったら戻さない（スクロールのたびに繰り返し再生しない）。
 */
export function useInView<T extends Element>(rootMargin = '0px 0px -8% 0px') {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (inView) return;
    const element = ref.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView] as const;
}
