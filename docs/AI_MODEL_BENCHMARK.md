# AI_MODEL_BENCHMARK.md — ローカル AI モデルの Benchmark Lab（Beta・開発者向け）

> **このドキュメントの目的は「モデルを採用すること」ではなく、「モデルを公平に採用判断できる状態を作ること」です。**
> 結果が出る前に「Qwen3 4B を STANDARD に決定」のような固定はしません。
> 採用は実測結果を見て人間が判断し、`docs/APPROVALS.md` に記録します。

01AS に必要なのは高度な世界知識ではなく、

```text
Engine が渡した Evidence を
勝手に改変せず
自然な日本語で
短く分かりやすく説明する能力
```

です。有名さ・一般的な LLM benchmark の高さだけでは採用しません。

関連: `docs/AI_EVALUATION.md`（評価基準）・`docs/AI_ARCHITECTURE.md`（構造）・`docs/AI_BOUNDARIES.md`（AI の役割）・
`docs/APPROVALS.md` AI-1〜3（承認の範囲）。

> **承認の範囲**: `@mlc-ai/web-llm` 0.2.85 は、この Lab で候補モデルを実測する目的に限って承認されています
> （2026-09-28・`docs/APPROVALS.md` AI-1）。一般ユーザー向け AI 機能・Production・将来の正式 Runtime への採用ではありません。

---

## 1. 全体の流れ

```text
Candidate Model（src/ai/benchmark/candidates.ts）
  ↓
Same 01AS Evidence（01AS Core v1・100 ケース。src/lab/benchmarkDataset.ts）
  ↓
Generate Explanation（版管理した prompt 01as-explain-ja@1 → Benchmark Runtime）
  ↓
Automatic Validation（contradiction / unsupported claim / 形 / thinking の漏れ / 体裁）
  ↓
Performance Measurement（TTFT / 生成時間 / tok/s / 出力量 / 読み込み時間 / サイズ）
  ↓
Comparable Result（BenchmarkRun。JSON / CSV export・人手評価）
```

### 1.1 ファイル構成

| ファイル | 役割 |
| --- | --- |
| `src/ai/benchmark/types.ts` | ケース・Runtime・結果の型 |
| `src/ai/benchmark/candidates.ts` | 候補モデル（**モデル名を書いてよいのはここだけ**。採用済み一覧ではない） |
| `src/ai/benchmark/prompt.ts` | 版管理したプロンプト（`PROMPT_VERSION`） |
| `src/ai/benchmark/tags.ts` | 観点タグを Evidence から機械的に導く |
| `src/ai/benchmark/dataset.ts` | ケースの組み立て・指紋（dataset fingerprint） |
| `src/ai/benchmark/checks.ts` | 自動検証（contradiction・unsupported claim・thinking・体裁） |
| `src/ai/benchmark/runner.ts` | 実行（タイムアウト・中断・1 件の失敗で止めない） |
| `src/ai/benchmark/metrics.ts` | 集計（01AS の優先順） |
| `src/ai/benchmark/export.ts` | JSON / CSV export・人手評価の型 |
| `src/ai/benchmark/device.ts` | 端末確認と互換性の判定 |
| `src/ai/benchmark/runtimes/templateRuntime.ts` | 決定論的な baseline（モデルなし） |
| `src/ai/benchmark/runtimes/mockRuntime.ts` | CI 用の Mock Runtime / Fake Model |
| `src/ai/benchmark/runtimes/webllmRuntime.ts` | WebLLM（動的 import）。保存方式ごとに 1 つの appConfig を使う |
| `src/ai/benchmark/modelStorage.ts` | モデルの保存方式（OPFS / IndexedDB / Cache API）・方式ごとの存在確認とサイズ・origin の保存状況（`docs/AI_MODEL_STORAGE.md`） |
| `src/ai/benchmark/modelLoadFailure.ts` | 取得・読み込みの失敗の分類と診断情報 |
| `src/ai/benchmark/runtimes/fakeStorage.ts` | テスト用の偽の保存 API |
| `src/lab/benchmarkDataset.ts` | 01AS Core v1 の定義（engine を**呼ぶだけ**） |
| `src/lab/AiModelLabPage.tsx` | AI MODEL LAB の画面（Developer Gate 配下） |
| `src/lab/labStorage.ts` | 結果・人手評価の保存（`01as-beta:` 名前空間） |

