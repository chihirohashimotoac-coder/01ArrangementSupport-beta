# AI_ARCHITECTURE.md — AI 説明層のアーキテクチャ（Beta）

> **Deterministic Engine decides. AI explains.**

01 Arrangement Support の思想は「答えを暗記するのではなく、アレンジの判断方法を学ぶ」です。
Beta ではこれを保ったまま、engine の判断を**言葉で理解する手助け**として AI を使えるようにします。
AI は Decision Maker ではなく **Explanation / Coaching Layer** です。

このドキュメントは構造（どこに何があり、どちら向きに依存するか）を定義します。
AI に許すこと・許さないことは `docs/AI_BOUNDARIES.md`、モデル比較の基準は `docs/AI_EVALUATION.md`。

---

## 1. 層と依存の向き

```text
01AS Core（domain / data）
    ↓  参照のみ
Decision Engine（src/engine/**）                 … 判断する（決定論的・テスト済み）
    ↓  結果（Suggestion / GameReview / TrainingStats）
Structured Evidence Layer（src/ai/evidence.ts）    … filter / normalize / serialize だけ
    ↓  Evidence（凍結した複製）
AI Provider（src/ai/types.ts の AiProvider）       … 説明文を返すだけ
    ↓  説明文（検証済み）
Explanation / Review / Coach（将来の画面）         … 表示するだけ
```

- 依存は**上から下への一方向**です。
- `src/engine/**`・`src/domain/**`・`src/data/**`・`src/storage/**`・`src/geometry/**` は
  `src/ai/**` を import しません。
- `src/ai/**` は engine の**結果の型**と、表示用の定数（`THROW_VERDICTS` / `THROW_VERDICT_JA`）
  だけを読みます。`suggestFor` / `rank*` / `evaluate*` / `enumerate*` / `select*` を呼びません。
- `src/ai/**` は data 層の戦術データ（ルート表・重み・Bogey 表）を読みません。
- AI の出力は**文字列（説明文）だけ**です。engine の state・判定・戦術データへ戻す経路はありません。

これらは `src/ai/architecture.test.ts` が静的に検査します（違反を入れると失敗することを確認済み）。

---

## 2. ファイル構成

| ファイル | 役割 |
| --- | --- |
| `src/ai/types.ts` | Evidence 型・Provider interface・呼び出し結果の型。モデル固有の型は置かない |
| `src/ai/evidence.ts` | engine の結果 → Evidence。並べ替え・再評価・探索をしない。凍結して返す |
| `src/ai/validation.ts` | Evidence の充足チェック（insufficient evidence）と、AI 出力の検証（unsupported claim） |
| `src/ai/templateProvider.ts` | 決定論的な説明（fallback）。モデルを使わない |
| `src/ai/explain.ts` | 安全な呼び出し口。検証・タイムアウト・fallback。例外を外へ出さない |
| `src/ai/featureFlag.ts` | AI 機能の ON / OFF（既定 OFF） |
| `src/ai/index.ts` | 公開 API。画面・将来の Coach はここからだけ import する |

巨大な `AiManager` クラスは作らず、純粋関数と小さな interface に分けています。

---

## 3. Structured Evidence Layer

AI へ生のアプリ state を渡しません。engine の結果から、**AI が説明に使ってよい検証済みの事実**
だけを取り出します。

```text
Engine result → filter / normalize / serialize → Evidence
```

| 関数 | 入力（engine） | Evidence |
| --- | --- | --- |
| `buildDecisionEvidence` | `suggestFor()` の `Suggestion` | `DecisionEvidence`（CHECKOUT / SETUP / NEXT_VISIT / UNAVAILABLE） |
| `buildGameReviewEvidence` | `buildGameReview()` の `GameReview` | `GameReviewEvidence` |
| `buildTrainingEvidence` | `computeStats()` の `TrainingStats` | `TrainingEvidence` |

### Evidence がすること

- **filter**: 候補を engine の上位から切り詰める（既定 3 件）。採点対象外の投（SCORING_PHASE）を除く。
  engine の内部値（重み・スコア・`tacticalScore`・ルートキー）、着弾座標、乱数、暗算の入力値、
  学習記録の時刻・ID・回答内容を落とす。
- **normalize**: PPR を小数第 1 位へ丸める。正答率を 0〜100 の整数にする。
- **serialize**: `serializeEvidence()` でキー順を固定した JSON にする（同じ Evidence → 同じ文字列）。

### Evidence がしないこと

- ランキングの再計算・並べ替え
- 推奨度（S / A / B / C）の付け直し
- 別ルートの探索・「より良い」ルートの提案
- reason code の追加・削除・言い換え

