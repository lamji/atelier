import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

const port = parentPort;
if (!port) throw new Error("embed-worker must run as a worker thread");

env.cacheDir = workerData.cacheDir;

try {
  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "q8",
    // Leave CPU capacity for the renderer and foreground CLI processes.
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  // Indexing, retrieval and summaries share one model. Serialize their
  // requests so overlapping callers cannot multiply native inference work.
  let queue = Promise.resolve();
  port.on("message", (request) => {
    queue = queue.then(async () => {
      try {
        const tensor = await extractor(request.texts, { pooling: "mean", normalize: true });
        const dims = tensor.dims[tensor.dims.length - 1] ?? 384;
        const data = tensor.data instanceof Float32Array
          ? tensor.data : Float32Array.from(tensor.data);
        const vectors = request.texts.map((_, row) => data.slice(row * dims, (row + 1) * dims));
        port.postMessage({ type: "result", id: request.id, vectors }, vectors.map((v) => v.buffer));
      } catch (error) {
        port.postMessage({ type: "error", id: request.id, error: String(error) });
      }
    });
  });
  port.postMessage({ type: "ready" });
} catch (error) {
  port.postMessage({ type: "init-error", error: String(error) });
  port.close();
}
