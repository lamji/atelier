import fs from "node:fs";
import path from "node:path";
import { newId } from "@atelier/shared";
import { atelierDataRoot, projectDataDir } from "@atelier/shared/node";

/** A project the supervisor knows about, persisted in projects.json. */
export interface ProjectRecord {
  id: string;
  name: string;
  /** Absolute workspace path. */
  path: string;
  /** Per-project data dir (knowledge DB, bridge.json). */
  dataDir: string;
  addedAt: number;
  lastOpenedAt?: number;
}

/**
 * The persisted list of projects. Plain JSON at
 * <atelier data>/projects.json — small, human-readable, edited only here.
 */
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

  private findByPath(abs: string): ProjectRecord | undefined {
    const key = path.resolve(abs).toLowerCase();
    return this.records.find((r) => path.resolve(r.path).toLowerCase() === key);
  }

  /** Register a project (idempotent by path); returns the record. */
  add(workspacePath: string): ProjectRecord {
    const abs = path.resolve(workspacePath);
    const existing = this.findByPath(abs);
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

  /** Stamp lastOpenedAt so the UI can pick the most-recent on boot. */
  touch(id: string): void {
    const record = this.get(id);
    if (!record) return;
    record.lastOpenedAt = Date.now();
    this.save();
  }
}
