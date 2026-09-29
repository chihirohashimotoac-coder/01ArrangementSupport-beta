/**
 * Benchmark の候補モデル（Benchmark Candidate Catalog）。
 *
 * **ここは採用済みのモデル一覧ではない。** 公平に採用判断するための「評価対象の一覧」であり、
 * 利用者向けの Model Catalog（`src/ai/models/catalog.ts`。既定は空）には載せない。
 *
 * - 具体的なモデル名は、この候補データ（と Model Catalog のデータ）にだけ書く
 * - `provisionalClass` は**仮説**。計測結果と人間の承認で確定するまで固定しない
 * - `adoptionStatus` はすべて NOT_EVALUATED（実測前）
 * - VRAM・低リソース向けか・必須 feature・context window は、package.json で固定した
 *   WebLLM の版（`WEBLLM_CONFIG_VERSION`）の `prebuiltAppConfig` の値を写したもの
 *   （`candidates.test.ts` が一致を検査する）
 * - ダウンロードサイズは未計測（null）。Lab で取得した後に Cache から計測して記録する
 *
 * 出典・ライセンス・日本語対応の根拠は `docs/AI_MODEL_BENCHMARK.md`。
 */
import type { BenchmarkCandidate } from './types';

/** 値を写した WebLLM の版。package.json の固定版と一致させる（テストで検査）。 */
export const WEBLLM_CONFIG_VERSION = '0.2.85';

const MIB = 1024 * 1024;

function mib(value: number): number {
  return Math.round(value * MIB);
}

export const BASELINE_CANDIDATE_ID = 'baseline-template';

/** 比較の基準線。モデルを使わない（アプリの fallback と同じ文面）。 */
export const BASELINE_CANDIDATE: BenchmarkCandidate = {
  id: BASELINE_CANDIDATE_ID,
  displayName: 'Baseline（決定論的な template）',
  family: 'template',
  parameterSize: '-',
  quantization: null,
  runtime: 'deterministic',
  runtimeModelId: null,
  labAvailability: 'RUNNABLE',
  provisionalClass: 'EXPERIMENTAL',
  license: 'このリポジトリ',
  japaneseSupport: 'listed',
  downloadSizeBytes: 0,
  estimatedVramBytes: 0,
  requiredGpuFeatures: [],
  lowResourceRequired: true,
  contextWindow: null,
  supportsThinkingToggle: false,
  adoptionStatus: 'NOT_EVALUATED',
  notesJa: '比較の基準線と、自動検証の誤検出が無いことの確認に使う。',
};

const QWEN3_NOTE =
  '01AS では thinking を原則 OFF（WebLLM の extra_body.enable_thinking=false）。比較のため ON も計測できる。';

/**
 * Qwen3（0.6B / 1.7B / 4B / 8B は同じ tokenizer）で数えた 01AS Core v1 の prompt token 数。
 *
 * 2026-09-29 に開発環境で、Qwen3 の tokenizer.json（npm `@lenml/tokenizer-qwen3` 3.7.2 に同梱。語彙 151,669）と
 * Qwen3 の chat template（`<|im_start|>system … <|im_end|>`・thinking OFF の空の `<think></think>`）で数えた。
 * 平均 1094.2 は、iPhone の実機（WebLLM・Qwen3 0.6B）の usage.prompt_tokens の平均 約 1094 と一致した。
 * 計測の手順は docs/AI_MODEL_BENCHMARK.md 10 節。データセット・prompt を変えたら数え直す（テストが指紋を照合する）。
 */
const QWEN3_PROMPT_TOKENS = {
  datasetFingerprint: 'd8bcc5db4101150e',
  promptVersion: '01as-explain-ja@1',
  cases: 100,
  meanTokens: 1094.2,
  p95Tokens: 1507,
  maxTokens: 1659,
  maxCaseId: 'SU-301-3',
  tokenizerJa: 'Qwen3 tokenizer（語彙 151,669・chat template 込み・thinking OFF）',
} as const;

