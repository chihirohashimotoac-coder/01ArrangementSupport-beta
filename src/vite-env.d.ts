/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /**
   * Beta の AI 機能（説明層）。`on` のときだけ有効。既定は OFF（未設定）。
   * 詳細は src/ai/featureFlag.ts / docs/AI_ARCHITECTURE.md。
   */
  readonly VITE_AI_FEATURES?: string;
}
