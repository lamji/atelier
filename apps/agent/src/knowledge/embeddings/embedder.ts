/**
 * Phase 5: local ONNX embeddings (all-MiniLM-L6-v2, 384 dims) running in a
 * worker thread. No API key, no network.
 */
export const EMBEDDING_DIMS = 384;

export class Embedder {
  async init(): Promise<void> {}

  async embed(_texts: string[]): Promise<Float32Array[]> {
    return [];
  }

  async shutdown(): Promise<void> {}
}