`src/ai/benchmark/**` は engine の関数を呼びません（`src/ai/architecture.test.ts`）。
engine を呼んで Evidence を作るのはデータセットの定義（`src/lab/`）で、画面が `suggestFor` を呼ぶのと同じ位置づけです。
`src/engine/**`・`src/data/**`・`src/domain/**`・`data/source/**` は変更していません。

---

## 2. 使い方（手動での実測）

実モデルの Benchmark は**手動実行**です。CI ではモデルを取得しません（Mock Runtime と Fake Model で検査）。

- **公開中の Beta（GitHub Pages）**: Pages 用の成果物は Developer Gate を開いてビルドしているので、
  https://chihirohashimotoac-coder.github.io/01ArrangementSupport-beta/ の設定画面から Lab を開けます（PR #2 の merge 後）。
- **ローカル**:

```bash
VITE_AI_FEATURES=on npm run dev
# または
VITE_AI_FEATURES=on npm run build && npm run preview
```

1. 設定 → **DEVELOPER** → 「AI MODEL LAB を開く」（Gate が閉じたビルドでは項目自体が出ません）
2. **DEVICE** で WebGPU・adapter・features・端末メモリ（報告値）・保存容量を確認
   **STORAGE** で Model Storage Backend（既定 OPFS）・Storage Persistent・Origin Usage / Quota を確認
3. **MODEL** で候補を選び、Compatibility（`CAN_TRY` / `MAY_BE_TOO_LARGE` / `UNSUPPORTED` / `UNKNOWN`）を確認
4. **Download** → 確認画面（model / download size / estimated memory / runtime / 保存方式 / license）→ 「ダウンロードを開始」
   （失敗したら区分と診断情報が出る。記録の仕方は `docs/AI_MODEL_STORAGE.md` 7 節）
5. **BENCHMARK** で Thinking（対応モデルだけ。既定 OFF）とケース（すべて / クイック 10 件）を選び Run Benchmark
6. **RESULTS** で指標を確認し、応答ごとに 5 項目を評価、JSON / CSV（blind）で export

- WebGPU は secure context（`https://` または `localhost`）でだけ使えます。スマートフォンで試す場合は HTTPS で配信してください。
- ページ表示・設定画面の表示・Lab の表示・モデルの選択だけでは、モデルを取得しません（`e2e/gate-open/` で外部通信を遮断して検査）。
  モデルを選ぶと、保存方式ごとに保存状況を確認します（保存領域を作らない）。どの方式にも WebLLM の保存領域が無ければ
  WebLLM のライブラリも読み込みません。保存領域があるときと Download / Load のときに WebLLM（同じ配信元の chunk）を読み込みます。
- 同じ候補の 2 回目以降の読み込みは `cache-cold`（ページ再読み込み後）/ `cache-warm`（同じページで再読み込み）として記録されます。

### 2.1 ビルドの種類と CI

| ビルド | Developer Gate | 用途 | CI での検査 |
| --- | --- | --- | --- |
| `npm run build`（通常） | 閉（`VITE_AI_FEATURES` 未設定） | lint / test / E2E | `npm run test:e2e`: Lab の入口が無い・Lab / WebLLM を precache しない・モデル配布元へ通信しない |
| `npm run build:pages`（GitHub Pages） | **開**（`scripts/lib/pagesBuild.mjs`） | Beta の公開 | `npm run check:base`: base path・Lab と WebLLM の chunk が別に出る・precache に入らない・モデルのファイルが無い |
| `npm run test:e2e:gate-open` | **開**（Pages と同じ設定・base path で配信） | Pages 成果物の E2E | 入口がある・Lab は遅延読み込み・起動だけでは Lab / WebLLM / モデルを読まない・Storage Backend = OPFS の表示・モデル選択で保存状況を確認（保存領域を作らない）・確認画面の表示（保存方式 OPFS）・「ダウンロードを開始」を押さなければ取得しない・Cache API / OPFS に何も書かない・外部通信 0・通常の 01AS が動く |

