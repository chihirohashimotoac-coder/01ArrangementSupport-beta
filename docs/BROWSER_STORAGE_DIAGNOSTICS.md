# BROWSER_STORAGE_DIAGNOSTICS.md — ブラウザの保存容量の実測（AI MODEL LAB）

> 対象: Beta の開発者向け AI MODEL LAB（Developer Gate 配下）。利用者向けの 01AS と Production には関係しません。
> WebLLM Runtime・WebLLM の版（0.2.85）・`cacheBackend` の既定（OPFS）・候補モデル・Benchmark・Engine・AI Coach は
> **変更していません**。追加したのは診断機能だけです。

---

## 1. 目的

AI MODEL LAB で Qwen3 1.7B をダウンロードすると、Cache API（PR #3 以前）でも OPFS（PR #3 以降）でも
`QuotaExceededError` になった。実機では次の状態で、単純なディスク容量不足ではない。

| 項目 | 値（依頼者の記録） |
| --- | --- |
| Origin Usage | 約 300 MiB |
| Origin Quota | 約 10 GiB |
| C ドライブの空き | 100 GB 以上 |

この診断は **WebLLM を一切使わずに**、Chrome 自身の保存 API（OPFS / IndexedDB / Cache API）へ
実際にどこまで書けるかを方式ごとに測り、

```text
Browser storage 自体の問題  vs  WebLLM 固有の問題
```

を切り分ける。

使わないもの: WebLLM・Qwen などのモデル・LLM のモデルファイル・Hugging Face・外部の通信。
書くのは**この端末で作ったテストデータだけ**（疑似乱数）。

---

## 2. 構造（Diagnostic architecture）

```text
src/storageDiagnostics/            … 保存 API を操作するのはここだけ（WebLLM・engine・ai・storage に依存しない）
  constants.ts                     … 診断用の名前・chunk・選べる大きさ
  types.ts                         … Adapter / 結果の型
  runner.ts                        … 方式によらない手順（計測・中止・後片付け・反映待ち）
  browserAdapters.ts               … OPFS / IndexedDB / Cache API の Adapter と navigator.storage の読み取り
  report.ts                        … 3 方式の比較（Case A〜D）と JSON export
  fakeAdapter.ts                   … unit test 用の Fake Storage Adapter
src/lab/StorageDiagnosticsSection.tsx … AI MODEL LAB 内の画面（呼ぶだけ。保存 API を直接触らない）
```

- `src/storageDiagnostics/**` を読むのは `src/lab/**` だけ。Lab は App.tsx から動的 import でだけ読まれるので、
  通常の画面の bundle には入らない（`src/storageDiagnostics/architecture.test.ts`）。
- 画面は Adapter を差し替えられる（unit test は Fake、実際の画面はブラウザの Adapter）。

### 2.1 診断用の名前（これ以外には触れない）

| 方式 | 作成・書き込み・削除する場所 |
| --- | --- |
| OPFS | root 直下の `01as-beta-storage-diagnostic/` ディレクトリと、その中の `opfs-test.bin` だけ |
| IndexedDB | データベース `01as-beta-storage-diagnostic`（object store `chunks`）だけ |
| Cache API | cache `01as-beta-storage-diagnostic` だけ（鍵は `<origin>/01as-beta-storage-diagnostic/chunk-000000.bin` など。通信しない） |

触れないもの: OPFS root・`tvmjs-opfs-store/`（WebLLM）・`webllm/model`・`webllm/config`・`webllm/wasm`・
Workbox の precache・Model Management の `01as-beta-ai-model:*`・01AS の利用者データ（localStorage の `01as-beta:*`）。

保証の方法:

- `architecture.test.ts` が、`removeEntry`・`deleteDatabase`・`caches.delete`・`open` などの**呼び出しの引数**が
  診断用の定数だけであること、保存 API を呼ぶのが `browserAdapters.ts` だけであること、WebLLM の保存領域の名前・
  localStorage・通信を使わないことを検査する
- `browserAdapters.test.ts` が、偽の OPFS / IndexedDB / Cache Storage に WebLLM のモデルとアプリのキャッシュを置いた状態で
  success / QuotaExceeded / abort / 後片付けを行い、**それらが 1 byte も変わらない**ことを確かめる
