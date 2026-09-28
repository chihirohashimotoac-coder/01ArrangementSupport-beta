/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /**
   * Beta の AI 層の Developer Gate（開発者向けの experimental kill switch）。
   * ユーザー向けの AI ON / OFF 設定ではない。`on` のときだけ開く。既定は閉（未設定）。
   * 詳細は src/ai/developerGate.ts / docs/AI_ARCHITECTURE.md。
   */
  readonly VITE_AI_FEATURES?: string;
}