- base path は deploy 時に repository 名から算出します（`.github/workflows/ci-deploy.yml`）。
  Pages 用ビルドの Gate の値と、検証用の既定 base は `scripts/lib/pagesBuild.mjs` の 1 か所にだけ書きます。
- CI の gate-open E2E は headless で WebGPU の adapter が無いため、確認画面の検査では adapter を偽装します
  （`requestDevice` は失敗させ、モデルは取得しません）。

### 2.2 KNOWN LIMITATION: WebLLM のキャッシュ

- モデルの保存方式は **OPFS が既定**です（PR #3。WebLLM 0.2.85 の既定の Cache API で `QuotaExceededError` が出たため）。
  方針・失敗の分類・実機での再検証手順は `docs/AI_MODEL_STORAGE.md`。
- OPFS でも `QuotaExceededError` になる場合の切り分け（WebLLM を使わずに OPFS / IndexedDB / Cache API へ実際に書く
  BROWSER STORAGE DIAGNOSTICS）は `docs/BROWSER_STORAGE_DIAGNOSTICS.md`（PR #4）。
- WebLLM 0.2.85 のキャッシュ名（`webllm/model`・`webllm/config`・`webllm/wasm`。OPFS では `tvmjs-opfs-store/webllm/*`）は、
  01AS 専用名へ変更できません。
  同じ origin（`chihirohashimotoac-coder.github.io`）の別のアプリが WebLLM を使うと、`webllm/*` を共有する可能性があります。
- 既知の制約として許容しています（`docs/APPROVALS.md` AI-3）。正式採用を妨げる問題としては扱いません。
- Benchmark の段階では次を守ります。
  - **WebLLM model cache ≠ 01AS user data**（モデルを削除しても設定・TRAINING 履歴・SIMULATION 設定・Benchmark の結果・人手評価は消えない）
  - **WebLLM の全キャッシュを一括削除する処理を 01AS 側に実装しない**。「モデルを削除」は選んだ候補のモデルだけを、
    いま選んでいる保存方式の appConfig で `deleteModelAllInfoInCache(modelId, appConfig)` で消す。`caches.delete()`・
    `indexedDB.deleteDatabase()`・OPFS の削除などの一括削除は `src/ai/architecture.test.ts` が禁止する
- 詳細は `docs/AI_ARCHITECTURE.md` 11.4 節。

---

## 3. 候補モデルと Runtime の判定

### 3.1 判定の区分

| 区分 | 意味 | Lab での扱い |
| --- | --- | --- |
| **WebLLM** | WebLLM の prebuilt（`prebuiltAppConfig.model_list`）に含まれる | `RUNNABLE`（Download・Benchmark できる） |
| **Transformers.js** | ONNX 版を Transformers.js で動かす必要がある | `EXPERIMENTAL`（Runtime は未追加。記録だけ） |
| **Other browser runtime** | LiteRT-LM / MediaPipe LLM Inference など別の Runtime が必要 | `EXPERIMENTAL` |
| **Not currently practical** | いまはブラウザで現実的に動かせない | `NOT_CURRENTLY_PRACTICAL` |

### 3.2 候補一覧（記録用の表）

