# AI_BOUNDARIES.md — AI が触れてよい領域・いけない領域（Beta）

> **Deterministic Engine decides. AI explains.**
>
> AI / LLM は 01 Arrangement Support のアレンジ判断の Source of Truth ではありません。

構造は `docs/AI_ARCHITECTURE.md`、評価基準は `docs/AI_EVALUATION.md` を参照。

---

## 1. Source of Truth

| 対象 | Source of Truth | AI の扱い |
| --- | --- | --- |
| 得点計算・Double Out・Bust | `src/domain/**`（`checkoutRules.ts` / `scoring.ts`） | 読むだけ（Evidence 経由） |
| Checkout 成立可否・Bogey 判定 | `src/domain/checkoutRules.ts` | 読むだけ |
| 基準ルート（Standard Route） | `src/data/standardCheckoutRoutes.generated.ts` / `lowStandardRoutes.ts` | 触れない |
| ランキング・推奨度（S / A / B / C） | `src/engine/ranking/**` / `src/engine/setup/**` + `src/data/rankingRules.ts` | 読むだけ |
| NEXT VISIT・Recovery | `src/engine/recovery/**` | 読むだけ |
| GAME REVIEW の判定 | `src/engine/simulation/review.ts` | 読むだけ |
| 理由の文面 | `src/data/explanations.ts`（reason code から生成） | 読むだけ・言い換えてよい |
| 承認済み戦術方針 | `docs/APPROVALS.md` | 触れない |

AI が参照できるのは `src/ai/evidence.ts` が作る **Evidence だけ**です。

---

## 2. AI MUST NOT（AI に決めさせてはいけないこと）

- RouteGrade（S / A / B / C）
- GOOD / BETTER / BAD 等の評価（GAME REVIEW の判定分類を含む）
- 最適ターゲット
- Standard Route
- NEXT VISIT
- Checkout 成立可否
- Bust 判定
- Bogey 判定
- Setup ランキング
- Recovery ランキング
- ダブルアウトの合法性
- 得点計算
- 残り本数
- engine の評価結果の上書き
- 承認済み戦術データの変更

**禁止例**: AI が独自に「116 なら T20 が最善です」と生成し、それをアプリの正式判定として使う設計。

AI の出力は文字列（説明文）だけです。型の上でも、AI の出力を engine の結果へ戻す経路を作りません。

---

## 3. AI MAY（AI に任せてよいこと）

1. engine が出した判断理由の自然言語説明
2. GAME REVIEW の要約
3. 複数ゲーム・練習履歴からの傾向整理
4. 苦手分野の説明
5. 学習上のフィードバック
6. ユーザーからの「なぜ？」への説明
7. engine evidence を根拠とした AI Coach

いずれも **Evidence に書かれた事実の範囲で**説明します。
「なぜ？」への答えも、engine の reason code と理由文を根拠にします。

---

## 4. Failure behavior（AI が失敗したとき）

| 状況 | 扱い |
| --- | --- |
| feature flag OFF / Provider 未設定 | 決定論的な説明（`disabled`） |
| Provider がその機能に未対応 | 決定論的な説明（`unsupported`） |
| 読み込み失敗・ブラウザ非対応・例外 | 決定論的な説明（`error`） |
| 応答が時間内に返らない（既定 8 秒） | 中断を通知し、決定論的な説明（`timeout`） |
| 返り値の形が不正（空・長すぎる・型違い） | 決定論的な説明（`invalid-response`） |
| Evidence に無い主張を含む | 決定論的な説明（`unsupported-claim`） |

どの場合も**例外をアプリへ出しません**。CHECKOUT / SETUP / TRAINING / SIMULATION / GAME REVIEW は
AI の状態と無関係に従来どおり動きます。

---

## 5. Unsupported claim（根拠の無い主張）への対応

AI の説明文に次が含まれていたら、その説明は**採用しません**（`src/ai/validation.ts`）。

- Evidence に現れない的（例: Evidence に無い `T17`）
- Evidence に無い推奨度（例: 「推奨度 C」と言うが Evidence の推奨度は S / A だけ）
- Evidence に無い数値（本数などの 0〜3 を除く）
- Evidence に無い reason code を根拠として挙げる

比べる前に説明文と Evidence を NFKC 正規化・大文字化し、小文字（`t1`）や全角（`Ｔ１`・`７７`・`Ｃ`）の
表記ゆれで検証をすり抜けないようにしています。

検出したら決定論的な説明へ切り替え、問題点を `issues` に残します。

この検証は「値が Evidence にあるか」を見る最低限の網です。Evidence にある値を**誤った関係で**
述べる矛盾（例: 第 3 候補を「最善」と呼ぶ）は検出しきれません。これはモデル導入前の評価
（`docs/AI_EVALUATION.md` の Engine contradiction rate）で測ります。

---

## 6. Insufficient evidence（事実が足りないとき）

Evidence が足りない（候補が無い・推奨度が欠けている・未知の reason code・記録が無い 等）ときは、
AI にも決定論的な説明にも**事実を補わせず**、`{ status: 'insufficient-evidence', missing }` を返します。
このとき Provider は呼びません。

---

## 7. Offline behavior

- 決定論的な説明は完全オフラインで動きます。
- Browser Local Provider を入れる場合も、モデル未取得・取得失敗は `error` として fallback し、
  アプリ本体のオフライン動作を妨げません。
- Remote Provider を入れる場合、オフラインでは fallback します（通信を前提にした機能を作らない）。

---

## 8. Privacy

- AI へ渡すのは Evidence だけ（必要最小限）。生のアプリ state・localStorage の中身は渡しません。
- 学習履歴は**集計値だけ**を渡し、記録の時刻・ID・回答内容は渡しません。
- SIMULATION の着弾座標・乱数・暗算の入力値は渡しません。
- 個人情報・API key・token・private endpoint をリポジトリへ置きません（公開リポジトリ）。
- 現時点で通信する AI Provider は存在しません。`src/ai/**` は通信 API を使いません
  （`src/ai/architecture.test.ts` で検査）。

---

## 9. Tactical data との境界 / Human Approval が必要な変更

AI 基盤のために次を変更してはいけません（`AGENTS.md` 2-2 節と同じ）。

- 基準ルート（`standardCheckoutRoutes.generated.ts` / `lowStandardRoutes.ts`）
- Bogey Number（`bogeyNumbers.ts`）
- ランキングの思想・重み・推奨度しきい値（`rankingRules.ts` / `GRADE_THRESHOLDS`）
- 良いセットアップ残り（`PREMIUM_TENPAI_LEAVES`）
- 書き下ろし説明（`CURATED_*_EXPLANATIONS`）
- 資料由来フィクスチャ（`setupReferenceCases.ts`）

AI の説明を作る過程でデータの問題に気づいても**修正せず**、`docs/DATA_CONFLICTS.md` または PR 説明へ
`QUESTION` / `DATA CONFLICT` / `PROPOSED CHANGE` として記録します。

さらに、次の変更は**人間の承認を経てから**別 PR で行います。

- AI モデル・推論ライブラリ（WebLLM / transformers.js / llama.cpp・wasm 等）の追加
- WebGPU 推論の導入
- 外部 AI API（OpenAI / Claude / Gemini 等）への接続・API key の導入
- backend（Cloudflare Worker / Supabase / Firebase 等）の追加
- AI 機能を既定 ON にすること、AI の説明をユーザーへ公開すること
- Evidence の範囲を広げること（特に個人の履歴・自由入力を渡すこと）
- この文書の AI MUST NOT / AI MAY の変更
