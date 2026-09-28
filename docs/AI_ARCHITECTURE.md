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
AI Explanation Layer（src/ai/explain.ts）          … 検証・タイムアウト・fallback
    ↓  AiProvider interface
AI Provider（src/ai/types.ts の AiProvider）       … 説明文を返すだけ
    ↓
Model Runtime（src/ai/models/runtime.ts の LocalModelRuntime）… 取得・削除・推論（実装は未作成）
    ↓
Active Local Model（activeModelId のモデル）       … 利用者が導入・選択したもの
```

説明文は Explanation Layer から画面（Explanation / Review / Coach。将来）へ渡り、表示されるだけです。

- 依存は**上から下への一方向**です。AI から Decision Engine への逆依存はありません。
- `src/ai/models/**`（Model Management）は engine / domain / data / storage / 画面に依存しません。
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
| `src/ai/developerGate.ts` | Developer Gate（開発者向けの experimental kill switch。利用者向けの設定ではない） |
| `src/ai/models/catalog.ts` | Model Catalog（モデル区分・モデル定義の検証。既定は空） |
| `src/ai/models/state.ts` | Model State（導入状態・activeModelId の純粋な状態遷移） |
| `src/ai/models/runtime.ts` | Model Runtime の境界・Provider の解決・モデル削除 |
| `src/ai/index.ts` | 公開 API。画面・将来の Coach はここからだけ import する |
| `src/ai/benchmark/**` | 開発者向け Benchmark（候補・prompt・自動検証・計測・export・端末確認・Runtime）。11 節 |
| `src/lab/**` | 開発者向け AI MODEL LAB（Developer Gate 配下）とデータセットの定義。11 節 |

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
2. Developer Gate が閉 → 決定論的な説明（fallbackReason: 'developer-gate-closed'）
   使用中のモデルが無い（未導入・未選択）→ 決定論的な説明（'no-active-model'）
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
  従来どおり動作します（アプリ本体の画面は AI 層を使っていません。例外は開発者向けの Lab と、その入口の Gate 判定だけ。11 節）

---

## 7. AI が使えるかどうかの決まり方

Beta では **「AI ON / OFF」を利用者の主要な操作にしません**。利用者が扱うのはモデルです。

```text
モデル未導入（または未選択）
  ↓
従来の 01 Arrangement Support として動作する（決定論的な説明だけ）

モデル導入済み・選択中（activeModelId）
  ↓
AI Explanation / Review / Coach を利用できる
```

内部的には次の 2 つが揃ったときだけ AI 層を使います。

```text
Developer Gate（開発者向けの kill switch）
        +
Installed / Active Model State（導入済みで選択中のモデル）
        ↓
AI 機能を利用できる
```

### 7.1 Developer Gate（`VITE_AI_FEATURES`）

| 項目 | 値 |
| --- | --- |
| 位置づけ | **開発者向けの experimental kill switch**。利用者向けの AI ON / OFF 設定ではない |
| 変数 | `VITE_AI_FEATURES`（ビルド時） |
| 既定 | 閉（未設定）。通常の CI（lint / test / build / E2E）・ローカルのビルドも閉 |
| 開く | `VITE_AI_FEATURES=on` のときだけ |
| Beta の GitHub Pages 成果物 | **開**（`npm run build:pages`。`scripts/lib/pagesBuild.mjs` が base path と同時に設定。`docs/APPROVALS.md` AI-2） |

実験中の不具合があったときに、ビルド単位で AI 層を止めるためのものです。閉じていれば、
モデルが選択されていても決定論的な説明を返します（`developer-gate-closed`）。
一般ユーザー向けの画面は AI 層を呼ばないため、どちらでも画面は Production と同じです。開いたビルドでだけ、設定画面に
開発者向けの AI MODEL LAB への入口が出ます（11 節）。

---

## 8. Model Management（`src/ai/models/`）

利用者が将来、複数のローカル AI モデルから次を行えるようにするための型と境界です。
**実モデル・実際のダウンロード処理・推論はまだありません。**

```text
モデルを選ぶ → 容量・性能・特徴を見る → 明示的にダウンロード
  → 使用モデルを選択 → 別モデルへ切り替え → 不要なモデルを削除
```

### 8.1 Model Catalog（`catalog.ts`）

| 区分 | 目安 | 想定 |
| --- | --- | --- |
| `ULTRA_LIGHT` | 0.5〜1B 級 | 低スペック端末・スマートフォン |
| `LIGHT` | 1〜2B 級 | 速度重視 |
| `STANDARD` | 3〜4B 級 | 品質と速度のバランス |
| `QUALITY` | 7〜8B 級など | 高性能 PC 向け |
| `EXPERIMENTAL` | 不定 | 新しいモデルの評価用 |

パラメータ数は目安で、固定の仕様ではありません。

`LocalAiModelDefinition` は `id`（アプリ内の安定 ID）・`displayName`・`modelClass`・`runtimeId`・
`modelId`（Runtime に渡す配布元の ID。アプリは解釈しない）・`parameterClass`・`downloadSizeBytes`・
`estimatedMemoryBytes`・`contextWindow`・`capabilities`（explanation / review / coach）・
`requirements`（webGpu / recommendedMemoryBytes）・`status`（supported / experimental / deprecated）を持ちます。

- 具体的なモデル名は**カタログのデータにだけ**書きます。アプリの他の場所は区分と定義の型だけを見ます
  （`src/ai/architecture.test.ts` が src 内のモデル系列名を検査）。
- 既定のカタログ（`DEFAULT_MODEL_CATALOG`）は**空**です。追加は評価と人間の承認を経てから。

### 8.2 Model State（`state.ts`）

| 状態 | 意味 |
| --- | --- |
| `AVAILABLE` | 導入できる（未ダウンロード） |
| `DOWNLOADING` | ダウンロード中（進捗 0〜1） |
| `DOWNLOADED` | 導入済み |
| `ACTIVE` | 導入済みで、使用中（`activeModelId`） |
| `ERROR` | 取得・検証に失敗。再試行できる |
| `UNSUPPORTED` | この端末・ブラウザでは使えない（WebGPU 必須など） |

- 保存するのはモデルごとの導入状態と `activeModelId` だけで、`ACTIVE` は
  「`DOWNLOADED` かつ `activeModelId` と一致」から導きます（二重に持たない）。
- 遷移はすべて純粋関数（`startDownload` / `completeDownload` / `failDownload` / `cancelDownload` /
  `activateModel` / `clearActiveModel` / `deleteModel` / `restoreModelState`）。不正な遷移は状態を変えずに拒否します。
- `deprecated` のモデルは新しくダウンロードできません（導入済みなら使えます）。

### 8.3 activeModel

- 複数のモデルを導入でき、その中から 1 つを `activeModelId` として選びます。未導入のモデルは選べません。
- 切り替えは `activateModel` をもう一度呼ぶだけです。
- モデルの状態は Decision Engine・TRAINING 履歴・SIMULATION 設定・GAME REVIEW・通常の設定を
  持たず、参照せず、変更しません。モデルを替えても engine の結果は同じです（テストで確認）。

### 8.4 モデル削除と利用者データの分離

```text
AI model cache（01as-beta-ai-model:<id>） ≠ user data（localStorage の 01as-beta:oas.*）
```

| 保存するもの | 場所 | モデル削除で消えるか |
| --- | --- | --- |
| モデルのファイル | Cache Storage / IndexedDB の `01as-beta-ai-model:<id>` | 消える（Runtime の `remove`） |
| モデルの状態 | `01as-beta:ai.models.v1`（保存の実装は未作成） | そのモデルの項目だけ AVAILABLE に戻る |
| 設定・学習履歴・SIMULATION 設定 | `01as-beta:oas.*` | **消えない**（削除の経路に現れない） |
| アプリ本体のオフライン用キャッシュ | Workbox `01as-beta-precache-…` | 消えない |

- 開発者向けの AI MODEL LAB が使う WebLLM は、モデルを WebLLM 側で名前が固定された Cache Storage
  （`webllm/model`・`webllm/config`・`webllm/wasm`）に置きます。上の `01as-beta-ai-model:<id>` とは名前が違います
  （11.4 節。利用者向けの Model Management へ組み込むときに扱いを決める）。
- 選択中のモデルを削除したら `activeModelId` は null に戻り、**従来の 01AS として動作**します。
  別のモデルへ勝手に切り替えません。
- Runtime の削除が失敗したら状態を変えません（ファイルが残っている可能性があるため）。

### 8.5 Provider abstraction との接続

`resolveActiveProvider({ developerGateOpen, state, catalog, runtimes })` が、選択中のモデルの
Runtime から `AiProvider` を作ります。Gate が閉・モデル未選択・Runtime が無い・作成に失敗した
場合は `provider: null` を返し、`explainDecision` は従来の説明（`no-active-model` など）を返します。

---

## 9. オフライン

- 決定論的な説明は完全オフラインで動きます。
- 将来の Browser Local Provider は、モデルの取得に失敗・未取得でも `error` として fallback します。
- Remote Provider を入れる場合も、通信失敗は `error` / `timeout` として fallback します。

---

## 10. 今後（このリポジトリではまだ行わない）

- OSS モデルの実測と採用判断（比較の基盤は 11 節の Benchmark Lab。採用は人間が判断する）
- 利用者向けの Model Runtime（`LocalModelRuntime` の実装）と Model Catalog へのモデル追加
- モデル状態の保存（`01as-beta:ai.models.v1`）
- 画面への組み込み（モデルの一覧・容量表示・ダウンロード・選択・削除、説明ボタン・GAME REVIEW の要約・AI Coach）

いずれも人間の承認を経てから別 PR で行います（`docs/AI_BOUNDARIES.md` 9 節）。

---

## 11. AI Model Benchmark Lab（開発者向け）

ローカル AI モデルを**公平に採用判断するための**内部 Lab です。一般ユーザー向けの画面ではなく、
モデルの採用・AI Coach はここでは行いません。詳細（候補・Runtime の比較・データセット・指標・手順）は
`docs/AI_MODEL_BENCHMARK.md`。

### 11.1 構造

```text
src/lab/benchmarkDataset.ts          … engine を呼んで Evidence を作る（suggestFor / 自動プレイ / buildGameReview）
    ↓ Evidence（凍結）
src/ai/benchmark/dataset.ts          … タグ付け・指紋（戦術判断をしない）
    ↓ BenchmarkCase
src/ai/benchmark/prompt.ts           … 版管理した prompt（01as-explain-ja@1）
    ↓ messages
BenchmarkRuntime（template / mock / WebLLM）… 生成だけ
    ↓ 文字列 + 計測値
src/ai/benchmark/checks.ts           … contradiction / unsupported claim / 形 / thinking / 体裁
    ↓
src/ai/benchmark/metrics.ts・export.ts … 集計・JSON / CSV
    ↓
src/lab/AiModelLabPage.tsx           … 画面（Developer Gate 配下）・src/lab/labStorage.ts（保存）
```

- `src/ai/benchmark/**` も engine の関数を呼びません。engine を呼ぶのはデータセットの定義（`src/lab/`）だけです。
- Benchmark の結果（文字列）は engine・アプリの説明へ戻りません。`explain.ts` の実行時の経路とは独立しています
  （検証関数 `findUnsupportedClaims` / `checkOutputShape` は同じものを使う）。
- `BenchmarkRuntime` は計測用の interface で、利用者向けの `LocalModelRuntime`（8 節）とは別です。
  実測で採用が決まった Runtime を、`LocalModelRuntime` の実装として組み込むのは別 PR です。

### 11.2 入口（Developer Gate）

- `VITE_AI_FEATURES=on` のビルドでだけ、設定画面に **DEVELOPER → AI MODEL LAB** が出ます。
  Beta の GitHub Pages 成果物は Gate を開いてビルドするので、公開中の Beta でも Lab を使えます（7.1 節）。
  通常の CI は閉じたビルドで「入口が無い」ことを検査し、さらに Pages と同じ設定の成果物を base path で配信して
  「入口がある・Lab と WebLLM は遅延読み込み・precache しない・明示操作なしにモデルを取得しない」ことを検査します
  （`e2e/gate-open/`）。
- Lab は `React.lazy` の動的 import で、開いたときに初めて読み込みます。
- Lab と WebLLM の chunk は Service Worker の precache に入れません（`vite.config.ts` の `globIgnores`）。
- AI 層（`src/ai/**`）を使うのは `src/lab/**` と、App.tsx の Gate 判定（`./ai/developerGate`）だけです。

### 11.3 推論ライブラリ（WebLLM）

- `@mlc-ai/web-llm` を**版固定**（0.2.85）で追加しました。Benchmark の primary runtime 候補の検証用です。
- `src/ai/benchmark/runtimes/webllmRuntime.ts` から**動的 import でだけ**読みます（静的 import は architecture test で禁止）。
- モデルの取得は `load({ allowDownload: true })`、つまり利用者が確認画面で「ダウンロードを開始」を押したときだけです。
  Benchmark の実行は `allowDownload: false` で、キャッシュに無ければ失敗します。
- ほかの推論ライブラリ（Transformers.js・LiteRT-LM 等）は追加していません（`docs/AI_MODEL_BENCHMARK.md` 4 節）。
- 承認の範囲: Benchmark Lab で候補モデルを実測する目的に限る（`docs/APPROVALS.md` AI-1）。
  一般ユーザー向け AI 機能・Production・将来の正式 Runtime への採用ではありません。

### 11.3.1 explain.ts を通さない唯一の例外

Benchmark は候補モデルの**生の応答**を測るため、`src/ai/benchmark/runner.ts` が `explain.ts` を通さずに
Benchmark Runtime を呼びます（explain.ts を通すと、不合格の応答が fallback に置き換わり測定になりません）。

- runner はケースごとのタイムアウトと、explain.ts と同じ検証関数（`checkOutputShape`・`findUnsupportedClaims`）を持つ
- 結果は計測値として Lab に表示するだけで、アプリの説明・engine の state・戦術データへは戻らない
- `runtime.generate` を呼べるのは runner だけ（`src/ai/architecture.test.ts`）。Lab の画面は runner を呼ぶ

### 11.4 保存とキャッシュ

```text
AI model cache（WebLLM: 既定は OPFS の tvmjs-opfs-store/webllm/*。IndexedDB / Cache API の webllm/* も選べる）
  ≠
01AS user data（localStorage の 01as-beta:oas.*）
  ≠
Benchmark の結果・人手評価（localStorage の 01as-beta:ai.benchmark.*）
```

| 保存するもの | 場所 | モデル削除で消えるか |
| --- | --- | --- |
| モデル（重み・設定・model library） | 既定は OPFS `tvmjs-opfs-store/webllm/{model,config,wasm}`。IndexedDB / Cache API では `webllm/model`・`webllm/config`・`webllm/wasm`（WebLLM が名前を固定。`docs/AI_MODEL_STORAGE.md`） | 選んでいる保存方式の、そのモデルの項目だけ消える（`deleteModelAllInfoInCache`）。ほかの方式のモデルは消えない |
| Benchmark の結果（直近 5 run） | `01as-beta:ai.benchmark.runs.v1` | **消えない** |
| 人手評価 | `01as-beta:ai.benchmark.ratings.v1` | **消えない** |
| 設定・TRAINING 履歴・SIMULATION 設定 | `01as-beta:oas.*` | **消えない** |

- 削除で消えないことは `src/lab/AiModelLabPage.test.tsx` と `src/ai/benchmark/benchmark.test.ts` で確認しています。
#### KNOWN LIMITATION: WebLLM のキャッシュ名は 01AS 専用名にできない

- WebLLM 0.2.85 のキャッシュ名（`webllm/model`・`webllm/config`・`webllm/wasm`）は WebLLM 側で固定で、
  8.4 節の `01as-beta-ai-model:<id>` のような 01AS 専用名へ変更できません。
- GitHub Pages では、同じ origin（`chihirohashimotoac-coder.github.io`）の別のアプリが WebLLM を使うと、
  `webllm/*` を共有する可能性があります（Production の 01AS は WebLLM を使っていません）。
- これは既知の制約として許容しています（`docs/APPROVALS.md` AI-3）。正式採用を妨げる問題としては扱いません。

そのため Benchmark の段階では次を守ります。

| 規則 | 実装・検査 |
| --- | --- |
| WebLLM model cache ≠ 01AS user data | モデルは WebLLM の保存領域（既定 OPFS）、利用者データ・評価は localStorage の `01as-beta:*`。保存方式の変更・削除で利用者データ・評価が残ることをテストで確認 |
| **WebLLM の全キャッシュを一括削除しない** | 01AS 側に一括削除の処理を持たない。`caches.delete()`・`Cache.delete()`・`indexedDB.deleteDatabase()`・OPFS の削除・Clear-Site-Data・WebLLM の部分削除 API を architecture test で禁止 |
| 削除は対象モデル単位 | `deleteModelAllInfoInCache(modelId)` を、選んだ候補のモデル ID で 1 か所から呼ぶだけ（architecture test）。ほかのモデルのキャッシュが残ることを unit test で確認 |
| サイズの計測は読むだけ | `webllm/*` を `open` / `keys` / `match` で読み、`content-length` を合計する（書き換え・削除をしない） |

### 11.5 端末確認

`navigator.gpu`・`requestAdapter()`（features・limits・adapter.info）・`navigator.userAgent(Data)`・
`navigator.deviceMemory`・`navigator.storage.estimate()` の、API で取得できる値だけを記録します。
GPU の VRAM 量など取得できない値は推測しません。判定は `UNSUPPORTED`（WebGPU / adapter / 必須 feature が無い）・
`MAY_BE_TOO_LARGE`（推定 VRAM が報告された端末メモリを超える・モバイルで低リソース向けでない・保存容量が足りない恐れ）・
`CAN_TRY`（試してよい。実行できる保証ではない）・`UNKNOWN`（未確認）です。