値の出典: VRAM・低リソース向け・context window は **WebLLM 0.2.85 の `prebuiltAppConfig`**（package.json で固定。
`src/ai/benchmark/benchmark.test.ts` が一致を検査）。ライセンス・日本語対応は各モデルカード（8 節）。
**ダウンロードサイズは未計測**です（この作業環境からは配布元へ接続できず確認できませんでした）。Lab で取得した後、
保存方式ごとに計測・表示します（OPFS は WebLLM の記録の `nbytes` の合計、Cache API は `content-length` の合計、
IndexedDB は unknown。正確に数えられなければ unknown。`docs/AI_MODEL_STORAGE.md` 4 節）。

| candidate | runtime | license | parameter size | quantization | browser support | Japanese support | model download size | VRAM estimate | benchmark result | adoption status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline（template） | deterministic | このリポジトリ | — | — | すべて（モデルなし） | — | 0 | 0 | 100 / 100 合格・contradiction 0・unsupported 0（jsdom・Chromium で確認） | 比較の基準線 |
| Qwen3 0.6B | WebLLM `Qwen3-0.6B-q4f16_1-MLC` | Apache-2.0 | 0.6B | q4f16_1 | WebGPU 必須 | 公称 119 言語・方言（日本語を含む） | 未計測 | 1,403.34 MB（low_resource: true） | 未計測 | NOT_EVALUATED（想定 class: ULTRA_LIGHT・仮説） |
| Qwen3 1.7B | WebLLM `Qwen3-1.7B-q4f16_1-MLC` | Apache-2.0 | 1.7B | q4f16_1 | WebGPU 必須 | 同上 | 未計測 | 2,036.66 MB（low_resource: true） | 未計測 | NOT_EVALUATED（想定: LIGHT・仮説） |
| Qwen3 4B | WebLLM `Qwen3-4B-q4f16_1-MLC` | Apache-2.0 | 4B | q4f16_1 | WebGPU 必須 | 同上 | 未計測 | 3,431.59 MB（low_resource: true） | 未計測 | NOT_EVALUATED（想定: STANDARD・仮説） |
| Qwen3 8B | WebLLM `Qwen3-8B-q4f16_1-MLC` | Apache-2.0 | 8B | q4f16_1 | WebGPU 必須 | 同上 | 未計測 | 5,695.78 MB（low_resource: false） | 未計測 | NOT_EVALUATED（想定: QUALITY・仮説） |
| Llama 3.2 1B Instruct | WebLLM `Llama-3.2-1B-Instruct-q4f16_1-MLC` | Llama 3.2 Community License | 1B | q4f16_1 | WebGPU 必須 | 公式対応 8 言語に日本語は**含まれない** | 未計測 | 879.04 MB（low_resource: true） | 未計測 | NOT_EVALUATED（EXPERIMENTAL） |
| Phi-4-mini-instruct | WebLLM `Phi-4-mini-instruct-q4f16_1-MLC` | MIT | 3.8B | q4f16_1 | WebGPU 必須 | 対応言語に日本語を含む | 未計測 | 3,437.58 MB（low_resource: false） | 未計測 | NOT_EVALUATED（EXPERIMENTAL） |
| Qwen3.5 4B | WebLLM `Qwen3.5-4B-q4f16_1-MLC` | Apache-2.0 | 4B | q4f16_1 | WebGPU 必須 | 公称 201 言語・方言 | 未計測 | 3,867.82 MB（low_resource: false） | 未計測 | NOT_EVALUATED（EXPERIMENTAL） |
| Gemma 3n E2B IT | Transformers.js（ONNX）または Other（LiteRT-LM / MediaPipe） | Gemma Terms of Use | 実効 2B | 不明 | 未検証 | 公称 140 以上の言語で学習。日本語個別の記載は未確認 | 未計測 | 不明 | 未計測 | NOT_EVALUATED（EXPERIMENTAL・Runtime 未追加） |
| Gemma 3n E4B IT | 同上 | Gemma Terms of Use | 実効 4B | 不明 | 未検証 | 同上 | 未計測 | 不明 | 未計測 | NOT_EVALUATED（EXPERIMENTAL・Runtime 未追加） |

注記:

