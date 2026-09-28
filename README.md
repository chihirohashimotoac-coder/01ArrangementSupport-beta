# 01 Arrangement Support Beta

> **このリポジトリは 01 Arrangement Support の Beta 版です。**
>
> | | URL |
> | --- | --- |
> | Beta（このリポジトリの公開先） | https://chihirohashimotoac-coder.github.io/01ArrangementSupport-beta/ |
> | Production（正式版） | https://chihirohashimotoac-coder.github.io/01ArrangementSupport/ |
> | Production リポジトリ（READ ONLY） | https://github.com/chihirohashimotoac-coder/01ArrangementSupport |
>
> - Beta は Production と**保存データを共有しません**（設定・学習履歴は Beta 専用。`docs/BETA.md`）。
> - **AI 機能は実験段階**です。**AI モデルを導入していなければ、従来の 01 Arrangement Support として動作します。**
>   将来、ローカル AI モデルを利用者が選んでダウンロードし、使うモデルを選ぶと AI による説明・振り返りを
>   利用できるようにする予定です（AI の ON / OFF スイッチではなく、モデルの導入・選択で決まります）。
>   この版には AI モデルも外部 AI API も入っていません。開発者向けのビルド（Developer Gate）でだけ、
>   候補モデルを比較評価する **AI MODEL LAB** を使えます（`docs/AI_MODEL_BENCHMARK.md`）。
> - **Decision Engine は従来どおり決定論的**です。チェックアウト・セットアップ・推奨度・Bust 判定などは
>   すべて rule based engine が決め、**AI は判断を行いません**。AI は engine の判断を説明する役割に限定します
>   （`docs/AI_ARCHITECTURE.md` / `docs/AI_BOUNDARIES.md`）。

スティールダーツ 01 ゲーム（Double Out）の**アレンジ判断**を学ぶための Web アプリ / PWA です。

単なるチェックアウト早見表ではありません。

- なぜそのナンバーを狙うのか
- 狙いを外した場合にどうリカバリーするのか
- 171 点以上から、次ラウンドの良いテンパイをどう作るのか
- それらをどう反復学習するのか

までを扱います。**答えを覚えるアプリではなく、01 アレンジの「判断規則」を身につけるアプリ**です。

公開先（Beta）: https://chihirohashimotoac-coder.github.io/01ArrangementSupport-beta/

---

## 4 つのモード

| モード | 対象 | やること |
| --- | --- | --- |
| **CHECKOUT** | 残り 2〜170 | 基準ルート・MY ROUTE・理由・その他の合法ルートを表示。1 投ごとに追従。 |
| **SETUP** | 残り 171〜350 | 次ラウンドに良いテンパイを残す組み立てを提案。ノーテン（Bogey）を避ける。 |
| **TRAINING** | — | CHECKOUT / SETUP / RECOVERY / MIXED の反復練習と、成績の記録。 |
| **SIMULATION** | 301 / 501 / 701 / 任意 | 1 投ずつ自分で狙って上がりきる。着弾は設定した能力から盤面の座標として決まる。ゲーム中は答えを出さず、終了後に GAME REVIEW で振り返る。 |

### 特徴

- **理由が出る。** 「T18 を狙って S18 に落ちても 104 が残るため、残り 2 本で T18 → BULL の
  チェックアウトチャンスが残ります」のように、engine の計算結果から説明を組み立てます。
- **1 投ごとに追従する。** 実際に刺さった場所をタップすると、残り点と残り本数から候補を再計算します。
  Bust 判定と Undo があります。
- **成立するルートを不正解にしない。** TRAINING では推奨度 S / A / B / C を付け、
  C（成立するが戦術的に非推奨）には必ず非推奨理由を表示します。
- **完全オフライン。** ログイン・バックエンド・外部 DB・生成 AI API を一切使いません。
  判断はすべて決定論的な rule based engine です。
  Beta で追加した AI 基盤（`src/ai/`）も、engine の結果を説明するための層で、
  判断には使いません（現時点ではモデル未搭載のため、従来どおりの動作です）。
  開発者向けの AI MODEL LAB も判断には使わず、候補モデルの説明を同じ Evidence で比べるためだけのものです。

---

## 開発

```bash
npm ci
npm run dev            # 開発サーバー
npm run verify         # lint + typecheck + test + build
npm run test:e2e       # Playwright（先に npm run build が必要）
npm run import:checkout   # 添付 Excel から基準ルートデータを再生成
npm run audit:training    # TRAINING の大量出題監査
npm run audit:simulation  # SIMULATION の散布モデル統計監査
VITE_AI_FEATURES=on npm run dev   # 開発者向け: 設定 → DEVELOPER → AI MODEL LAB
```

AI MODEL LAB（ローカル AI モデルの Benchmark）は手動で実行します。CI ではモデルを取得しません
（Mock Runtime で検査）。手順は `docs/AI_MODEL_BENCHMARK.md`。

### 技術構成

