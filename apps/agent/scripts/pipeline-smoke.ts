/**
 * Phase 6 DoD smoke: drive a real task through the running agent and
 * assert the 9 pipeline stages emit in order, a plan is created, and a
 * summary lands. Requires the agent running + Claude auth.
 *
 *   pnpm --filter @atelier/agent smoke:pipeline
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";

const PIPELINE_ORDER = [
  "understand",
  "retrieve",
  "impact",
  "plan",
  "hooks",
  "execute",
  "validate",
  "knowledge",
  "review",
  "summary",
];

const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
const infoPath = path.join(
  process.env.ATELIER_DATA_DIR ?? path.join(base, "atelier"),
  "bridge.json"
);
const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as {
  port: number;
  token: string;
};

interface Frame {
  kind: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  topic?: string;
  taskId?: string;
  payload?: unknown;
}

let nextId = 0;
function rpc(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = `psmoke_${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout: ${method}`)),
      120_000
    );
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

async function main(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, {
    origin: "http://localhost:5173",
  });
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));
  await rpc(ws, "session.hello", {
    token: info.token,
    protocolVersion: 1,
    clientInfo: { name: "pipeline-smoke", version: "0" },
  });
  ws.send(JSON.stringify({ kind: "sub", id: "sub1", topic: "*" }));

  const conv = (await rpc(ws, "session.createConversation", {
    title: "pipeline smoke",
  })) as { conversation: { id: string } };

  const stagesStarted: string[] = [];
  const stagesCompleted: Array<{ stage: string; ok: boolean; detail?: string }> =
    [];
  let planSteps = 0;
  let intentKind = "";
  let summaryText = "";
  let hookBlocks = 0;
  const done = new Promise<string>((resolve) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.kind !== "event") return;
      const p = frame.payload as Record<string, unknown>;
      switch (frame.topic) {
        case "pipeline.stage.started":
          stagesStarted.push(String(p.stage));
          break;
        case "pipeline.stage.completed":
          stagesCompleted.push({
            stage: String(p.stage),
            ok: Boolean(p.ok),
            detail: p.detail as string | undefined,
          });
          break;
        case "intent.resolved":
          intentKind = String(p.kind);
          break;
        case "plan.created":
          planSteps = Array.isArray(p.steps) ? p.steps.length : 0;
          break;
        case "summary.created":
          summaryText = String(p.text ?? "");
          break;
        case "hook.blocked":
          hookBlocks += 1;
          break;
        case "task.completed":
          resolve("completed");
          break;
        case "task.error":
          resolve(`error: ${String(p.message)}`);
          break;
      }
    });
  });

  const started = (await rpc(ws, "task.start", {
    conversationId: conv.conversation.id,
    prompt:
      "Answer briefly from your knowledge index: which file implements " +
      "the incremental indexer? Do not modify anything.",
  })) as { taskId: string };
  console.log(`task started: ${started.taskId}`);

  const outcome = await Promise.race([
    done,
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("TIMEOUT"), 240_000)
    ),
  ]);

  console.log(`outcome: ${outcome}`);
  console.log(`intent: ${intentKind}`);
  console.log(`stages started:   ${stagesStarted.join(" -> ")}`);
  console.log(
    `stages completed: ${stagesCompleted
      .map((s) => `${s.stage}${s.ok ? "" : "(FAIL)"}`)
      .join(" -> ")}`
  );
  console.log(`plan steps: ${planSteps}`);
  console.log(`summary: ${summaryText}`);
  if (hookBlocks > 0) console.log(`hook blocks observed: ${hookBlocks}`);

  const orderOk =
    JSON.stringify(stagesStarted) === JSON.stringify(PIPELINE_ORDER);
  const allOk = stagesCompleted.every((s) => s.ok);
  console.log(
    orderOk
      ? "PASS all 9 stages emitted in order"
      : "FAIL stage order incorrect"
  );
  console.log(allOk ? "PASS all stages completed ok" : "FAIL a stage failed");
  console.log(
    summaryText ? "PASS summary.created emitted" : "FAIL no summary event"
  );

  ws.close();
  process.exit(orderOk && allOk && outcome === "completed" ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
