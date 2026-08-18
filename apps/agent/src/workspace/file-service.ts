import fs from "node:fs/promises";
import path from "node:path";
import { newId, pathDirname } from "@atelier/shared";
import type {
  Diff,
  FileEntry,
  FileTreeNode,
  MarkdownFile,
  MarkdownStatus,
  SearchMatch,
} from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import { workspaceFsError } from "./fs-error.js";
import type { PathGuard } from "./path-guard.js";
import type { WorkspaceIgnore } from "./ignore.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_TREE_NODES = 10_000;

/** Caps for the markdown catalog: file count, head bytes, blurb length. */
const MAX_MD_FILES = 500;
const MD_HEAD_BYTES = 4096;
const MAX_MD_DESCRIPTION = 140;

/** The app's own notes/prompt cache inside the workspace. */
const MD_DIR = ".atelier";

/** Depth/width caps for the "did you mean" scan on a missing directory. */
const NEARBY_DEPTH = 3;
const NEARBY_BUDGET = 4000;
const MAX_SUGGESTIONS = 6;
const MAX_SIBLINGS = 24;

export interface WriteOptions {
  taskId?: string;
}

/** The shape of a `file.changed` event's `type` field. */
type FileChangeType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

/** A markdown note in the app's own cache — outside the watcher's tree. */
function isNotePath(relPath: string): boolean {
  const posix = relPath.replace(/\\/g, "/");
  return posix.startsWith(".atelier/") && /\.md$/i.test(posix);
}

/**
 * A directory listing that survives a wrong path: when the requested
 * directory does not exist, the nearest existing ancestor is listed
 * instead and `note` says exactly what was missing. A hard error tells a
 * model nothing it can act on; real sibling names let it self-correct in
 * the same turn.
 */
export interface ModelListing {
  /** The directory actually listed (workspace-relative, "" = root). */
  path: string;
  entries: FileEntry[];
  /** Set only when it differs from `path`. */
  requested?: string;
  note?: string;
}

/** Callback so the watcher can label agent-originated changes. */
export type AgentWriteNotifier = (relPath: string) => void;

/** Pre-write gate (hooks): throw to refuse the write before it applies. */
export type WriteGuard = (
  relPath: string,
  nextContent: string,
  prevContent: string,
  taskId?: string
) => Promise<void>;

export class FileService {
  private notifyAgentWrite: AgentWriteNotifier = () => {};
  private writeGuard: WriteGuard = async () => {};

  constructor(
    private guard: PathGuard,
    private ig: WorkspaceIgnore,
    private bus: EventBus
  ) {}

  onAgentWrite(notifier: AgentWriteNotifier): void {
    this.notifyAgentWrite = notifier;
  }

