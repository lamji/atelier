/**
 * Persisted project list — plain JSON at <atelier data>/projects.json.
 * Moved from the deleted supervisor (apps/agent/src/supervisor/registry.ts);
 * same file format, so existing installs keep their recents.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProjectRecord {
  id: string;
  name: string;
  /** Absolute workspace path. */
  path: string;
  /** Per-project data dir (knowledge DB, settings). */
  dataDir: string;
  addedAt: number;
  lastOpenedAt?: number;
}

/** Base dir for all Atelier data (LOCALAPPDATA on Windows, ~/.local/share). */
export function atelierDataRoot(): string {
  if (process.env.ATELIER_DATA_DIR) return process.env.ATELIER_DATA_DIR;
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "atelier");
}

/** Stable slug for a workspace path — filesystem-safe, case-insensitive. */
function projectSlug(workspaceRoot: string): string {
  return workspaceRoot
    .replace(/[\\/:]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase();
}

function projectDataDir(workspaceRoot: string): string {
  return path.join(atelierDataRoot(), "projects", projectSlug(workspaceRoot));
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export class ProjectRegistry {
  private file = path.join(atelierDataRoot(), "projects.json");
  private records: ProjectRecord[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(raw)) this.records = raw as ProjectRecord[];
    } catch {
      // first run — no file yet
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), "utf8");
  }

  list(): ProjectRecord[] {
    return [...this.records];
  }

  get(id: string): ProjectRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** Register a project (idempotent by resolved path). */
  add(workspacePath: string): ProjectRecord {
    const abs = path.resolve(workspacePath);
    const key = abs.toLowerCase();
    const existing = this.records.find(
      (r) => path.resolve(r.path).toLowerCase() === key
    );
    if (existing) return existing;
    const record: ProjectRecord = {
      id: newId("proj"),
      name: path.basename(abs) || abs,
      path: abs,
      dataDir: projectDataDir(abs),
      addedAt: Date.now(),
    };
    this.records.push(record);
    this.save();
    return record;
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  /** Stamp lastOpenedAt so pickers can sort by recency. */
  touch(id: string): void {
    const record = this.get(id);
    if (!record) return;
    record.lastOpenedAt = Date.now();
    this.save();
  }
}
