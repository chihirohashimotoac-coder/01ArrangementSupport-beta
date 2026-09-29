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
| `src/ai/benchmark/checks.ts` | 自動検証（contradiction・unsupported claim・thinking・体裁・反復・出力の上限・内部 code の漏れ。validator v2） |
| `src/ai/benchmark/runner.ts` | 実行（タイムアウト・中断・1 件の失敗で止めない・checkpoint 用の hook） |
| `src/ai/benchmark/metrics.ts` | 集計（01AS の優先順・Clean response） |
| `src/ai/benchmark/profiles.ts` | Benchmark Profile（STANDARD / MOBILE_FEASIBILITY）・段階制の判定（10 節） |
| `src/ai/benchmark/reevaluate.ts` | 保存済み run を、モデルを再実行せずに現在の検証で評価し直す（12 節） |
| `src/lab/benchmarkCheckpoint.ts` | crash checkpoint と段階の記録（11 節） |
| `src/lab/labTestRuntime.ts` | E2E 用の Test Runtime（`?ai-lab-test-runtime=mock`。実モデルなし・precache しない） |
| `scripts/reevaluate-benchmark.ts` | export JSON を現在の検証で再評価する開発者向けスクリプト（`npm run reevaluate:benchmark`） |
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
- MOBILE_FEASIBILITY の段階・crash checkpoint の復元は `e2e/gate-open/mobileFeasibility.gate-open.spec.ts` で、URL に
  `?ai-lab-test-runtime=mock`（`mock-hang`）を付けたときだけ Lab が読む E2E 用の Test Runtime（Mock。`src/lab/labTestRuntime.ts`）で確かめます。
  Test Runtime の chunk（`labTestRuntime-*.js`）は precache しません（`vite.config.ts`・`npm run check:base`）。

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
| Qwen3 0.6B | WebLLM `Qwen3-0.6B-q4f16_1-MLC` | Apache-2.0 | 0.6B | q4f16_1 | WebGPU 必須 | 公称 119 言語・方言（日本語を含む） | 未計測 | 1,403.34 MB（low_resource: true） | iPhone 100 件完走（STANDARD・validator v1: contradiction 0 / 100・unsupported 7・pass 93 / 100。反復・上限到達・内部 code の漏れあり。13 節） | NOT_EVALUATED（本命候補にしない判断。fallback 候補の可能性は残す。13.2 節） |
| Qwen3 1.7B | WebLLM `Qwen3-1.7B-q4f16_1-MLC` | Apache-2.0 | 1.7B | q4f16_1 | WebGPU 必須 | 同上 | 未計測 | 2,036.66 MB（low_resource: true） | iPhone: download 成功・Run Benchmark でページ終了（13 節）。品質は未計測 | NOT_EVALUATED（Mobile primary candidate として MOBILE_FEASIBILITY で評価する方針・仮説） |
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

生成の既定値（STANDARD）: thinking OFF・temperature 0・seed 1・max_tokens 384・1 件のタイムアウト 60 秒。
各ケースの前に会話を reset します（前のケースを持ち越さない）。
MOBILE_FEASIBILITY では max_tokens 192・context window 2048 です（10 節）。**prompt の本文（`01as-explain-ja@1`）は PR #5 でも変えていません**
（モデルの差と prompt の改善を混ぜずに確かめるため）。

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
- 誤検出が無いことは、決定論的な baseline（アプリの fallback と同じ文面）が全 100 ケースで合格することで確認しています
  （validator v2 の反復・内部 code の検出を含む）。

### 7.1a validator v2（PR #5）: 反復・出力の上限・内部 code の漏れ

Qwen3 0.6B の iPhone 実機 100 件（13 節）で、v1 が合格にしていた失敗（反復の暴走・max_tokens への張り付き・内部 code の漏れ）を
拾うため、次を追加しました。どれも **validation の不合格**（`failureCodes`）です。run に `validatorVersion: 2` を記録します。

