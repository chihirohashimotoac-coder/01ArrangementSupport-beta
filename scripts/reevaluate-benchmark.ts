/**
 * AI MODEL LAB の Benchmark の export（JSON）を、**モデルを再実行せずに**現在の自動検証で評価し直す（開発者向け）。
 *
 *   npm run reevaluate:benchmark -- <export.json> [出力.json]
 *
 * - 入力は Lab の「Export JSON」（schema `01as-ai-benchmark-export`）。各 run の生の応答（rawText）を、
 *   run を作ったデータセット（01AS Core v1 を engine から組み立て直し、ID・版・指紋が一致するもの）の Evidence で検証し直す
 * - 元の run は書き換えない。出力は新しい run（`reevaluation.originalRunId`・`validatorVersion`）だけを入れた別の JSON
 * - 出力を省略すると `<入力>.reeval-v<版>.json` に書く
 * - 集計（contradiction・unsupported claim・validation・反復・出力の上限・内部 code・Clean response）を表示する
 *
 * このスクリプトは production bundle に入らない（scripts/ 配下）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BENCHMARK_VALIDATOR_VERSION } from '../src/ai/benchmark/checks';
import { buildJsonExport, type BenchmarkExport } from '../src/ai/benchmark/export';
import { summarizeRun } from '../src/ai/benchmark/metrics';
import { describeRunProfile } from '../src/ai/benchmark/profiles';
import { reevaluateRun } from '../src/ai/benchmark/reevaluate';
import type { BenchmarkRun } from '../src/ai/benchmark/types';
import { coreDataset } from '../src/lab/benchmarkDataset';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [input, outputArg] = process.argv.slice(2);
if (!input) fail('使い方: npm run reevaluate:benchmark -- <export.json> [出力.json]');

const parsed = JSON.parse(readFileSync(input, 'utf8')) as Partial<BenchmarkExport>;
if (parsed.schema !== '01as-ai-benchmark-export' || !Array.isArray(parsed.runs)) {
  fail(`${input} は AI MODEL LAB の Export JSON（schema 01as-ai-benchmark-export）ではありません。`);
}

const dataset = coreDataset();
const reevaluatedAt = new Date().toISOString();
const reevaluated: BenchmarkRun[] = [];
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

for (const exported of parsed.runs) {
  // export は run に summary と profile を足している。summary は計算し直すので外す。
  const { summary: _summary, ...run } = exported as BenchmarkRun & { summary?: unknown };
  const result = reevaluateRun(run, dataset, reevaluatedAt);
  if (!result.ok) {
    console.log(`SKIP ${run.runId}: ${result.reasonJa}`);
    continue;
  }
  reevaluated.push(result.run);
  const before = summarizeRun(run);
  const after = summarizeRun(result.run);
  console.log(`\n${run.runId}`);
  console.log(`  profile: ${describeRunProfile(run)}`);
  console.log(`  validator: v${run.validatorVersion ?? 1} → v${BENCHMARK_VALIDATOR_VERSION}（${result.reevaluatedCases} 件を再評価）`);
  console.log(`  Engine contradiction : ${before.withContradictions} → ${after.withContradictions} / ${after.completed}`);
  console.log(`  Unsupported claim    : ${before.withUnsupportedClaims} → ${after.withUnsupportedClaims} 応答（${after.unsupportedClaimTotal} 件）`);
  console.log(`  Validation pass      : ${before.validationPassed} → ${after.validationPassed} / ${after.total}`);
  console.log(`  Repetition           : ${after.withRepetition}`);
  console.log(`  Output limit reached : ${after.withOutputLimit}`);
  console.log(`  Internal code leak   : ${after.withInternalCodeLeak}`);
  console.log(`  Clean response       : ${after.cleanResponses} / ${after.total}（${percent(after.cleanResponseRate)}）`);
}

if (reevaluated.length === 0) fail('\n再評価できた run がありません。');
// profile が違う run は 1 つの export に混ぜない（buildJsonExport が拒否する）ので、profile ごとに分けて渡す前提。
const output = outputArg ?? input.replace(/\.json$/i, '') + `.reeval-v${BENCHMARK_VALIDATOR_VERSION}.json`;
writeFileSync(output, `${JSON.stringify(buildJsonExport(reevaluated, parsed.ratings ?? {}, dataset), null, 2)}\n`);
console.log(`\n書き出しました: ${output}（元のファイルは変更していません）`);
