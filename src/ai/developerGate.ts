/**
 * AI 機能の Developer Gate（開発者向けの experimental kill switch）。
 *
 * **ユーザー向けの「AI ON / OFF」設定ではありません。**
 * Beta でユーザーが扱うのは「どのローカル AI モデルを導入し、どれを使うか」だけです
 * （`src/ai/models/`）。AI 機能が使えるのは次の両方が揃ったときです。
 *
 *   Developer Gate（このファイル）  +  導入済みで選択中のモデル（activeModelId）
 *
 * - モデルが未導入 / 未選択なら、Developer Gate に関係なく従来の 01AS として動作する
 * - Developer Gate が閉じていれば、モデルが選択されていても AI 層を使わない
 *   （実験中の不具合時に、ビルド単位で AI を止めるための開発者用の非常停止）
 *
 * ビルド時の環境変数 `VITE_AI_FEATURES=on` のときだけ開く。既定は閉（未設定）。
 * 実モデルが導入されていない現時点では、開いていても挙動は変わらない。
 */
export interface DeveloperGateEnv {
  readonly VITE_AI_FEATURES?: string;
}

export const AI_DEVELOPER_GATE_DEFAULT_OPEN = false;

export function isAiDeveloperGateOpen(env: DeveloperGateEnv = import.meta.env): boolean {
  const value = env.VITE_AI_FEATURES;
  if (value === undefined) return AI_DEVELOPER_GATE_DEFAULT_OPEN;
  return value.trim().toLowerCase() === 'on';
}
