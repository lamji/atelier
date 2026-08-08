import type { Monaco } from "@monaco-editor/react";
import { bridge } from "@/services/bridge-client";

// monaco-editor isn't a direct dependency (pnpm strict layout), so the
// model/position types are derived from @monaco-editor/react's Monaco.
type TextModel = ReturnType<Monaco["editor"]["getModels"]>[number];
type CursorPosition = InstanceType<Monaco["Position"]>;

/** Directory contents move rarely mid-edit; a short cache keeps "@" snappy. */
const DIR_TTL_MS = 15_000;

interface DirEntry {
  name: string;
  isDir: boolean;
}

const cache = new Map<string, { entries: DirEntry[]; at: number }>();
let registered = false;

/**
 * One directory level, straight from the agent.
 *
 * This used to slice a level out of the flat `fs.files` list, but that call
 * walks depth-first and stops at 8000 paths — on a large checkout the cap
 * can be spent inside the first subtree, so the root listing came back
 * missing most of its own entries (and every directory that sorts after
 * the one that ate the budget). `fs.list` answers for exactly one level,
 * so the cap cannot apply and folders show up whatever the repo's size.
 */
async function entriesAt(dir: string): Promise<DirEntry[]> {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.entries;

  const { entries } = await bridge.rpc("fs.list", { path: dir || "." });
  const mapped: DirEntry[] = entries.map((entry) => ({
    name: entry.name,
    isDir: entry.type === "dir",
  }));
  // Dirs first, then files, each alphabetical.
  mapped.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
  cache.set(dir, { entries: mapped, at: Date.now() });
  return mapped;
}

/** Switching projects makes every cached listing wrong. */
export function clearMentionCache(): void {
  cache.clear();
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

      // A listing that fails (deleted folder, agent mid-restart) must close
      // the menu quietly — a rejected provider makes Monaco drop the whole
      // suggest session, so "@" looks broken until the editor is remounted.
      let entries: DirEntry[];
      try {
        entries = await entriesAt(dir);
      } catch {
        return { suggestions: [] };
      }

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
