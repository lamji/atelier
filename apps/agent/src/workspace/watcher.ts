import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { EventBus } from "../events/event-bus.js";
import type { PathGuard } from "./path-guard.js";
import type { WorkspaceIgnore } from "./ignore.js";

const AGENT_WRITE_WINDOW_MS = 2000;

export type FileChangeListener = (
  relPath: string,
  type: "add" | "change" | "unlink"
) => void;

/**
 * Chokidar workspace watcher. The ignore filter runs BEFORE registration so
 * node_modules/.git never enter the watch tree (critical on Windows).
 * Changes caused by the agent's own writes are labeled source:"agent".
 */
export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private onError?: (error: Error) => void;
  private recentAgentWrites = new Map<string, number>();
  private listeners = new Set<FileChangeListener>();

  constructor(
    private bus: EventBus,
    private guard: PathGuard,
    private ig: WorkspaceIgnore,
    private workspaceRoot: string
  ) {}

  /** Called by FileService just before it writes. */
  markAgentWrite(relPath: string): void {
    this.recentAgentWrites.set(relPath.toLowerCase(), Date.now());
  }

  onChange(listener: FileChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.watcher = chokidar.watch(this.workspaceRoot, {
      ignored: (absPath, stats) => {
        if (path.resolve(absPath) === path.resolve(this.workspaceRoot)) {
          return false;
        }
        return this.ig.ignoresAbsolute(absPath, stats?.isDirectory() ?? false);
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const emit = (type: "add" | "change" | "unlink") => (absPath: string) => {
      let relPath: string;
      try {
        relPath = this.guard.toRelative(absPath);
      } catch {
        return;
      }
      const source = this.consumeAgentWrite(relPath) ? "agent" : "user";
      this.bus.publish("file.changed", { path: relPath, type, source });
      for (const listener of this.listeners) listener(relPath, type);
    };
    const emitDirOnly =
      (type: "addDir" | "unlinkDir") => (absPath: string) => {
        try {
          const relPath = this.guard.toRelative(absPath);
          if (!relPath) return; // the root itself
          this.bus.publish("file.changed", { path: relPath, type, source: "user" });
        } catch {
          // outside the workspace — nothing to report
        }
      };
    this.watcher.on("add", emit("add"));
    this.watcher.on("change", emit("change"));
    this.watcher.on("unlink", emit("unlink"));
    // Folders go to the bus only: the file listeners are the git refresher
    // and the indexer, and neither has anything to do with a directory.
    this.watcher.on("addDir", emitDirOnly("addDir"));
    this.watcher.on("unlinkDir", emitDirOnly("unlinkDir"));
    /*
     * chokidar emits "error" on an EventEmitter, and an 'error' event with no
     * listener is a process-level throw in Node — so one unreadable path in a
     * user's workspace (a permission-denied folder, a broken symlink, an
     * archive Electron refuses to stat) killed the agent for that project
     * entirely. Watching is best-effort by nature: the workspace keeps
     * working without live file events, which is a far better outcome than
     * no workspace at all.
     */
    this.watcher.on("error", (error) => {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /** Told about watcher failures so the runtime can log them. */
  onWatchError(handler: (error: Error) => void): void {
    this.onError = handler;
  }

  private consumeAgentWrite(relPath: string): boolean {
    const key = relPath.toLowerCase();
    const at = this.recentAgentWrites.get(key);
    if (at === undefined) return false;
    this.recentAgentWrites.delete(key);
    return Date.now() - at < AGENT_WRITE_WINDOW_MS;
  }

  stop(): void {
    void this.watcher?.close();
    this.watcher = null;
  }
}
