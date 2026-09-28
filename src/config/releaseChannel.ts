/**
 * 配信チャネル（Production / Beta）の識別。
 *
 * このリポジトリは 01 Arrangement Support の **Beta 版**です。
 * Production（chihirohashimotoac-coder/01ArrangementSupport）と同じ GitHub Pages の
 * origin で配信されるため、PWA の表示名・保存領域・キャッシュ名を
 * ここで決めた値で Production と分ける。
 *
 * vite.config.ts（ビルド時）と画面（実行時）の両方から読むので、
 * ブラウザ API にも Node API にも依存しない定数だけを置く。
 */
export const APP_NAME = '01 Arrangement Support Beta';
export const APP_SHORT_NAME = '01AS Beta';
export const APP_DESCRIPTION =
  '01 Arrangement Support の Beta 版。スティールダーツ01のチェックアウト／セットアップの「判断規則」を学ぶためのアプリ。Production 版とは保存データを共有しません。';

/** 画面に出す小さな識別表示。 */
export const CHANNEL_BADGE = 'BETA';

/**
 * localStorage のキーへ付ける接頭辞。
 *
 * Production と Beta は同じ origin（chihirohashimotoac-coder.github.io）を共有するため、
 * URL のパスが違っても localStorage は共有される。Beta は必ずこの接頭辞付きの
 * キーだけを使い、Production のキー（`oas.*`）は読まない・書かない・消さない。
 */
export const STORAGE_NAMESPACE = '01as-beta:';

/** Workbox の Cache Storage 名の接頭辞（Production の既定名と衝突させない）。 */
export const CACHE_ID = '01as-beta';