理由の文面（`summaryJa`）は、engine が既存の説明テンプレート（`src/data/explanations.ts`）で
組み立てたものをそのまま写します。reason logic を二重に実装しません。

### 凍結と複製

Evidence は `deepFreeze` で凍結して返します。さらに `explain.ts` は Provider へ渡す前に
JSON で複製して凍結し直します。Provider が Evidence を書き換えようとしても、
engine の state・キャッシュには届きません（`src/ai/explain.test.ts` で確認）。

---

## 4. AI Provider interface

```ts
interface AiProvider {
  readonly id: string;
  readonly kind: 'deterministic' | 'browser-local' | 'remote';
  explainDecision(evidence: DecisionEvidence, context: AiCallContext): Promise<AiTextOutput>;
  summarizeSession?(evidence: SessionEvidence, context: AiCallContext): Promise<AiTextOutput>;
}

interface AiTextOutput {
  readonly text: string;
  readonly citedReasonCodes?: readonly string[];
}
```

- 実行場所（`kind`）で分類し、モデル名では分類しません。Browser Local OSS Model / Remote OSS Model /
  商用 API のどれでも、この interface を実装すれば差し替えられます。
- プロンプト形式・トークン・SDK の型は Provider の実装の中に閉じ込め、アプリへ漏らしません。
- 必須は `explainDecision` だけです。対応しない機能は省略でき、呼び出し側が決定論的な説明へ切り替えます。
- `context.signal` はタイムアウト時に abort されます。

**このリポジトリにはまだ実 LLM の Provider はありません**（決定論的な `templateProvider` だけ）。

---

## 5. 安全な呼び出し（`explainDecision` / `summarizeSession`）

```text
1. Evidence を検証 ─ 不足 → { status: 'insufficient-evidence', missing }（Provider を呼ばない）
2. feature flag OFF / Provider 未設定 → 決定論的な説明（fallbackReason: 'disabled'）
3. Provider が機能を持たない → 決定論的な説明（'unsupported'）
4. 凍結した複製で Provider を呼ぶ（既定 8 秒でタイムアウト）
     throw → 'error' / 時間切れ → 'timeout'
5. 返り値の形を検証 → 不正 → 'invalid-response'
6. Evidence に無い主張を検証 → あれば 'unsupported-claim'
7. すべて通れば Provider の説明を採用（source: 'provider'）
```

- この関数は**例外を投げません**。AI 側で何が起きても、engine と画面はこれまでどおり動きます。
- 返り値（`AiResult`）は説明文・出所・fallback 理由・問題点だけで、engine の値を含みません。

---

## 6. Deterministic fallback

`templateProvider` はモデルを使わず、Evidence の値と engine の理由文だけで説明を組み立てます。

- 同じ Evidence からは常に同じ文面
- 2〜350 × 残り 1〜3 本（1,047 場面）のすべてで、Evidence が充足し、
  出力に Evidence に無い的・推奨度・数値が含まれないことをテストで確認
- AI 機能が無くても、CHECKOUT / SETUP / TRAINING / SIMULATION / GAME REVIEW は
  従来どおり動作します（そもそもアプリ本体は現時点で AI 層を import していません）

---

## 7. Feature flag

| 項目 | 値 |
| --- | --- |
| 変数 | `VITE_AI_FEATURES`（ビルド時） |
| 既定 | **OFF**（未設定） |
| ON | `VITE_AI_FEATURES=on` のときだけ |

OFF のとき `explainDecision` / `summarizeSession` は Provider を呼ばず、決定論的な説明を返します。
現時点ではアプリ本体が AI 層を使っていないため、OFF / ON のどちらでも画面は Production と同じです。

実 Provider を入れる PR で、設定画面の ON / OFF（端末ごと・保存キーは `namespacedKey()`）を
この flag の上に足します。未完成の AI チャット UI は公開しません。

---

## 8. オフライン

- 決定論的な説明は完全オフラインで動きます。
- 将来の Browser Local Provider は、モデルの取得に失敗・未取得でも `error` として fallback します。
- Remote Provider を入れる場合も、通信失敗は `error` / `timeout` として fallback します。

---

## 9. 今後（このリポジトリではまだ行わない）

- OSS モデルの候補比較と Browser Local 推論の実現性調査（`docs/AI_EVALUATION.md` の基準で比較）
- Provider 実装（モデルの取得・キャッシュ・WebGPU 判定）
- 画面への組み込み（説明ボタン・GAME REVIEW の要約・AI Coach）と実行時の ON / OFF

いずれも人間の承認を経てから別 PR で行います（`docs/AI_BOUNDARIES.md` 9 節）。
