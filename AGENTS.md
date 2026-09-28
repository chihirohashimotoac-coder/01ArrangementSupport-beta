# AGENTS.md — このリポジトリで作業する AI への指示

このリポジトリは複数の PC から、Claude Code と Codex の両方を使って開発します。
**GitHub リポジトリを唯一の Source of Truth** とし、ローカル環境は作業コピーとして扱います。

> **このリポジトリは 01 Arrangement Support の Beta 版です**（`01ArrangementSupport-beta`）。
> Production（`01ArrangementSupport`）から複製し、AI による説明・振り返り支援の基盤を試しています。
> Production との分離は `docs/BETA.md`、AI の規則は本書 6 節と `docs/AI_BOUNDARIES.md` を参照。
>
> **Deterministic Engine decides. AI explains.**

---

## 0. 作業を始める前に必ず読む

1. `docs/SPEC.md` — アプリ全体の仕様
2. `docs/ARRANGE_RULES.md` — 戦術評価のルールと重み
3. `docs/CHECKOUT_DATA_POLICY.md` — 基準ルートデータの扱い（**最重要**）
4. `docs/APPROVALS.md` — どの戦術方針が人間承認済みか（**最重要**）
5. `docs/SETUP_THEORY.md` — SETUP（171〜350）の考え方
6. `docs/TEST_STRATEGY.md` — テストの方針
7. `docs/SIMULATION_DESIGN.md` — SIMULATION（着弾モデル・進行・レビュー）
8. `docs/BETA.md` — Beta 版と Production の分離（Pages / PWA / Storage）
9. `docs/AI_BOUNDARIES.md` — AI が触れてよい領域・いけない領域（**Beta で最重要**）
10. `docs/AI_ARCHITECTURE.md` — AI 説明層の構造（一方向依存）

読まずに実装を始めないこと。

---

## 1. Git 運用

- **作業前に最新の `main` を取得する**（`git fetch origin main`）。
- **`main` への直接 push は禁止**。必ず feature branch → Pull Request。
- **1 タスク 1 branch**。branch 名は `claude/<内容>` または `codex/<内容>`。
- **他の AI の作業 branch を勝手に編集しない**。Claude Code と Codex が同一 feature branch を同時編集する運用は禁止。
- **PR 必須**。CI がすべて成功していない PR はレビュー対象にしない。
- **自動 merge は行わない**。最終 merge には人間の確認が必要。
- **PR には Preview URL を出す**。Vercel の GitHub App が PR へ自動でコメントするので、
  その URL を PR 説明か最終報告へ載せる。仕組みは `docs/PREVIEW.md`。

---

## 2. 絶対にしてはいけないこと

### 2-1. 既存リポジトリへの変更

- **Production リポジトリ `chihirohashimotoac-coder/01ArrangementSupport` は READ ONLY**。
  commit / push / PR / tag / branch 作成をしない。Beta への取り込み元（`upstream`）と
  仕様の参照元としてだけ使う。Production の更新は `upstream/main` を Beta の feature branch へ
  merge して PR で取り込む。
- `chihirohashimotoac-coder/Darts-Calculator` は **READ ONLY**。
  commit も PR も作らない。SVG ダーツボードや geometry は、
  このリポジトリへコピーして独立管理している（共通パッケージ化はしない）。
- `n02` など他の既存アプリも変更しない。

### 2-2. 戦術データの独断変更（Human Approval Required）

次の変更には**人間の承認が必要**です。AI が「こちらのルートの方が合理的なので変えました」
という判断で書き換えてはいけません。

- 基準ルート（`src/data/standardCheckoutRoutes.generated.ts`、`src/data/lowStandardRoutes.ts`）
- Bogey Number の定義（`src/data/bogeyNumbers.ts`）
- ランキングの思想・重み（`src/data/rankingRules.ts`）
- 良いセットアップ残りの定義（`PREMIUM_TENPAI_LEAVES` など）
- 書き下ろし説明（`CURATED_*_EXPLANATIONS`）
- 添付資料由来のフィクスチャ（`src/data/setupReferenceCases.ts`）

変更が必要に見える場合は、**変更せずに** `docs/DATA_CONFLICTS.md` か PR 説明へ
`QUESTION` / `DATA CONFLICT` / `PROPOSED CHANGE` として記録してください。

現在の値のうち、どれが人間の承認を受けた「v1 の戦術方針」かは
**`docs/APPROVALS.md`** に記録されています。
承認済みであることは「その値が絶対に正しい」という意味ではなく、
**「人間が選んだ暫定の方針である」**という意味です。
v1 から変更したい場合は、あらためて承認を得て `docs/APPROVALS.md` へ v2 として追記してください。

### 2-3. Production の保存データへの接触

