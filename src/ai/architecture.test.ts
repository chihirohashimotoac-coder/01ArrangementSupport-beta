/**
 * AI 説明層の構造上の約束をコードで固定する。
 *
 * Engine → Evidence → Provider interface → Presentation の一方向依存。
 *
 * - engine / domain / data / storage は src/ai を import しない（AI が判断へ入り込む経路を作らない）
 * - src/ai は engine の**結果（型）と表示用の定数**だけを読み、探索・ランキング関数を呼ばない
 *   （Evidence Layer で戦術ロジックを二重実装・再計算しない）
 * - src/ai は通信しない（外部 AI API・backend を持たない）
 * - AI モデル・推論ライブラリの dependency を持たない
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function isTest(path: string): boolean {
  return /\.test\.(ts|tsx)$/.test(path);
}

interface ImportStatement {
  readonly typeOnly: boolean;
  readonly names: readonly string[];
  readonly from: string;
}

function importsOf(source: string): ImportStatement[] {
  const statements: ImportStatement[] = [];
  const pattern = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const clause = match[2];
    const braces = clause.match(/\{([\s\S]*)\}/)?.[1] ?? '';
    const names = braces
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const allTypes = names.length > 0 && names.every((name) => name.startsWith('type '));
    statements.push({ typeOnly: Boolean(match[1]) || allTypes, names, from: match[3] });
  }
  // export ... from も依存として数える。
  for (const match of source.matchAll(/export\s+(type\s+)?\{[\s\S]*?\}\s+from\s+['"]([^'"]+)['"]/g)) {
    statements.push({ typeOnly: Boolean(match[1]), names: [], from: match[2] });
  }
  return statements;
}

const AI_DIR = join(SRC, 'ai');
const aiSources = sourceFiles(AI_DIR).filter((path) => !isTest(path));

describe('依存の向き', () => {
  it('engine / domain / data / storage / geometry は src/ai を import しない', () => {
    const violations: string[] = [];
    for (const layer of ['engine', 'domain', 'data', 'storage', 'geometry']) {
      for (const file of sourceFiles(join(SRC, layer))) {
        for (const statement of importsOf(readFileSync(file, 'utf8'))) {
          if (/(^|\/)ai(\/|$)/.test(statement.from)) {
            violations.push(`${relative(ROOT, file)} → ${statement.from}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('src/ai は画面（components / pages / hooks）と保存処理を値として import しない', () => {
    const violations: string[] = [];
    for (const file of aiSources) {
      for (const statement of importsOf(readFileSync(file, 'utf8'))) {
        if (/(^|\/)(components|pages|hooks|App)(\/|$)/.test(statement.from)) {
          violations.push(`${relative(ROOT, file)} → ${statement.from}`);
        }
        if (/(^|\/)storage(\/|$)/.test(statement.from) && !statement.typeOnly) {
          violations.push(`${relative(ROOT, file)} → ${statement.from}（値の import）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('src/ai は engine の探索・評価関数を呼ばない（結果の型と表示用定数だけを読む）', () => {
    /** 値として読んでよい engine の定数（表示ラベル・判定の一覧）。 */
    const allowedEngineValues = new Set(['THROW_VERDICTS', 'THROW_VERDICT_JA']);
    const violations: string[] = [];
    for (const file of aiSources) {
      for (const statement of importsOf(readFileSync(file, 'utf8'))) {
        if (!/(^|\/)engine\//.test(statement.from) || statement.typeOnly) continue;
        for (const name of statement.names) {
          if (name.startsWith('type ')) continue;
          if (!allowedEngineValues.has(name)) {
            violations.push(`${relative(ROOT, file)}: ${name} from ${statement.from}`);
          }
        }
      }
      const source = readFileSync(file, 'utf8');
      for (const call of source.matchAll(/\b(suggestFor|rank\w+|evaluate\w+|enumerate\w+|select\w+|buildGameReview|reviewThrow)\s*\(/g)) {
        violations.push(`${relative(ROOT, file)}: ${call[1]}() を呼んでいる`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('src/ai は data 層の戦術データ（ルート表・重み・Bogey 表）を読まない', () => {
    const violations: string[] = [];
    for (const file of aiSources) {
      for (const statement of importsOf(readFileSync(file, 'utf8'))) {
        if (/(^|\/)data\//.test(statement.from) && !statement.typeOnly) {
          violations.push(`${relative(ROOT, file)} → ${statement.from}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('アプリ本体（src/ai 以外）はまだ AI 層を使っていない（既定 OFF・未公開）', () => {
    const users = sourceFiles(SRC)
      .filter((file) => !file.startsWith(AI_DIR) && !isTest(file))
      .filter((file) =>
        importsOf(readFileSync(file, 'utf8')).some((statement) =>
          /(^|\/)ai(\/|$)/.test(statement.from),
        ),
      )
      .map((file) => relative(ROOT, file));
    expect(users).toEqual([]);
  });
});

describe('通信・秘密情報・AI 依存を持たない', () => {
  it('src/ai は通信 API を使わない', () => {
    const forbidden = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|importScripts)\b|https?:\/\//;
    const violations = aiSources
      .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(violations).toEqual([]);
  });

  it('src/ai に API key・token の類が無い', () => {
    const secret = /(api[_-]?key|secret|bearer|authorization|sk-[A-Za-z0-9]{10,})/i;
    const violations = aiSources
      .filter((file) => secret.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(violations).toEqual([]);
  });

  it('AI モデル・推論ライブラリ・AI API SDK を dependency に持たない', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    const aiPackage =
      /(web-llm|mlc-ai|transformers|xenova|huggingface|onnxruntime|llama|ggml|wllama|tensorflow|tfjs|openai|anthropic|google\/generative-ai|google\/genai|@google-ai|langchain|ollama|mistral|cohere|webgpu)/i;
    expect(names.filter((name) => aiPackage.test(name))).toEqual([]);
  });

  it('モデルファイルをリポジトリへ置いていない', () => {
    const modelFile = /\.(gguf|onnx|safetensors|bin|tflite|pt|ckpt|mlc|wasm)$/i;
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', '.git', 'dist', 'dev-dist', 'playwright-report', 'test-results'].includes(name)) {
          continue;
        }
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (modelFile.test(name)) found.push(relative(ROOT, path));
      }
    };
    walk(ROOT);
    expect(found).toEqual([]);
  });
});
