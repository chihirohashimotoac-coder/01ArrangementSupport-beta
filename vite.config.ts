/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import {
  APP_DESCRIPTION,
  APP_NAME,
  APP_SHORT_NAME,
  CACHE_ID,
} from './src/config/releaseChannel';

/**
 * GitHub Pages ではリポジトリ配下パス（例: /01ArrangementSupport-beta/）で公開されるため、
 * base をビルド時の環境変数から差し替えられるようにしている。
 */
const base = process.env.VITE_BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      /*
       * 'autoUpdate' では新しいビルドを検出した時点で window.location.reload() が
       * 走り、TRAINING の回答途中や SIMULATION のゲーム中でも問答無用で
       * 読み込み直されていた。'prompt' にして、更新するかどうかをユーザーへ渡す。
       * 画面側の実装は src/components/UpdateBanner.tsx。
       */
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: [
        'icons/favicon-32.png',
        'icons/favicon-48.png',
        'icons/apple-touch-icon-180.png',
      ],
      manifest: {
        id: base,
        // Beta 版として Production と見分けられる名前にする（src/config/releaseChannel.ts）。
        name: APP_NAME,
        short_name: APP_SHORT_NAME,
        description: APP_DESCRIPTION,
        lang: 'ja',
        dir: 'ltr',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        background_color: '#07111f',
        theme_color: '#07111f',
        categories: ['sports', 'education', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        /*
         * Cache Storage の名前を Production と分ける。Production と Beta は同じ origin を
         * 共有するので、既定名のままだとスコープ文字列だけが区別の手がかりになる。
         */
        cacheId: CACHE_ID,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        cleanupOutdatedCaches: true,
        /*
         * clientsClaim は true のまま。これは「初回にインストールされた
         * Service Worker が、すでに開いているページの制御を引き取るか」であって、
         * 更新の待機とは別の話。false にすると初回訪問がリロードまで
         * 制御されず、オフライン動作が 1 回遅れる。
         *
         * skipWaiting は false にする。true だと新しい Service Worker が
         * 即座に有効化されてしまい、「更新しますか」と尋ねる余地が無くなる。
         * 待機させておき、ユーザーが更新ボタンを押した時点で
         * messageSkipWaiting() を送る（virtual:pwa-register が行う）。
         */
        clientsClaim: true,
        skipWaiting: false,
        navigateFallback: 'index.html',
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    restoreMocks: true,
  },
});