- E2E（`e2e/gate-open/storageDiagnostics.gate-open.spec.ts`）が実ブラウザで同じことを確かめる

---

## 3. 書き込みの方法

目的は**保存容量**の測定で、RAM の試験ではない。巨大な単一の ArrayBuffer は作らず、
**16 MiB の chunk を 1 つだけ作って使い回し**、逐次書き込む（`16 MiB → 32 MiB → 48 MiB → …`）。

- 中身は xorshift32 の疑似乱数（毎回同じ）。Chrome は IndexedDB の値を圧縮することがあり（作業環境の Chromium で、
  ほぼゼロの 320 MiB が usage 約 17 MiB になるのを観測）、ゼロ埋めでは方式ごとの比較にならないため
- chunk ごとに先頭 4 byte へ chunk の番号を書き込み、同じ中身が並ばないようにする
- 各方式の書き込みは、WebLLM 0.2.85 がモデルを保存するときの方法に近づけてある（比較のため）

| 方式 | 書き込み | 確定 |
| --- | --- | --- |
| OPFS | `getDirectoryHandle(DIAG, { create: true })` → `getFileHandle('opfs-test.bin', { create: true })` → `createWritable({ keepExistingData: false })` → chunk ごとに `write(chunk)` | 最後に `close()`（Chrome は close まで一時ファイルへ書く。WebLLM が画面のスレッドで動くときの async 経路と同じ API。sync access handle は dedicated worker 専用なので使わない） |
| IndexedDB | `open(DIAG, 1)`（`chunks` を作る）→ chunk ごとに readwrite transaction を 1 つ作り `put(ArrayBuffer, index)` | 各 transaction の `complete`（容量制限は transaction の `abort` として届く） |
| Cache API | `caches.open(DIAG)` → chunk ごとに `cache.put(url, new Response(chunk))` | 各 `put` の完了 |

- IndexedDB は ArrayBuffer ごと保存されるので、最後の短い chunk（部分）だけは必要な長さに複製する
- `Response` の作成・`put` の複製で一時的に chunk 1 つ分のメモリを使うが、保持はしない

### 3.1 chunk size と大きさ

| 項目 | 値 |
| --- | --- |
| chunk size | 16 MiB |
| 通常の選択肢 | 256 MiB / 512 MiB / **1 GiB（既定）** |
| Advanced | 2 GiB（「Advanced」を開いたときだけ選べる）。**選べる最大は 2 GiB** |
| E2E 用の test mode | `?storage-diagnostic-test-mode=1` のとき 1 / 2 / 4 MiB（chunk 1 MiB） |

---

## 4. 実行・中止・後片付け

### 4.1 実行

- 書き込みは利用者がボタンを押したときだけ始める。画面を開いただけでは書かない（前回の残りを調べるだけで、
  保存領域を作らない: OPFS は `create` なしで開く・IndexedDB は `databases()`・Cache API は `has()`）
- 「ストレージテスト開始（3 方式を同じ 〜 で順に）」: OPFS → IndexedDB → Cache API の順で、同じ target size で測る
- 各方式の「1 GiBテスト」: その方式だけを測る
- モデルの取得・読み込み中は開始できず、診断の実行中はモデルの取得・読み込み・削除・Benchmark を始められない（測定がずれるため）

各テストの手順（`runner.ts`）:

```text
origin の状態（開始前）→ 前回の残りを削除 → origin の状態（書き始め＝基準）→ 開く → chunk を順に書く → 確定
→ origin の状態（後）→ 診断用のデータだけを削除 → 削除の反映を待つ（最大 5 秒）→ origin の状態（削除後）
```

### 4.2 中止（abort）

- 「中止」を押す・Lab から戻る（画面を離れる）・ページを閉じる（`pagehide`）と中止する
- 中止は chunk の境目で確かめる。進行中の 1 chunk（16 MiB）は待ってから止める
- 3 方式を順に測っている途中なら、残りの方式は始めない
- 中止した結果は `status: "aborted"` として残し、比較（Case）には使わない

### 4.3 後片付け（cleanup）