  setWriteGuard(guard: WriteGuard): void {
    this.writeGuard = guard;
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

  /**
   * Flat list of every non-ignored file path (workspace-relative), for
   * the composer's "@" mention picker. Capped so a huge repo can't flood
   * the wire — the client fuzzy-filters what it gets.
   */
  async allFiles(limit = 8000): Promise<string[]> {
    const out: string[] = [];
    await this.collectFiles(this.guard.toAbsolute("."), out, limit);
    return out;
  }

  private async collectFiles(
    absDir: string,
    out: string[],
    limit: number
  ): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const abs = path.join(absDir, entry.name);
      const isDir = entry.isDirectory();
      if (this.ig.ignoresAbsolute(abs, isDir)) continue;
      if (isDir) await this.collectFiles(abs, out, limit);
      else if (entry.isFile()) out.push(this.guard.toRelative(abs));
    }
  }

  /**
   * Catalog of the .md files under the workspace's `.atelier` folder —
   * the app's own notes/prompt cache — with a display title and one-line
   * blurb, computed here so the client gets it in one call. The walk
   * skips ignore rules on purpose: `.atelier` is typically gitignored,
   * and gitignore must not hide the app's own data from the app.
   */
  async markdownFiles(limit = MAX_MD_FILES): Promise<MarkdownFile[]> {
    const md: string[] = [];
    await this.collectMarkdown(this.guard.toAbsolute(MD_DIR), md, limit);
    const out: MarkdownFile[] = [];
    for (const rel of md) {
      // null = the file vanished between the walk and the read; skip it.
      const file = await this.markdownFile(rel);
      if (file) out.push(file);
    }
    return out;
  }

  /**
   * One entry of that catalog, by path. Split out so a caller that already
   * knows which file it wants — the note driving a task — gets its title
   * without walking the folder, and gets it from the SAME parse the catalog
   * uses, so the two can never disagree about what a note is called.
   */
  async markdownFile(relPath: string): Promise<MarkdownFile | null> {
    try {
      const abs = this.guard.toAbsolute(relPath, "read");
      const rel = this.guard.toRelative(abs);
      const stat = await fs.stat(abs);
      const head = await readHead(abs, MD_HEAD_BYTES);
      return { path: rel, mtime: stat.mtimeMs, ...parseMarkdownHead(head, rel) };
    } catch {
      return null;
    }
  }

  private async collectMarkdown(
    absDir: string,
    out: string[],
    limit: number
  ): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // no .atelier folder yet — the catalog is simply empty
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.collectMarkdown(abs, out, limit);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(this.guard.toRelative(abs));
      }
    }
  }

  async list(relPath: string): Promise<FileEntry[]> {
    const absDir = this.guard.toAbsolute(relPath || ".", "read");
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (error) {
      throw workspaceFsError(error, relPath, "directory");
    }
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

  /**
   * list() for model-invoked calls: a missing directory degrades to the
   * nearest existing ancestor plus a note, instead of a dead-end error.
   * The path guard still applies — escapes throw as before.
   */
  async listForModel(relPath: string): Promise<ModelListing> {
    const abs = this.guard.toAbsolute(relPath || ".", "read");
    const requested = this.guard.toRelative(abs);
    try {
      return { path: requested, entries: await this.list(requested) };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const { path: ancestor, missing } = await this.nearestExisting(requested);
    const entries = await this.list(ancestor);
    // The last segment may exist as a FILE — saying "does not exist" there
    // would be plainly wrong and would send the model looking elsewhere.
    const asFile = entries.some(
      (entry) => entry.name === missing && entry.type === "file"
    );
    const suggestions = asFile
      ? []
      : await this.nearbyMatches(ancestor, missing);
    return {
      path: ancestor,
      requested,
      entries,
      note: this.listingNote(requested, ancestor, missing, asFile, suggestions),
    };
  }

  private listingNote(
    requested: string,
    ancestor: string,
    missing: string,
    asFile: boolean,
    suggestions: string[]
  ): string {
    const here = ancestor || "<workspace root>";
    if (asFile) {
      return (
        `"${requested}" is a file, not a directory — open it with ` +
        `read_file. Listed its parent "${here}" instead.`
      );
    }
    const tail =
      suggestions.length > 0
        ? `Similar paths that DO exist: ${suggestions.join(", ")}.`
        : "Use one of the entries above, or search_workspace to locate the " +
          "code by what it does rather than by path.";
    return (
      `"${requested}" does not exist. Listed the nearest existing ` +
      `directory instead: "${here}". Nothing named "${missing}" is in ` +
      `it. ${tail}`
    );
  }

  /**
   * Real sibling names for a missing file, so read_file failures are
   * recoverable too. When the parent directory is invented as well — the
   * usual case for a hallucinated path — it walks up to the nearest
   * directory that does exist rather than giving up.
   */
  async suggestFor(relPath: string): Promise<string> {
    const parent = pathDirname(relPath);
    let dir = parent;
    let entries: FileEntry[];
    try {
      entries = await this.list(parent);
    } catch (error) {
      if (!isMissing(error)) return "";
      const nearest = await this.nearestExisting(parent);
      dir = nearest.path;
      entries = await this.list(dir).catch(() => []);
    }
    if (entries.length === 0) return "";

    const names = entries
      .slice(0, MAX_SIBLINGS)
      .map((e) => (e.type === "dir" ? `${e.name}/` : e.name));
    const more = entries.length > MAX_SIBLINGS ? ", …" : "";
    const where =
      dir === parent
        ? `In "${dir || "<workspace root>"}"`
        : `"${parent}" does not exist either; the nearest real directory ` +
          `is "${dir || "<workspace root>"}", which holds`;
    return ` ${where}: ${names.join(", ")}${more}`;
  }

  /** Walks up until a real directory is found; also reports what broke. */
  private async nearestExisting(
    relPath: string
  ): Promise<{ path: string; missing: string }> {
    const segments = relPath.split("/").filter(Boolean);
    let missing = segments[segments.length - 1] ?? relPath;
    for (let cut = segments.length - 1; cut > 0; cut--) {
      const candidate = segments.slice(0, cut).join("/");
      try {
        await fs.readdir(this.guard.toAbsolute(candidate));
        return { path: candidate, missing: segments[cut] ?? missing };
      } catch {
        missing = segments[cut - 1] ?? missing;
      }
    }
    return { path: "", missing: segments[0] ?? missing };
  }

  /**
   * Bounded breadth-first hunt under `absStart` for directories whose name
   * relates to the missing segment — this is what turns "no such
   * directory: src/components/layout" into "but there is
   * src/components/my-dashboard/layouts".
   */
  private async nearbyMatches(
    relStart: string,
    missing: string
  ): Promise<string[]> {
    const needle = missing.toLowerCase();
    if (needle.length < 3) return [];
    const found: string[] = [];
    let frontier = [relStart];
    let visited = 0;
    for (let depth = 0; depth < NEARBY_DEPTH && frontier.length > 0; depth++) {
      if (visited >= NEARBY_BUDGET || found.length >= MAX_SUGGESTIONS) break;
      const next: string[] = [];
      for (const dir of frontier) {
        if (visited >= NEARBY_BUDGET || found.length >= MAX_SUGGESTIONS) break;
        let entries;
        try {
          entries = await fs.readdir(this.guard.toAbsolute(dir), {
            withFileTypes: true,
          });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          visited += 1;
          const rel = dir ? `${dir}/${entry.name}` : entry.name;
          if (this.ig.ignores(rel, true)) continue;
          // Both directions, so "layout" finds "layouts" and "auth" finds
          // "authentication" — but only for names long enough that the
          // containment means something.
          const name = entry.name.toLowerCase();
          if (name.includes(needle) || (name.length >= 3 && needle.includes(name))) {
            if (found.length < MAX_SUGGESTIONS) found.push(rel);
          }
          next.push(rel);
        }
      }
      frontier = next;
    }
    return found;
  }

  async stat(relPath: string): Promise<FileEntry> {
    const abs = this.guard.toAbsolute(relPath, "read");
    const stat = await statOrThrow(abs, relPath, "path");
    return {
      path: this.guard.toRelative(abs),
      name: path.basename(abs),
      type: stat.isDirectory() ? "dir" : "file",
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  }

  async readFile(
    relPath: string,
    opts: { offset?: number; limit?: number } = {}
  ): Promise<{ content: string; mtime: number; totalLines?: number }> {
    const abs = this.guard.toAbsolute(relPath, "read");
    const stat = await statOrThrow(abs, relPath, "file");
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`File too large (${stat.size} bytes): ${relPath}`);
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(abs);
    } catch (error) {
      throw workspaceFsError(error, relPath, "file");
    }
    if (isBinary(buffer)) {
      throw new Error(`Binary file: ${relPath}`);
    }
    const text = buffer.toString("utf8");
    if (opts.offset === undefined && opts.limit === undefined) {
      return { content: text, mtime: stat.mtimeMs };
    }
    // 1-based line range, mirroring the SDK's built-in Read tool. Lines
    // keep their own terminators: rejoining a CRLF file with "\n" would
    // hand the model text that no longer matches the bytes on disk, and
    // every multi-line replace_code it derived from that read would miss.
    const lines = text.split(/(?<=\n)/);
    const start = Math.max(0, (opts.offset ?? 1) - 1);
    const end = opts.limit === undefined ? lines.length : start + opts.limit;
    return {
      content: lines.slice(start, end).join(""),
      mtime: stat.mtimeMs,
      totalLines: text.split(/\r?\n/).length,
    };
  }

  async readImage(
    relPath: string
  ): Promise<{ dataUrl: string; mediaType: string; mtime: number }> {
    const abs = this.guard.toAbsolute(relPath, "read");
    const stat = await statOrThrow(abs, relPath, "file");
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${stat.size} bytes): ${relPath}`);
    }
    const mediaType = imageMediaType(relPath);
    if (!mediaType) throw new Error(`Unsupported image file: ${relPath}`);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(abs);
    } catch (error) {
      throw workspaceFsError(error, relPath, "file");
    }
    return {
      dataUrl: `data:${mediaType};base64,${buffer.toString("base64")}`,
      mediaType,
      mtime: stat.mtimeMs,
    };
  }

  async writeImage(
    relPath: string,
    data: string,
    mediaType: string
  ): Promise<string> {
    const wirePath = this.guard.toRelative(this.guard.toAbsolute(relPath));
    if (!/^\.atelier\/images\/[^/]+\.png$/i.test(wirePath)) {
      throw new Error("Screenshots must be saved as .atelier/images/*.png");
    }
    if (mediaType !== "image/png") {
      throw new Error(`Unsupported screenshot type: ${mediaType}`);
    }
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      throw new Error("Screenshot must be between 1 byte and 20 MB");
    }
    const abs = this.guard.toAbsolute(wirePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer, { flag: "wx" });
    return wirePath;
  }

  async writeFile(
    relPath: string,
    content: string,
    opts: WriteOptions = {}
  ): Promise<Diff> {
    // Same model-side bug as replace_code: a tool call that omits content
    // (or sends a non-string) would crash preserveEol below with a TypeError.
    // Catch it here so the model gets a clear, field-named error instead.
    if (typeof content !== "string") {
      throw new Error(
        "write_file missing required string field: content. Re-send the " +
          "call with content as a string."
      );
    }
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
    // A whole-file rewrite must not silently re-line-end the file.
    const after = preserveEol(before, content);
    return this.applyEdit(abs, wirePath, before, after, opts);
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
    // A model that drops or mis-types a required field gets a specific
    // error here instead of a TypeError from the matcher below. The shared
    // matcher now treats non-string args as an empty hit, so this branch
    // is the one that tells the model which field is wrong.
    if (typeof oldString !== "string" || typeof newString !== "string") {
      const missing: string[] = [];
      if (typeof oldString !== "string") missing.push("oldString");
      if (typeof newString !== "string") missing.push("newString");
      throw new Error(
        `replace_code missing required string field(s): ${missing.join(", ")}. ` +
          "Re-send the call with both oldString and newString as strings."
      );
    }
    const edit = resolveEdit(before, oldString, newString);
    if (edit.count === 0) {
      throw new Error(`oldString not found in ${relPath}`);
    }
    if (edit.count > 1 && !replaceAll) {
      throw new Error(
        `oldString occurs ${edit.count} times in ${relPath}; pass replaceAll ` +
          "or a more specific string"
      );
    }
    const after = replaceAll
      ? before.split(edit.oldString).join(edit.newString)
      : before.replace(edit.oldString, edit.newString);
    return this.applyEdit(abs, wirePath, before, after, opts);
  }

  private async applyEdit(
    abs: string,
    wirePath: string,
    before: string,
    after: string,
    opts: WriteOptions
  ): Promise<Diff> {
    // Hooks gate every write path (model tools and UI RPCs alike) before
    // any diff is created or byte hits disk.
    await this.writeGuard(wirePath, after, before, opts.taskId);
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
    // The watcher never sees `.atelier/` (it is ignored so the cache stays
    // out of the tree/search/index), so a note write — the status flip to
    // in-progress, the report and the flip to review — produced no
    // `file.changed` and the Markdown panel's badge stayed stale until
    // something else moved the tree. Announce it here instead.
    if (isNotePath(wirePath)) this.publishChange(wirePath, "change");
    return diff;
  }

  /**
   * Creates an empty file for the explorer's "New File". Missing parent
   * folders are created, mirroring VS Code's `a/b/c.ts` input. An existing
   * path is refused rather than truncated — a create must never destroy.
   */
  async createFile(relPath: string): Promise<string> {
    const abs = this.guard.toAbsolute(relPath);
    const wirePath = this.guard.toRelative(abs);
    await this.refuseExisting(abs, wirePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // wx = create-or-fail, so a race loses instead of overwriting.
    const handle = await fs.open(abs, "wx");
    await handle.close();
    this.publishChange(wirePath, "add");
    return wirePath;
  }

  async createDir(relPath: string): Promise<string> {
    const abs = this.guard.toAbsolute(relPath);
    const wirePath = this.guard.toRelative(abs);
    await this.refuseExisting(abs, wirePath);
    await fs.mkdir(abs, { recursive: true });
    this.publishChange(wirePath, "addDir");
    return wirePath;
  }

  /** Rename in place or move to another folder; never overwrites. */
  async rename(fromRel: string, toRel: string): Promise<string> {
    const fromAbs = this.guard.toAbsolute(fromRel);
    const toAbs = this.guard.toAbsolute(toRel);
    const fromWire = this.guard.toRelative(fromAbs);
    const toWire = this.guard.toRelative(toAbs);
    const stat = await statForExplorer(fromAbs, fromWire);
    // A case-only rename on Windows/macOS hits the same inode, so the
    // "already exists" check would reject a legitimate rename.
    if (fromAbs.toLowerCase() !== toAbs.toLowerCase()) {
      await this.refuseExisting(toAbs, toWire);
    }
    this.refuseIntoSelf(fromAbs, toAbs, stat.isDirectory());
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    const kind = stat.isDirectory() ? "Dir" : "";
    this.publishChange(fromWire, `unlink${kind}` as FileChangeType);
    this.publishChange(toWire, `add${kind}` as FileChangeType);
    return toWire;
  }

  /** Copy a file, or a directory tree, to a path that must not exist. */
  async copy(fromRel: string, toRel: string): Promise<string> {
    const fromAbs = this.guard.toAbsolute(fromRel);
    const toAbs = this.guard.toAbsolute(toRel);
    const fromWire = this.guard.toRelative(fromAbs);
    const toWire = this.guard.toRelative(toAbs);
    const stat = await statForExplorer(fromAbs, fromWire);
    await this.refuseExisting(toAbs, toWire);
    this.refuseIntoSelf(fromAbs, toAbs, stat.isDirectory());
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.cp(fromAbs, toAbs, { recursive: stat.isDirectory() });
    this.publishChange(toWire, stat.isDirectory() ? "addDir" : "add");
    return toWire;
  }

  /** Deletes a file, or a directory and everything under it. */
  async remove(relPath: string): Promise<string> {
    const abs = this.guard.toAbsolute(relPath);
    const wirePath = this.guard.toRelative(abs);
    if (!wirePath) throw new Error("Refusing to delete the workspace root");
    const stat = await statForExplorer(abs, wirePath);
    const isDir = stat.isDirectory();
    await fs.rm(abs, { recursive: isDir, force: false });
    this.publishChange(wirePath, isDir ? "unlinkDir" : "unlink");
    return wirePath;
  }

  private async refuseExisting(abs: string, wirePath: string): Promise<void> {
    const exists = await fs
      .stat(abs)
      .then(() => true)
      .catch(() => false);
    if (exists) throw new Error(`Already exists: ${wirePath}`);
  }

  /** Moving or copying a folder inside itself would recurse forever. */
  private refuseIntoSelf(fromAbs: string, toAbs: string, isDir: boolean): void {
    if (!isDir) return;
    const inside = toAbs.toLowerCase().startsWith(fromAbs.toLowerCase() + path.sep);
    if (inside) throw new Error("Cannot move a folder into itself");
  }

  /**
   * Announces an explorer mutation on the same event the watcher uses, so
   * every client refreshes its tree the way it already does for edits.
   * Directory events are the reason this exists: chokidar's file-only
   * listeners never report an empty folder appearing or vanishing.
   */
  private publishChange(relPath: string, type: FileChangeType): void {
    this.bus.publish("file.changed", { path: relPath, type, source: "user" });
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

function imageMediaType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".ico": return "image/x-icon";
    case ".avif": return "image/avif";
    default: return null;
  }
}

/** A path that simply is not there — the recoverable failure. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * stat for the explorer's mutations. The model-facing variant appends
 * advice about list_dir and search_workspace, which reads as noise in a
 * "couldn't rename that" banner — a person can see the tree already.
 */
async function statForExplorer(abs: string, wirePath: string) {
  try {
    return await fs.stat(abs);
  } catch {
    throw new Error(`No such file or folder: ${wirePath}`);
  }
}

async function statOrThrow(
  abs: string,
  relPath: string,
  what: "file" | "directory" | "path"
) {
  try {
    return await fs.stat(abs);
  } catch (error) {
    throw workspaceFsError(error, relPath, what);
  }
}

function isBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

/** Read at most `bytes` from the start of a file, decoded as UTF-8. */
async function readHead(abs: string, bytes: number): Promise<string> {
  const handle = await fs.open(abs, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** "In Progress" / "in_progress" / "in-progress" all mean in-progress. */
function normalizeStatus(raw: string): MarkdownStatus {
  const v = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (v === "in-progress" || v === "review" || v === "done") return v;
  return "todo";
}

/**
 * Title, blurb, and status from a markdown head: the first `#` heading,
 * the first prose line (markers stripped), and the frontmatter's
 * `status:` — the YAML block is otherwise skipped.
 */
function parseMarkdownHead(
  head: string,
  relPath: string
): { title: string; description: string; status: MarkdownStatus } {
  let lines = head.split(/\r?\n/);
  let status: MarkdownStatus = "todo";
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end !== -1) {
      for (const raw of lines.slice(1, end)) {
        const m = /^status\s*:\s*(.+)$/i.exec(raw.trim());
        if (m) status = normalizeStatus(m[1]!);
      }
      lines = lines.slice(end + 1);
    }
  }
  let title = "";
  let description = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (!title) title = heading[1]!.trim();
      continue;
    }
    description = line.replace(/^(?:[>*-]\s*)+/, "").trim();
    if (description) break;
  }
  if (!title) title = path.basename(relPath).replace(/\.md$/i, "");
  if (description.length > MAX_MD_DESCRIPTION) {
    description = `${description.slice(0, MAX_MD_DESCRIPTION - 1)}…`;
  }
  return { title, description, status };
}