export const BENCHMARK_CANDIDATES: readonly BenchmarkCandidate[] = [
  BASELINE_CANDIDATE,
  // --- WebLLM primary candidates -----------------------------------------
  {
    id: 'webllm-qwen3-0.6b',
    displayName: 'Qwen3 0.6B',
    family: 'Qwen3',
    parameterSize: '0.6B',
    quantization: 'q4f16_1',
    runtime: 'webllm',
    runtimeModelId: 'Qwen3-0.6B-q4f16_1-MLC',
    labAvailability: 'RUNNABLE',
    provisionalClass: 'ULTRA_LIGHT',
    license: 'Apache-2.0',
    japaneseSupport: 'listed',
    downloadSizeBytes: null,
    estimatedVramBytes: mib(1403.34),
    requiredGpuFeatures: [],
    lowResourceRequired: true,
    contextWindow: 4096,
    supportsThinkingToggle: true,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa: QWEN3_NOTE,
    promptTokenMeasurement: QWEN3_PROMPT_TOKENS,
  },
  {
    id: 'webllm-qwen3-1.7b',
    displayName: 'Qwen3 1.7B',
    family: 'Qwen3',
    parameterSize: '1.7B',
    quantization: 'q4f16_1',
    runtime: 'webllm',
    runtimeModelId: 'Qwen3-1.7B-q4f16_1-MLC',
    labAvailability: 'RUNNABLE',
    provisionalClass: 'LIGHT',
    license: 'Apache-2.0',
    japaneseSupport: 'listed',
    downloadSizeBytes: null,
    estimatedVramBytes: mib(2036.66),
    requiredGpuFeatures: [],
    lowResourceRequired: true,
    contextWindow: 4096,
    supportsThinkingToggle: true,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa: QWEN3_NOTE,
    promptTokenMeasurement: QWEN3_PROMPT_TOKENS,
  },
  {
    id: 'webllm-qwen3-4b',
    displayName: 'Qwen3 4B',
    family: 'Qwen3',
    parameterSize: '4B',
    quantization: 'q4f16_1',
    runtime: 'webllm',
    runtimeModelId: 'Qwen3-4B-q4f16_1-MLC',
    labAvailability: 'RUNNABLE',
    provisionalClass: 'STANDARD',
    license: 'Apache-2.0',
    japaneseSupport: 'listed',
    downloadSizeBytes: null,
    estimatedVramBytes: mib(3431.59),
    requiredGpuFeatures: [],
    lowResourceRequired: true,
    contextWindow: 4096,
    supportsThinkingToggle: true,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa: QWEN3_NOTE,
    promptTokenMeasurement: QWEN3_PROMPT_TOKENS,
  },
  {
    id: 'webllm-qwen3-8b',
    displayName: 'Qwen3 8B',
    family: 'Qwen3',
    parameterSize: '8B',
    quantization: 'q4f16_1',
    runtime: 'webllm',
    runtimeModelId: 'Qwen3-8B-q4f16_1-MLC',
    labAvailability: 'RUNNABLE',
    provisionalClass: 'QUALITY',
    license: 'Apache-2.0',
    japaneseSupport: 'listed',
    downloadSizeBytes: null,
    estimatedVramBytes: mib(5695.78),
    requiredGpuFeatures: [],
    lowResourceRequired: false,
    contextWindow: 4096,
    supportsThinkingToggle: true,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa: QWEN3_NOTE,
    promptTokenMeasurement: QWEN3_PROMPT_TOKENS,
  },
  // --- Cross-family candidates --------------------------------------------
  {
    id: 'webllm-llama-3.2-1b-instruct',
    displayName: 'Llama 3.2 1B Instruct',
    family: 'Llama 3.2',
    parameterSize: '1B',
    quantization: 'q4f16_1',
    runtime: 'webllm',
    runtimeModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    labAvailability: 'RUNNABLE',
    provisionalClass: 'EXPERIMENTAL',
    license: 'Llama 3.2 Community License',
    japaneseSupport: 'not-listed',
    downloadSizeBytes: null,
    estimatedVramBytes: mib(879.04),
    requiredGpuFeatures: [],
    lowResourceRequired: true,
    contextWindow: 4096,
    supportsThinkingToggle: false,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa: '公式の対応言語に日本語が含まれない。日本語品質は実測で確認する。',
  },
  {
    id: 'webllm-phi-4-mini-instruct',
    displayName: 'Phi-4-mini-instruct',
    family: 'Phi-4',
    parameterSize: '3.8B',
    quantization: 'q4f16_1',
    runtime: 'webllm',
    runtimeModelId: 'Phi-4-mini-instruct-q4f16_1-MLC',
    labAvailability: 'RUNNABLE',
    provisionalClass: 'EXPERIMENTAL',
    license: 'MIT',
    japaneseSupport: 'listed',
    downloadSizeBytes: null,
    estimatedVramBytes: mib(3437.58),
    requiredGpuFeatures: [],
    lowResourceRequired: false,
    contextWindow: 4096,
    supportsThinkingToggle: false,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa: 'WebLLM の prebuilt に含まれる。',
  },
  {
    id: 'webllm-qwen3.5-4b',
    displayName: 'Qwen3.5 4B',
    family: 'Qwen3.5',
    parameterSize: '4B',
    quantization: 'q4f16_1',
    runtime: 'webllm',
    runtimeModelId: 'Qwen3.5-4B-q4f16_1-MLC',
    labAvailability: 'RUNNABLE',
    provisionalClass: 'EXPERIMENTAL',
    license: 'Apache-2.0',
    japaneseSupport: 'listed',
    downloadSizeBytes: null,
    estimatedVramBytes: mib(3867.82),
    requiredGpuFeatures: [],
    lowResourceRequired: false,
    contextWindow: 4096,
    supportsThinkingToggle: true,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa:
      'WebLLM の prebuilt に含まれる（max_history_size=1）。enable_thinking は WebLLM 上 Qwen3 向けと記載されており、Qwen3.5 での効き方は未検証。',
  },
  {
    id: 'gemma-3n-e2b-it',
    displayName: 'Gemma 3n E2B IT',
    family: 'Gemma 3n',
    parameterSize: 'E2B（実効 2B）',
    quantization: null,
    runtime: 'transformers-js',
    runtimeModelId: null,
    labAvailability: 'EXPERIMENTAL',
    provisionalClass: 'EXPERIMENTAL',
    license: 'Gemma Terms of Use',
    japaneseSupport: 'unknown',
    downloadSizeBytes: null,
    estimatedVramBytes: null,
    requiredGpuFeatures: [],
    lowResourceRequired: null,
    contextWindow: null,
    supportsThinkingToggle: false,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa:
      'WebLLM の prebuilt に無い。Transformers.js（ONNX 版）または LiteRT-LM / MediaPipe LLM Inference（Other browser runtime）が必要。Runtime の追加は人間の承認を経てから。',
  },
  {
    id: 'gemma-3n-e4b-it',
    displayName: 'Gemma 3n E4B IT',
    family: 'Gemma 3n',
    parameterSize: 'E4B（実効 4B）',
    quantization: null,
    runtime: 'transformers-js',
    runtimeModelId: null,
    labAvailability: 'EXPERIMENTAL',
    provisionalClass: 'EXPERIMENTAL',
    license: 'Gemma Terms of Use',
    japaneseSupport: 'unknown',
    downloadSizeBytes: null,
    estimatedVramBytes: null,
    requiredGpuFeatures: [],
    lowResourceRequired: null,
    contextWindow: null,
    supportsThinkingToggle: false,
    adoptionStatus: 'NOT_EVALUATED',
    notesJa:
      'E2B と同じく追加の Runtime が必要。E2B より大きく、モバイルでは現実的でない可能性が高い（未計測）。',
  },
];

export function candidateById(id: string): BenchmarkCandidate | undefined {
  return BENCHMARK_CANDIDATES.find((candidate) => candidate.id === id);
}