- **成功・失敗・中止のどれでも**、最後に診断用のデータだけを削除する
  - OPFS: `root.removeEntry('01as-beta-storage-diagnostic', { recursive: true })`（書き込み途中の一時ファイルを含む。OPFS root は消さない）
  - IndexedDB: 自分の接続を閉じてから `indexedDB.deleteDatabase('01as-beta-storage-diagnostic')`。別のタブが接続を開いたままで
    10 秒以内に削除できなければ `BlockedError` として失敗させる
  - Cache API: `caches.delete('01as-beta-storage-diagnostic')`
- 削除に失敗したら、結果に `cleanup.status: "failed"` と error を残し、画面に **`diagnostic cleanup failed: <name>: <message>`** を表示する
  （黙って成功にしない）
- ページを閉じる・削除に失敗したなどで残ったデータは、次のテストの前に削除する。**どの方式のテストでも、書き始める前に
  3 方式すべての残りを調べて削除する**（前のテストで削除に失敗した方式の残りが quota を使ったまま、別の方式を測らないように）。
  残りの有無が分からない方式（例: `indexedDB.databases()` が無い）も削除を試みる。反映を待つかどうかは、削除の結果
  （実際に何かを消したか。OPFS は `removeEntry` の成否、IndexedDB は `deleteDatabase` の `oldVersion > 0`、Cache API は
  `caches.delete()` の戻り値）で決める
  ほかの方式の残りを削除できなければ、書き込みを始めない（`failedPhase: "prepare"`）。画面の「前回のテストの残り」で確認でき、
  「診断用のデータを削除」でも消せる（失敗したら `diagnostic cleanup failed — …` と表示）

### 4.4 削除の反映（usageReclaimed）

作業環境の Chromium（headless）で、次を観測した（**実機の Chrome で同じかは不明**。実機の結果で確かめる）。

| 観測 | 内容 |
| --- | --- |
| Cache API | `caches.delete()` が成功し `caches.has()` も false になったあとも、`estimate().usage` は 30 秒以上減らず、**ページを再読み込みすると減った** |
| IndexedDB（通常のプロファイル） | `deleteDatabase()` の直後に usage が減った |
| IndexedDB（一時的なプロファイル・incognito 相当） | 60 秒待っても usage が減らなかった |
| OPFS | `removeEntry()` の直後に usage が減った |

反映されていない分は quota の判定にも数えられていた（incognito 相当のプロファイルで、IndexedDB を削除したあとの Cache API の
最初の `put` が `QuotaExceededError` になった）。つまり**同じページで続けて測ると、後の方式が使える容量が少なく見える**ことがある。

そこで:

- 削除のあと、Origin Usage が「書き始めの usage ＋ 1 chunk」以内に戻るまで最大 5 秒待ち、結果に `usageReclaimed`（true / false / null）と
  `reclaimWaitMs` を残す。基準（`originUsageBefore`）は**前回の残りを削除したあと**に測り直した値
  （残りの分を基準に含めると、今回の分が消えずに残っても「元に戻った」と誤判定するため）
- 前回の残りがあったときは、その削除が usage に反映される（開始前より減る）まで最大 5 秒待ってから基準を取る。
  減らなければ書き込みを始めず、`failedPhase: "prepare"`・`errorName: "StaleUsageError"` として再読み込みを求める
  （待っている間に中止されたら、中止として記録する。書き込みのあとの反映待ちで中止されたら、すぐに待つのをやめ、
  反映は確かめられていないもの（`usageReclaimed: false`）として扱う）
- 次のどれかが起きたら、3 方式を順に測っている途中でも**残りの方式は測らず**、このページでは
  **再読み込みするまで次のテストを始められない**（「診断用のデータを削除」と JSON の保存はできる）。
  診断用のデータ（またはその usage）が quota に数えられたまま次を測ると、誤った Case を出すため
  - 後片付けに失敗した（`cleanup.status: "failed"`。usage が分からなくても止める）
  - 削除が usage に反映されなかった（`usageReclaimed: false`）
  - 前回の残りの削除が反映されず、書き始めなかった（`StaleUsageError`）
- 結果（数値と文字列だけ）は Lab 専用のキー `01as-beta:ai.storage-diagnostic.results.v1`（localStorage、直近 30 件）に残し、
  再読み込みをまたいで比較に使う。「記録した結果を消す」で消せる。01AS の利用者データ（`01as-beta:oas.*`）とは別のキー。
  保存できなかったとき（localStorage が使えない・容量不足）は、再読み込みで結果が消えるので、画面に警告を出して
  先に JSON を保存するよう求める