- **VRAM estimate** は WebLLM の設定値 `vram_required_MB` で、実機のピーク使用量ではありません（実測は別途）。
  `low_resource` は WebLLM の `low_resource_required`（低リソース端末向けの目安）です。
- Qwen3 の q4f16_1 は WebLLM 0.2.85 の設定上 `required_features`（`shader-f16` など）が空です。
  ほかのモデル（例: Gemma 2 系の q4f16_1）では `shader-f16` が必須で、その場合 Lab は adapter の features を見て
  `UNSUPPORTED` にします。
- Qwen3.5 4B は当初「追加 Runtime が必要かもしれない候補」でしたが、固定した WebLLM 0.2.85 の prebuilt に含まれるため
  `RUNNABLE` にしています（`max_history_size: 1` の設定付き）。WebLLM の `enable_thinking` は Qwen3 向けと
  記載されており、Qwen3.5 での効き方は**未検証**です。
- Gemma 3n は WebLLM 0.2.85 の prebuilt にありません（同梱は `gemma3-1b-it` など）。Transformers.js か
  LiteRT-LM / MediaPipe の追加が必要で、**このPRでは Runtime を追加していません**（人間の承認が必要）。
  Google は MediaPipe LLM Inference API（Web）を maintenance-only とし、LiteRT-LM への移行を案内しています。

### 3.3 Qwen3 の thinking

01AS では **thinking を原則 OFF** にします（`extra_body.enable_thinking: false`）。

- 目的は Evidence の説明で、長い推論は不要
- latency を抑える
- unsupported claim が生まれる機会を増やさない

比較のため Lab で ON も計測できます。thinking ON の応答は `<think>…</think>` を除いた本文だけを検証し、
TTFT は「最初のトークン（thinking を含む）」と「本文の最初の文字」を別々に記録します。
OFF なのに推論の本文が出た場合・think タグが閉じていない場合は `thinkingLeak` として数えます。

---

## 4. Runtime: WebLLM と Transformers.js

**WebLLM を primary runtime 候補として検証しますが、採用ありきにはしません。**
このPRで追加した推論ライブラリは WebLLM（`@mlc-ai/web-llm` 0.2.85・版固定）だけです。

| 観点 | WebLLM（0.2.85・このPRで組み込み） | Transformers.js（未追加） |
| --- | --- | --- |
| 推論バックエンド | WebGPU（MLC でコンパイルした model library の wasm） | ONNX Runtime Web（WebGPU / WASM） |
| WebGPU が無い端末 | 動かない（fallback なし） | WASM（CPU）で動かせる可能性（速度は未検証） |
| 候補の Qwen3 0.6 / 1.7 / 4 / 8B | prebuilt に**ある**（q4f16_1 / q4f32_1 など） | ONNX 版の有無・品質は未検証 |
| Gemma 3n | prebuilt に**無い** | ONNX 版があれば候補（未検証） |
| API | OpenAI 互換の chat.completions（stream・usage） | pipeline / generate（TextStreamer） |
| 計測値 | usage に prompt / completion tokens・decode tok/s・TTFT が入る | 自前で計測する必要がある |
| VRAM の目安 | `vram_required_MB`・`low_resource_required` を持つ | 設定に無い（自前で計測） |
| 進捗 | `initProgressCallback`（取得・読み込み） | progress_callback |
| キャッシュ | Cache API（WebLLM の既定）/ IndexedDB / OPFS。**Lab は OPFS を既定**にする。名前は `webllm/model`・`webllm/config`・`webllm/wasm`（OPFS は `tvmjs-opfs-store/webllm/*`）で**固定** | Cache API（既定の名前はライブラリ側で固定。未検証） |
| キャッシュ削除 | `deleteModelAllInfoInCache(modelId, appConfig)`（保存方式ごと） | Cache API を直接操作 |
| thinking の切り替え | `extra_body.enable_thinking`（Qwen3 向け） | chat template の引数（未検証） |
| モデル切り替え | `engine.reload(modelId)` | pipeline の作り直し |
| bundle | 動的 import の chunk 6.05 MB（gzip 2.15 MB。このリポジトリのビルドで計測） | 未計測 |
| ライセンス | Apache-2.0 | Apache-2.0 |