| 区分 | 判定（`checks.ts`。しきい値は定数で固定し、`checks.test.ts` で検査） | 誤検出しないもの |
| --- | --- | --- |
| `REPETITION` | ① 的の列で、周期 1〜4 本の並びが **3 回以上**続き、繰り返しが **8 本以上**（`dartPeriodMax 4`・`dartMinRepeats 3`・`dartMinSpan 8`）② 1 つの列に的が **16 本以上**（Evidence の投は最大 12 件）③ 空白を除いて **8〜80 文字**の同じ文字列が **3 回以上連続** ④ 空白を除いて 8 文字以上の同じ文が **3 回以上** | `T20 → T20 → D20`・「T20 を 2 本」・同じ的に何度か触れる・同じ文の言い直し 2 回・6 本の交互の列（`S20、S18` × 3） |
| `OUTPUT_LIMIT_REACHED` | Runtime の `finish_reason: "length"`（**優先**。WebLLM 0.2.85 は max_tokens・context window のどちらで止まっても `length`）。finish_reason が分からない記録（PR #5 以前）だけ、出力トークン数 ≥ max_tokens − 8（`OUTPUT_LIMIT_TOKEN_MARGIN`）で安全側に判断 | Runtime が `stop` を返した応答（上限の近くでも） |
| `INTERNAL_CODE_LEAK` | 検証用の正規化（NFKC・大文字化）のあと、`/(?<![A-Z0-9_])[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+(?![A-Z0-9_])/`（`_` を 1 つ以上含む大文字の語。例: `STANDARD_ROUTE`・`GOOD_DECISION`・`LEAVES_CHECKOUTABLE`）。allowlist は**該当なし**（01AS の画面の用語に `_` を含む語は無い） | `T20`・`D16`・`S5`・`BULL`・`S-BULL`・`SB`・`PPR`・`BUST`・`NEXT VISIT`・`GOOD`・`BETTER` |

集計（RESULTS・export の summary）は次を**個別に**出します。

| 指標 | 定義 |
| --- | --- |
| Engine contradiction | 矛盾を含む応答 / 応答が返ったケース |
| Unsupported claim | 根拠の無い主張を含む応答数・件数 |
| Validation failure | 不合格（どの区分でも。エラー・タイムアウトを含む）/ 全ケース |
| Repetition / Output limit reached / Internal code leak | それぞれを含む応答数 / 全ケース |
| **Clean response** | 応答が返り、contradiction なし・unsupported claim なし・validation pass・反復なし・上限に達していない・内部 code なし / 全ケース |

v1 の記録（反復などを調べていない）では、新しい指標を「未計測」と表示します（0 とは表示しない）。12 節の再評価で埋まります。

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

---

## 10. Benchmark Profile と MOBILE_FEASIBILITY（PR #5）

**目的は 1.7B を無理に採用することではなく、iPhone 上で実用可能かを正しく判定できる状態を作ること**です。
Lab 限定の実行条件で、Production・利用者向けの 01AS・本番の Runtime には影響しません。

### 10.1 Profile

| Profile | 版 | context window | max_tokens | 実行 | 位置づけ |
| --- | --- | --- | --- | --- | --- |
| `STANDARD` | 1 | Runtime の既定（WebLLM の prebuilt。Qwen3 は 4096）。**何も上書きしない** | 384 | Run Benchmark（すべて / クイック） | 品質の benchmark（PR #2〜#4 と同じ条件） |
| `MOBILE_FEASIBILITY` | 1 | **2048**（`context_window_size` を上書き） | **192** | 段階制（LOAD ONLY → 1 CASE → QUICK 10 → FULL 100） | スマートフォンで安定して読み込み・生成できるかの確認。**品質の benchmark ではない** |

- run に `profile`（`id`・`version`・`contextWindowSize`・`stage`）を必ず保存します。PR #5 以前の run は STANDARD と同じ条件で実行したので、
  STANDARD v1（`recorded: false`「profile の記録なし」）として扱います。
