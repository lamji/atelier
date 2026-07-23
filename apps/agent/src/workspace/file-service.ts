import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "@atelier/shared";
import type {
  Diff,
  FileEntry,
  FileTreeNode,
  SearchMatch,
} from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import type { PathGuard } from "./path-guard.js";
import type { WorkspaceIgnore } from "./ignore.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_TREE_NODES = 10_000;

export interface WriteOptions {
  taskId?: string;
}

/** Callback so the watcher can label agent-originated changes. */
export type AgentWriteNotifier = (relPath: string) => void;

export class FileService {
  private notifyAgentWrite: AgentWriteNotifier = () => {};

  constructor(
    private guard: PathGuard,
    private ig: WorkspaceIgnore,
    private bus: EventBus
  ) {}

  onAgentWrite(notifier: AgentWriteNotifier): void {
    this.notifyAgentWrite = notifier;
  }

  async tree(relPath = "", depth = Infinity): Promise<FileTreeNode> {
    const rootAbs = this.guard.toAbsolute(relPath || ".");
    const rootRel = relPath ? this.guard.toRelative(rootAbs) : "";
    const budget = { nodes: 0 };
    const root: FileTreeNode = {
      path: rootRel,
      name: rootRel ? path.basename(rootAbs) : path.basename(this.rootName()),
      type: "dir",
      children: await this.walkDir(rootAbs, depth, budget),
    };
    return root;
  }

  private rootName(): string {
    return this.guard.toAbsolute(".");
  }

  private async walkDir(
    absDir: string,
    depth: number,
    budget: { nodes: number }
  ): Promise<FileTreeNode[]> {
    if (depth <= 0 || budget.nodes >= MAX_TREE_NODES) return [];
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: FileTreeNode[] = [];
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (budget.nodes >= MAX_TREE_NODES) break;
      const abs = path.join(absDir, entry.name);
      const isDir = entry.isDirectory();
      if (this.ig.ignoresAbsolute(abs, isDir)) continue;
      if (!isDir && !entry.isFile()) continue;
      budget.nodes += 1;
      const rel = this.guard.toRelative(abs);
      if (isDir) {
        nodes.push({
          path: rel,
          name: entry.name,
          type: "dir",
          children: await this.walkDir(abs, depth - 1, budget),
        });
      } else {
        nodes.push({ path: rel, name: entry.name, type: "file" });
      }
    }
    return nodes;
  }

  async list(relPath: string): Promise<FileEntry[]> {
    const absDir = this.guard.toAbsolute(relPath || ".");
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const isDir = entry.isDirectory();
      if (this.ig.ignoresAbsolute(abs, isDir)) continue;
      if (!isDir && !entry.isFile()) continue;
      const stat = await fs.stat(abs);
      result.push({
        path: this.guard.toRelative(abs),
        name: entry.name,
        type: isDir ? "dir" : "file",
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
    return result;
  }

  async stat(relPath: string): Promise<FileEntry> {
    const abs = this.guard.toAbsolute(relPath);
    const stat = await fs.stat(abs);
    return {
      path: this.guard.toRelative(abs),
      name: path.basename(abs),
      type: stat.isDirectory() ? "dir" : "file",
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  }

  async readFile(relPath: string): Promise<{ content: string; mtime: number }> {
    const abs = this.guard.toAbsolute(relPath);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`File too large (${stat.size} bytes): ${relPath}`);
    }
    const buffer = await fs.readFile(abs);
    if (isBinary(buffer)) {
      throw new Error(`Binary file: ${relPath}`);
    }
    return { content: buffer.toString("utf8"), mtime: stat.mtimeMs };
  }

  async writeFile(
    relPath: string,
    content: string,
    opts: WriteOptions = {}
  ): Promise<Diff> {
    const abs = this.guard.toAbsolute(relPath);
    const wirePath = this.guard.toRelative(abs);
    let before = "";
    try {
      before = (await this.readFile(wirePath)).content;
    } catch {
      // new file (or binary — overwrite refused below)
      const exists = await fs
        .stat(abs)
        .then(() => true)
        .catch(() => false);
      if (exists) throw new Error(`Refusing to overwrite non-text file: ${relPath}`);
    }
    return this.applyEdit(abs, wirePath, before, content, opts);
  }

  async replaceCode(
    relPath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
    opts: WriteOptions = {}
  ): Promise<Diff> {
    const abs = this.guard.toAbsolute(relPath);
    const wirePath = this.guard.toRelative(abs);
    const { content: before } = await this.readFile(wirePath);
    const count = countOccurrences(before, oldString);
    if (count === 0) {
      throw new Error(`oldString not found in ${relPath}`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `oldString occurs ${count} times in ${relPath}; pass replaceAll or a ` +
          "more specific string"
      );
    }
    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);
    return this.applyEdit(abs, wirePath, before, after, opts);
  }

  private async applyEdit(
    abs: string,
    wirePath: string,
    before: string,
    after: string,
    opts: WriteOptions
  ): Promise<Diff> {
    const diff: Diff = {
      id: newId("diff"),
      taskId: opts.taskId,
      path: wirePath,
      before,
      after,
      hunks: [],
      createdAt: Date.now(),
      applied: false,
    };
    this.bus.publish("diff.created", diff, opts.taskId);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    this.notifyAgentWrite(wirePath);
    await fs.writeFile(abs, after, "utf8");
    diff.applied = true;
    this.bus.publish(
      "edit.applied",
      { path: wirePath, diffId: diff.id },
      opts.taskId
    );
    return diff;
  }

  async search(
    query: string,
    glob?: string,
    maxResults = 200,
    regex = false
  ): Promise<SearchMatch[]> {
    const matcher = regex
      ? new RegExp(query, "i")
      : new RegExp(escapeRegex(query), "i");
    const globRe = glob ? globToRegex(glob) : null;
    const matches: SearchMatch[] = [];
    await this.searchDir(this.guard.toAbsolute("."), matcher, globRe, matches, maxResults);
    return matches;
  }

  private async searchDir(
    absDir: string,
    matcher: RegExp,
    globRe: RegExp | null,
    matches: SearchMatch[],
    maxResults: number
  ): Promise<void> {
    if (matches.length >= maxResults) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      const abs = path.join(absDir, entry.name);
      const isDir = entry.isDirectory();
      if (this.ig.ignoresAbsolute(abs, isDir)) continue;
      if (isDir) {
        await this.searchDir(abs, matcher, globRe, matches, maxResults);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = this.guard.toRelative(abs);
      if (globRe && !globRe.test(rel)) continue;
      let buffer: Buffer;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
        buffer = await fs.readFile(abs);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let row = 0; row < lines.length; row++) {
        const line = lines[row]!;
        const m = matcher.exec(line);
        if (m) {
          matches.push({
            path: rel,
            row: row + 1,
            col: m.index + 1,
            line: line.length > 300 ? line.slice(0, 300) : line,
          });
          if (matches.length >= maxResults) return;
        }
      }
    }
  }
}

function isBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/** Minimal glob: ** spans directories, * stays in one segment, ? one char. */
function globToRegex(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      out += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, "i");
}
