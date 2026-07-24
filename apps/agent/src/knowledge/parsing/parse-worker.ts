import { parentPort } from "node:worker_threads";
import { languageForFile } from "./languages.js";
import { parseSource, initTreeSitter } from "./parser.js";
import { extractTsJs } from "./extractor.js";
import type { ExtractedFile } from "./extracted.js";

/**
 * Worker-thread parse job runner. Parses off the main thread so large
 * scans never block the bridge/event loop. Protocol: main posts
 * { id, path, source }; worker replies { id, ok, result | error }.
 */
interface ParseRequest {
  id: number;
  path: string;
  source: string;
}

interface ParseResponse {
  id: number;
  ok: boolean;
  result?: (ExtractedFile & { path: string; lang: string }) | null;
  error?: string;
}

const port = parentPort;
if (!port) throw new Error("parse-worker must run as a worker thread");

let ready: Promise<void> | null = null;

port.on("message", (msg: ParseRequest) => {
  void handle(msg);
});

async function handle(msg: ParseRequest): Promise<void> {
  try {
    if (!ready) ready = initTreeSitter();
    await ready;
    const spec = languageForFile(msg.path);
    if (!spec) {
      reply({ id: msg.id, ok: true, result: null });
      return;
    }
    const tree = await parseSource(spec.grammar, msg.source);
    if (!tree) {
      reply({ id: msg.id, ok: true, result: null });
      return;
    }
    try {
      const extracted = extractTsJs(tree, spec.name);
      reply({
        id: msg.id,
        ok: true,
        result: { path: msg.path, lang: spec.name, ...extracted },
      });
    } finally {
      tree.delete();
    }
  } catch (error) {
    reply({ id: msg.id, ok: false, error: String(error) });
  }
}

function reply(response: ParseResponse): void {
  port!.postMessage(response);
}
