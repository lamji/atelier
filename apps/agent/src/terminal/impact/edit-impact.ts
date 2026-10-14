import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import { extractTsJs } from "../../knowledge/parsing/extractor.js";
import type { ExtractedSymbol } from "../../knowledge/parsing/extracted.js";
import { languageForFile } from "../../knowledge/parsing/languages.js";
import { parseSource } from "../../knowledge/parsing/parser.js";

/**
 * What an edit to one file can break, found with tree-sitter.
 *
 * Runs before a CLI agent edits a file (the impact-check skill's
 * PreToolUse hook) and again after a fix (`--diff`). It finds the functions
 * the edit lands in, then every place in the repo that uses them, and
 * reads each of those places with tree-sitter so a name in a comment, a
 * string, or prose is not taken for a use.
 *
 * Cheap enough to run on every edit: no index is built. `git grep` narrows
 * the repo to the files that mention a name, and only those are parsed.
 */

export interface ImpactSymbol {
  name: string;
  kind: string;
  exported: boolean;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export interface ImpactSite {
  /** Repo-relative, forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  kind: "call" | "import" | "reference";
  /** The function or component the use sits in, when there is one. */
  inside: string | null;
  text: string;
}

export interface EditImpact {
  file: string;
  symbols: ImpactSymbol[];
  sites: ImpactSite[];
  /** Test files among the sites. */
  tests: string[];
  /** More uses exist than are listed. */
  truncated: boolean;
}

/** Files parsed for uses, and sites listed, at most. */
const MAX_FILES = 50;
const MAX_SITES = 60;
const CODE_PATHSPECS = [
  "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs",
];
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "type_identifier",
]);
/** A use inside one of these is text about the name, not the name. */
const TEXT_TYPES = new Set([
  "comment",
  "string",
  "string_fragment",
  "template_string",
  "regex",
]);
const DECLARATION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "method_definition",
  "variable_declarator",
  "public_field_definition",
]);

function repoRootOf(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return dir;
  }
}

function toRel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Rows (0-based, inclusive) an edit's old text occupies in `content`. */
function rowsOf(content: string, text: string): [number, number] | null {
  const needle = text.replace(/\r\n/g, "\n");
  const index = content.indexOf(needle);
  if (!needle.trim() || index === -1) return null;
  const start = content.slice(0, index).split("\n").length - 1;
  return [start, start + needle.split("\n").length - 1];
}

function size(symbol: ExtractedSymbol): number {
  return symbol.endRow - symbol.startRow;
}

/** The innermost symbols an edit's rows land in. */
function touched(
  symbols: ExtractedSymbol[],
  ranges: Array<[number, number]>
): ExtractedSymbol[] {
  const found = new Set<ExtractedSymbol>();
  for (const [start, end] of ranges) {
    const hits = symbols.filter(
      (symbol) => symbol.startRow <= end && symbol.endRow >= start
    );
    for (const hit of hits) {
      const holdsAnother = hits.some(
        (other) =>
          other !== hit &&
          size(other) < size(hit) &&
          other.startRow >= hit.startRow &&
          other.endRow <= hit.endRow
      );
      if (!holdsAnother) found.add(hit);
    }
  }
  return [...found].sort((a, b) => a.startRow - b.startRow);
}

/** Files in the repo whose code mentions one of `names`, tracked or new. */
function filesMentioning(root: string, names: string[]): string[] {
  if (names.length === 0) return [];
  const args = ["grep", "-l", "-I", "-w", "--untracked"];
  for (const name of names) args.push("-e", name);
  args.push("--", ...CODE_PATHSPECS);
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    // Exit 1 is "no match"; anything else (no git) leaves the file alone.
    return [];
  }
}

function within(node: Node, types: Set<string>): Node | null {
  for (let cur: Node | null = node; cur; cur = cur.parent) {
    if (types.has(cur.type)) return cur;
  }
  return null;
}

/** What the name at `node` is doing there, or null when it is not a use. */
function classify(node: Node): ImpactSite["kind"] | null {
  if (!IDENTIFIER_TYPES.has(node.type)) return null;
  if (within(node, TEXT_TYPES)) return null;
  const parent = node.parent;
  if (!parent) return "reference";
  if (within(node, new Set(["import_statement"]))) return "import";
  // The name being declared, not used.
  if (
    DECLARATION_TYPES.has(parent.type) &&
    parent.childForFieldName("name")?.id === node.id
  ) {
    return null;
  }
  const callee = parent.type === "member_expression" &&
    parent.childForFieldName("property")?.id === node.id
    ? parent
    : node;
  const call = callee.parent;
  if (
    call &&
    (call.type === "call_expression" || call.type === "new_expression") &&
    (call.childForFieldName("function") ?? call.childForFieldName("constructor"))
      ?.id === callee.id
  ) {
    return "call";
  }
  if (
    parent.type === "jsx_opening_element" ||
    parent.type === "jsx_self_closing_element"
  ) {
    return "call";
  }
  return "reference";
}

/** The innermost function-like symbol holding `row`. */
function enclosing(symbols: ExtractedSymbol[], row: number): string | null {
  let best: ExtractedSymbol | null = null;
  for (const symbol of symbols) {
    if (symbol.startRow > row || symbol.endRow < row) continue;
    if (symbol.endRow === symbol.startRow && symbol.startRow === row) {
      // A one-line declaration is the line itself, not a place code runs.
      if (!/function|method|component|hook/.test(symbol.kind)) continue;
    }
    if (!best || size(symbol) < size(best)) best = symbol;
  }
  return best?.name ?? null;
}

