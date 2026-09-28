/**
 * BROWSER STORAGE DIAGNOSTICS の構造上の約束をコードで固定する。
 *
 * 診断は OPFS / IndexedDB / Cache API へ実際に書き込み・削除するので、次を保証する。
 *
 * - 診断用の OPFS path（`01as-beta-storage-diagnostic/`）以外を削除しない
 * - 診断用の IndexedDB 以外を削除しない
 * - 診断用の Cache 以外を削除しない
 * - WebLLM の保存領域（`webllm/*`・`tvmjs-opfs-store/`）へ触れない
 * - 01AS の利用者データ（localStorage・`01as-beta:` / `oas.` のキー）へ触れない
 * - モデル・推論ライブラリ・外部の通信を使わない
 * - 診断のコードは Developer Gate 配下の Lab（src/lab）からだけ読まれる（通常の画面の bundle に入らない）
 *
 * 実際の保存領域での振る舞いは `browserAdapters.test.ts`（偽の保存 API）と
 * `e2e/gate-open/storageDiagnostics.gate-open.spec.ts`（実ブラウザ・1〜4 MiB）で確かめる。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as constants from './constants';

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');
const DIR = join(SRC, 'storageDiagnostics');
const LAB = join(SRC, 'lab');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const isTest = (path: string) => /\.test\.(ts|tsx)$/.test(path);
const diagnosticSources = sourceFiles(DIR).filter((path) => !isTest(path));
/** 保存 API を実際に操作するのは browserAdapters.ts だけ。 */
const ADAPTERS = join(DIR, 'browserAdapters.ts');