- 3 方式の順は OPFS → IndexedDB → Cache API（削除が反映されにくい Cache API を最後）
- 比較の表に各方式の **Usage before** を出す（前の方式の残りが混ざっていないかを確かめられる）
- **最も厳密に比べるには、方式ごとにページを再読み込みしてから 1 方式ずつ測る**

---

## 5. 永続化（Persistence）

- 画面に `navigator.storage.persisted()` を **Persistent: Yes / No / unknown** で表示する
- 「Persistent Storageを要求」ボタンを押したときだけ `navigator.storage.persist()` を呼ぶ
- **書き込みのテストでは要求しない**（まず通常の状態で測る）。各結果には開始時の `persisted` を残す
- Persistent は eviction（自動削除）への対策で、quota を広げるものではない

---

## 6. 結果と JSON export

各方式の結果（`StorageDiagnosticResult`）:

| 項目 | 意味 |
| --- | --- |
| `backend` | `opfs` / `indexeddb` / `cache` |
| `writeMethod` | 書き込みの方法（3 節） |
| `status` | `success` / `failed` / `aborted` |
| `startedAt` / `finishedAt` | ISO 8601 |
| `targetBytes` / `chunkBytes` | 目標の大きさ・chunk の大きさ |
| `writtenBytes` | 書き込みが完了した（write / put が resolve した）chunk の合計 |
| `lastSuccessfulBytes` | 最後に成功した chunk の終端（逐次書き込みなので通常は `writtenBytes` と同じ） |
| `failedAtBytes` | 失敗した chunk を書き終えていたはずの位置（例: Last successful 304 MiB → Failed at 320 MiB）。確定（close）の失敗なら書いた量。成功・中止は null |
| `failedPhase` | `prepare`（前回の残りの削除・開く）/ `write` / `finalize`（OPFS の close） |
| `durationMs` / `bytesPerSecond` | 書き込みの段階（開く〜確定）の時間と速さ。後片付けは含まない |
| `errorName` / `errorMessage` | `DOMException.name` と message をそのまま |
| `originUsageBefore` / `originUsageAfter` / `originUsageAfterCleanup` | `estimate().usage`（書き始め＝前回の残りを削除した後 / 書き込みの直後・削除の前 / 削除の反映を待った後） |
| `originQuotaBefore` / `originQuotaAfter` | `estimate().quota` |
| `usageReclaimed` / `reclaimWaitMs` | 削除が usage に反映されたか・待った時間（4.4 節） |
| `persisted` | 開始時の `persisted()` |
| `cleanup` | `{ status: "ok" \| "failed", errorName, errorMessage }` |

「診断結果を保存（JSON）」の形:

```json
{
  "schema": "01as-browser-storage-diagnostic",
  "schemaVersion": 1,
  "exportedAt": "2026-09-28T00:00:00.000Z",
  "browser": { "userAgent": "...", "brands": ["Google Chrome 153", "..."], "platform": "Windows" },
  "storage": { "usageBytes": 318767104, "quotaBytes": 11059540787, "persisted": false },
  "support": { "opfs": true, "indexeddb": true, "cache": true },
  "testMode": false,
  "results": [
    {
      "backend": "opfs",
      "status": "failed",
      "targetBytes": 1073741824,
      "writtenBytes": 318767104,
      "lastSuccessfulBytes": 318767104,
      "failedAtBytes": 335544320,
      "errorName": "QuotaExceededError",
      "...": "..."
    }
  ],
  "comparison": { "targetBytes": 1073741824, "outcomes": { "opfs": "failed", "indexeddb": "success", "cache": "failed" }, "case": "C", "interpretationJa": "..." }
}
```

`results` は実行した順（中止を含む。再読み込みの前の結果も含む。直近 30 件）。`comparison` は 3 方式に同じ target size の完了した結果（成功・失敗）が
そろっているときだけ入る（同じ方式が複数あれば最後の結果）。

---

## 7. 結果の読み方（INTERPRETATION）