- **profile が違う run どうしを同じ benchmark として比べません。** RESULTS の run 一覧に `[profile]` を出し、STANDARD 以外の run には
  「STANDARD の結果と直接比べない」と表示します。JSON / CSV の export は profile が違う run を混ぜると拒否します（`BenchmarkProfileMixError`）。
- context window を小さくする profile は、候補の tokenizer で数えた prompt の最大 token 数 ＋ max_tokens ＋ 余裕 64 が収まる候補にだけ使えます
  （`profileFitsCandidate`。未計測の候補・計測時とデータセット／prompt の版が違う候補には使わない）。

### 10.2 値の根拠: prompt token 数（計測値）

2026-09-29 に開発環境で、01AS Core v1（指紋 `d8bcc5db4101150e`）・prompt `01as-explain-ja@1` の 100 件を Qwen3 の tokenizer で数えました。

| 項目 | 値 |
| --- | --- |
| tokenizer | Qwen3 の tokenizer.json（npm `@lenml/tokenizer-qwen3` 3.7.2 に同梱。語彙 151,669）。**作業環境の scratchpad だけで使い、リポジトリの依存には追加していません** |
| 数え方 | Qwen3 の chat template（`<\|im_start\|>system …<\|im_end\|>`・user・assistant の開始・thinking OFF の空の `<think>\n\n</think>\n\n`）を含む |
| 平均 / p50 / p95 / 最大 | **1094.2** / 1120 / 1507 / **1659**（`SU-301-3`） |
| カテゴリ別の最大 | CHECKOUT 1241・SETUP 1659・NEXT_VISIT 1166・RECOVERY 1530・SIMULATION_REVIEW 1520 |
| 照合 | iPhone 実機（WebLLM・Qwen3 0.6B）の usage.prompt_tokens の平均 **約 1094** と一致 |
| 出力の目安 | 決定論的な baseline の説明文は Qwen3 の tokenizer で平均 121.2・p95 171・最大 179 tokens |

- **context window 2048**: 1659 ＋ 192 ＋ 64 = 1915 ≤ 2048。1536 では最大の prompt（1659）が入らない（context 不足で失敗する設定は使わない）。
- **max_tokens 192**: 依頼の目安 128〜192 の上限。baseline の最大 179 tokens が収まる長さ。128 では baseline 並みの長さの説明の約半分が
  打ち切られる（打ち切られた応答は `OUTPUT_LIMIT_REACHED` として不合格にする）。
- 同じ値を `candidates.ts` の `promptTokenMeasurement`（Qwen3 0.6B / 1.7B / 4B / 8B。同じ tokenizer）に記録し、テストがデータセットの指紋・prompt の版と照合します。

### 10.3 WebLLM 0.2.85 で確認したメモリ関連の設定（実コード）

`node_modules/@mlc-ai/web-llm/lib/index.js`・`config.d.ts`・`engine.d.ts`（0.2.85）を読んで確認しました。**存在するものだけを使っています。**