React 19 / TypeScript (strict) / Vite / vite-plugin-pwa / Vitest / Testing Library /
Playwright / ESLint / GitHub Actions / GitHub Pages。サーバーは使いません。

### ディレクトリ

```
src/
  domain/     盤面配置・得点・ダート・Double Out ルール（UI 非依存の事実）
  data/       戦術データ（基準ルート・Bogey・隣接・重み・説明文）
  engine/     探索と評価（checkout / setup / recovery / ranking / training）
  geometry/   SVG ダーツボードの座標計算
  components/ 表示部品
  pages/      画面
  hooks/      React との接続
  storage/    localStorage（設定・学習履歴。Beta は `01as-beta:` 名前空間）
  config/     配信チャネル（Beta）の識別子
  ai/         Beta: AI 説明層の基盤（Evidence Layer / Provider interface / fallback / benchmark）
  lab/        Beta: 開発者向け AI MODEL LAB（Developer Gate 配下）とベンチマークのデータセット
scripts/      Excel 取り込み・検算、アイコン生成、SPA フォールバック
data/source/  一次資料（添付 Excel）
docs/         仕様書
```

`UI` / `domain` / `data` / `engine` / `storage` の責務を分離しています。
戦術データを React コンポーネントへ直書きしません。

---

## データの出典について

- 残り **41〜170** の基準ルートは、添付 Excel `checkout_table_added_routes_final.xlsx` の
  「第1候補」を取り込んだもの（**123 件**）です。取り込み時と CI で毎回、
  合計・最終ダート・Double Out・途中 Bust・指定ダブル終わりを再計算して検証します。
- 残り **2〜40** は Excel に収録がないため、明示ルールで導出しています
  （`src/data/lowStandardRoutes.ts`、39 件）。2026-08-31 に **v1 の基準ルートとして人間が承認**済みです。
- Excel のヘッダーには「PDC頻出ルート」とありますが、出典の一次資料を確認できていないため、
  アプリ内では **「基準ルート（Standard Route）」** とだけ呼びます（人間承認済み）。
  詳細は `docs/CHECKOUT_DATA_POLICY.md`。

アプリ内では、トップページ下部の **「参考資料・出典」** から同じ内容を確認できます
（`src/data/references.ts` / `src/pages/ReferencesPage.tsx`）。
掲載するのは**このリポジトリ・添付資料・PR 履歴から実際に参照したことを確認できるものだけ**で、
Source of Truth / Reference / Project Documentation を区別して表示します。

### 戦術方針の位置づけ

ルートの推奨度や残し方の評価に使う重みは、**人間が承認した v1 の戦術方針**です。
「数学的・統計的に絶対正しい値」ではなく、運用しながら見直す前提の暫定値として扱います。
承認の内容と経緯は `docs/APPROVALS.md` に記録しています。

算術・ルール上の正しさ（合計が LEFT と一致する、最終ダートがダブルである、Bogey かどうか）は
engine が計算し、テストで検証している**検証可能な事実**で、上の戦術判断とは区別しています。

---

## AI 開発者向け

このリポジトリは Claude Code と Codex の両方で開発します。
作業前に **`AGENTS.md`** と **`CLAUDE.md`** を必ず読んでください。

- `main` への直接 push は禁止（PR 必須、自動 merge しない）
- 戦術データの変更には Human Approval が必要
- 既存の `Darts-Calculator` リポジトリは READ ONLY
- Production リポジトリ `01ArrangementSupport` も READ ONLY（Beta の取り込み元としてだけ使う）
- 生成 AI は判断をしない: **Deterministic Engine decides. AI explains.**

---

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| `docs/SPEC.md` | アプリ全体の仕様 |
| `docs/ARRANGE_RULES.md` | 評価ルールと重み、理由コード |
| `docs/CHECKOUT_DATA_POLICY.md` | 基準ルートデータの扱いと検算 |
| `docs/SETUP_THEORY.md` | 171〜350 の考え方（0・1・4・7、TON の罠、S-BULL） |
| `docs/UI_SPEC.md` | 画面仕様 |
| `docs/SIMULATION_DESIGN.md` | SIMULATION の着弾モデル・進行・レビュー |
| `docs/TEST_STRATEGY.md` | テスト方針 |
| `docs/DATA_CONFLICTS.md` | 資料と計算結果の食い違い・確認事項 |
| `docs/APPROVALS.md` | 戦術方針の人間承認記録（v1） |
| `docs/BETA.md` | Beta 版の位置づけ・Production からの分離（Pages / PWA / Storage / Cache） |
| `docs/AI_ARCHITECTURE.md` | Beta: AI 説明層のアーキテクチャ（一方向依存） |
| `docs/AI_BOUNDARIES.md` | Beta: AI が触れてよい領域・いけない領域 |
| `docs/AI_EVALUATION.md` | Beta: モデル比較のための評価基準 |
| `docs/AI_MODEL_BENCHMARK.md` | Beta: ローカル AI モデルの Benchmark Lab（候補・Runtime・データセット・指標・手順） |