判断:

- Qwen3 の 4 サイズがそろって prebuilt で動き、計測に必要な値（usage・VRAM の目安・進捗）を API が返す
  WebLLM を**最初に**検証する。
- WebGPU を公開していないブラウザ・adapter を取得できない端末では WebLLM は動かない。その場合も 01AS 本体は
  決定論的な説明で動く（`docs/AI_BOUNDARIES.md`）。WASM で動く Transformers.js の必要性は、
  WebLLM の実測でモバイルの互換性がどの程度か分かってから判断する。
- Transformers.js・LiteRT-LM などの追加は、この文書に評価を書き、人間の承認を得てから別 PR で行う。

---

## 5. Benchmark Dataset: 01AS Core v1

| 項目 | 値 |
| --- | --- |
| ID / 版 | `01as-core` / 1（`CORE_DATASET_VERSION`） |
| 件数 | **100** |
| 指紋 | `d8bcc5db4101150e`（Evidence 全体。`src/lab/benchmarkDataset.test.ts` で固定） |
| 作り方 | 既存 engine を呼ぶだけ（`suggestFor`・SIMULATION の自動プレイ・`buildGameReview`）。人手で答えを書かない |

### 5.1 カテゴリ（主分類）

| カテゴリ | 件数 | 内容 |
| --- | --- | --- |
| CHECKOUT | 32 | 2〜170 で残り本数で上がれる場面（1〜3 本・低い残り・BULL・複数ルート） |
| SETUP | 22 | 171〜350（高い残り・TON の罠・テンパイを作れない場面・S-BULL） |
| NEXT_VISIT | 14 | 2〜170 だが残り本数では上がれない場面（Bogey 7 件を含む） |
| RECOVERY | 20 | engine の第 1 候補の 1 投目がシングル・隣・盤外へ外れたあとの場面（外れ方は `previousThrow` で渡す） |
| SIMULATION_REVIEW | 12 | 固定 seed の自動プレイ（301 / 170 / 501、PPR 45〜100）の GAME REVIEW |

### 5.2 観点タグ（Evidence から機械的に導出。1 ケースに複数）

| タグ | 件数 | 導出条件 |
| --- | --- | --- |
| single-miss-safety | 69 | 候補の reasons に `SINGLE_MISS_*` / `SETUP_SINGLE_MISS_*` |
| multiple-valid-routes | 61 | 候補が 2 件以上 |
| good-better-distinction | 55 | 候補の推奨度が 2 種類以上 / GAME REVIEW で GOOD と BETTER の両方がある |
| neighbor-safety | 31 | `NEIGHBOR_SAFE` / `NEIGHBOR_RISK` |
| miss-recovery | 20 | `previousThrow` がある |
| two-dart-checkout | 15 | CHECKOUT の第 1 候補が 2 本 |
| three-dart-checkout | 15 | CHECKOUT の第 1 候補が 3 本 |
| high-score-setup | 14 | SETUP で残り 250 以上 |
| low-score-checkout | 13 | CHECKOUT で残り 60 以下 |
| bogey-avoidance | 11 | Bogey の残り・TON の罠・`LEAVES_BOGEY` 等 |
| one-dart-checkout | 10 | CHECKOUT の第 1 候補が 1 本 |
| bull-finish | 9 | 第 1 候補が BULL で終わる |
| ton-trap | 4 | `tonTrapLeave` がある |

- 同じ Evidence からは同じ prompt（同じ `promptHash`）になります（決定論的な fixture）。
- GAME REVIEW の Evidence は prompt を 4K context に収めるため、投を先頭 12 件までにしています（`omittedThrowCount` に残りの件数）。
- 場面の選び方・Evidence の形を変えたら版を上げます。**版・指紋が違う結果どうしは比べません。**