| 設定 | 実コードでの扱い | 上書き | 使ったか |
| --- | --- | --- | --- |
| `context_window_size`（`ChatConfig`） | `LLMChatPipeline` が KV cache を `create_tir_paged_kv_cache(max_num_sequence=1, max_total_sequence_length=context_window_size, prefill_chunk_size, page_size=16, …)` で**読み込み時に確保**する。decode 中に context に達すると `finish_reason: "length"` で止め、prompt が入らなければ `ContextWindowSizeExceededError` | `ModelRecord.overrides` または `engine.reload(modelId, chatOpts)`（`reloadInternal` が `Object.assign({}, mlc-chat-config, modelRecord.overrides, chatOpts)`） | **使った**（MOBILE_FEASIBILITY で 2048。`reload` の chatOpts で渡す。appConfig は変えない） |
| `sliding_window_size` / `attention_sink_size` | context window と同時に正にできない（`WindowSizeConfigurationError`）。sliding window にすると KV cache は sliding window 分 | 同上 | 使わない（prompt が context に収まるので不要。注意の範囲が変わり説明の条件が変わる） |
| `prefill_chunk_size` | `metadata.prefill_chunk_size`（モデルの wasm に埋め込まれた値。Qwen3 の wasm 名は `…_cs1k-webgpu.wasm`）を読む。`ChatConfig` の値は使われない | **できない** | 使えない |
| `max_history_size` | RNN state のモデルだけ | 同上 | 対象外（Qwen3 は KV cache） |
| `max_num_sequence`・`page_size` | 1・16 で固定（コード内の定数） | できない | 使えない |
| `max_tokens`（`GenerationConfig`） | 生成の上限。KV cache の確保量は変えない（生成時間・出力量だけ） | 要求ごと | 使った（192） |
| `vram_required_MB`・`low_resource_required`・`buffer_size_required_bytes` | 表示・判定用の記録。確保量は変えない | — | 変更しない |
| WebGPU device の要求 | `detectGPUDevice` が `maxBufferSize`（1 GiB → 256 MiB）・`maxStorageBufferBindingSize`（1 GiB → 128 MiB）を要求。`reload` ごとに device を作り、`unload` → `pipeline.dispose()`（`tvm.dispose()` を含む）で解放 | できない | 変更しない |

KV cache の見積もり（**推定**）: Qwen3 1.7B の公開 config（`num_hidden_layers` 28・`num_key_value_heads` 8・`head_dim` 128。この作業環境からは
Hugging Face へ接続できず**再確認はできていません**）と f16 から、1 token あたり 2 × 28 × 8 × 128 × 2 B = 112 KiB。
context 4096 で約 448 MiB、2048 で約 224 MiB（差 約 224 MiB。`vram_required_MB` 2036.66 の約 11%）。重み・prefill の作業領域（`prefill_chunk_size` で固定）は
この設定では減りません。**この削減で iPhone（WebKit）の上限に収まるかは不明**で、実機の段階制で確かめます（14 節）。
iPhone の WebKit がタブを終了するメモリの上限値は、公開された確かな値を確認できていないため**不明**とします。

### 10.4 段階制（MOBILE_FEASIBILITY）

| 段階 | 内容 | ケース |
| --- | --- | --- |
| LOAD ONLY | 読み込んで**すぐ解放**し、成否と読み込み時間だけを記録 | なし |
| 1 CASE | 読み込み → 1 件生成 → 解放 | クイックの 1 件目（`CO-2-1`） |
| QUICK 10 CASES | 同上 | 各カテゴリ 2 件（計 10 件: `CO-2-1`・`CO-8-3`・`SU-171-3`・`SU-178-3`・`NV-3-1`・`NV-99-1`・`RC-170-3-single`・`RC-167-3-single`・`SR-170-ppr60-s1`・`SR-170-ppr90-s2`） |
| FULL 100 | 同上 | 100 件 |

- 各段階は「解放 → **保存済みのモデルを読み込む（取得しない）** → 生成 → 解放」で、前の段階のメモリを持ち越しません。
- 次のどれかがあると、次の段階を**推奨しない**（ボタンに「非推奨」と理由を出し、押すと確認画面を挟む。実行はできる）:
  前の段階が未実施・失敗（読み込みの失敗・1 件のエラー / タイムアウト）・中止・正常終了しなかった／checkpoint が残っている／device lost・GPU error を記録した。
  品質の不合格（validation fail）は段階の失敗にしません（安定性の確認なので）。
- 段階の記録は「候補 × profile（id@version）× 保存方式」ごとに `01as-beta:ai.benchmark.feasibility.v1`（直近 60 件）へ残します。

### 10.5 Runtime / WebGPU の資源の扱い