interface Parsed {
  source: string;
  lines: string[];
  symbols: ExtractedSymbol[];
  root: Node;
}

async function parseFile(file: string): Promise<Parsed | null> {
  const lang = languageForFile(file);
  if (!lang) return null;
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const tree = await parseSource(lang.grammar, source);
  if (!tree) return null;
  return {
    source,
    lines: source.split(/\r?\n/),
    symbols: extractTsJs(tree, lang.name).symbols,
    root: tree.rootNode,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every use of `names` in one parsed file. */
function usesIn(
  rel: string,
  parsed: Parsed,
  names: string[],
  skip: Array<[number, number]>
): ImpactSite[] {
  const sites: ImpactSite[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(`\\b(${names.map(escapeRegExp).join("|")})\\b`, "g");
  parsed.lines.forEach((text, row) => {
    if (skip.some(([start, end]) => row >= start && row <= end)) return;
    for (const match of text.matchAll(pattern)) {
      const node = parsed.root.descendantForPosition({
        row,
        column: match.index ?? 0,
      });
      const kind = node ? classify(node) : null;
      if (!kind) continue;
      const key = `${row}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({
        file: rel,
        line: row + 1,
        kind,
        inside: kind === "import" ? null : enclosing(parsed.symbols, row),
        text: text.trim().slice(0, 160),
      });
    }
  });
  return sites;
}

/**
 * The impact of editing `file`. `edits` is the old text each edit replaces
 * (an Edit's old_string, a patch's removed lines); null means the whole
 * file is rewritten. `ranges` gives the edited rows directly instead.
 * Null when the file is not code tree-sitter reads, or does not exist yet.
 */
export async function analyzeEdit(args: {
  cwd: string;
  file: string;
  edits: string[] | null;
  ranges?: Array<[number, number]>;
}): Promise<EditImpact | null> {
  const file = path.resolve(args.cwd, args.file);
  const parsed = await parseFile(file);
  if (!parsed) return null;
  const root = repoRootOf(path.dirname(file));
  const rel = toRel(root, file);

  let symbols: ExtractedSymbol[];
  if (args.ranges) {
    symbols = touched(parsed.symbols, args.ranges);
  } else if (args.edits === null) {
    symbols = parsed.symbols.filter(
      (symbol) => symbol.exported && !symbol.parentQualifiedName
    );
  } else {
    const content = parsed.source.replace(/\r\n/g, "\n");
    const ranges = args.edits
      .map((edit) => rowsOf(content, edit))
      .filter((range): range is [number, number] => range !== null);
    symbols = touched(parsed.symbols, ranges);
  }
  if (symbols.length === 0) return null;

  const exported = symbols.filter((symbol) => symbol.exported);
  const ownRanges = symbols.map(
    (symbol): [number, number] => [symbol.startRow, symbol.endRow]
  );
  const sites = usesIn(rel, parsed, symbols.map((s) => s.name), ownRanges);
  const others = filesMentioning(root, [...new Set(exported.map((s) => s.name))])
    .filter((other) => other !== rel);
  let truncated = others.length > MAX_FILES;
  for (const other of others.slice(0, MAX_FILES)) {
    const theirs = await parseFile(path.join(root, other));
    if (!theirs) continue;
    sites.push(...usesIn(other, theirs, exported.map((s) => s.name), []));
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (sites.length > MAX_SITES) truncated = true;
  const listed = sites.slice(0, MAX_SITES);

  return {
    file: rel,
    symbols: symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      startLine: symbol.startRow + 1,
      endLine: symbol.endRow + 1,
    })),
    sites: listed,
    tests: [...new Set(sites.map((site) => site.file))].filter((f) =>
      TEST_FILE.test(f)
    ),
    truncated,
  };
}

/**
 * The impact as the agent reads it: `before` an edit, what it can break;
 * `after` one, which sites to re-check against what was just written.
 */
export function formatImpact(
  impact: EditImpact,
  when: "before" | "after" = "before"
): string {
  const describe = (symbol: ImpactSymbol) =>
    `${symbol.name} (${symbol.kind}${symbol.exported ? ", exported" : ""}, ` +
    `lines ${symbol.startLine}-${symbol.endLine})`;
  const files = new Set(impact.sites.map((site) => site.file)).size;
  const lines = [
    when === "after"
      ? `Atelier impact check (tree-sitter) after editing ${impact.file}.`
      : `Atelier impact check (tree-sitter) for ${impact.file}.`,
    `${when === "after" ? "Changed" : "Changing"}: ` +
      impact.symbols.map(describe).join("; "),
  ];
  if (impact.sites.length === 0) {
    lines.push("Nothing else in the repo uses it.");
  } else {
    lines.push(
      `Used at ${impact.sites.length} site(s) in ${files} file(s)` +
        `${impact.truncated ? " (more not listed)" : ""}:`,
      ...impact.sites.map(
        (site) =>
          `- ${site.file}:${site.line} ${site.kind}` +
          `${site.inside ? ` in ${site.inside}` : ""}: ${site.text}`
      )
    );
  }
  if (impact.tests.length > 0) lines.push(`Tests: ${impact.tests.join(", ")}`);
  lines.push(
    when === "after"
      ? "Re-check each site above against the change just made, update any " +
          "that no longer fits, then run the tests above."
      : "Keep every site above working: if the signature, return value or " +
          "behaviour changes, update or re-check each one. After the fix, " +
          "re-check them and run the tests above (impact-check skill)."
  );
  return lines.join("\n");
}
