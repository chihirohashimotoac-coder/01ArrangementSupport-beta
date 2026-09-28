# AI_EVALUATION.md — AI Provider の評価基準（Beta）

将来、AI Provider（Browser Local OSS Model / Remote OSS Model / 商用 API）を比較・採用するための
評価基準です。**特定のモデル名に依存しない**ように、入力（Evidence）と出力（説明文）と
実行環境だけで定義します。

- 構造は `docs/AI_ARCHITECTURE.md`、許される役割は `docs/AI_BOUNDARIES.md`。
- このドキュメントの**合格ラインはすべて提案値**です。採用判断の前に人間の承認を得て確定します。
- 決定論的な `templateProvider` が比較の基準線（baseline）です。
- この基準で候補を比べる仕組み（AI Model Benchmark Lab）は実装済みです（6 節・`docs/AI_MODEL_BENCHMARK.md`）。
  **実モデルの実測結果はまだありません**（採用も未定）。

---

## 1. 評価の前提

### 1.1 何を評価するか

AI は判断をしないので、「正しいルートを選べるか」は評価しません。評価するのは次の 2 つです。

1. **説明が Evidence に忠実か**（根拠の無い事実を足さない・engine と矛盾しない）
2. **その説明を、利用者の端末で実用的に出せるか**（速度・メモリ・ダウンロード量・互換性）

### 1.2 評価データセット

engine から機械的に作ります。人手で答えを書きません（答えは engine が持っている）。

| セット | 作り方 | 件数の目安 |
| --- | --- | --- |
| D-ALL | `buildDecisionEvidence(suggestFor(left, darts))`、left = 2〜350、darts = 1〜3 | 1,047 |
| D-CORE | D-ALL から CHECKOUT / SETUP / NEXT_VISIT / UNAVAILABLE・Bogey・TON の罠を層別抽出 | 100〜200（**実装: 01AS Core v1・100 件**。6 節） |
| D-REF | 添付資料由来の回帰ケース（122 / 302〜309 / 231〜235 / 271〜275） | 既存テストと同じ |
| G-SET | SIMULATION を固定 seed で自動プレイした `buildGameReviewEvidence` | 50 ゲーム程度 |
| T-SET | 合成した学習履歴からの `buildTrainingEvidence`（記録 0 件を含む） | 20 程度 |

Evidence は `serializeEvidence()` で固定した文字列として保存し、モデル間で同じ入力を使います。
モデル比較のたびに engine の出力が変わっていないこと（`scripts/maintenance-snapshot.ts` の hash）も記録します。

### 1.3 実行環境

| 区分 | 例 |
| --- | --- |
| Desktop | Chrome / Edge / Safari / Firefox の最新安定版 |
| Mobile | iOS Safari（PWA インストール時を含む）/ Android Chrome |
| 端末性能 | 高（直近のフラッグシップ）/ 中 / 低（数年前の普及機） |
| 通信 | オンライン / オフライン（初回取得後） |

---

## 2. 評価指標