- MLCEngine は Runtime につき 1 つだけ作る（`engine ??=`）。WebLLM の `reload` は前のモデルを解放してから読み込む
- 読み込みを同時に 2 つ走らせない（`runtime-unavailable`）
- 解放（unload）の途中で次の読み込みを頼まれたら、解放が終わってから `reload` する。profile・候補の切り替えでは、解放が終わるまで Lab を busy にする（段階を始めさせない）
- 読み込み済みのモデルと context window が違えば読み込み直し、同じなら `already-loaded`
- 候補の切り替え・profile の切り替え・保存方式の切り替え・Lab を離れる（unmount）・`pagehide` で解放する。MOBILE_FEASIBILITY の段階は終わったら解放する
- 検査: `src/ai/benchmark/profiles.test.ts`（偽の WebLLM モジュールで MLCEngine の生成数・chatOpts・appConfig の同一性・同時読み込み）、
  `src/lab/AiModelLabFeasibility.test.tsx`（解放のタイミング）。実機の WebGPU の資源の解放そのものは CI では確かめられません（WebGPU の adapter が無いため）

### 10.6 保存済みのモデルを再ダウンロードしない

- profile の違いは `reload` の chatOpts（実行時の設定）だけで、appConfig（保存方式・モデルの URL）は変えません。保存済みのモデルをそのまま読み込みます
  （テストで、context window を変えても `download` が起きず、存在確認と MLCEngine に渡す appConfig が同じオブジェクトであることを確かめています）
- 段階は `allowDownload: false` で読み込みます（保存されていなければ「先に Download」と表示し、取得しない）
- **partial（一部だけ保存）**: WebLLM の存在確認はすべてのファイルがそろわないと「無い」と答えるため、`countModelEntries`（読むだけ）で
  そのモデルの記録が残っているかを数え、`OPFS`・`Cache API` では「一部だけ保存（partial）」と表示します（IndexedDB は数えられないので不明）。
  partial のときも「モデルを削除」を出し、**対象モデル単位**の `deleteModelAllInfoInCache` だけで消します（`webllm/*` の一括削除はしない）。
  「Download（残りを取得）」では、WebLLM が保存済みのファイルを取り直さずに残りだけを取得します

---

## 11. crash checkpoint（PR #5）

iPhone ではメモリが足りないとタブごと終了し、try / catch で失敗を記録できません。実行中の段階を**とても小さく** localStorage
（`01as-beta:ai.benchmark.checkpoint.v1`。`storage/localJson.ts` 経由）へ書きます。

```json
{
  "schema": "01as-ai-benchmark-checkpoint",
  "version": 1,
  "runId": "webllm-qwen3-1.7b|webllm|thinking-off|MOBILE_FEASIBILITY@1|…",
  "candidateId": "webllm-qwen3-1.7b",
  "candidateLabel": "Qwen3 1.7B",
  "runtimeModelId": "Qwen3-1.7B-q4f16_1-MLC",
  "profileId": "MOBILE_FEASIBILITY",
  "profileVersion": 1,
  "contextWindowSize": 2048,
  "stage": "QUICK_10",
  "storageBackend": "opfs",
  "phase": "generating",
  "caseIndex": 3,
  "caseTotal": 10,
  "caseId": "SU-…",
  "startedAt": "…",
  "updatedAt": "…"
}
```

- 書くのは段階の切り替わりだけ: 読み込みの前（`loading`）・読み込みの後（`loaded`）・各ケースの生成の前（`generating`）・生成が返った後（`validating`）・
  解放の前（`unloading`）。トークンごとには書きません（FULL 100 でも 1 run あたり約 200 回・1 回 600 byte 未満）
- 正常終了・利用者の「中止」・捕まえた失敗（読み込みの失敗など）で消します。Download / Load（手動の読み込み）も読み込みの間だけ書きます
- Lab を離れた（画面の切り替え）・ページを閉じた（`pagehide`）ことによる中止では**消しません**（abort の理由 `lab-lifecycle` で区別）。
  その実行は段階の記録にも「中止」として残さず、次に開いたとき「正常終了しなかった」として記録します