---

## 6. Prompt（`01as-explain-ja@1`）

system（要旨。全文は `src/ai/benchmark/prompt.ts`）:

```text
あなたはスティールダーツの 01 アレンジ学習支援 AI です。

以下は 01 Arrangement Support の決定論的 Engine が、すでに計算・検証した事実（Evidence）です。
この Evidence に含まれる情報だけを使用してください。

新しいルート、新しい評価、新しい得点、新しい戦術判断を追加してはいけません。
（順位・推奨度・残り・理由を変えない / 的の表記と数値は Evidence のまま / 無いことは推測しない）

ユーザーが「なぜこの判断なのか」を理解できるよう、自然な日本語で簡潔に説明してください。
（200 文字程度・2〜4 文 / 見出し・箇条書き・Markdown・英文を使わない）
```

user: 場面ごとの指示（CHECKOUT / SETUP / NEXT VISIT / RECOVERY / GAME REVIEW）＋ `<evidence>`（キー順を固定した JSON）。

生成の既定値: thinking OFF・temperature 0・seed 1・max_tokens 384・1 件のタイムアウト 60 秒。
各ケースの前に会話を reset します（前のケースを持ち越さない）。

---

## 7. 指標

### 7.1 01AS の重要指標（一般的な LLM benchmark より優先）

| 優先 | 指標 | 定義 | 実装 |
| --- | --- | --- | --- |
| 1 | **Engine contradiction rate** | engine の判断と矛盾する応答 / 応答が返ったケース | `findContradictions`: 第 1 候補の取り違え・推奨度の取り違え・基準ルートの取り違え・CHECKOUT なのに「上がれない」・上がれない場面で「このラウンドで上がれる」・Bogey の否定／捏造・本数の取り違え・GAME REVIEW の結果と BUST 回数の取り違え |
| 2 | **Unsupported claim rate** | Evidence に無い的・推奨度・数値・reason code を 1 つ以上含む応答 / 応答が返ったケース | 実行時と同じ `findUnsupportedClaims`（RECOVERY の `previousThrow` も根拠に含める） |
| 3 | **Validation failure rate** | 不合格（形・根拠・矛盾のどれか、エラー・タイムアウトを含む）/ 全ケース | `validationPassed` |
| 4 | **Japanese explanation quality** | 人手評価 5 項目（7.3）＋ 自動の目安（長すぎ・短すぎ・日本語の割合・Markdown・英文・thinking の漏れ・第 1 候補への言及） | `styleFlagsOf`・export |
| 5 | **Latency** | TTFT・本文の TTFT・生成時間・tok/s | 7.2 |

- 自動の矛盾検出は**既知のパターンだけを拾う保守的なもの**で、見逃しはあり得ます。人手確認を省略しません。
- 誤検出が無いことは、決定論的な baseline（アプリの fallback と同じ文面）が全 100 ケースで合格することで確認しています。

### 7.2 計測値

| 項目 | 定義 |
| --- | --- |
| `unsupportedClaims` | 応答ごとの根拠の無い主張の一覧（件数は合計と応答数の両方を集計） |
| `validationPassed` | 形・根拠・矛盾をすべて通ったか |
| `timeToFirstToken` | 要求から最初のトークン（thinking を含む）まで（クライアント計測） |
| `timeToFirstVisibleToken` | 要求から本文（think の外）の最初の文字まで |
| `generationTime` | 要求から最後のトークンまで |
| `tokensPerSecond` | WebLLM の `decode_tokens_per_s`。無ければ (出力トークン − 1) / (生成時間 − TTFT) |
| `outputTokens` / `promptTokens` | Runtime の usage |
| `outputLength` | 本文の文字数 |
| `modelLoadTime` | 読み込みにかかった時間と種類（`download` / `cache-cold` / `cache-warm` / `already-loaded`） |
| `modelSizeBytes` | 取得後に、選んでいる保存方式から計測（`docs/AI_MODEL_STORAGE.md` 4 節）。正確に数えられなければ null（unknown） |
| `estimatedVRAM` | Runtime の設定値（WebLLM の `vram_required_MB`） |

