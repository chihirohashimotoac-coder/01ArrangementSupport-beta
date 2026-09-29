# AI_MODEL_STORAGE.md — AI MODEL LAB のモデル保存方式（Storage Backend）

> 対象: Beta の開発者向け AI MODEL LAB（Developer Gate 配下）の WebLLM Runtime。
> 利用者向けの 01AS（CHECKOUT / SETUP / TRAINING / SIMULATION）と、Production には関係しません。
> WebLLM は承認済みの **0.2.85** のまま（版の変更・Runtime の追加・モデルの変更はしていません）。

---

## 1. インシデント（PR #3 の発端）

公開 Beta の AI MODEL LAB で実モデル（Qwen3 1.7B）をダウンロードしようとすると、次の表示で止まった。

```text
読み込めませんでした: Quota exceeded.
```

実機の状況（依頼者の記録）:

| 項目 | 値 |
| --- | --- |
| Browser | Chrome / Chromium 153 |
| WebGPU | available（Intel / gen-12lp、maxBufferSize 2.00 GiB） |
| reported device memory | 16 GiB+ |
| origin storage usage | 約 1 MiB |
| origin storage quota | 約 10.00 GiB |

origin 全体の quota（約 10 GiB）を使い切ったことが原因とは考えにくい状態だった。

---

## 2. 原因の分析

### 2.1 コードで確認できたこと（事実）

WebLLM 0.2.85（`node_modules/@mlc-ai/web-llm/lib/index.js`）と、修正前の `src/ai/benchmark/runtimes/webllmRuntime.ts` を読んで確認した。

| # | 確認したこと | 根拠 |
| --- | --- | --- |
| 1 | `prebuiltAppConfig` は `cacheBackend: "cache"`（Cache API）を持つ。`getCacheBackend()` も未指定なら `"cache"` を返す | `const prebuiltAppConfig = { cacheBackend: "cache", model_list: [...] }`・`function getCacheBackend(appConfig)` |
| 2 | 修正前の Runtime は `prebuiltAppConfig` を**そのまま** `hasModelInCache`・`deleteModelAllInfoInCache`・`new MLCEngine({ appConfig })` へ渡していた → モデルの保存は Cache API | 修正前の `webllmRuntime.ts` |
| 3 | Cache API の経路（tvmjs の `ArtifactCache.addToCache`）では、モデルの各ファイル（重みの shard・tokenizer・設定・wasm）を `cache.add(request)` で保存する。重みは 4 並列で取得・保存する | `class ArtifactCache` の `addToCache`・`fetchTensorCacheInternal` の `downloadCache` |
| 4 | `cache.add()` の失敗は包まずにそのまま呼び出し元へ投げ直される（`this.env.logger("Error: Cannot fetch ...")` のあと `throw err`） | `fetchTensorCacheInternal` |
| 5 | 修正前の Lab は `error.message` だけを「読み込めませんでした: 〜」として出していた。Chrome の `QuotaExceededError`（DOMException）の message は `Quota exceeded.` で、表示と一致する | 修正前の `AiModelLabPage.tsx` |
| 6 | 01AS の Service Worker（Workbox）はモデルの配布元への要求を扱わない（`runtimeCaching` なし。precache は同じ配信元の js / css / html など、Lab と WebLLM の chunk は除外） | `vite.config.ts` |
| 7 | OPFS の経路（`ArtifactOPFSCache` / `OPFSStore`）は Cache API を使わず、`tvmjs-opfs-store/<scope>/` に `<sha256(url)>.bin`（本体）と `<sha256(url)>.record.json`（`{ url, nbytes }`）を書く。記録は本体を書き終えてから書く（committed record）。`has()` は記録と本体の大きさが一致したときだけ「ある」とする | `class OPFSStore` の `write`・`has`・`getStoredEntry` |

→ 今回の「Quota exceeded.」は、**Cache API へモデルのファイルを保存する `cache.add()` から投げられた `QuotaExceededError` である**、
という第一仮説とコードの経路は一致する（Cache API の経路以外に、この文言をそのまま出す箇所は無い）。
GPU（WebGPU）への読み込みは保存が終わった後の段階で、今回の失敗とは別。