- 次に Lab を開いたとき残っていれば、「前回のBenchmarkは正常終了しませんでした。」と Model・Profile・Phase・Case（`4 / 10`）・ID を表示し、
  JSON で保存できます。その段階は「正常終了しなかった（incomplete）」として段階の記録に残り、次の段階を推奨しません
- これは **「前回の run が正常終了しなかった証拠」** で、ブラウザ・タブの crash の証拠ではありません（再読み込み・タブを閉じた場合も残ります）。原因は断定しません
- localStorage への書き込みがタブの終了の前に確定しているかは、ブラウザの実装によります（best-effort）
- back-forward cache から戻った（`pageshow` の `persisted`）ときは、同じ画面のまま再開するので、残した checkpoint を読み直して表示します

---

## 12. 保存済み run の再評価（モデルを再実行しない）

- RESULTS の **「Re-evaluate with current checks」**: 保存済みの run の生の応答（`rawText`）を、その run を作ったデータセット（ID・版・指紋が一致するもの）の
  Evidence で、現在の検証（validator v2）で評価し直します。**元の run は書き換えず**、新しい run（`reevaluation.originalRunId`・`originalValidatorVersion`・
  `validatorVersion: 2`）として保存します。応答 ID は元と同じなので人手評価をそのまま使えます
- finish_reason は PR #5 以前の記録に無いので、出力の上限は出力トークン数 ≥ max_tokens − 8 で安全側に判断します
- export した JSON は `npm run reevaluate:benchmark -- <export.json> [出力.json]` で再評価できます（元のファイルは変更せず、`<入力>.reeval-v2.json` へ書く）
- 再評価できないとき: データセットが一致しない・すでに validator v2・rawText が残っていない（理由を表示します）
- Lab の保存は直近 5 件です。再評価した run を足すときは**元の run を残し**、代わりに元の run 以外でいちばん古い run を外します（念のため先に Export JSON で保存してください）

---

## 13. 実機の記録（iPhone）

依頼者の実機での記録です（この作業環境では実モデルを取得・実行していません）。

### 13.1 端末

| 項目 | 値 |
| --- | --- |
| OS | iOS 26.6 |
| Browser | Chrome for iOS 154（エンジンは WebKit） |
| WebGPU | 利用可（Apple adapter） |

### 13.2 Qwen3 0.6B（STANDARD・validator v1・100 件）

| 指標 | 値 |
| --- | --- |
| 完走 | 100 / 100 |
| Engine contradiction | 0 / 100 |
| Unsupported claims | 7 |
| Validation pass | 93 / 100 |
| prompt tokens（平均） | 約 1094 |
| SIMULATION_REVIEW の出力 | 12 件中 7 件が 379〜384 tokens（max_tokens 384）に到達 |

v1 の自動検証が見逃していた失敗（人手で確認されたもの）: 反復の暴走（`S20、S18、S20、S18…`）・token limit への到達・内部の enum / reason code の漏れ
（`STANDARD_ROUTE`・`GOOD_DECISION`・`LEAVES_CHECKOUTABLE`）・根拠の無い target / 数値・意味が崩れた日本語。
validator v2（7.1a 節）で前 3 つを不合格として数えます。この run の JSON を 12 節の方法で再評価すると、v2 の数値が出ます
（**この作業環境には run の JSON が無いため、v2 での数値は未計測**）。

**判断（依頼者）**: 0.6B は動作確認用・fallback 候補にはなり得るが、利用者向け AI の本命としては品質が不足している。本命候補にはしない。

### 13.3 Qwen3 1.7B

| 段階 | 結果 |
| --- | --- |
| Download（保存） | 成功 |
| Run Benchmark（STANDARD・context 4096・max_tokens 384） | 「このページを開けません」と表示され、タブが終了した |
| 推定 VRAM | 2,036.66（WebLLM の `vram_required_MB`） |