/**
 * The file's line ending, when it uses exactly one. A mixed file returns
 * null: picking a winner there would rewrite lines the edit never
 * touched, which is worse than the inconsistency it would fix.
 */
function soleEol(text: string): "\r\n" | "\n" | null {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf === 0) return "\r\n";
  if (lf > 0 && crlf === 0) return "\n";
  return null;
}

/**
 * Keeps a rewritten file in the line ending it already had. A model
 * regenerating a whole file emits LF, so writing its output verbatim
 * silently flips a CRLF file and turns a three-line change into a
 * whole-file diff. Left alone: new files (nothing to preserve), files
 * with no newlines, and mixed files.
 *
 * The trade-off: a deliberate "convert this file to LF" is undone. That
 * is the rarer intent by far, and it stays reachable — delete the file
 * and write it fresh, or convert it outside the write path.
 */
export function preserveEol(before: string, content: string): string {
  const eol = soleEol(before);
  if (!eol) return content;
  const asLf = toLf(content);
  return eol === "\r\n" ? toCrlf(asLf) : asLf;
}

/** An edit resolved against the bytes actually on disk. */
export interface ResolvedEdit {
  oldString: string;
  newString: string;
  count: number;
}

/**
 * Matches an edit against the file's own line endings. A model works in
 * LF — from memory, from a normalizing read, or from its own generated
 * text — so a multi-line oldString copied against a CRLF file matches
 * nothing, and the edit fails with "oldString not found" no matter how
 * many times it retries. Falling back to the file's convention (and
 * inserting newString in that same convention) makes the CRLF/LF split
 * invisible to the model instead of a dead end.
 */
