import type { Node, Tree } from "web-tree-sitter";
import type { SymbolKind } from "@atelier/protocol";
import type {
  CallSite,
  ExtractedExport,
  ExtractedFile,
  ExtractedImport,
  ExtractedSymbol,
} from "./extracted.js";

/**
 * TS/TSX/JS symbol + import/export + call-site extraction by manual AST
 * walking (no tree-sitter query strings — grammar drift tolerant). Ported
 * from the myai indexer and extended with export records and Atelier's
 * richer SymbolKind set (component / hook / constant detection).
 */
export function extractTsJs(tree: Tree, lang: string): ExtractedFile {
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const exports: ExtractedExport[] = [];
  const root = tree.rootNode;
  walk(root, undefined, { symbols, imports, exports, lang });
  return { symbols, imports, exports };
}

interface Ctx {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  exports: ExtractedExport[];
  lang: string;
}

const CLASS_KINDS: Record<string, SymbolKind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
};

const CALL_TYPES = ["call_expression", "new_expression"];
const COMMENT_TYPES = ["comment"];

function named(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function fieldText(node: Node, field: string): string {
  return node.childForFieldName(field)?.text ?? "";
}

function firstLine(node: Node): string {
  const text = node.text;
  const nl = text.indexOf("\n");
  let line = nl < 0 ? text : text.slice(0, nl);
  line = line.trim();
  if (line.length > 160) line = line.slice(0, 157) + "...";
  return line;
}

function docComment(node: Node): string | undefined {
  let target = node;
  while (target.parent && target.parent.type === "export_statement") {
    target = target.parent;
  }
  const prev = target.previousNamedSibling;
  if (prev && COMMENT_TYPES.includes(prev.type)) {
    if (target.startPosition.row - prev.endPosition.row <= 1) {
      let doc = prev.text.trim();
      if (doc.length > 500) doc = doc.slice(0, 497) + "...";
      return doc;
    }
  }
  return undefined;
}

function isExported(node: Node): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (cur.type === "export_statement") return true;
    cur = cur.parent;
  }
  return false;
}

function callName(call: Node): string | undefined {
  const fn =
    call.childForFieldName("function") ?? call.childForFieldName("constructor");
  if (!fn) return undefined;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    return fieldText(fn, "property") || undefined;
  }
  return undefined;
}

