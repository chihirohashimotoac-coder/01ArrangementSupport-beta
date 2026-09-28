# PREVIEW.md — PR ごとのプレビュー配信

PR の内容を、マージ前にブラウザで確認するための仕組みです。
**本番（GitHub Pages）とは完全に別系統**で、本番 deploy にも Pages の設定にも触れません。

---

> **Beta リポジトリについて**: この節は Production リポジトリでの構成です。
> Beta リポジトリ（`01ArrangementSupport-beta`）へ Vercel の GitHub App を接続するかどうかは
> リポジトリオーナーの判断で、接続されていない場合は PR にプレビュー URL が付きません。
> Beta の本番配信先は https://chihirohashimotoac-coder.github.io/01ArrangementSupport-beta/ です。

## 1. 現在の構成（Production）

Production リポジトリには **Vercel の GitHub App が接続済み**です。
PR を作る／push するたびに Vercel が自動でビルドし、PR へプレビュー URL をコメントします。

```
https://01-arrangement-support-git-<branch>-<owner>.vercel.app
```

- リポジトリ側に workflow も Secrets も要りません（Vercel 側の Git 連携で動きます）
- ブランチごとに URL が固定で、push のたびに中身が更新されます
- **本番の URL は変わりません**:
  https://chihirohashimotoac-coder.github.io/01ArrangementSupport/

Vite のプリセットで `npm run build` → `dist` が配信されます。
`vite.config.ts` の `base` は既定 `/` なので、プレビュー用の追加設定は不要です。
アプリは URL ルーティングを持たない（画面の切り替えは内部 state）ため、
SPA fallback の設定も要りません。

---

## 2. なぜ GitHub Pages でプレビューしないか

このリポジトリの本番配信は **GitHub Actions をソース**にした GitHub Pages です
（`.github/workflows/ci-deploy.yml` の `build-pages` → `deploy`）。

- GitHub Pages のソースは 1 リポジトリにつき 1 つだけです。
  `gh-pages` ブランチ配信へ切り替えると、切り替え中に本番が影響を受けます。
- `actions/deploy-pages` の `preview` 入力は **alpha で一般公開されていません**。
- `deploy-pages` は成果物でサイト全体を置き換えるため、PR から実行すると
  次に main が deploy されるまで本番がプレビューに差し替わってしまいます。

そのため、プレビューだけを外部（Vercel）へ出す構成にしています。
`ci-deploy.yml` の `build-pages` / `deploy` は、これまでどおり
**main への push でだけ**動きます（`if: github.event_name != 'pull_request'`）。

---

## 3. 運用ルール

- **PR を作ったら、説明か最終報告にプレビュー URL を必ず載せる。**
- プレビューは**公開 URL** です。未公開にしたい内容は載せないでください。
- Service Worker が登録されるため、同じブラウザで複数のプレビューを見比べるときは
  シークレットウィンドウを使うか、開発者ツールの
  **Application → Service Workers → Unregister** をしてください。

---

## 4. Vercel の接続が外れた場合

Vercel ダッシュボードの **Project → Settings → Git** で、
このリポジトリを再接続すれば元に戻ります。Build 設定は Vite のプリセットのままで動きます。

| 項目 | 値 |
| --- | --- |
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm ci` |

**Production Branch は設定しないでください**（本番は GitHub Pages 側です）。
Vercel 側の本番 deploy が要らない場合は、Settings → Git の
**Ignored Build Step** で `main` を除外できます。
