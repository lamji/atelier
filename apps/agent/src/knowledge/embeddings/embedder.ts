import path from "node:path";
import { Worker } from "node:worker_threads";

export const EMBEDDING_DIMS = 384;
export const EMBEDDER_VERSION = "minilm-l6-v2-q8";

const BATCH_SIZE = 16;

type WorkerReply =
  | { type: "ready" }
  | { type: "init-error"; error: string }
  | { type: "result"; id: number; vectors: Float32Array[] }
  | { type: "error"; id: number; error: string };

/**
 * Local ONNX embeddings (all-MiniLM-L6-v2, 384 dims, quantized) via
 * @huggingface/transformers. The model downloads once into the agent data
 * dir and runs fully offline afterwards. When the model cannot load
 * (offline first run, broken runtime) the embedder reports unavailable and
 * indexing simply skips embeddings — retrieval falls back to keyword+graph.
 */
export class Embedder {
  private worker: Worker | null = null;
  private ready = false;
  private stopped = false;
  private initPromise: Promise<void> | null = null;
  private finishInit: (() => void) | null = null;
  private failed: string | null = null;
  private sequence = 0;
  private pending = new Map<number, {
    resolve: (vectors: Float32Array[]) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private dataDir: string) {}

  get available(): boolean {
    return this.ready;
  }

  get failureReason(): string | null {
    return this.failed;
  }

  async init(): Promise<void> {
    if (this.stopped) return;
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private doInit(): Promise<void> {
    return new Promise((resolve) => {
      this.finishInit = resolve;
      try {
        // Native inference and tokenization can block even behind `await`.
        // Keep them off the event loop that dispatches terminal.write RPCs.
        // Both desktop bundles emit this worker beside utility-main.mjs.
        const worker = new Worker(new URL("./embed-worker.mjs", import.meta.url), {
          workerData: { cacheDir: path.join(this.dataDir, "models") },
        });
        this.worker = worker;
        worker.on("message", (message: WorkerReply) => {
          if (this.worker !== worker) return;
          if (message.type === "ready") {
            this.ready = true;
            worker.unref();
            this.finishInit?.();
            this.finishInit = null;
          } else if (message.type === "init-error") {
            this.fail(new Error(message.error));
          } else {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (this.pending.size === 0) worker.unref();
            if (message.type === "result") pending.resolve(message.vectors);
            else pending.reject(new Error(message.error));
          }
        });
        worker.on("error", (error) => {
          if (this.worker === worker) this.fail(error);
        });
        worker.on("exit", (code) => {
          if (this.worker === worker) this.fail(new Error(`Embedding worker exited (${code})`));
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error): void {
    this.failed = String(error);
    this.ready = false;
    const worker = this.worker;
    this.worker = null;
    this.finishInit?.();
    this.finishInit = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (worker) void worker.terminate();
  }

  /** Embed texts (L2-normalized). Returns [] when unavailable. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    if (!this.available) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const worker = this.worker;
      if (!worker) return [];
      const vectors = await new Promise<Float32Array[]>((resolve, reject) => {
        const id = ++this.sequence;
        this.pending.set(id, { resolve, reject });
        worker.ref();
        try {
          worker.postMessage({ id, texts: texts.slice(i, i + BATCH_SIZE) });
        } catch (error) {
          this.pending.delete(id);
          if (this.pending.size === 0) worker.unref();
          reject(error);
        }
      });
      out.push(...vectors);
    }
    return out;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    const worker = this.worker;
    this.worker = null;
    this.finishInit?.();
    this.finishInit = null;
    for (const pending of this.pending.values()) pending.resolve([]);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
