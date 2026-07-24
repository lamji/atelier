import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { languageForFile, type LangSpec } from "./languages.js";
import { parseSource, initTreeSitter } from "./parser.js";
import { extractTsJs } from "./extractor.js";
import type { ExtractedFile } from "./extracted.js";

export interface ParsedFile extends ExtractedFile {
  path: string;
  lang: string;
}

/** Files below this many bytes parse inline; larger ones go to a worker. */
const WORKER_THRESHOLD_BYTES = 24_000;

interface Pending {
  resolve: (value: ParsedFile | null) => void;
  reject: (error: Error) => void;
}

/**
 * Parsing facade. Small files parse inline (a few ms, no thread hop);
 * large files run in a pool of worker threads so big scans never block
 * the bridge/event loop. Falls back to fully inline if workers can't
 * spawn (e.g. bundled without the worker file).
 */
export class ParserPool {
  private workers: Worker[] = [];
  private queue: Array<{ path: string; source: string; pending: Pending }> = [];
  private idle: Worker[] = [];
  private jobs = new Map<number, Pending>();
  private jobSeq = 0;
  private workerCount: number;
  private workersReady = false;
  private disabled = false;

  constructor(workerCount?: number) {
    this.workerCount =
      workerCount ?? Math.max(1, Math.min(4, (os.cpus()?.length ?? 2) - 1));
  }

  async init(): Promise<void> {
    await initTreeSitter();
    this.spawnWorkers();
  }

  langFor(relPath: string): LangSpec | null {
    return languageForFile(relPath);
  }

  /** Parse + extract one file's source. Returns null for unsupported langs. */
  async parseFile(relPath: string, source: string): Promise<ParsedFile | null> {
    const spec = languageForFile(relPath);
    if (!spec) return null;
    if (
      this.workersReady &&
      !this.disabled &&
      source.length >= WORKER_THRESHOLD_BYTES
    ) {
      try {
        return await this.parseInWorker(relPath, source);
      } catch {
        // Worker died mid-job; fall back to inline for this file.
        return this.parseInline(relPath, spec, source);
      }
    }
    return this.parseInline(relPath, spec, source);
  }

  private async parseInline(
    relPath: string,
    spec: LangSpec,
    source: string
  ): Promise<ParsedFile | null> {
    const tree = await parseSource(spec.grammar, source);
    if (!tree) return null;
    try {
      const extracted = extractTsJs(tree, spec.name);
      return { path: relPath, lang: spec.name, ...extracted };
    } finally {
      tree.delete();
    }
  }

  private async parseInWorker(
    relPath: string,
    source: string
  ): Promise<ParsedFile | null> {
    return new Promise<ParsedFile | null>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      const worker = this.idle.pop();
      if (worker) this.dispatch(worker, relPath, source, pending);
      else this.queue.push({ path: relPath, source, pending });
    });
  }

  private dispatch(
    worker: Worker,
    relPath: string,
    source: string,
    pending: Pending
  ): void {
    const id = ++this.jobSeq;
    this.jobs.set(id, pending);
    (worker as Worker & { _jobId?: number })._jobId = id;
    worker.postMessage({ id, path: relPath, source });
  }

  private spawnWorkers(): void {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Packaged build emits parse-worker.mjs beside main.mjs; dev runs the
    // .ts directly under tsx.
    const mjs = path.join(here, "parse-worker.mjs");
    const workerFile = fs.existsSync(mjs)
      ? mjs
      : path.join(here, "parse-worker.ts");
    try {
      for (let i = 0; i < this.workerCount; i++) {
        const worker = new Worker(workerFile);
        worker.on("message", (msg: {
          id: number;
          ok: boolean;
          result?: ParsedFile | null;
          error?: string;
        }) => {
          const pending = this.jobs.get(msg.id);
          if (!pending) return;
          this.jobs.delete(msg.id);
          if (msg.ok) pending.resolve(msg.result ?? null);
          else pending.reject(new Error(msg.error ?? "worker parse failed"));
          this.release(worker);
        });
        worker.on("error", (error) => {
          const jobId = (worker as Worker & { _jobId?: number })._jobId;
          if (jobId) {
            this.jobs.get(jobId)?.reject(error);
            this.jobs.delete(jobId);
          }
          this.disabled = true;
        });
        this.workers.push(worker);
        this.idle.push(worker);
      }
      this.workersReady = this.workers.length > 0;
    } catch {
      // Workers unavailable — stay fully inline.
      this.disabled = true;
      this.workersReady = false;
    }
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) this.dispatch(worker, next.path, next.source, next.pending);
    else this.idle.push(worker);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
  }
}
