import type { Monaco } from "@monaco-editor/react";
import { bridge } from "@/services/bridge-client";

// monaco-editor isn't a direct dependency (pnpm strict layout), so the
// model/position types are derived from @monaco-editor/react's Monaco.
type TextModel = ReturnType<Monaco["editor"]["getModels"]>[number];
type CursorPosition = InstanceType<Monaco["Position"]>;

/** Paths move rarely mid-edit; a short cache keeps "@" typing snappy. */
const PATHS_TTL_MS = 15_000;

let cache: { paths: string[]; at: number } | null = null;
let registered = false;

async function workspacePaths(): Promise<string[]> {
  if (cache && Date.now() - cache.at < PATHS_TTL_MS) return cache.paths;
  const { files } = await bridge.rpc("fs.files", {});
  cache = { paths: files, at: Date.now() };
  return files;
}

interface DirEntry {
  name: string;
  isDir: boolean;
}

/** One directory level of the flat path list, dirs first, alphabetical. */
function entriesAt(paths: string[], dir: string): DirEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  const sorted = (set: Set<string>, isDir: boolean) =>
    [...set].sort().map((name) => ({ name, isDir }));
  return [...sorted(dirs, true), ...sorted(files, false)];
}

/**
 * The chat composer's "@" file browser, in Monaco form: one directory
 * level at a time, exactly like the chatbox. A bare "@" lists the
 * workspace root; picking a folder inserts "dir/" and reopens the menu
 * on its children; picking a file inserts its path (never the contents)
 * and replaces the "@" marker. Registered once per app.
 */
export function registerMarkdownMentions(monaco: Monaco): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("markdown", {
    triggerCharacters: ["@", "/"],
    async provideCompletionItems(model: TextModel, position: CursorPosition) {
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const at = line.lastIndexOf("@");
      const token = at === -1 ? null : line.slice(at + 1);
      if (token === null || /\s/.test(token)) return { suggestions: [] };

      // "apps/web/s" → browse "apps/web", filter by "s" (Monaco's job).
      const lastSlash = token.lastIndexOf("/");
      const dir = lastSlash === -1 ? "" : token.slice(0, lastSlash);
      const prefix = dir ? `${dir}/` : "";

      const entries = entriesAt(await workspacePaths(), dir);
      // Replace from the "@" itself, so the marker disappears on pick.
      const range = new monaco.Range(
        position.lineNumber,
        at + 1,
        position.lineNumber,
        position.column
      );
      const suggestions = entries.map((entry, index) => ({
        label: entry.isDir ? `${entry.name}/` : entry.name,
        kind: entry.isDir
          ? monaco.languages.CompletionItemKind.Folder
          : monaco.languages.CompletionItemKind.File,
        // Folders keep the "@" so the browser stays anchored for the next
        // level; only the final file pick strips the marker.
        insertText: entry.isDir
          ? `@${prefix}${entry.name}/`
          : `${prefix}${entry.name}`,
        filterText: `@${prefix}${entry.name}`,
        sortText: `${entry.isDir ? "0" : "1"}:${String(index).padStart(4, "0")}`,
        range,
        // Stepping into a folder immediately shows its children.
        command: entry.isDir
          ? { id: "editor.action.triggerSuggest", title: "browse" }
          : undefined,
      }));
      return { suggestions };
    },
  });
}
