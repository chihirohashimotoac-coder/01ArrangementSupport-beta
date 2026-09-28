# CLAUDE.md — Claude Code 固有の作業ルール

まず `AGENTS.md` を読んでください。ここには Claude Code に固有の事項だけを書きます。

> このリポジトリは **Beta 版**です。Production（`01ArrangementSupport`）は READ ONLY。
> **Deterministic Engine decides. AI explains.**（`docs/AI_BOUNDARIES.md`）

---

## 1. 担当範囲

Claude Code はこのリポジトリの**主実装担当**です。

- アーキテクチャの決定と大規模な機能実装
- アレンジエンジン（checkout / setup / recovery / ranking / training）
- データモデルと Excel 取り込みパイプライン
- UI・PWA・CI/CD・テスト構造・ドキュメント
- 大規模リファクタ

小さな文言修正や CSS の微調整だけを目的とした PR は、Codex 側の担当です。

---

## 2. 実装するときの順序

大きな一括変更で品質を落とさないこと。次の順で進めます。

1. 仕様を読む（`docs/`）
2. 変更対象のテストを先に確認する（既存の期待値を壊していないか）
3. engine → data → UI の順に変更する（UI から書き始めない）
4. `npm run verify` を通す
5. 内部的に意味のある単位で小さく commit する

## 3. 変更してよい場所・いけない場所

| 対象 | Claude Code の扱い |
| --- | --- |
| `src/engine/**` | 自由に実装・リファクタしてよい |
| `src/components/**`, `src/pages/**` | 自由に実装してよい |
| `src/domain/**` | ルールの実装。仕様変更を伴う場合は docs も同時に更新する |
| `src/data/rankingRules.ts` | **重みの変更は Human Approval Required** |
| `src/data/bogeyNumbers.ts` | **Human Approval Required**（計算結果との一致をテストが担保） |
| `src/data/standardCheckoutRoutes.generated.ts` | **手編集禁止**（`npm run import:checkout` で再生成） |
| `src/data/lowStandardRoutes.ts` | v1 承認済み。導出ルールの変更は **Human Approval Required** |
| `src/data/setupReferenceCases.ts` | 添付資料の記録。**書き換えず、矛盾は報告する** |
| `src/engine/training/**` | TRAINING 専用。教育設計は `docs/TRAINING_DESIGN.md` |
| `src/engine/simulation/**` | SIMULATION 専用。設計は `docs/SIMULATION_DESIGN.md`。既存エンジンへは手を入れず、`suggestFor` などを呼ぶだけにする |
| `SIGMA_ANCHORS`（`accuracy.ts`） | 戦術データではない。`npm run audit:simulation -- --solve` で逆算し直して差し替える |
| `data/source/*.xlsx` | 一次資料。**変更禁止** |
| `src/ai/**` | Beta の AI 説明層。engine の結果を読むだけ。**判断・ランキング・再探索を書かない** |
| `src/ai/models/**` | Model Management。engine / data / storage に依存しない。**実モデルの追加は Human Approval Required** |
| `src/ai/benchmark/**` | 開発者向け Benchmark。Evidence と応答文字列だけを扱い、engine を呼ばない。候補モデル名は `candidates.ts` にだけ書く |
| `src/lab/**` | Developer Gate 配下の AI MODEL LAB。engine を**呼ぶだけ**で Evidence を作る。App.tsx から動的 import でだけ読む |
| `src/storage/**` | キーは必ず `namespacedKey()`（`01as-beta:`）で作る。Production の `oas.*` に触れない |
| `src/config/releaseChannel.ts` | Beta の識別子（PWA 名・保存名前空間・cacheId）。変えると Production と衝突し得る |

## 3-1. 承認済みの戦術方針

`docs/APPROVALS.md` に、人間が承認した v1 の戦術方針（呼称・2〜40 の導出規則・
SEGMENT_DIFFICULTY・SETUP の重み・GRADE_THRESHOLDS など）が記録されています。

- 承認済み = **人間が選んだ暫定の方針**であって、「絶対に正しい値」ではありません。
- ドキュメントや説明文で、これらを「数学的・統計的に正しい」と表現しないこと。
- v1 から変更したい場合は、値を変えずに提案だけを書き、承認を得てください。

## 3-2. AI 説明層（Beta）

- `src/ai/**` は `src/engine/**` の**結果（型）を読むだけ**。`suggestFor` / `rank*` / `evaluate*` /
  `enumerate*` / `select*` を `src/ai/**` から呼ばない（`src/ai/architecture.test.ts` が検査する）。
- engine / domain / data / storage から `src/ai/**` を import しない（同上）。
- AI の出力で engine の state・判定・戦術データを変えない。Evidence は凍結した複製で渡す。
- Provider が失敗・タイムアウト・不正応答・未対応でも、決定論的な fallback
  （`templateProvider`）で必ず説明を返し、アプリ本体を止めない。
- Evidence が足りないときは補完・推測せず `insufficient-evidence` として返す。
- AI を使えるかどうかは「Developer Gate（`VITE_AI_FEATURES`、開発者向け kill switch）＋導入済みで選択中の
  モデル（`activeModelId`）」で決まる。利用者向けの AI ON / OFF 設定として書かない。
- モデル未導入・未選択なら従来の 01AS として動く。選択中のモデルを削除したら `activeModelId` を null に戻す。
- モデルのファイル（`01as-beta-ai-model:`）と利用者データ（`01as-beta:oas.*`）を混ぜない。
- モデル・推論ライブラリ（WebLLM / transformers.js / llama.cpp 等）・外部 AI API・API key・
  backend は、人間の承認なしに追加しない。

## 4. データに矛盾を見つけたとき

勝手に直さないこと。次の手順を守ります。

1. 何と何が矛盾しているかを、再現できる形（テストまたはスクリプト）で示す
2. `docs/DATA_CONFLICTS.md` へ `DATA CONFLICT` として追記する
3. 直したい場合は `PROPOSED CHANGE` として案を書く（実際には変更しない）
4. PR 説明にも同じ内容を書く

## 5. テストの書き方

- 数万回の `expect` を回さない。全件走査は違反だけを配列へ集め、最後に 1 回 assert する
  （そうしないと vitest の既定タイムアウト 5 秒を超える）。
- engine の変更では、必ず添付資料由来の回帰テスト（122 / 302〜309 / 231〜235 / 271〜275）が
  通ることを確認する。
- TRAINING の 10 万問規模の統計監査は `npm run audit:training` に分離してある。
  通常の `npm run test` へ大量生成を戻さない（高速な決定論的回帰として保つ）。
  監査用のコードを production bundle へ混ぜない（`scripts/` 側に置く）。
- ランキングの重みを触ったら、`基準ルートが 2〜170 すべてで第 1 候補になる` テストが
  通ることを必ず確認する。

## 6. コミットメッセージ

日本語で、何をなぜ変えたかを書きます。モデル名は書きません。