| # | 指標 | 定義 | 測り方 | 合格ライン（提案） |
| --- | --- | --- | --- | --- |
| 1 | **Groundedness** | 説明文中の事実（的・推奨度・数値・reason code）のうち、Evidence に根拠があるものの割合 | `findUnsupportedClaims()` の自動判定 + D-CORE の人手確認 | ≥ 99% |
| 2 | **Hallucination rate** | Evidence に無い事実を 1 つ以上含む応答の割合 | `unsupported-claim` になった応答数 / 全応答数 | ≤ 1% |
| 3 | **Engine contradiction rate** | engine の判断と矛盾する応答の割合（第 1 候補以外を「最善」と呼ぶ、推奨度の取り違え、Bust / Bogey の否定 等） | D-CORE を人手ラベル付け + 矛盾パターンの自動検出 | 0%（1 件でもあれば不採用） |
| 4 | **Explanation correctness** | reason code の意味どおりに説明しているか（例: `SINGLE_MISS_SAFE` を「外すと上がれない」と逆に言わない） | reason code ごとの人手ルーブリック（正しい / 不完全 / 誤り） | 誤り 0% / 不完全 ≤ 5% |
| 5 | **Japanese naturalness** | 日本語として自然で、アプリの用語（テンパイ・ノーテン・基準ルート 等）を正しく使うか | 5 段階評価（2 名以上）。`templateProvider` を 3 とする | 平均 ≥ 4 |
| 6 | **Latency** | 呼び出しから説明文が返るまでの時間（初回・2 回目以降） | p50 / p95 を端末区分ごとに計測 | 2 回目以降 p95 ≤ 3 秒（タイムアウトは 8 秒） |
| 7 | **Memory usage** | 推論中のピークメモリ（JS heap + GPU バッファ） | DevTools / `performance.measureUserAgentSpecificMemory` 等 | 中性能 Mobile でタブが落ちない |
| 8 | **Initial download size** | 初回に取得するモデル・wasm・重みの合計 | ネットワークログ | 利用者の明示的な同意なしに取得しない。サイズを画面に表示できること |
| 9 | **Offline availability** | 初回取得後、機内モードで説明が出るか | 実機で確認 | 出ない場合も fallback で本体が動くこと |
| 10 | **Browser compatibility** | 対象ブラウザで動く割合と、動かない理由 | 1.3 の表で実機確認 | 非対応ブラウザでは `error` として fallback |
| 11 | **Mobile compatibility** | iOS / Android・PWA インストール時の動作 | 実機確認（バックグラウンド復帰を含む） | 動かない端末で fallback すること |
| 12 | **WebGPU dependency** | WebGPU が無い環境で動くか、代替（WASM / CPU）の速度 | WebGPU 無効化フラグで計測 | WebGPU が無くてもアプリ本体は動く（必須） |
| 13 | **Fallback behavior** | 失敗時に決定論的な説明へ正しく切り替わるか | 故障注入（throw / タイムアウト / 不正応答 / 未対応 / 根拠の無い主張） | 100%（`src/ai/explain.test.ts` と同じ観点を実 Provider で） |

### 補足

- 1〜4 は**正しさ**、5 は**読みやすさ**、6〜12 は**実用性**、13 は**安全性**です。
  正しさの指標を満たさないモデルは、速度や自然さに関係なく不採用とします。
- 3（Engine contradiction）は実行時の検証（`validation.ts`）では拾いきれない種類の誤りなので、
  評価時の人手確認を省略しません。
- 5 の評価者には、どの Provider の出力かを伏せます。

---

## 3. 評価の手順（案）

1. 評価データセットを生成し、engine snapshot の hash と一緒に保存する
2. baseline（`templateProvider`）で全指標を測る
3. 候補 Provider で同じ入力を実行し、全応答・所要時間・メモリ・失敗理由を記録する
4. 自動判定（1・2・13）→ 人手評価（3・4・5）→ 実機計測（6〜12）の順に行う
5. 結果を表にまとめ、採用・不採用を人間が判断する（`docs/APPROVALS.md` へ記録）

評価スクリプトは production bundle へ混ぜず `scripts/` 側に置きます（TRAINING 監査と同じ方針）。

---

## 4. Model Catalog への掲載基準（案）

評価は**モデル区分（`ULTRA_LIGHT` / `LIGHT` / `STANDARD` / `QUALITY` / `EXPERIMENTAL`）ごと**に行い、
同じ区分の候補どうしで比べます。区分ごとに求める実用性の重み付けを変えます。

| 区分 | 重視する指標 | 掲載の目安（提案） |
| --- | --- | --- |
| `ULTRA_LIGHT` | 7・8・11・12（メモリ・取得量・Mobile・WebGPU 非依存） | 中性能 Mobile で動くこと |
| `LIGHT` | 6（Latency） | 2 回目以降 p95 が最も短い候補 |
| `STANDARD` | 1〜5 と 6 のバランス | 正しさを満たしたうえで Desktop・高性能 Mobile で実用的 |
| `QUALITY` | 4・5（正しさ・自然さ） | 高性能 PC で実用的であれば、取得量は大きくてよい |
| `EXPERIMENTAL` | 全指標を記録 | 利用者向けには `status: 'experimental'` と明示 |

どの区分でも、1〜4（正しさ）と 13（Fallback）を満たさない候補はカタログへ載せません。
カタログの `downloadSizeBytes` / `estimatedMemoryBytes` / `requirements` は、この評価で測った値を書きます
（利用者がダウンロード前に容量・性能を比べられるようにするため）。