### 2.2 確認できていないこと（不明）

- origin の usage 約 1 MiB・quota 約 10 GiB の状態で、Chrome の Cache API が**どの上限・どの判定で**
  `cache.add()` を拒否したのかは、この作業環境では再現・確認できていない（**不明**）。
  実モデルはこの環境ではダウンロードしていない（CI でも取得しない）。
- したがって「OPFS なら必ず成功する」とは言えない。OPFS は大容量ファイル向けの保存 API で、WebLLM 0.2.85 が
  公式に対応している（`cacheBackend: "opfs"`）ため第一候補にした、という位置づけ。実機での再検証が必要（7 節）。

---

## 3. 保存方式の方針

| 方式 | WebLLM の `cacheBackend` | Lab での扱い |
| --- | --- | --- |
| **OPFS**（Origin Private File System） | `"opfs"` ＋ `opfsAccessMode: "auto"` | **既定** |
| IndexedDB | `"indexeddb"` | OPFS の API が無いブラウザの初期値。手動で選べる |
| Cache API | `"cache"`（WebLLM 0.2.85 の既定） | どちらも無いときの初期値。手動で選べる |

- 推奨順は **OPFS → IndexedDB → Cache API**（`MODEL_STORAGE_BACKENDS`）。
- 初期値は「API があるか」だけで決める（`chooseModelStorageBackend`）。同じブラウザなら毎回同じ方式になる。
- **保存の失敗を理由に、別の方式へ自動で切り替えない**。方式が違えば保存場所も別なので、自動で切り替えると
  利用者の意図しない再ダウンロード（数百 MB〜数 GB）が起きるため。
  失敗したときは画面で「OPFS で再試行」などを示し、利用者が確認画面で「ダウンロードを開始」を押したときだけ取得する。
- 方式を切り替えても、別の方式に保存したモデルは移動・削除しない（migration はしない）。
- `opfsAccessMode: "auto"` は「dedicated worker で sync access handle が使えれば sync、使えなければ async」。
  Lab は WebLLM を画面のスレッドで動かすので、実際には async（`createWritable`）で書く。

### 3.1 WebLLM へ渡す appConfig

```ts
// src/ai/benchmark/modelStorage.ts
withModelStorage(webllm.prebuiltAppConfig, 'opfs');
// → { ...prebuiltAppConfig（cacheBackend / opfsAccessMode を除く）, cacheBackend: 'opfs', opfsAccessMode: 'auto' }
```

- `prebuiltAppConfig` 自体は変更しない（新しいオブジェクトを作る）。
- 1 つの Runtime は 1 つの方式だけを使う。方式ごとの appConfig は Runtime の中で 1 回だけ作り、
  **同じオブジェクト**を `hasModelInCache`・`deleteModelAllInfoInCache`・`new MLCEngine({ appConfig })` へ渡す。
  方式を変えるときは Runtime を作り直す（前の Runtime は unload する）。
- 検査: `src/ai/benchmark/modelStorage.test.ts`（3 つの呼び出しが同じオブジェクトを受け取る・方式が混ざらない）、
  `src/ai/architecture.test.ts`（`prebuiltAppConfig` を直接渡さない・3 か所とも `configFor` の結果を渡す）。

### 3.2 方式ごとの存在確認（「Cache API に無い」＝「どこにも無い」としない）

- 画面の「保存状況（方式ごと）」に `OPFS: あり / IndexedDB: なし / Cache API: 不明` のように方式ごとに出す。
- いまの方式に無くても、別の方式にあれば「このモデルは Cache API に保存されています。保存方式を切り替えると、
  再ダウンロードせずに Load できます」と示す（PR #2 の頃に Cache API へ保存したモデルもこれで見つかる）。
