/**
 * AI 機能の feature flag。
 *
 * 既定は **OFF**。ビルド時の環境変数 `VITE_AI_FEATURES=on` のときだけ ON になる。
 * OFF のとき、アプリは AI 層を一切呼ばず Production と同じ挙動になる。
 *
 * 実行時の切り替え（設定画面の ON / OFF）は、実 Provider を入れる PR で
 * この関数の上に足す。ここではビルド単位の既定値だけを決める。
 */
export interface AiFeatureEnv {
  readonly VITE_AI_FEATURES?: string;
}

export const AI_FEATURES_DEFAULT_ENABLED = false;

export function isAiFeatureEnabled(env: AiFeatureEnv = import.meta.env): boolean {
  const value = env.VITE_AI_FEATURES;
  if (value === undefined) return AI_FEATURES_DEFAULT_ENABLED;
  return value.trim().toLowerCase() === 'on';
}
