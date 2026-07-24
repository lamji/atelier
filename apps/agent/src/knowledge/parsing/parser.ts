import path from "node:path";
import { createRequire } from "node:module";
import { Language, Parser, type Tree } from "web-tree-sitter";

/**
 * web-tree-sitter (WASM) bootstrap. Grammar wasm files come from the
 * tree-sitter-wasms package; Language objects are cached per grammar and
 * Parser.init() is memoized. No node-gyp, no native builds.
 */
let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();

const require = createRequire(import.meta.url);

function wasmDir(): string {
  return path.join(
    path.dirname(require.resolve("tree-sitter-wasms/package.json")),
    "out"
  );
}

export async function initTreeSitter(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

export async function loadLanguage(grammar: string): Promise<Language> {
  await initTreeSitter();
  const cached = languageCache.get(grammar);
  if (cached) return cached;
  const wasmPath = path.join(wasmDir(), `tree-sitter-${grammar}.wasm`);
  const lang = await Language.load(wasmPath);
  languageCache.set(grammar, lang);
  return lang;
}

/** Parse source with a fresh parser (cheap; Language is the heavy part). */
export async function parseSource(
  grammar: string,
  source: string
): Promise<Tree | null> {
  const lang = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  parser.delete();
  return tree;
}