**最重要**: 同じ端末・同じブラウザ・同じプロファイルで、OPFS / IndexedDB / Cache API を**同じ target size** で比べる。
画面の COMPARISON と JSON の `comparison.case` に、次の Case を出す。Case は**切り分けの手がかり**で、原因の断定ではない。

### Case A

```text
OPFS       1 GiB success
IndexedDB  1 GiB success
Cache API  1 GiB success
```

→ Browser Storage は正常。**WebLLM Runtime / WebLLM の保存の実装**を疑う。

### Case B

```text
OPFS       約300 MiBでfailure
IndexedDB  約300 MiBでfailure
Cache API  約300 MiBでfailure
```

→ **Browser / Chrome Profile / Storage quota management** 側の可能性が高い。
Failed at の位置が 3 方式で近いかも確かめる。

### Case C

```text
OPFS       failure
IndexedDB  success
Cache API  failure
```

→ **IndexedDB を WebLLM の保存方式の候補**として検討する（切り替えは提案として出し、人間の承認を得てから）。

### Case D

```text
OPFS       success
IndexedDB  success
Cache API  failure
```

→ **Cache API 固有の問題**の可能性が高い。

### その他

Case A〜D のどれにも当てはまらない組み合わせ（例: OPFS だけ成功）は `other`。各方式の errorName・Failed at・
Usage before を比べる。

### 7.1 読み違えを避けるための確認

- **Usage before** が方式ごとに大きく違う（前の方式の削除が反映されていない、4.4 節）なら、その比較はずれている。
  再読み込みしてから 1 方式ずつ測り直す
- `failedPhase: "prepare"` は書き込み以前の失敗（前回の残りを消せない・保存領域を開けない・残りの削除が反映されない）で、
  容量の問題とは限らない。**比較（Case）には使わない**（その方式は、書き込みまで走った結果がそろうまで比較に出ない）
- `cleanup.status: "failed"` のときは、診断用のデータが残っている。次のテストの前に「診断用のデータを削除」する
- Origin Quota が端末の空き容量に比べて小さい（例: 空き 100 GB 以上で約 10 GiB）理由は、この診断だけでは**不明**。
  次を記録しておくと切り分けやすい（どれが原因かは断定しない）:
  - シークレット（incognito）ウィンドウ・ゲストプロファイルか（一時的なプロファイルは quota が小さい）
  - DevTools の Application → Storage にある「Simulate custom storage quota」が有効になっていないか
  - 別の Chrome プロファイル・別のブラウザ（Edge など）で同じ結果になるか

---

## 8. テスト

