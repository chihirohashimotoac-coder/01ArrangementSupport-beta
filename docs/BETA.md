# BETA.md — Beta 版の位置づけと Production からの分離

このリポジトリ（`chihirohashimotoac-coder/01ArrangementSupport-beta`）は
**01 Arrangement Support の Beta 版**です。

| | Production | Beta |
| --- | --- | --- |
| リポジトリ | https://github.com/chihirohashimotoac-coder/01ArrangementSupport | https://github.com/chihirohashimotoac-coder/01ArrangementSupport-beta |
| 公開 URL | https://chihirohashimotoac-coder.github.io/01ArrangementSupport/ | https://chihirohashimotoac-coder.github.io/01ArrangementSupport-beta/ |
| PWA 名 | 01 Arrangement Support / 01アレンジ | 01 Arrangement Support Beta / 01AS Beta |
| 保存キー | `oas.*` | `01as-beta:oas.*` |
| Cache Storage | Workbox 既定名 | `01as-beta-precache-*`（`cacheId`） |

Beta の目的は、Production の決定論的アレンジエンジンを変えずに
**AI による説明・振り返り支援の基盤**を試すことです（`docs/AI_ARCHITECTURE.md`）。

---

## 1. Bootstrap の記録

| 項目 | 値 |
| --- | --- |
| コピー元 | `chihirohashimotoac-coder/01ArrangementSupport` の `main` |
| コピー元 commit | `abf8200b24939e1ef48e9e339a4894a51d518f96` |
| コピー元 commit 日時 | 2026-09-27T21:10:45+09:00（Merge pull request #31） |
| Beta `main` の基準点 | 同じ `abf8200b…`（Git 履歴 164 commits をそのまま保持） |
| Bootstrap 実施日 | 2026-09-28 |

Bootstrap の push は Production の `main` と**完全に同一の commit** を Beta の `main` へ
置いただけで、コード・設定・文言の変更は含めていません。以降の変更はすべて
feature branch → Pull Request で入れます。

### remote の構成

```text
origin   → chihirohashimotoac-coder/01ArrangementSupport-beta   （読み書き）
upstream → chihirohashimotoac-coder/01ArrangementSupport        （READ ONLY）
```

`upstream` は **READ ONLY** です。Production へ commit / push / PR / tag / branch 作成を
行ってはいけません。ローカルでは誤操作を防ぐため push URL を無効化しておくことを推奨します。

```bash
git remote add upstream https://github.com/chihirohashimotoac-coder/01ArrangementSupport
git remote set-url --push upstream DISABLED_READ_ONLY
```

Production の更新を Beta へ取り込むときは、`upstream/main` を feature branch へ
merge して PR を作ります（Beta の `main` へ直接 push しない）。

---

## 2. GitHub Pages

`.github/workflows/ci-deploy.yml` は base path を**リポジトリ名から動的に**決めるため、
Beta では `/01ArrangementSupport-beta/` で自動的にビルドされます（ハードコード不要）。

`npm run check:base` の既定 base は `/01ArrangementSupport-beta/` です。加えて次を検証します。

- Beta の base が Production の Service Worker スコープ（`/01ArrangementSupport/`）と重ならない
- manifest の `name` / `short_name` が Beta と識別できる
- `sw.js` が Beta 専用の `cacheId` を使う

> GitHub Pages を有効にするには、リポジトリの **Settings → Pages → Source** を
> **GitHub Actions** にする必要があります（リポジトリ設定のため、コードからは変更できません）。

> **有効化は、Production からの分離（保存キーの名前空間化）が `main` に入ってから行ってください。**
> Bootstrap 直後の `main`（Production と同一の `abf8200b…`）は Production と同じ保存キー（`oas.*`）を
> 使います。これを Beta の URL で配信すると、同じ origin の Production の設定・学習履歴を
> 読み書きしてしまいます。2026-09-28 の Bootstrap 時は Pages が未有効だったため
> `configure-pages` で止まり、何も配信されていません（Actions run #1）。その run は再実行しないでください。

---

## 3. 同じ origin を共有することの影響と対策

Production と Beta はどちらも `https://chihirohashimotoac-coder.github.io` という
**同じ origin** で配信されます。URL のパスが違っても、ブラウザの保存領域は origin 単位です。

| 保存領域 | 共有されるか | Beta の対策 |
| --- | --- | --- |
| localStorage | **共有される** | すべてのキーに `01as-beta:` 接頭辞。`src/storage/localJson.ts` が接頭辞の無いキーの読み書き・削除を拒否する |
| sessionStorage | 共有される（タブ単位） | 使用していない |
| IndexedDB | 共有される | 使用していない |
| Cache Storage | 共有される | Workbox の `cacheId: '01as-beta'` で名前を分ける。Precache 名にはスコープ URL も入る。将来のローカル AI モデルは `01as-beta-ai-model:<id>` に置き、利用者データ・アプリのキャッシュと分ける（`docs/AI_ARCHITECTURE.md` 8.4 節）。開発者向けの AI MODEL LAB が使う WebLLM は、既定で OPFS の `tvmjs-opfs-store/webllm/*` に置く（IndexedDB / Cache API を選んだ場合は名前が固定の `webllm/model`・`webllm/config`・`webllm/wasm`。`docs/AI_MODEL_STORAGE.md`）（同じ origin の他アプリが WebLLM を使うと共有される。`docs/AI_ARCHITECTURE.md` 11.4 節）。Lab と WebLLM のコードは precache しない。WebLLM のキャッシュを一括削除する処理は持たない（対象モデル単位の削除だけ。`docs/APPROVALS.md` AI-3） |
| Service Worker | スコープ（URL 前方一致）単位 | `/01ArrangementSupport-beta/` は `/01ArrangementSupport/` で始まらないため、互いのページを制御しない |

### Storage 分離の要件

Beta は Production の保存データを

- 読まない
- 書き換えない
- 削除しない
- 自動 migration しない

Production 側のキー（`oas.preferences.v1` / `oas.training.v1` / `oas.simulation.v1`）は
一切変更していません。Beta は**空の状態から**始まります。Production の履歴を取り込む
import 機能はありません。

検証:

- `src/storage/betaIsolation.test.ts` — Production キーを置いた状態で Beta の読み書き・削除が
  Production キーへ 1 度もアクセスしないこと（`Storage.prototype` を spy）
- `e2e/pwa.spec.ts` — 実ブラウザで同じことを確認

`index.html` の初回テーマ読み込み（バンドル前のインラインスクリプト）も
`01as-beta:oas.preferences.v1` を読みます。キーの一致はテストで固定しています。

### Cache の掃除について

Workbox の `cleanupOutdatedCaches` は「`-precache-` を含み、**自分の登録スコープ URL を含む**」
キャッシュだけを削除します。Production のスコープ文字列
`…/01ArrangementSupport/` は Beta のキャッシュ名 `…/01ArrangementSupport-beta/` に含まれないため、
Production の Service Worker が Beta のキャッシュを消すことはありません（その逆も同じ）。

---

## 4. Preview

`docs/PREVIEW.md` を参照。Vercel の GitHub App を Beta リポジトリへ接続するかどうかは
リポジトリオーナーの判断です。