- 確認は**保存領域を作らずに**行う（`hasWebLlmStore`）。WebLLM の `hasModelInCache` は保存領域
  （OPFS のディレクトリ・IndexedDB のデータベース・Cache API の cache）を作ってしまうため、先に次を調べ、
  無ければ WebLLM を呼ばずに「なし」とする。

| 方式 | 作らずに調べる方法 | 調べられないとき |
| --- | --- | --- |
| OPFS | `getDirectory()` から `tvmjs-opfs-store/webllm/model` を名前だけで開く（NotFound なら無い） | — |
| IndexedDB | `indexedDB.databases()` に `webllm/model` があるか | `databases()` が無いブラウザでは、別の方式としては「不明」（いまの方式なら WebLLM で確かめる） |
| Cache API | `caches.has('webllm/model')` | — |

- 副次効果として、どの方式にも保存領域が無ければ、モデルを選んだだけでは WebLLM のライブラリも読み込まない
  （`e2e/gate-open/` で検査）。

---

## 4. モデル単位のサイズ（cachedSizeBytes）

**誤った 0 B や 1 MiB を表示するより「unknown」を優先する。**

| 方式 | 数え方 | unknown になる場合 |
| --- | --- | --- |
| OPFS | `tvmjs-opfs-store/webllm/{model,config,wasm}/*.record.json` のうち、そのモデルの URL（`model` の下・`model_lib`）の記録の `nbytes` を合計。本体（`.bin`）の大きさが `nbytes` と一致することも確かめる | 本体が無い・大きさが違う（書きかけ）・何も無い・ディレクトリを列挙できない |
| Cache API | `webllm/{model,config,wasm}` の応答の `content-length` を合計 | `content-length` が無い・`content-encoding` があり本体の大きさと一致しない・何も無い |
| IndexedDB | 数えない | 常に unknown（大きさを知るには本体を読み出す必要があり、数 GB をメモリへ載せるため） |

- 読むのは記録と大きさだけで、保存領域の作成・書き込み・削除はしない（`src/ai/architecture.test.ts` が
  `removeEntry`・`createWritable`・`createSyncAccessHandle`・`{ create: true }` を `src/ai`・`src/lab` で禁止）。
- 別の指標として **Estimated download footprint**（download 前後の `navigator.storage.estimate().usage` の差）を
  記録・表示する。これは **origin 全体の差分**で、モデルのファイルの厳密な大きさではない
  （同じ時間の他の保存も含み、値自体がブラウザの見積もり）。

---

## 5. Storage Diagnostics・永続化

AI MODEL LAB の **STORAGE** に次を表示する。

| 項目 | 取得元 |
| --- | --- |
| Model Storage Backend | 選んでいる方式（既定 OPFS） |
| 使える方式 | `navigator.storage.getDirectory`・`indexedDB`・`caches` の有無 |
| Storage Persistent | `navigator.storage.persisted()`（yes / no / unknown） |
| Origin Usage / Origin Quota | `navigator.storage.estimate()`（origin 全体） |

永続化（`navigator.storage.persist()`）:

- 利用者が「ダウンロードを開始」を押したときに、まだ永続化されていなければ **best-effort で 1 回だけ**要求する
  （Lab を開いている間に 1 回まで。ページ表示・モデル選択では要求しない）。
- 結果を待たずに取得を始める。拒否されても取得は止めない。
- 永続化は eviction（ブラウザによる自動削除）への対策で、**容量制限（QuotaExceeded）の対策ではない**。

---

## 6. 失敗の分類（error classification）

`src/ai/benchmark/modelLoadFailure.ts` の `classifyModelLoadFailure`。容量制限を最優先で見分け、GPU 不足と混同しない。