---

## 5. 記録する項目（モデル名に依存しない）

| 項目 | 例 |
| --- | --- |
| Provider の種類 | `browser-local` / `remote` |
| モデル区分 | `ULTRA_LIGHT` / `LIGHT` / `STANDARD` / `QUALITY` / `EXPERIMENTAL` |
| モデルの識別子・版・量子化方式・ライセンス | 評価時点の値をそのまま記録 |
| 実行バックエンド | WebGPU / WASM / CPU / サーバー |
| 取得サイズ・キャッシュ先 | Cache Storage / IndexedDB（Beta の名前空間） |
| 評価データセットの hash | `serializeEvidence` の結果の sha256 |
| engine snapshot の hash | `scripts/maintenance-snapshot.ts` の出力 |
| 指標 1〜13 の値 | 上表 |

モデルを差し替えても、同じ表で比較できるようにします。

---

## 6. AI Model Benchmark Lab での実装（PR #2）

この文書の基準を、候補モデルで再現可能に測るための実装です。手順・候補・データセットの内訳は
`docs/AI_MODEL_BENCHMARK.md`。

### 6.1 01AS の優先順

一般的な LLM benchmark より、次の順で重視します（Lab の表示・集計もこの順）。

1. **Engine contradiction rate**（2 節の指標 3）
2. **Unsupported claim rate**（指標 2。1 の Groundedness は応答単位の件数から読む）
3. **Validation failure rate**（形・根拠・矛盾のどれかで不合格。エラー・タイムアウトを含む）
4. **Japanese explanation quality**（指標 5。人手評価 5 項目 ＋ 自動の目安）
5. **Latency**（指標 6。TTFT・本文の TTFT・生成時間・tok/s、読み込みは download / cache-cold / cache-warm を区別）

### 6.2 指標との対応

| 2 節の指標 | Benchmark での扱い |
| --- | --- |
| 1 Groundedness / 2 Hallucination rate | `findUnsupportedClaims`（実行時と同じ関数）。応答数と件数の両方を集計 |
| 3 Engine contradiction rate | `findContradictions`（既知のパターンの自動検出）＋ export した応答の人手確認 |
| 4 Explanation correctness | 人手評価（export の CSV で reason code ごとに確認する運用。自動判定はしない） |
| 5 Japanese naturalness | 人手評価 5 項目（日本語の自然さ・分かりやすさ・簡潔さ・学習上の価値・ダーツプレイヤーとしての自然さ）。blind CSV で Provider を伏せる |
| 6 Latency | TTFT・生成時間・tok/s（p50 / p95）。読み込み時間は種類つき |
| 7 Memory usage | Runtime の設定値（推定 VRAM）だけ。実機のピークは DevTools 等で別途（API で取得できないため推測しない） |
| 8 Initial download size | 取得後に Cache Storage から計測。取得前は確認画面に表示（未計測なら「不明」） |
| 10〜12 互換性・WebGPU 依存 | 端末確認（WebGPU・adapter・features・limits・ブラウザ情報）と UNSUPPORTED / MAY_BE_TOO_LARGE の判定 |
| 13 Fallback behavior | 対象外（実行時の `explain.ts` のテストで確認済み）。Benchmark は生の応答を測る |

### 6.3 再現性

- データセットは engine から決定論的に作り、Evidence 全体の指紋を固定（`d8bcc5db4101150e`）
- prompt は版つき（`01as-explain-ja@1`）で、ケースごとに `promptHash` を記録
- 生成は temperature 0・seed 固定・thinking OFF が既定。各ケースの前に会話を reset
- run には dataset の版と指紋・prompt の版・生成設定・端末情報・読み込みの種類を記録
- engine snapshot（`scripts/maintenance-snapshot.ts`）: states=8376・
  sha256=602e43693d5df9fa3fc3429759bb0147a507fa1694f1091775fb1a4044f83877（このPRで不変）

### 6.4 CI での扱い

CI はモデルを取得しません。Mock Runtime（Fake Model・偽の時計）と決定論的な baseline で、
読み込み → 生成 → 検証 → 計測 → export の流れと、「明示操作なしに取得しない」「モデル削除で利用者データ・
評価を消さない」ことを検査します。実モデルの Benchmark は手動実行です。