読み込みの種類:

- `download`: 読み込み前にキャッシュが無かった（取得を含む）
- `cache-cold`: キャッシュはあり、このページで初めての読み込み
- `cache-warm`: 同じページで一度読み込んだことがある

分布は平均・p50・p95（最近傍順位法）で出します。

### 7.3 人手評価（Human Evaluation）

各応答について 1〜5 で評価します（Lab の画面、または CSV に記入）。

| 列 | 観点 |
| --- | --- |
| `rating_japanese_naturalness` | Japanese naturalness（日本語の自然さ） |
| `rating_clarity` | Clarity（分かりやすさ） |
| `rating_conciseness` | Conciseness（簡潔さ） |
| `rating_educational_value` | Educational value（学習上の価値） |
| `rating_darts_player_naturalness` | Darts-player naturalness（ダーツプレイヤーとしての自然さ） |
| `rater_note` | 自由記述 |

- **CSV（blind）** はモデル・Runtime・run の列を出さず、応答 ID 順に並べます（評価者に Provider を伏せる）。
  対応表は JSON export にあります。
- CSV は UTF-8（BOM 付き）。式として解釈される先頭文字（`= + - @`）は無害化します。
- JSON export にはデータセット（Evidence・promptHash）・run・集計・評価を入れます。

---

## 8. 出典

この作業環境からは Hugging Face へ直接接続できなかったため、モデル固有の数値は npm から取得した
WebLLM 0.2.85 の `prebuiltAppConfig` をローカルで読み、ライセンス・言語対応は下記のモデルカード等の記載によります。

- WebLLM: https://github.com/mlc-ai/web-llm ・ https://www.npmjs.com/package/@mlc-ai/web-llm
- Qwen3（Apache-2.0・119 言語）: https://qwenlm.github.io/blog/qwen3/
- Qwen3.5 4B（Apache-2.0・201 言語）: https://huggingface.co/Qwen/Qwen3.5-4B
- Llama 3.2 1B Instruct（Llama 3.2 Community License・公式 8 言語）: https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct
- Phi-4-mini-instruct（MIT・日本語を含む）: https://huggingface.co/microsoft/Phi-4-mini-instruct
- Gemma 3n: https://ai.google.dev/gemma/docs/gemma-3n
- MediaPipe LLM Inference（Web）: https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js
- Transformers.js: https://huggingface.co/docs/transformers.js

---

## 9. 次に実測する順番（提案）

1. **Baseline（template）**: 実機ブラウザでも 100 / 100 合格を確認（自動検証の誤検出が無いことの再確認）
2. **Qwen3 1.7B・thinking OFF**（Desktop・WebGPU）: クイック 10 件で流れを確認 → 100 件
3. **Qwen3 0.6B・thinking OFF**: ULTRA_LIGHT の仮説。Desktop と Android Chrome（WebGPU）の両方
4. **Qwen3 4B・thinking OFF**: STANDARD の仮説
5. **Qwen3 1.7B・thinking ON**: OFF との比較（latency・unsupported claim・thinking の漏れ）
6. **Phi-4-mini-instruct / Qwen3.5 4B**: Qwen3 4B と同じ規模帯での比較
7. **Llama 3.2 1B**: 公式に日本語非対応。0.6B / 1.7B と日本語品質を比べる
8. **Qwen3 8B**: QUALITY の仮説。高性能 PC だけ
9. **Gemma 3n E2B / E4B**: 追加 Runtime の承認後

各 run の export（JSON）と人手評価を保存し、3.2 の表の「benchmark result」を更新します。
採用・class の確定は、この表を見て人間が判断し `docs/APPROVALS.md` へ記録します。
