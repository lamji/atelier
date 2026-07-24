import path from "node:path";

export const EMBEDDING_DIMS = 384;
export const EMBEDDER_VERSION = "minilm-l6-v2-q8";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = 16;

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ dims: number[]; data: Float32Array | number[] }>;

/**
 * Local ONNX embeddings (all-MiniLM-L6-v2, 384 dims, quantized) via
 * @huggingface/transformers. The model downloads once into the agent data
 * dir and runs fully offline afterwards. When the model cannot load
 * (offline first run, broken runtime) the embedder reports unavailable and
 * indexing simply skips embeddings — retrieval falls back to keyword+graph.
 */
export class Embedder {
  private extractor: FeatureExtractor | null = null;
  private initPromise: Promise<void> | null = null;
  private failed: string | null = null;

  constructor(private dataDir: string) {}

  get available(): boolean {
    return this.extractor !== null;
  }

  get failureReason(): string | null {
    return this.failed;
  }

  async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const transformers = await import("@huggingface/transformers");
      const env = transformers.env as { cacheDir?: string };
      env.cacheDir = path.join(this.dataDir, "models");
      const pipe = await transformers.pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
      });
      this.extractor = pipe as unknown as FeatureExtractor;
      this.failed = null;
    } catch (error) {
      this.failed = String(error);
      this.extractor = null;
    }
  }

  /** Embed texts (L2-normalized). Returns [] when unavailable. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    const extractor = this.extractor;
    if (!extractor) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const tensor = await extractor(batch, {
        pooling: "mean",
        normalize: true,
      });
      const dims = tensor.dims[tensor.dims.length - 1] ?? EMBEDDING_DIMS;
      const data =
        tensor.data instanceof Float32Array
          ? tensor.data
          : Float32Array.from(tensor.data);
      for (let row = 0; row < batch.length; row++) {
        out.push(data.slice(row * dims, (row + 1) * dims));
      }
    }
    return out;
  }

  async shutdown(): Promise<void> {
    this.extractor = null;
  }
}
