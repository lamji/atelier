import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { ImageAttachment, ReasoningEffort } from "@atelier/protocol";
import type { EventBus } from "../../events/event-bus.js";
import type { CodexToolBridgeSession } from "./tool-bridge.js";

export interface CodexExecOptions {
  cwd: string;
  prompt: string;
  model?: string;
  signal: AbortSignal;
  sandbox: "read-only" | "workspace-write";
  effort?: ReasoningEffort;
  telemetry?: CodexTelemetry;
  toolBridge?: CodexToolBridgeSession;
  /**
   * Atelier tools the MCP proxy should register. Undefined registers all
   * of them; direct mode (system knowledge off) passes the subset that
   * excludes retrieval, the graph, and impact analysis.
   */
  toolNames?: string[];
  /** Attachments for this turn. Codex reads images from disk, not stdin. */
  images?: ImageAttachment[];
}

interface CodexTelemetry {
  bus: EventBus;
  taskId: string;
  conversationId: string;
  messageId: string;
}

interface CodexJsonEvent {
  type?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
}

/** Runs Codex through the installed CLI and the user's signed-in Codex session. */
export async function runCodexExec(opts: CodexExecOptions): Promise<string> {
  const out = path.join(
    os.tmpdir(),
    `atelier-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  const args = [
    "exec",
    "-",
    "--cd",
    opts.cwd,
    "--sandbox",
    opts.sandbox,
    "--output-last-message",
    out,
    "--color",
    "never",
    "--json",
    "--skip-git-repo-check",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  // The prompt goes in over stdin, which carries no attachments — pasted
  // screenshots only reach the model as files behind `--image`.
  const imageFiles = await writeImageFiles(opts.images);
  for (const file of imageFiles) args.push("--image", file);
  if (opts.toolBridge) {
    const mcpEntry = resolveMcpEntry();
    args.push(
      "-c",
      `mcp_servers.atelier.required=true`,
      "-c",
      `mcp_servers.atelier.startup_timeout_sec=30`,
      "-c",
      `mcp_servers.atelier.tool_timeout_sec=120`,
      "-c",
      `mcp_servers.atelier.default_tools_approval_mode="approve"`,
      // Spawn the bundle with the runtime we are already running under.
      // pnpm/tsx are absent in the packaged app, and pnpm's own output on
      // stdout broke the MCP initialize handshake even where it existed.
      "-c",
      `mcp_servers.atelier.command="${escapeToml(process.execPath)}"`,
      "-c",
      `mcp_servers.atelier.args=["${escapeToml(mcpEntry)}"]`,
      "-c",
      `mcp_servers.atelier.cwd="${escapeToml(path.dirname(mcpEntry))}"`,
      // process.execPath is electron.exe in the desktop app; without this
      // it would boot a browser process instead of Node.
      "-c",
      `mcp_servers.atelier.env.ELECTRON_RUN_AS_NODE="1"`,
      "-c",
      `mcp_servers.atelier.env.ATELIER_CODEX_TOOL_URL="${escapeToml(opts.toolBridge.url)}"`,
      "-c",
      `mcp_servers.atelier.env.ATELIER_CODEX_TOOL_TOKEN="${escapeToml(opts.toolBridge.token)}"`
    );
    // Source-run fallback: plain Node cannot load the .ts entry on its own.
    if (mcpEntry.endsWith(".ts")) {
      args.push("-c", `mcp_servers.atelier.env.NODE_OPTIONS="--import tsx"`);
    }
    // The proxy registers only these when set — an absent tool is the one
    // way to make "no retrieval" true for a model we do not otherwise gate.
    if (opts.toolNames) {
      args.push(
        "-c",
        "mcp_servers.atelier.env.ATELIER_CODEX_TOOLS=" +
          `"${escapeToml(opts.toolNames.join(","))}"`
      );
    }
  }

  try {
    let text = "";
    let completed = false;
    const parser = new JsonLineParser((event) => {
      if (event.type === "turn.completed") completed = true;
      const delta = handleCodexEvent(event, opts.telemetry);
      if (delta) text += delta;
    });
    const child = execa("codex", args, {
      cwd: opts.cwd,
      input: opts.prompt,
      // `codex` is a .cmd on Windows, so it launches through cmd.exe —
      // without this a console window appears on screen for every call.
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
      all: true,
      reject: false,
      timeout: 300_000,
      cancelSignal: opts.signal,
      forceKillAfterDelay: 1000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const killTree = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).unref();
      } else {
        child.kill("SIGTERM");
      }
    };
    if (opts.signal.aborted) killTree();
    else opts.signal.addEventListener("abort", killTree, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => parser.push(chunk.toString("utf8")));

    // Stop must be immediate. Killing the tree is best-effort — `codex`
    // spawns its own MCP server and a shim on Windows — and waiting for
    // that teardown left the UI sitting on "stopping" long after the user
    // asked. The kill still runs; this just stops the task waiting on it.
    const cancelled = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("Codex run cancelled"));
      if (opts.signal.aborted) fail();
      else opts.signal.addEventListener("abort", fail, { once: true });
    });
    // The child is raced, so nothing else awaits it — without this an
    // abort-time rejection would surface as an unhandled rejection.
    void child.catch(() => undefined);

    try {
      const result = await Promise.race([child, cancelled]);
      parser.flush();
      const finalText = await fs.readFile(out, "utf8").catch(() => "");
      const outputText = finalText.trim() || text.trim() || (result.all ?? "").trim();
      if (result.exitCode != null && result.exitCode !== 0) {
        throw new Error(
          `Codex exec failed (${result.exitCode}): ${(result.all ?? "").slice(-2000)}`
        );
      }
      if (result.exitCode == null && !completed) {
        throw new Error(
          `Codex exec failed (unknown): ${(result.all ?? "").slice(-2000)}`
        );
      }
      return outputText;
    } finally {
      opts.signal.removeEventListener("abort", killTree);
    }
  } finally {
    await fs.unlink(out).catch(() => undefined);
    await Promise.all(
      imageFiles.map((file) => fs.unlink(file).catch(() => undefined))
    );
  }
}

/**
 * Locates the bundled stdio MCP server. Every build emits codex-mcp.mjs
 * beside the agent entry — dist-electron/ in dev, resources/agent/ when
 * packaged — so this is one lookup in both. Running the agent straight
 * from source under tsx has no bundle, so it falls back to the .ts entry
 * spawned through the tsx loader already in this process.
 */
function resolveMcpEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "codex-mcp.mjs");
  if (existsSync(bundled)) return bundled;
  const source = path.join(here, "mcp-main.ts");
  if (existsSync(source)) return source;
  throw new Error(
    `Atelier MCP server for Codex not found (looked in ${here}). ` +
      "Rebuild the agent bundle: pnpm --filter @atelier/agent build:electron"
  );
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Spills base64 attachments to temp files so `codex exec --image` can read them. */
async function writeImageFiles(
  images: ImageAttachment[] | undefined
): Promise<string[]> {
  if (!images || images.length === 0) return [];
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const written: string[] = [];
  try {
    for (const [index, image] of images.entries()) {
      const ext = IMAGE_EXTENSIONS[image.mediaType.toLowerCase()] ?? "png";
      const file = path.join(
        os.tmpdir(),
        `atelier-codex-img-${stamp}-${index}.${ext}`
      );
      await fs.writeFile(file, Buffer.from(image.data, "base64"));
      written.push(file);
    }
    return written;
  } catch (error) {
    await Promise.all(
      written.map((file) => fs.unlink(file).catch(() => undefined))
    );
    throw error;
  }
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function handleCodexEvent(
  event: CodexJsonEvent,
  telemetry: CodexTelemetry | undefined
): string {
  const item = event.item;
  if (!item) return "";
  if (item.type === "agent_message" && event.type === "item.completed") {
    const text = item.text ?? "";
    if (text && telemetry) {
      telemetry.bus.publish(
        "chat.message.delta",
        {
          conversationId: telemetry.conversationId,
          messageId: telemetry.messageId,
          delta: text,
        },
        telemetry.taskId
      );
    }
    return text;
  }
  if (item.type === "command_execution") {
    publishCommandEvent(event.type, item, telemetry);
  }
  return "";
}

function publishCommandEvent(
  type: string | undefined,
  item: NonNullable<CodexJsonEvent["item"]>,
  telemetry: CodexTelemetry | undefined
): void {
  if (!telemetry || !item.id) return;
  const toolCallId = `codex_${item.id}`;
  const input = { command: item.command ?? "" };
  if (type === "item.started") {
    telemetry.bus.publish(
      "tool.started",
      { toolCallId, name: "run_terminal", input },
      telemetry.taskId
    );
    return;
  }
  if (type !== "item.completed") return;
  const result = {
    exitCode: item.exit_code ?? null,
    output: item.aggregated_output ?? "",
    truncated: false,
    timedOut: false,
  };
  if (item.status === "completed" && item.exit_code === 0) {
    telemetry.bus.publish(
      "tool.completed",
      { toolCallId, name: "run_terminal", result, durationMs: 0 },
      telemetry.taskId
    );
  } else {
    telemetry.bus.publish(
      "tool.failed",
      {
        toolCallId,
        name: "run_terminal",
        error: `Codex command failed (${item.exit_code ?? "unknown"})`,
        durationMs: 0,
      },
      telemetry.taskId
    );
  }
}

class JsonLineParser {
  private buffer = "";

  constructor(private onEvent: (event: CodexJsonEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.parse(line);
  }

  flush(): void {
    if (this.buffer) this.parse(this.buffer);
    this.buffer = "";
  }

  private parse(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      this.onEvent(JSON.parse(trimmed) as CodexJsonEvent);
    } catch {
      // Older Codex builds can mix status text into stdout.
    }
  }
}