| 区分 | 主な判定 |
| --- | --- |
| `aborted` | 利用者の中止（AbortSignal）・`AbortError` |
| `quota-exceeded` | `QuotaExceededError`・旧 code 22・message の「quota exceeded」 |
| `opfs-unavailable` | 方式が OPFS で、`OPFS API unavailable`・`SecurityError`・`NotSupportedError`・`crypto.subtle.digest is unavailable` |
| `storage-failed`（読み戻し。PR #5） | `ArtifactIndexedDBCache failed to fetch: <url>`・`ArtifactOPFSCache failed to fetch: <url>`・（Cache API のとき）`Cannot fetch <url>`。**通信の判定より先に見る**（6.1 節） |
| `network-failed` | `NetworkError`・「Failed to fetch」・「Unable to fetch … received status 404」・「Network response was not ok」・Cache API の「Request failed」など |
| `gpu-load-failed` | `WebGPUNotAvailableError`・`FeatureSupportError`・`ShaderF16SupportError`・`DeviceLostError`・WebGPU / device lost / maxBufferSize などの message |
| `storage-failed` | `InvalidStateError`・`NoModificationAllowedError`・`NotReadableError` など、容量制限以外の保存の失敗 |
| `unknown` | 上のどれとも判断できない（message をそのまま示す） |

分類は message の文字列にも頼るため推定である。診断情報には元の `name`・`message` をそのまま残す。

診断情報（`01as-ai-model-load-failure`、画面の「診断情報」と「診断情報を保存（JSON）」）:

- storage backend・error class・`DOMException.name`・message
- model（runtime model ID）・download progress（失敗の直前に Runtime が報告した割合）
- 失敗の直後の origin usage / quota / persisted、取得を始める前の origin usage
- 生の stack trace は含めない

利用者向けの表示（例: Cache API で容量制限）:

```text
モデルの保存に失敗しました。
保存方式: Cache API
ブラウザのモデル保存領域で容量制限（QuotaExceededError）が発生しました。GPU の不足ではありません。
OPFS で再試行できます（保存方式を OPFS に切り替え、確認のあとで取得します）。
```

「OPFS で再試行」を押すと、方式を OPFS に切り替えて**確認画面を開くだけ**で、取得は「ダウンロードを開始」を押してから。

### 6.0 取得の後の読み戻しの失敗（PR #5）

PC 実機で保存方式を IndexedDB にしたとき、WebLLM が 30 / 30 shard を取得した後に次で止まり、Lab が `network-failed` と誤って分類した。

```text
ArtifactIndexedDBCache failed to fetch: https://huggingface.co/…/params_shard_0.bin
```

WebLLM 0.2.85（`node_modules/@mlc-ai/web-llm/lib/index.js`）で確かめたこと:

- `ArtifactIndexedDBCache.addToCache` は、取得した応答を `store.add({ data, url })` し、**request の `onsuccess` で完了**とする。
  transaction の確定（`oncomplete`）・中止（`onabort`。容量制限の QuotaExceededError は transaction の abort として届く）を待たない
- `fetchWithCache` は `addToCache` の後に `asyncGetHelper` で読み戻し、空なら削除して 1 回だけ取り直し、それでも空なら
  `ArtifactIndexedDBCache failed to fetch: <url>` を投げる
- 取得の失敗は `addToCache` の中で `Failed to store <url> with error: TypeError: Failed to fetch` として**先に**投げられる
  （HTTP の失敗は `… with error: Error: Network response was not ok`）

したがって「`ArtifactIndexedDBCache failed to fetch:` で始まる」失敗は、**取得が例外なく終わった後の保存領域の失敗**（commit の失敗の可能性。
容量制限の可能性を含むが断定しない）で、通信の失敗ではない。download progress が 100% に近いこととも整合する。
OPFS（`ArtifactOPFSCache failed to fetch:`）・Cache API（`Cannot fetch <url>`。`cache.add()` の後の `match()` が空）の同じ段階の失敗も同じく扱う。

- 分類: `storage-failed`（`isPostStoreReadFailure`）。本物の通信の失敗（上の `Failed to store … Failed to fetch`・HTTP の失敗・接続の失敗）は
  `network-failed` のまま（`modelStorage.test.ts`）
- 診断情報に `postStoreReadFailure: true` を残し、画面に「配布元からの取得は終わりましたが、保存したファイルを保存領域から読み戻せませんでした。
  通信の失敗ではありません。」と出す（IndexedDB では commit の失敗の可能性を、断定せずに添える）

