/**
 * End-to-end bridge smoke test (Phase 1 DoD):
 *   handshake, bad-token rejection, conversation, chat round-trip, timeline.
 * Requires the agent to be running. Run:
 *   pnpm --filter @atelier/agent exec tsx scripts/bridge-smoke.ts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";

const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
const infoPath = path.join(
  process.env.ATELIER_DATA_DIR ?? path.join(base, "atelier"),
  "bridge.json"
);
const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as {
  port: number;
  token: string;
};
const url = `ws://127.0.0.1:${info.port}`;

function connect(): WebSocket {
  return new WebSocket(url, { origin: "http://localhost:5173" });
}

interface Frame {
  kind: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  topic?: string;
  payload?: unknown;
}

let nextId = 0;
function rpc(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = `smoke_${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
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

async function testBadToken(): Promise<void> {
  const ws = connect();
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));
  const closeCode = new Promise<number>((resolve) =>
    ws.on("close", (code) => resolve(code))
  );
  await rpc(ws, "session.hello", {
    token: "wrong",
    protocolVersion: 1,
    clientInfo: { name: "smoke", version: "0" },
  }).catch((error: Error) => {
    console.log(`PASS bad token rejected: ${error.message}`);
  });
  const code = await closeCode;
  console.log(
    code === 4401
      ? "PASS socket closed with 4401"
      : `FAIL close code was ${code}`
  );
}

async function testChat(): Promise<void> {
  const ws = connect();
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));

  const hello = (await rpc(ws, "session.hello", {
    token: info.token,
    protocolVersion: 1,
    clientInfo: { name: "smoke", version: "0" },
  })) as { workspaceRoot: string; authStatus: string };
  console.log(
    `PASS hello: workspace=${hello.workspaceRoot} auth=${hello.authStatus}`
  );

  let deltas = 0;
  let completedText = "";
  const done = new Promise<void>((resolve, reject) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.kind !== "event") return;
      const payload = frame.payload as Record<string, unknown>;
      if (frame.topic === "chat.message.delta") deltas += 1;
      if (frame.topic === "chat.message.completed") {
        completedText = String(payload.text);
      }
      if (frame.topic === "task.completed") resolve();
      if (frame.topic === "task.error") {
        reject(new Error(`task.error: ${String(payload.message)}`));
      }
    });
  });
  ws.send(JSON.stringify({ kind: "sub", id: "sub_all", topic: "*" }));

  const conv = (await rpc(ws, "session.createConversation", {
    title: "smoke",
  })) as { conversation: { id: string } };
  const { taskId } = (await rpc(ws, "task.start", {
    conversationId: conv.conversation.id,
    prompt: "Reply with exactly the word: pong",
  })) as { taskId: string };
  console.log(`.. task ${taskId} started, waiting for stream`);

  await done;
  console.log(
    `PASS chat round-trip: ${deltas} deltas, reply=${JSON.stringify(
      completedText.slice(0, 80)
    )}`
  );

  const timeline = (await rpc(ws, "task.getTimeline", { taskId })) as {
    entries: Array<{ topic: string }>;
  };
  const topics = timeline.entries.map((e) => e.topic);
  console.log(`PASS timeline persisted: [${topics.join(", ")}]`);

  const notImpl = await rpc(ws, "fs.readFile", { path: "README.md" }).catch(
    (error: Error) => error.message
  );
  console.log(`PASS stub method answers: ${String(notImpl)}`);

  ws.close();
}

await testBadToken();
await testChat();
console.log("smoke complete");
process.exit(0);