メモリ圧迫による WebKit のタブの終了を疑っていますが、**確定していません**（crash checkpoint が無かったため、どの段階で終わったかも不明）。

**方針**: 1.7B を Mobile primary candidate として MOBILE_FEASIBILITY（10 節）で評価する。**品質は未計測**。
1.7B が合理的な設定でも安定しない場合は、この仮説（0.6B = 軽量 fallback / 1.7B = 通常利用の候補）を撤回できるようにし、次の候補は人間が決める。
モデル選定の結論は実装で固定しません。

### 13.4 今回の提案（実装していない）

- **Prompt v2 は実装していません**（モデルの差と prompt の改善を混ぜないため）。0.6B の品質の問題が prompt・max_tokens・model capacity の
  どれに強く依存するかは、1.7B の MOBILE_FEASIBILITY の結果と、0.6B の再評価（v2）の内訳（反復・上限到達・内部 code がどのカテゴリに集中するか）を見てから判断します。
  参考: SIMULATION_REVIEW は prompt が長く（平均 1448 tokens）、指示が「verdict が GOOD_DECISION 以外の投」と内部の enum 名を含むため、
  内部 code の漏れを誘っている可能性があります（**仮説**。検証していません）

---

## 14. merge 後の iPhone での手順（MOBILE_FEASIBILITY）

**いきなり 100 件を実行しないでください。** 各段階が成功した場合だけ次へ進みます。

1. 公開 Beta を開く（更新の案内が出たら更新する）→ 設定 → DEVELOPER → 「AI MODEL LAB を開く」
2. 「前回のBenchmarkは正常終了しませんでした」が出たら、内容（Model・Phase・Case）を記録し「checkpoint を保存（JSON）」→「確認した」
3. **MODEL** で **Qwen3 1.7B** を選び、保存状況を確認する
   - 「ダウンロード済み（キャッシュあり）」: そのまま 4 へ
   - 「一部だけ保存（partial）」: 「Download（残りを取得）」で残りを取得する（または「モデルを削除」でこのモデルの分だけ消してから Download）
   - 「未ダウンロード」: 保存方式（OPFS / IndexedDB / Cache API）を切り替えて、ほかの方式に保存されていないか確かめる（「保存状況（方式ごと）」）。
     どこにも無ければ Download
4. **BENCHMARK** の Benchmark Profile で **MOBILE_FEASIBILITY** を選ぶ（context window 2048・max_tokens 192 と表示される）
5. **LOAD ONLY** を押す → 「前回: 成功・load …」になったら次へ（失敗したら診断情報を保存して止める）
6. **1 CASE** を押す → 「前回: 成功・1 / 1 件」になったら次へ
7. **QUICK 10 CASES** を押す → 「10 / 10 件」になったら次へ。RESULTS で Export JSON
8. ここまで成功した場合だけ **FULL 100** を押す → Export JSON
9. タブが終了した（「このページを開けません」）場合は、Lab を開き直し、表示される checkpoint（Phase・Case）を記録して JSON で保存する。
   同じ段階を 1 回だけ再試行してもよいが、2 回続けて終了したら**そこで止め**、結果（どの段階・どの Phase で終わったか）を報告する
10. 記録するもの: 各段階の成否・load 時間・Phase・Case・RESULTS の Export JSON・DEVICE の表示（Adapter・maxBufferSize）

判定の目安（人間が判断する）:

- LOAD ONLY で終了する → 重み＋KV cache（2048）の確保だけで上限を超えている可能性。context window の縮小では足りない
- LOAD ONLY は成功し 1 CASE で終了する → 生成時の作業領域（prefill の chunk 1024 分など。WebLLM 0.2.85 では変えられない）を含めて上限を超えている可能性
- QUICK 10 の途中で終了する → 繰り返しの生成での一時的なメモリ・発熱などの可能性（checkpoint の Case で位置を確かめる）