### 6.1 WebGPU の制約とは分けて扱う

今回の実機（Intel / gen-12lp、maxBufferSize 2.00 GiB）では、4B / 8B などで GPU 側の別の制約に当たる可能性がある。
それは `gpu-load-failed` として記録し、今回の `quota-exceeded`（保存の失敗）とは分けて扱う。

---

## 7. 実機での再検証手順（MANUAL VERIFICATION）

実モデルは CI・Claude Code の環境では取得しない。修正の効果は実機で確かめる。

1. 公開 Beta（https://chihirohashimotoac-coder.github.io/01ArrangementSupport-beta/ ）を開く
   （更新の案内が出たら更新する。Service Worker が古い版を出している場合がある）
2. 設定 → DEVELOPER → 「AI MODEL LAB を開く」
3. **STORAGE** で次を確認・記録する
   - Model Storage Backend = **OPFS**
   - 使える方式（OPFS yes / IndexedDB yes / Cache API yes）
   - Storage Persistent（yes / no / unknown）
   - Origin Usage / Origin Quota
4. **MODEL** で Qwen3 1.7B（`Qwen3-1.7B-q4f16_1-MLC`）を選ぶ
   - 保存状況（方式ごと）が表示される（前回 Cache API へ一部でも保存できていれば「Cache API: あり」になることがある）
5. **Download** → 確認画面で「保存方式: OPFS」を確認 → 「ダウンロードを開始」
6. progress（`Fetching param cache[i/N] … % completed`）が進むことを確認
7. 完了すると Model status が「読み込み済み（download …）」になる
   - Download size が「… （OPFS から計測）」、Estimated download footprint が表示される
   - STORAGE の Origin Usage が増えている
8. **BENCHMARK** でケースを「クイック（各カテゴリ 2 件）」にして Run Benchmark（10 件）
9. RESULTS を確認し、Export JSON で保存する

### 7.1 失敗したときに記録すること

失敗の表示（赤枠）の「診断情報」を開くか、「診断情報を保存（JSON）」で保存し、次を記録する。

| 項目 | 画面の表示 |
| --- | --- |
| backend | Storage backend |
| error class | Error class（`quota-exceeded` / `opfs-unavailable` / `storage-failed` / `network-failed` / `gpu-load-failed` / `aborted` / `unknown`） |
| error name / message | Error name / Message |
| origin usage / quota | Origin Usage / Quota（失敗の直後）・Origin Usage（取得の前） |
| モデル | Model |
| download progress % | Download progress |
| persistent | Storage Persistent |
| ブラウザ・GPU | DEVICE の Browser・Adapter・maxBufferSize |

- `quota-exceeded` が OPFS でも出る場合: Origin Usage / Quota と端末の空き容量を記録する。別の方式（IndexedDB）で
  試すのは、保存方式を手動で切り替えてから（自動では切り替えない）。
- `gpu-load-failed` の場合: 保存は済んでいる可能性がある（保存状況が「OPFS: あり」か確認）。GPU の制約として別に扱う。
- 途中で失敗したときは、保存を終えたファイル（OPFS では記録を書き終えたもの）は残る。もう一度 Download すると、
  WebLLM は保存済みのファイルを取得し直さない（`addToCache` が保存済みかを先に確かめる）。

---

### 7.2 OPFS でも QuotaExceededError になるとき（PR #4）

Cache API・OPFS の両方で `QuotaExceededError` になった場合は、WebLLM を使わずに保存 API 自体へどこまで書けるかを
AI MODEL LAB の **BROWSER STORAGE DIAGNOSTICS** で測る（OPFS / IndexedDB / Cache API を同じ大きさで比較）。
手順と結果の読み方（Case A〜D）は `docs/BROWSER_STORAGE_DIAGNOSTICS.md`。

---

### 7.3 実機の結果（PC-A / PC-B。依頼者の記録）

