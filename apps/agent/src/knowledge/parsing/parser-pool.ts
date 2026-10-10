import fs from "node:fs";
import path from "node:path";
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
  private initialized = false;
  private stopped = false;

  constructor(workerCount?: number) {
    // The indexer awaits each parse. Extra idle workers only duplicate WASM
    // heaps for every open workspace; explicit parallel callers may opt in.
    this.workerCount = workerCount ?? 1;
  }

  async init(): Promise<void> {
    await initTreeSitter();
    this.initialized = true;
  }

  langFor(relPath: string): LangSpec | null {
    return languageForFile(relPath);
  }

  /** Parse + extract one file's source. Returns null for unsupported langs. */
  async parseFile(relPath: string, source: string): Promise<ParsedFile | null> {
    if (this.stopped) return null;
    const spec = languageForFile(relPath);
    if (!spec) return null;
    if (this.initialized && !this.workersReady && !this.disabled &&
        source.length >= WORKER_THRESHOLD_BYTES) this.spawnWorkers();
    if (
      this.workersReady &&
      !this.disabled &&
      source.length >= WORKER_THRESHOLD_BYTES
    ) {
      try {
        return await this.parseInWorker(relPath, source);
      } catch {
        if (this.stopped) return null;
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
      if (this.stopped) return null;
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
    worker.ref();
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
          this.disableWorkers(error);
        });
        worker.on("exit", (code) => {
          if (this.workers.includes(worker)) {
            this.disableWorkers(new Error(`Parser worker exited (${code})`));
          }
        });
        worker.unref();
        this.workers.push(worker);
        this.idle.push(worker);
      }
      this.workersReady = this.workers.length > 0;
    } catch (error) {
      // Workers unavailable — stay fully inline.
      this.disableWorkers(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) this.dispatch(worker, next.path, next.source, next.pending);
    else {
      worker.unref();
      this.idle.push(worker);
    }
  }

  private disableWorkers(error: Error): void {
    this.disabled = true;
    for (const pending of this.jobs.values()) pending.reject(error);
    for (const item of this.queue) item.pending.reject(error);
    this.jobs.clear();
    this.queue = [];
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    this.workersReady = false;
    for (const worker of workers) void worker.terminate();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.workersReady = false;
    for (const pending of this.jobs.values()) pending.resolve(null);
    for (const item of this.queue) item.pending.resolve(null);
    this.jobs.clear();
    this.queue = [];
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    await Promise.all(workers.map((w) => w.terminate()));
  }
}