/** Collect call sites inside a node body (iterative DFS). */
function collectCalls(node: Node): CallSite[] {
  const seen = new Set<string>();
  const calls: CallSite[] = [];
  const stack: Node[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (CALL_TYPES.includes(cur.type)) {
      const name = callName(cur);
      if (name) {
        const key = `${name}@${cur.startPosition.row}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push({ name, row: cur.startPosition.row });
        }
      }
    }
    for (const child of named(cur)) stack.push(child);
  }
  return calls;
}

/** Refine function/variable kinds: React component, hook, constant. */
function refineKind(
  base: SymbolKind,
  name: string,
  ctx: Ctx,
  isFn: boolean
): SymbolKind {
  if (isFn && /^use[A-Z]/.test(name)) return "hook";
  if (
    isFn &&
    /^[A-Z]/.test(name) &&
    (ctx.lang === "tsx" || ctx.lang === "javascript")
  ) {
    return "component";
  }
  if (base === "variable" && /^[A-Z0-9_]+$/.test(name)) return "constant";
  return base;
}

function push(
  ctx: Ctx,
  node: Node,
  init: {
    name: string;
    kind: SymbolKind;
    parent?: string;
    exported?: boolean;
    signature?: string;
  }
): void {
  if (!init.name) return;
  const qualifiedName = init.parent
    ? `${init.parent}.${init.name}`
    : init.name;
  ctx.symbols.push({
    name: init.name,
    qualifiedName,
    kind: init.kind,
    signature: init.signature ?? firstLine(node),
    doc: docComment(node),
    parentQualifiedName: init.parent,
    exported: init.exported ?? false,
    startRow: node.startPosition.row,
    startCol: node.startPosition.column,
    endRow: node.endPosition.row,
    endCol: node.endPosition.column,
    calls: collectCalls(node),
  });
}

function walk(node: Node, parent: string | undefined, ctx: Ctx): void {
  for (const child of named(node)) {
    visit(child, parent, ctx);
  }
}

function visit(node: Node, parent: string | undefined, ctx: Ctx): void {
  const type = node.type;

  if (type === "export_statement") {
    handleExport(node, ctx);
    walk(node, parent, ctx);
    return;
  }
  if (type === "import_statement") {
    handleImport(node, ctx);
    return;
  }

  const classKind = CLASS_KINDS[type];
  if (classKind) {
    const name = fieldText(node, "name");
    push(ctx, node, {
      name,
      kind: classKind,
      parent,
      exported: isExported(node),
    });
    const body = node.childForFieldName("body");
    if (body && name) walk(body, name, ctx);
    return;
  }

  if (
    type === "function_declaration" ||
    type === "generator_function_declaration"
  ) {
    const name = fieldText(node, "name");
    push(ctx, node, {
      name,
      kind: refineKind("function", name, ctx, true),
      parent,
      exported: isExported(node),
    });
    return;
  }

  if (type === "method_definition") {
    const name = fieldText(node, "name");
    if (name && name !== "constructor") {
      push(ctx, node, {
        name,
        kind: "method",
        parent,
        exported: parent !== undefined,
      });
    }
    return;
  }

  if (type === "type_alias_declaration") {
    push(ctx, node, {
      name: fieldText(node, "name"),
      kind: "type",
      parent,
      exported: isExported(node),
    });
    return;
  }

  if (type === "lexical_declaration" || type === "variable_declaration") {
    for (const decl of named(node)) {
      if (decl.type !== "variable_declarator") continue;
      const name = fieldText(decl, "name");
      const value = decl.childForFieldName("value");
      const isFn =
        value?.type === "arrow_function" || value?.type === "function_expression";
      const exported = isExported(node);
      // Index function values always; plain values only when exported
      // at the top level (mirrors the myai heuristic).
      if (!isFn && !(exported && parent === undefined)) continue;
      push(ctx, decl, {
        name,
        kind: refineKind(isFn ? "function" : "variable", name, ctx, isFn),
        parent,
        exported,
        signature: firstLine(node),
      });
    }
    return;
  }

  // Anything else: recurse with the same parent (module blocks, etc.).
  walk(node, parent, ctx);
}

function handleImport(node: Node, ctx: Ctx): void {
  const source = fieldText(node, "source").replace(/['"]/g, "");
  if (!source) return;
  const typeOnly = /^import\s+type\b/.test(node.text);
  const names = new Set<string>();
  for (const spec of node.descendantsOfType([
    "import_specifier",
    "namespace_import",
    "identifier",
  ])) {
    if (!spec) continue;
    if (spec.type === "import_specifier") {
      const n = fieldText(spec, "name");
      if (n) names.add(n);
    } else if (spec.type === "namespace_import") {
      const id = spec.descendantsOfType(["identifier"])[0];
      if (id) names.add(id.text);
    } else {
      // default import: identifier directly under import_clause
      if (spec.parent?.type === "import_clause") names.add(spec.text);
    }
  }
  ctx.imports.push({ specifier: source, names: [...names], typeOnly });
}

function handleExport(node: Node, ctx: Ctx): void {
  const source = fieldText(node, "source").replace(/['"]/g, "") || undefined;
  const isDefault = /^export\s+default\b/.test(node.text);

  // Re-exports are imports too — without this, barrel files (index.ts
  // with `export * from "./x"`) never connect to their targets in the
  // file graph.
  if (source) {
    const typeOnly = /^export\s+type\b/.test(node.text);
    ctx.imports.push({ specifier: source, names: [], typeOnly });
  }

  // export * from './x'
  if (/^export\s+\*/.test(node.text) && source) {
    ctx.exports.push({ exportedName: "*", isDefault: false, reExportFrom: source });
    return;
  }

  // export { a, b as c } [from './x']
  const clause = named(node).find((c) => c.type === "export_clause");
  if (clause) {
    const names: string[] = [];
    for (const spec of named(clause)) {
      if (spec.type !== "export_specifier") continue;
      const local = fieldText(spec, "name");
      const alias = fieldText(spec, "alias");
      if (source && local) names.push(local);
      ctx.exports.push({
        exportedName: alias || local,
        localName: local,
        isDefault: false,
        reExportFrom: source,
      });
    }
    // Backfill the specifier names for `export { a, b } from './x'`.
    if (source && names.length > 0) {
      const imp = ctx.imports[ctx.imports.length - 1];
      if (imp && imp.specifier === source) imp.names = names;
    }
    return;
  }

  // export [default] <declaration>
  const decl = named(node).find((c) =>
    /_declaration$/.test(c.type) || c.type === "class"
  );
  if (decl) {
    if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
      for (const d of named(decl)) {
        if (d.type !== "variable_declarator") continue;
        const name = fieldText(d, "name");
        if (name) {
          ctx.exports.push({ exportedName: name, localName: name, isDefault });
        }
      }
    } else {
      const name = fieldText(decl, "name") || (isDefault ? "default" : "");
      if (name) {
        ctx.exports.push({ exportedName: name, localName: name, isDefault });
      }
    }
    return;
  }

  // export default <expression>
  if (isDefault) {
    const expr = named(node)[0];
    const name = expr?.type === "identifier" ? expr.text : "default";
    ctx.exports.push({
      exportedName: "default",
      localName: name,
      isDefault: true,
    });
  }
}
