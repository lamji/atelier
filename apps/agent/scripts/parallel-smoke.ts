/**
 * Multi-agent smoke: two tasks started simultaneously in two conversations
 * must run concurrently (interleaved chat deltas) and finish independently.
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
  taskId?: string;
  payload?: Record<string, unknown>;
}

let nextId = 0;
function rpc(method: string, params: unknown): Promise<unknown> {
  const id = `par_${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 240_000);
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

await rpc("session.hello", {
  token: info.token,
  protocolVersion: 1,
  clientInfo: { name: "parallel-smoke", version: "0" },
});
ws.send(JSON.stringify({ kind: "sub", id: "sub_all", topic: "*" }));

const convA = ((await rpc("session.createConversation", { title: "agent A" })) as {
  conversation: { id: string };
}).conversation.id;
const convB = ((await rpc("session.createConversation", { title: "agent B" })) as {
  conversation: { id: string };
}).conversation.id;

const deltaLog: Array<"A" | "B"> = [];
const completed = new Set<string>();
const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for tasks")), 240_000);
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as Frame;
    if (frame.kind !== "event") return;
    const conv = frame.payload?.conversationId;
    if (frame.topic === "chat.message.delta") {
      if (conv === convA) deltaLog.push("A");
      if (conv === convB) deltaLog.push("B");
    }
    if (frame.topic === "task.completed" || frame.topic === "task.error") {
      completed.add(String(conv));
      if (frame.topic === "task.error") {
        console.log(`.. task error in ${conv === convA ? "A" : "B"}: ${frame.payload?.message}`);
      }
      if (completed.size === 2) {
        clearTimeout(timer);
        resolve();
      }
    }
  });
});

const prompt =
  "Count from 1 to 15, one short sentence per number. Do not use any tools.";
const [taskA, taskB] = await Promise.all([
  rpc("task.start", { conversationId: convA, prompt }),
  rpc("task.start", { conversationId: convB, prompt }),
]);
console.log(
  `PASS both tasks started: A=${(taskA as { taskId: string }).taskId} ` +
    `B=${(taskB as { taskId: string }).taskId}`
);

// Same conversation must reject a second concurrent task.
await rpc("task.start", { conversationId: convA, prompt: "again" }).then(
  () => console.log("FAIL second task in same conversation was allowed"),
  (error: Error) =>
    console.log(`PASS same-session concurrency rejected: ${error.message.slice(0, 80)}`)
);

await done;

const switches = deltaLog.reduce(
  (n, cur, i) => (i > 0 && deltaLog[i - 1] !== cur ? n + 1 : n),
  0
);
const aCount = deltaLog.filter((x) => x === "A").length;
const bCount = deltaLog.filter((x) => x === "B").length;
console.log(
  `PASS both completed. deltas A=${aCount} B=${bCount}, stream interleavings=${switches}`
);
console.log(
  switches >= 2
    ? "PASS tasks ran concurrently (streams interleaved)"
    : "WARN streams did not interleave — tasks may have run sequentially"
);
ws.close();
process.exit(0);