Production と Beta は GitHub Pages 上で同じ origin を共有するため、localStorage も共有されます。
Beta は Production の保存キー（`oas.*`）を**読まない・書かない・消さない・取り込まない**。
保存キーは必ず `src/storage/namespace.ts` の `namespacedKey()` で作り、
`localStorage` を直接触らず `src/storage/localJson.ts` を通してください。

### 2-4. 生成物の手編集

`src/data/standardCheckoutRoutes.generated.ts` は自動生成ファイルです。
直接編集せず、`npm run import:checkout` で再生成してください。

---

## 3. 役割分担

### Claude Code（主実装）

アーキテクチャ／大規模機能実装／アレンジエンジン／データモデル／SETUP エンジン／
Recovery エンジン／UI／PWA／CI・CD／テスト構造／ドキュメント／大規模リファクタ

### Codex（レビューと小規模修正）

独立レビュー／バグ探索／仕様照合／テスト追加／軽微な CSS 修正／文言修正／
明確な小規模バグ修正／小規模リファクタ

---

## 4. 品質ゲート

PR を出す前に、ローカルで次をすべて通してください。

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

`npm run verify` で lint / typecheck / test / build をまとめて実行できます。

GitHub Actions では lint / typecheck / Excel 再検算 / unit test / build / E2E が必須チェックです。

---

## 5. 設計の原則

- **生成 AI を runtime の判断に使わない。** アレンジ判断は決定論的・再現可能・
  テスト可能・オフライン動作可能な rule based engine であること。
  Beta では生成 AI を**説明層としてだけ**使ってよい（6 節）。
- **責務を分離する。** `UI` / `domain` / `data` / `engine` / `storage` を混ぜない。
  戦術データを React コンポーネントへ直書きしない。
- **理由はコードで持つ。** 評価理由は reason code として構造化し、表示用の日本語は
  `src/data/explanations.ts` で解決する。手書きの文章だけで管理しない。
- **秘密情報を commit しない。** 公開リポジトリ前提。API key・トークンの類は不要な構成にしてある。

---

## 6. 生成 AI の規則（Beta）

Production では「生成 AI を runtime で使わない」でした。Beta では、**説明層に限って**
生成 AI を組み込めるよう基盤を用意しています。ただし最重要原則は変わりません。

```text
Deterministic Engine decides.
AI explains.
```

AI は アレンジの Source of Truth ではありません。詳細は `docs/AI_BOUNDARIES.md`。

### 6-1. AI MUST NOT（AI に決めさせてはいけないこと）

RouteGrade（S / A / B / C）・GOOD / BETTER / BAD 等の評価・最適ターゲット・Standard Route・
NEXT VISIT・Checkout 成立可否・Bust 判定・Bogey 判定・Setup / Recovery ランキング・
ダブルアウトの合法性・得点計算・残り本数・engine の評価結果の上書き・承認済み戦術データの変更。

「116 なら T20 が最善です」のような戦術判断を AI が生成し、それをアプリの正式判定として
使う設計は禁止です。

### 6-2. AI MAY（AI に任せてよいこと）

engine が出した判断理由の自然言語説明 / GAME REVIEW の要約 / 練習履歴からの傾向整理 /
苦手分野の説明 / 学習上のフィードバック / 「なぜ？」への説明 /
engine evidence を根拠にした AI Coach。

### 6-3. 実装上の規則

- AI へ渡すのは `src/ai/evidence.ts` が engine の結果から抽出した **Evidence だけ**。
  生のアプリ state・ユーザー履歴の全量・個人情報を渡さない。
- Evidence Layer は **filter / normalize / serialize だけ**。ランキングの再計算や
  別ルートの探索をしない（戦術ロジックの二重実装をしない）。
- 依存は `engine → evidence → provider → presentation` の**一方向**。
  `src/engine/**`・`src/domain/**`・`src/data/**`・`src/storage/**` から `src/ai/**` を import しない。
- UI から直接モデルを呼ばない。必ず `src/ai/explain.ts` の安全な呼び出し
  （検証・タイムアウト・fallback 付き）を通す。
- AI 機能を使えるかどうかは **利用者がローカル AI モデルを導入・選択しているか**で決まる
  （`src/ai/models/`）。モデル未導入・未選択なら従来の 01AS として動作すること。
  利用者向けの「AI ON / OFF」スイッチを主要な操作にしない。
- `VITE_AI_FEATURES` は**開発者向けの experimental kill switch**（Developer Gate、既定は閉）。
  利用者向けの設定ではない。
- 具体的なモデル名は Model Catalog のデータにだけ書く。モデルを削除しても利用者データ
  （設定・学習履歴・SIMULATION 設定）を消さない。
- モデル・推論ライブラリ・外部 AI API・API key・backend を追加する PR は、
  `docs/AI_EVALUATION.md` の評価と人間の承認を経てから。