/** コメントを除いたソース（説明文の語に反応しないように）。 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `name(` の呼び出しの第 1 引数（そのままの文字列）。 */
function firstArguments(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

describe('診断用の名前', () => {
  it('作成・削除してよい名前は、すべて 01as-beta-storage-diagnostic を含む', () => {
    expect(constants.DIAGNOSTIC_NAMESPACE).toBe('01as-beta-storage-diagnostic');
    expect(constants.DIAGNOSTIC_OPFS_DIRECTORY).toBe('01as-beta-storage-diagnostic');
    expect(constants.DIAGNOSTIC_OPFS_FILE).toBe('opfs-test.bin');
    expect(constants.DIAGNOSTIC_IDB_NAME).toBe('01as-beta-storage-diagnostic');
    expect(constants.DIAGNOSTIC_IDB_STORE).toBe('chunks');
    expect(constants.DIAGNOSTIC_CACHE_NAME).toBe('01as-beta-storage-diagnostic');
    expect(constants.DIAGNOSTIC_CACHE_PATH).toContain('01as-beta-storage-diagnostic');
  });

  it('WebLLM・アプリのキャッシュ・利用者データの名前と重ならない', () => {
    const names = [constants.DIAGNOSTIC_OPFS_DIRECTORY, constants.DIAGNOSTIC_IDB_NAME, constants.DIAGNOSTIC_CACHE_NAME];
    for (const name of names) {
      expect(name.startsWith('webllm')).toBe(false);
      expect(name.startsWith('tvmjs')).toBe(false);
      expect(name.startsWith('01as-beta:')).toBe(false); // localStorage の利用者データ
      expect(name.startsWith('01as-beta-ai-model:')).toBe(false); // Model Management の保存領域
      expect(name.startsWith('01as-beta-precache')).toBe(false); // Workbox の precache
      expect(name.startsWith('oas.')).toBe(false); // Production の保存キー
    }
  });

  it('テスト用の大きさ（E2E）は 4 MiB まで、通常の選択肢は 1 GiB を既定に 2 GiB（Advanced）まで', () => {
    expect(Math.max(...constants.DIAGNOSTIC_TEST_MODE_SIZE_OPTIONS.map((option) => option.bytes))).toBe(4 * constants.MIB);
    expect(constants.DIAGNOSTIC_SIZE_OPTIONS.find((option) => option.id === constants.DEFAULT_DIAGNOSTIC_SIZE_ID)?.bytes).toBe(constants.GIB);
    expect(constants.DIAGNOSTIC_SIZE_OPTIONS.filter((option) => option.advanced).map((option) => option.bytes)).toEqual([2 * constants.GIB]);
    expect(constants.DIAGNOSTIC_SIZE_OPTIONS.filter((option) => !option.advanced).map((option) => option.bytes)).toEqual([
      256 * constants.MIB,
      512 * constants.MIB,
      constants.GIB,
    ]);
    expect(constants.DIAGNOSTIC_CHUNK_BYTES).toBe(16 * constants.MIB);
  });
});

describe('削除・作成は診断用の名前だけ（呼び出しの引数まで検査する）', () => {
  const adapters = code(ADAPTERS);

  it('OPFS: removeEntry は診断用ディレクトリだけ。作成するのは診断用ディレクトリと opfs-test.bin だけ', () => {
    expect(firstArguments(adapters, /\.removeEntry\(\s*([^,)]+)/g)).toEqual(['DIAGNOSTIC_OPFS_DIRECTORY']);
    // getDirectoryHandle / getFileHandle に渡す名前は診断用の定数だけ（root の中を列挙・走査しない）。
    expect(new Set(firstArguments(adapters, /\.getDirectoryHandle\(\s*([^,)]+)/g))).toEqual(new Set(['DIAGNOSTIC_OPFS_DIRECTORY']));
    expect(new Set(firstArguments(adapters, /\.getFileHandle\(\s*([^,)]+)/g))).toEqual(new Set(['DIAGNOSTIC_OPFS_FILE']));
    expect(adapters).not.toMatch(/\.(values|entries|keys)\s*\(\s*\)/);
  });

  it('IndexedDB: deleteDatabase / open は診断用データベースだけ', () => {
    expect(firstArguments(adapters, /\.deleteDatabase\(\s*([^,)]+)/g)).toEqual(['DIAGNOSTIC_IDB_NAME']);
    expect(firstArguments(adapters, /\bidb\.open\(\s*([^,)]+)/g)).toEqual(['DIAGNOSTIC_IDB_NAME']);
    expect(new Set(firstArguments(adapters, /\.transaction\(\s*([^,)]+)/g))).toEqual(new Set(['DIAGNOSTIC_IDB_STORE']));
  });

  it('Cache API: delete / open は診断用 cache だけ', () => {
    expect(firstArguments(adapters, /\.delete\(\s*([^,)]+)/g)).toEqual(['DIAGNOSTIC_CACHE_NAME']);
    expect(firstArguments(adapters, /cacheStorage\.open\(\s*([^,)]+)/g)).toEqual(['DIAGNOSTIC_CACHE_NAME']);
    expect(firstArguments(adapters, /cacheStorage\.has\(\s*([^,)]+)/g)).toEqual(['DIAGNOSTIC_CACHE_NAME']);
  });

  it('保存 API（削除・作成・書き込み）を呼ぶのは browserAdapters.ts だけ', () => {
    const storageCall = /\.(removeEntry|createWritable|createSyncAccessHandle|deleteDatabase|getDirectoryHandle|getFileHandle|objectStore)\s*\(|\bcaches\s*\.|\bindexedDB\s*\.|\bcreate\s*:\s*true\b/;
    const violations = [...diagnosticSources, ...sourceFiles(LAB).filter((path) => !isTest(path))]
      .filter((path) => path !== ADAPTERS)
      .filter((path) => storageCall.test(code(path)))
      .map((path) => relative(ROOT, path));
    expect(violations).toEqual([]);
  });

  it('WebLLM の保存領域・利用者データ・通信・モデルに触れない', () => {
    const forbidden: readonly [RegExp, string][] = [
      // 保存領域の名前（webllm/model・webllm/config・webllm/wasm・tvmjs-opfs-store）。説明文の「WebLLM」は対象外。
      [/['"`][^'"`\n]*(webllm\/|tvmjs)[^'"`\n]*['"`]/, 'WebLLM の保存領域の名前'],
      [/web-llm|mlc-ai/i, 'WebLLM'],
      [/\blocalStorage\b|\bsessionStorage\b/, 'localStorage / sessionStorage'],
      [/['"`]oas\.|01as-beta:|01as-beta-ai-model/, '利用者データ・Model Management の保存キー'],
      [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b|navigator\.sendBeacon|https?:\/\/(?!localhost)/, '通信'],
      [/\bclearSiteData\b|Clear-Site-Data/i, 'Clear-Site-Data'],
      [/\bcaches\s*\.\s*keys\s*\(|\.databases\s*\(\s*\)\s*\)\s*\.\s*(forEach|map)/, '保存領域を列挙して操作'],
    ];
    const violations: string[] = [];
    for (const path of diagnosticSources) {
      const source = code(path);
      for (const [pattern, label] of forbidden) {
        if (pattern.test(source)) violations.push(`${relative(ROOT, path)}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('依存の向き', () => {
  const importsOf = (source: string) => [...source.matchAll(/(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

  it('src/storageDiagnostics は engine / domain / data / storage / ai / 画面を import しない', () => {
    const violations: string[] = [];
    for (const path of diagnosticSources) {
      for (const from of importsOf(readFileSync(path, 'utf8'))) {
        if (!from.startsWith('./')) violations.push(`${relative(ROOT, path)} → ${from}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('src/storageDiagnostics を読むのは Lab（src/lab）だけ（Lab は App.tsx から遅延読み込みされる）', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(SRC).filter((file) => !isTest(file) && !file.startsWith(DIR) && !file.startsWith(LAB))) {
      const source = readFileSync(path, 'utf8');
      if (/storageDiagnostics/.test(source)) violations.push(relative(ROOT, path));
    }
    expect(violations).toEqual([]);
  });

  it('画面（src/lab）は Fake Adapter を読まない（本番の画面はブラウザの Adapter だけを使う）', () => {
    const violations = sourceFiles(LAB)
      .filter((path) => !isTest(path))
      .filter((path) => /storageDiagnostics\/fakeAdapter/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(violations).toEqual([]);
  });
});
