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
const LAB_DIR = join(SRC, 'lab');
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

  it('Model Management（src/ai/models）は engine / domain / data / storage / 画面に依存しない', () => {
    const violations: string[] = [];
    for (const file of aiSources.filter((path) => path.startsWith(join(AI_DIR, 'models')))) {
      for (const statement of importsOf(readFileSync(file, 'utf8'))) {
        if (/(^|\/)(engine|domain|data|storage|geometry|components|pages|hooks)(\/|$)/.test(statement.from)) {
          violations.push(`${relative(ROOT, file)} → ${statement.from}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('AI 層を使うのは Developer Gate 配下の Lab（src/lab）と、その入口の Gate 判定（App.tsx）だけ', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC).filter((path) => !path.startsWith(AI_DIR) && !isTest(path))) {
      const inLab = file.startsWith(LAB_DIR);
      for (const statement of importsOf(readFileSync(file, 'utf8'))) {
        if (!/(^|\/)ai(\/|$)/.test(statement.from)) continue;
        if (inLab) continue;
        // 入口（App.tsx）は Developer Gate の判定だけを読む。
        if (relative(SRC, file) === 'App.tsx' && statement.from === './ai/developerGate') continue;
        violations.push(`${relative(ROOT, file)} → ${statement.from}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('Lab（src/lab）は App.tsx から遅延読み込み（動的 import）でだけ使われる', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC).filter((path) => !path.startsWith(LAB_DIR) && !isTest(path))) {
      const source = readFileSync(file, 'utf8');
      for (const statement of importsOf(source)) {
        if (/(^|\/)lab(\/|$)/.test(statement.from)) violations.push(`${relative(ROOT, file)} → ${statement.from}（静的 import）`);
      }
      for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (/(^|\/)lab(\/|$)/.test(match[1]) && relative(SRC, file) !== 'App.tsx') {
          violations.push(`${relative(ROOT, file)} → ${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('src/lab は engine / domain を読んでよいが、書き換える経路（data 層の値・storage の直接操作）を持たない', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(LAB_DIR).filter((path) => !isTest(path))) {
      const source = readFileSync(file, 'utf8');
      for (const statement of importsOf(source)) {
        if (/(^|\/)data\//.test(statement.from) && !statement.typeOnly) violations.push(`${relative(ROOT, file)} → ${statement.from}`);
      }
      if (/\blocalStorage\b/.test(source)) violations.push(`${relative(ROOT, file)}: localStorage を直接使っている`);
    }
    expect(violations).toEqual([]);
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

  it('AI の dependency は人間が承認した推論ライブラリ（WebLLM）だけで、版を固定している', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const aiPackage =
      /(web-llm|mlc-ai|transformers|xenova|huggingface|onnxruntime|llama|ggml|wllama|tensorflow|tfjs|openai|anthropic|google\/generative-ai|google\/genai|@google-ai|langchain|ollama|mistral|cohere|webgpu|mediapipe|litert)/i;
    const found = Object.keys(all).filter((name) => aiPackage.test(name));
    // PR #2（AI MODEL BENCHMARK LAB）で Benchmark 用の primary runtime 候補として追加。
    // 追加の Runtime（Transformers.js など）は docs/AI_MODEL_BENCHMARK.md の評価と人間の承認を経てから。
    expect(found).toEqual(['@mlc-ai/web-llm']);
    expect(all['@mlc-ai/web-llm']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('WebLLM は Benchmark の Runtime（webllmRuntime.ts）から動的 import でだけ読む', () => {
    const allowed = join(AI_DIR, 'benchmark', 'runtimes', 'webllmRuntime.ts');
    const violations: string[] = [];
    for (const file of sourceFiles(SRC).filter((path) => !isTest(path))) {
      const source = readFileSync(file, 'utf8');
      for (const statement of importsOf(source)) {
        if (statement.from.includes('web-llm') && !statement.typeOnly) {
          violations.push(`${relative(ROOT, file)}: 静的 import`);
        }
      }
      if (file !== allowed && source.includes('@mlc-ai/web-llm')) violations.push(relative(ROOT, file));
    }
    expect(violations).toEqual([]);
    expect(readFileSync(allowed, 'utf8')).toMatch(/import\('@mlc-ai\/web-llm'\)/);
  });

  it('具体的なモデル名をアプリのコードへ書かない（候補・カタログのデータにだけ書く）', () => {
    // 利用者向けの Model Catalog は空のまま。モデル名は Benchmark の候補データにだけ現れる。
    const allowed = new Set([join(AI_DIR, 'benchmark', 'candidates.ts')]);
    const family = /\b(qwen|llama|gemma|phi-?\d|mistral|deepseek|smollm|tinyllama)/i;
    const violations = sourceFiles(SRC)
      .filter((file) => !isTest(file) && !allowed.has(file))
      .filter((file) => family.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(violations).toEqual([]);
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