export function resolveEdit(
  content: string,
  oldString: string,
  newString: string
): ResolvedEdit {
  // A model can emit a tool call whose oldString / newString is missing or
  // typed wrong (Ollama sometimes drops the field, or sends a number when
  // the schema asked for a string). The early-return below is what used to
  // throw "Cannot read properties of undefined (reading 'replace')" — the
  // string methods are called on whatever the model sent, and the result
  // is a TypeError instead of a recoverable "oldString not found" message.
  // Coerce to a string here so the shared matcher behaves identically and
  // the upstream tool can keep returning a clear, specific error.
  const oldText = typeof oldString === "string" ? oldString : "";
  const newText = typeof newString === "string" ? newString : "";
  if (typeof oldString !== "string" || typeof newString !== "string") {
    return { oldString: oldText, newString: newText, count: 0 };
  }
  const asIs = countOccurrences(content, oldText);
  if (asIs > 0 || !oldText) return { oldString: oldText, newString: newText, count: asIs };

  const lf = oldText.replace(/\r\n/g, "\n");
  const variants: Array<[string, (s: string) => string]> = [
    [lf.replace(/\n/g, "\r\n"), toCrlf],
    [lf, toLf],
  ];
  for (const [variant, align] of variants) {
    if (variant === oldText) continue;
    const count = countOccurrences(content, variant);
    if (count > 0) {
      return { oldString: variant, newString: align(newText), count };
    }
  }
  return { oldString: oldText, newString: newText, count: 0 };
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function toCrlf(text: string): string {
  return toLf(text).replace(/\n/g, "\r\n");
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
