/**
 * ローカル AI モデルのカタログ（Model Catalog）。
 *
 * 利用者は将来、複数のローカル AI モデルから選び、容量・性能・特徴を見て、明示的に
 * ダウンロードし、使うモデルを選び、切り替え、不要なものを削除する。
 * ここはその「選べるモデルの一覧」の型と検証だけを持つ。
 *
 * - 具体的なモデル名（系列名・配布元の ID）は、**このカタログのデータにだけ**書く。
 *   アプリの他の場所は `LocalAiModelDefinition` と `LocalAiModelClass` だけを見る。
 * - 現時点のカタログは**空**（実モデルは未導入）。追加は人間の承認を経てから。
 * - Decision Engine・戦術データ・利用者データには依存しない。
 */

/** モデルの区分。パラメータ数は目安で、固定の仕様ではない。 */
export const LOCAL_AI_MODEL_CLASSES = [
  'ULTRA_LIGHT',
  'LIGHT',
  'STANDARD',
  'QUALITY',
  'EXPERIMENTAL',
] as const;

export type LocalAiModelClass = (typeof LOCAL_AI_MODEL_CLASSES)[number];

export interface LocalAiModelClassProfile {
  readonly labelJa: string;
  /** パラメータ規模の目安（固定仕様ではない）。 */
  readonly parameterScaleHint: string;
  /** 想定する利用環境・用途。 */
  readonly intendedForJa: string;
}

export const LOCAL_AI_MODEL_CLASS_PROFILES: Readonly<
  Record<LocalAiModelClass, LocalAiModelClassProfile>
> = {
  ULTRA_LIGHT: {
    labelJa: '超軽量',
    parameterScaleHint: '0.5〜1B 級（目安）',
    intendedForJa: '低スペック端末・スマートフォン',
  },
  LIGHT: {
    labelJa: '軽量',
    parameterScaleHint: '1〜2B 級（目安）',
    intendedForJa: '速度重視',
  },
  STANDARD: {
    labelJa: '標準',
    parameterScaleHint: '3〜4B 級（目安）',
    intendedForJa: '品質と速度のバランス',
  },
  QUALITY: {
    labelJa: '高品質',
    parameterScaleHint: '7〜8B 級など（目安）',
    intendedForJa: '高性能 PC 向け',
  },
  EXPERIMENTAL: {
    labelJa: '実験',
    parameterScaleHint: '不定',
    intendedForJa: '新しいモデルの評価用',
  },
};

export const LOCAL_AI_MODEL_STATUSES = ['supported', 'experimental', 'deprecated'] as const;
export type LocalAiModelStatus = (typeof LOCAL_AI_MODEL_STATUSES)[number];

export interface LocalAiModelCapabilities {
  /** CHECKOUT / SETUP の判断理由の説明。 */
  readonly explanation: boolean;
  /** GAME REVIEW・練習履歴の要約。 */
  readonly review: boolean;
  /** 「なぜ？」への回答・学習フィードバック。 */
  readonly coach: boolean;
}

export interface LocalAiModelRequirements {
  readonly webGpu?: boolean;
  readonly recommendedMemoryBytes?: number;
}

/** カタログに載るモデル 1 件。 */
export interface LocalAiModelDefinition {
  /** アプリ内の安定した ID（保存する activeModelId はこれ）。 */
  readonly id: string;
  readonly displayName: string;
  readonly modelClass: LocalAiModelClass;
  /** このモデルを扱う Model Runtime の ID（`LocalModelRuntime.id`）。 */
  readonly runtimeId: string;
  /** Runtime に渡すモデル識別子（配布元の ID など）。アプリはこの値を解釈しない。 */
  readonly modelId: string;
  /** 表示用のパラメータ規模（例: "1.5B"）。 */
  readonly parameterClass?: string;
  readonly downloadSizeBytes?: number;
  readonly estimatedMemoryBytes?: number;
  readonly contextWindow?: number;
  readonly capabilities: LocalAiModelCapabilities;
  readonly requirements?: LocalAiModelRequirements;
  readonly status: LocalAiModelStatus;
}

export interface LocalAiModelCatalog {
  readonly models: readonly LocalAiModelDefinition[];
  byId(id: string): LocalAiModelDefinition | undefined;
  byClass(modelClass: LocalAiModelClass): readonly LocalAiModelDefinition[];
}

function isNonNegativeFinite(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/** 1 件の定義の問題点（空なら正しい）。 */
export function problemsOfModelDefinition(definition: LocalAiModelDefinition): string[] {
  const problems: string[] = [];
  const at = `model "${definition.id}"`;
  if (typeof definition.id !== 'string' || definition.id.trim().length === 0) problems.push('id が空です。');
  if (typeof definition.displayName !== 'string' || definition.displayName.trim().length === 0) {
    problems.push(`${at}: displayName が空です。`);
  }
  if (!(LOCAL_AI_MODEL_CLASSES as readonly string[]).includes(definition.modelClass)) {
    problems.push(`${at}: 未知の modelClass ${String(definition.modelClass)}`);
  }
  if (!(LOCAL_AI_MODEL_STATUSES as readonly string[]).includes(definition.status)) {
    problems.push(`${at}: 未知の status ${String(definition.status)}`);
  }
  if (typeof definition.runtimeId !== 'string' || definition.runtimeId.length === 0) {
    problems.push(`${at}: runtimeId が空です。`);
  }
  if (typeof definition.modelId !== 'string' || definition.modelId.length === 0) {
    problems.push(`${at}: modelId が空です。`);
  }
  for (const key of ['downloadSizeBytes', 'estimatedMemoryBytes', 'contextWindow'] as const) {
    if (!isNonNegativeFinite(definition[key])) problems.push(`${at}: ${key} が不正です。`);
  }
  if (!isNonNegativeFinite(definition.requirements?.recommendedMemoryBytes)) {
    problems.push(`${at}: requirements.recommendedMemoryBytes が不正です。`);
  }
  const capabilities = definition.capabilities;
  if (
    typeof capabilities !== 'object' ||
    capabilities === null ||
    typeof capabilities.explanation !== 'boolean' ||
    typeof capabilities.review !== 'boolean' ||
    typeof capabilities.coach !== 'boolean'
  ) {
    problems.push(`${at}: capabilities が不正です。`);
  }
  return problems;
}

/**
 * 定義の一覧からカタログを作る。ID の重複や不正な定義があれば例外を投げる
 * （カタログは静的データなので、誤りはビルド・テストの時点で止める）。
 */
export function createModelCatalog(
  definitions: readonly LocalAiModelDefinition[],
): LocalAiModelCatalog {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    problems.push(...problemsOfModelDefinition(definition));
    if (seen.has(definition.id)) problems.push(`model "${definition.id}": id が重複しています。`);
    seen.add(definition.id);
  }
  if (problems.length > 0) {
    throw new Error(`Model Catalog が不正です:\n${problems.join('\n')}`);
  }
  const models = Object.freeze(definitions.map((definition) => Object.freeze({ ...definition })));
  const index = new Map(models.map((definition) => [definition.id, definition]));
  return Object.freeze({
    models,
    byId: (id: string) => index.get(id),
    byClass: (modelClass: LocalAiModelClass) =>
      models.filter((definition) => definition.modelClass === modelClass),
  });
}

/**
 * 既定のカタログ。**実モデルは未導入なので空**。
 * モデルを追加する PR は `docs/AI_EVALUATION.md` の評価と人間の承認を経てから。
 */
export const DEFAULT_MODEL_CATALOG: LocalAiModelCatalog = createModelCatalog([]);
