/**
 * Phase 2 smoke: fs RPCs, path-guard rejection, watcher events, and a real
 * agent-driven edit through the SDK tool layer (diff.created -> edit.applied).
 * Requires the agent to be running.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";

const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
const info = JSON.parse(
  fs.readFileSync(
    path.join(process.env.ATELIER_DATA_DIR ?? path.join(base, "atelier"), "bridge.json"),
    "utf8"
  )
) as { port: number; token: string };

const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, {
  origin: "http://localhost:5173",
});
await new Promise<void>((resolve) => ws.on("open", () => resolve()));

interface Frame {
  kind: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  topic?: string;
  payload?: Record<string, unknown>;
}

const events: Frame[] = [];
ws.on("message", (raw) => {
  const frame = JSON.parse(String(raw)) as Frame;
  if (frame.kind === "event") events.push(frame);
});

let nextId = 0;
function rpc(method: string, params: unknown): Promise<unknown> {
  const id = `p2_${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 180_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.kind === "res" && frame.id === id) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        if (frame.ok) resolve(frame.result);
        else reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ kind: "req", id, method, params }));
  });
}

function waitForEvent(
  topic: string,
  predicate: (p: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 180_000
): Promise<Frame> {
  const existing = events.find((e) => e.topic === topic && predicate(e.payload!));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${topic}`)),
      timeoutMs
    );
    const onMessage = (raw: WebSocket.RawData): void => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.kind === "event" && frame.topic === topic && predicate(frame.payload!)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(frame);
      }
    };
    ws.on("message", onMessage);
  });
}

await rpc("session.hello", {
  token: info.token,
  protocolVersion: 1,
  clientInfo: { name: "p2-smoke", version: "0" },
});
ws.send(JSON.stringify({ kind: "sub", id: "sub_all", topic: "*" }));
console.log("PASS hello");

// 1. fs.tree
const tree = (await rpc("fs.tree", { depth: 2 })) as {
  root: { children: Array<{ name: string; type: string }> };
};
const names = tree.root.children.map((c) => c.name);
console.log(`PASS fs.tree: ${names.join(", ")}`);
if (names.includes("node_modules") || names.includes(".git")) {
  console.log("FAIL ignore filter leaked node_modules/.git");
}

// 2. fs.readFile
const readme = (await rpc("fs.readFile", { path: "README.md" })) as {
  content: string;
};
console.log(`PASS fs.readFile: README ${readme.content.length} chars`);

// 3. path escape rejected
await rpc("fs.readFile", { path: "../secrets.txt" }).then(
  () => console.log("FAIL path escape was allowed"),
  (error: Error) => console.log(`PASS path escape rejected: ${error.message}`)
);

// 4. fs.search
const search = (await rpc("fs.search", {
  query: "PROTOCOL_VERSION",
  glob: "packages/**/*.ts",
  maxResults: 10,
})) as { matches: Array<{ path: string; row: number }> };
console.log(
  `PASS fs.search: ${search.matches.length} matches, first=${search.matches[0]?.path}`
);

// 5. fs.writeFile emits diff.created + edit.applied + file.changed(agent)
const scratch = "scratch/phase2-smoke.txt";
await rpc("fs.writeFile", { path: scratch, content: "hello phase 2\n" });
await waitForEvent("diff.created", (p) => p.path === scratch);
await waitForEvent("edit.applied", (p) => p.path === scratch);
const changed = await waitForEvent("file.changed", (p) => p.path === scratch, 15_000);
console.log(`PASS write pipeline: diff+applied+watcher(source=${changed.payload!.source})`);

// 6. fs.replaceCode
await rpc("fs.replaceCode", {
  path: scratch,
  oldString: "hello",
  newString: "hi",
});
const after = (await rpc("fs.readFile", { path: scratch })) as { content: string };
console.log(
  after.content.startsWith("hi phase 2")
    ? "PASS fs.replaceCode"
    : `FAIL replaceCode content: ${after.content}`
);

// 7. agent-driven edit through the SDK tool layer
const conv = (await rpc("session.createConversation", { title: "p2" })) as {
  conversation: { id: string };
};
const { taskId } = (await rpc("task.start", {
  conversationId: conv.conversation.id,
  prompt:
    "Use the write_file tool to create the file scratch/agent-note.md " +
    "containing exactly one line: Atelier phase 2 works. Then stop.",
})) as { taskId: string };
console.log(`.. task ${taskId}: waiting for model to use write_file`);

await waitForEvent(
  "tool.completed",
  (p) => p.name === "write_file" && String((p.result as Record<string, unknown>)?.path ?? "").includes("agent-note")
);
console.log("PASS model called write_file through the tool registry");
await waitForEvent("diff.created", (p) => String(p.path).includes("agent-note"));
console.log("PASS agent edit produced observable diff");
await waitForEvent("task.completed", () => true);

const note = (await rpc("fs.readFile", { path: "scratch/agent-note.md" })) as {
  content: string;
};
console.log(`PASS file on disk: ${JSON.stringify(note.content.trim())}`);

console.log("phase 2 smoke complete");
ws.close();
process.exit(0);