| PC | BROWSER STORAGE DIAGNOSTICS | 読み方 |
| --- | --- | --- |
| PC-A | **Case A**（OPFS / IndexedDB / Cache API のすべてが同じ大きさで成功） | この PC の Browser Storage は正常。WebLLM 側の保存の実装を疑う |
| PC-B | **Case B**（約 300 MiB で 3 方式とも `QuotaExceededError`） | **WebLLM 固有の問題ではなかった**。Browser / Chrome Profile / quota の管理の側の可能性が高い（原因は断定しない） |

- PC-B では WebLLM を使わない診断でも同じ大きさで 3 方式が失敗したので、`QuotaExceededError` を WebLLM・保存方式の選択の問題として扱わない。
  `navigator.storage.estimate()` の quota（約 10 GiB）は実際に書ける上限を保証しない（`docs/BROWSER_STORAGE_DIAGNOSTICS.md` 11 節）
- IndexedDB の既知の挙動（6.0 節）: WebLLM 0.2.85 は IndexedDB の transaction の確定を待たずに保存を終えるため、確定に失敗すると
  取得が 100% に達した後で `ArtifactIndexedDBCache failed to fetch` になる。PC 実機でこれが起きた（どちらの PC かは依頼の記載に無く**不明**）
- iPhone（iOS 26.6・Chrome for iOS 154 / WebKit）では、Qwen3 0.6B・1.7B とも保存（Download）に成功した（`docs/AI_MODEL_BENCHMARK.md` 13 節）。
  1.7B は保存の後の Run Benchmark でタブが終了した（保存の問題ではなく実行時のメモリの問題を疑っているが未確定）

## 8. 既知の制約

- 保存場所の名前は WebLLM / tvmjs 側で固定（Cache API・IndexedDB は `webllm/model`・`webllm/config`・`webllm/wasm`、
  OPFS は `tvmjs-opfs-store/webllm/*`）。同じ origin の別アプリが WebLLM を使うと共有し得る（`docs/APPROVALS.md` AI-3）。
- 書きかけ（取得途中で失敗）のモデルは、WebLLM の存在確認ではすべてのファイルがそろったときだけ「ある」となるため「ある」とは出ない。
  PR #5 から、OPFS・Cache API では、そのモデルの記録が残っていれば「一部だけ保存（partial）」と表示し、対象モデル単位の「モデルを削除」を出す
  （`countModelEntries`。読むだけ）。IndexedDB は数えられないので「未ダウンロード」のまま（不明）。残ったファイルは次の Download で再利用される。
  partial の削除で WebLLM が tensor-cache.json を保存領域に持っていなければ、WebLLM はその一覧（小さな JSON）を配布元から取り直してから消す。
  全体を消す処理（OPFS root の削除・`caches.delete`・`indexedDB.deleteDatabase`・Clear-Site-Data）は持たない。
  （BROWSER STORAGE DIAGNOSTICS は `caches.delete` などを使うが、対象は診断用の `01as-beta-storage-diagnostic` だけで、
  モデルの保存領域には触れない。`docs/BROWSER_STORAGE_DIAGNOSTICS.md`）
- OPFS の中のファイル名・記録の形式（`<sha256(url)>.bin` / `.record.json`）は WebLLM 0.2.85（tvmjs）の実装に依存する。
  版を変えると形式が変わる可能性があり、そのときはサイズが unknown になる（誤った値は出さない）。
- IndexedDB のモデル単位のサイズは unknown。

---

## 9. 変更しなかったもの

- WebLLM の版（0.2.85）・Transformers.js などの Runtime・候補モデル・AI Coach
- `src/engine/**`・`src/data/**`・`src/domain/**`・`data/source/**`（`suggestFor` の snapshot:
  `states=8376 sha256=602e43693d5df9fa3fc3429759bb0147a507fa1694f1091775fb1a4044f83877` を維持）
- 01AS の利用者データ（`01as-beta:oas.*`）と Benchmark の結果・人手評価（`01as-beta:ai.benchmark.*`）。
  保存方式の変更・モデルの削除で変わらないことをテストで確認