| 種類 | 内容 | 大きさ |
| --- | --- | --- |
| unit（`runner.test.ts`） | Fake Storage Adapter で success / QuotaExceeded / abort / cleanup / cleanup failure / finalize の失敗 / 削除の反映待ち / chunk の使い回し | 書かない（数えるだけ） |
| unit（`browserAdapters.test.ts`） | 偽の OPFS / IndexedDB / Cache Storage。WebLLM のモデル・アプリのキャッシュを置いた状態で、ほかを変えずに診断用だけを作って消す。IndexedDB の削除の blocked | 数十 KiB（メモリ上） |
| unit（`report.test.ts`） | Case A〜D・other の判定、JSON export の項目 | — |
| unit（`architecture.test.ts`） | 診断用の名前以外を削除・作成しない（呼び出しの引数まで）、webllm/*・利用者データ・通信に触れない、依存の向き | — |
| unit（`src/lab/StorageDiagnosticsSection.test.tsx`・`AiModelLabPage.test.tsx`） | 画面: 開いただけでは書かない・大きさの選択肢・進行中の表示・中止・画面を離れたら中止・失敗・cleanup failed・比較・persist は別ボタン・JSON・Lab との排他・削除が反映されないときに残りを測らず再読み込みまで止める・結果が再読み込みをまたいで残る | Fake |
| E2E（`e2e/gate-open/storageDiagnostics.gate-open.spec.ts`） | 実ブラウザ（Chromium）の OPFS / IndexedDB / Cache API へ test mode で書き（削除が反映されずに止まったら再読み込みして残りを測る）、WebLLM のモデル（偽物）・利用者データが残り、診断用のデータだけが消えること・JSON | **4 MiB × 3 方式** |

**CI では 1 GiB の書き込みをしない**（CI のディスクを使わない）。1 GiB 以上は実機で手動で測る（9 節）。

---

## 9. 実機で行うテストの順（MANUAL VERIFICATION）

1. 公開 Beta を開く（更新の案内が出たら更新する）。**通常のウィンドウ**（シークレットではない）で行う
2. 設定 → DEVELOPER → 「AI MODEL LAB を開く」
3. **BROWSER STORAGE DIAGNOSTICS** で Origin Usage / Origin Quota / Persistent / 前回のテストの残り を記録する
   （Persistent Storage はまだ要求しない。以前の結果が残っていれば「記録した結果を消す」）
4. Test size = **1 GiB**（既定）のまま「ストレージテスト開始（3 方式を同じ 1 GiB で順に）」を押す
5. 終わったら COMPARISON の Case と、各方式の結果（成功 / errorName・Failed at・Last successful）を確認する
6. 「削除した診断用のデータが、まだ Origin Usage から減っていません」が出たら（残りの方式は測られず、次のテストも始められない）、
   **ページを再読み込みして、まだ測っていない方式の「1 GiBテスト」を 1 つずつ**押す（反映されなければ、また再読み込みしてから次へ）。
   結果は再読み込みしても残り、3 方式がそろうと COMPARISON が出る。Usage before が方式ごとに大きく違わないかも確認する
7. 「診断結果を保存（JSON）」で保存する
8. （任意）1 GiB がすべて成功したら、Advanced を開いて 2 GiB でも同じ手順で測る
9. （任意・最後に）「Persistent Storageを要求」を押し、Persistent が Yes になったら 4〜7 をもう一度行い、結果を別の JSON で保存する
   （通常の状態の結果と混ぜない）
10. 保存した JSON を PR / Issue に添付し、7 節の Case で次の対応（WebLLM 側の調査・保存方式の候補の見直し）を決める

---

## 10. 変更しなかったもの

- WebLLM Runtime（`src/ai/benchmark/runtimes/webllmRuntime.ts`）・WebLLM の版（0.2.85）・`cacheBackend` の既定（OPFS）
- 候補モデル（`src/ai/benchmark/candidates.ts`）・Benchmark のロジック・AI Coach
- `src/engine/**`・`src/data/**`・`src/domain/**`・`data/source/**`（`suggestFor` の snapshot
  `states=8376 sha256=602e43693d5df9fa3fc3429759bb0147a507fa1694f1091775fb1a4044f83877` を維持）
- 01AS の利用者データ（`01as-beta:oas.*`）と Benchmark の結果・人手評価

---

## 11. 実機の事例（PR #5 で記録）

依頼者の実機での結果です（同じ手順・9 節）。Case は切り分けの手がかりで、原因の断定ではありません。

| PC | Case | 結果 | 読み方 |
| --- | --- | --- | --- |
| PC-A | **Case A** | OPFS / IndexedDB / Cache API のすべてが同じ target size で成功 | この PC の Browser Storage は正常。WebLLM の保存の実装の側を疑う（IndexedDB の保存の確定を待たない挙動。`docs/AI_MODEL_STORAGE.md` 6.0 節） |
| PC-B | **Case B** | **約 300 MiB で 3 方式とも `QuotaExceededError`** | **WebLLM 固有ではなかった**（WebLLM を使わない診断でも同じ）。Browser / Chrome Profile / quota の管理の側の可能性が高い |

### 11.1 `navigator.storage.estimate()` の quota は実際に書ける上限を保証しない

PC-B では、画面の Origin Quota は約 10 GiB（`navigator.storage.estimate().quota`）だったのに、約 300 MiB で 3 方式とも書けなくなった。

- `estimate()` の値は名前のとおりブラウザの**見積もり**で、MDN は圧縮・重複排除・セキュリティ上の難読化のため正確な値ではないと説明している
  （https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate 。仕様: https://storage.spec.whatwg.org/#dom-storagemanager-estimate ）
- したがって「quota が十分に大きい」ことを、書き込みが成功する根拠にしない。実際に書けるかは、この診断のように**書いて確かめる**
- PC-B で quota の見積もりと実際の上限が食い違った理由は**不明**（7.1 節の確認項目: シークレット / ゲストプロファイル・DevTools の
  「Simulate custom storage quota」・別プロファイル / 別ブラウザでの再現）
