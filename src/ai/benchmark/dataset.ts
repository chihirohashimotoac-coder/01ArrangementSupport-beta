/**
 * Benchmark Dataset の組み立て（Evidence → ケース）。
 *
 * engine を呼ぶのはデータセットの定義側（`src/lab/benchmarkDataset.ts`）で、ここは
 * 受け取った Evidence にタグを付け、指紋を計算して凍結するだけ（戦術判断をしない）。
 */
import { deepFreeze } from '../evidence';
import { fingerprint } from './hash';
import { evidenceJsonOf } from './prompt';
import { deriveTags } from './tags';
import type { BenchmarkCase, BenchmarkDataset } from './types';

export type CaseDraft = Omit<BenchmarkCase, 'tags'>;

/** 全ケースの ID・分類・Evidence から計算する指紋。Evidence が 1 か所でも変われば変わる。 */
export function datasetFingerprint(cases: readonly BenchmarkCase[]): string {
  return fingerprint(
    cases.map((item) => `${item.id}\n${item.category}\n${evidenceJsonOf(item)}`).join('\n\n'),
  );
}

export function assembleDataset(input: {
  readonly id: string;
  readonly version: number;
  readonly labelJa: string;
  readonly drafts: readonly CaseDraft[];
}): BenchmarkDataset {
  const seen = new Set<string>();
  for (const draft of input.drafts) {
    if (seen.has(draft.id)) throw new Error(`Benchmark case の ID が重複しています: ${draft.id}`);
    seen.add(draft.id);
  }
  const cases = input.drafts.map((draft) => ({ ...draft, tags: deriveTags(draft.input) }));
  return deepFreeze({
    id: input.id,
    version: input.version,
    labelJa: input.labelJa,
    cases,
    fingerprint: datasetFingerprint(cases),
  });
}
