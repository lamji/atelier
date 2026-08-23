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
import { codexBinary } from "./binary.js";

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

// WORDING IS LOAD-BEARING. The previous version forbade following
// "external ... MCP servers", and codex 0.147 honored that by stripping
// the MCP tools from the request entirely — 0 tool-carrying runs in 4
// A/B probes with that sentence, ~50% without it (the residual being the
// unrelated startup flake the ping gate retries). Never name MCP in a
// prohibition here; say what to avoid concretely instead. The old
// "tool-less completion" escape hatch is gone for the same reason — the
// ping gate retries a tool-less run rather than accepting its answer.
const ATELIER_CODEX_TOOL_INSTRUCTIONS =
  "CODEX BRIDGE CONTRACT: Your FIRST action in this tool-enabled run, " +
  "before anything else, is to call the Atelier `ping` tool once. Do all " +
  "workspace work through the Atelier tools — read, search, edit and run " +
  "only through them, never through native shell, apply_patch, filesystem, " +
  "git, browser, subagent, or computer-use tools.";

/** A healthy run emits JSONL continuously; this much silence is a corpse. */
const IDLE_TIMEOUT_MS = 180_000;

/** Runs Codex through the installed CLI and the user's signed-in Codex session. */
export async function runCodexExec(opts: CodexExecOptions): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const out = path.join(
    os.tmpdir(),
    `atelier-codex-${stamp}.txt`
  );
  const args = [
    "exec",
    "-",
    // Atelier owns orchestration. Keep the signed-in account, but do not
    // inherit personal MCP servers, plugins, hooks or exec rules.
    //
    // NO --ephemeral. Measured across every diagnostic run: with it, codex
    // 0.147 spawns the configured MCP server (the proxy's hello fires) but
    // never offers its tools to the model — 0 for 15 — so every Atelier
    // codex turn ran tool-less and reported it could not edit. Without it,
    // tools flow (the residual startup flake is handled by the hello-gated
    // retry). The cost is codex persisting session rollouts to its own
    // home, which is cosmetic; the isolation that matters is carried by
    // the two --ignore flags.
    "--ignore-user-config",
    "--ignore-rules",
    // `codex exec` is headless, so there is nobody to answer an approval
    // prompt. Without this, 0.147 reports MCP calls as "user cancelled"
    // even though the server started and the model selected its tool.
    "-c",
    `approval_policy="never"`,
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
    // Workspace actions belong to Atelier's authenticated MCP bridge. Keep
    // Codex's native shell unavailable so it cannot start a second workflow.
    "-c",
    "features.shell_tool=false",
  ];
  if (opts.model) args.push("--model", opts.model);
  // Atelier's picker goes up to max/ultra; codex tops out at xhigh, and an
  // unknown value fails the whole run rather than degrading.
  const effort =
    opts.effort === "max" || opts.effort === "ultra" ? "xhigh" : opts.effort;
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  // The prompt goes in over stdin, which carries no attachments — pasted
  // screenshots only reach the model as files behind `--image`.
  let imageFiles: string[] = [];
  try {
    imageFiles = await writeImageFiles(opts.images);
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
        // Avoid a Codex-side prompt for the non-interactive process. The
        // loopback bridge still runs ToolRegistry, so Atelier's own approval
        // hooks remain the authority for protected operations.
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
        `mcp_servers.atelier.env.ATELIER_CODEX_TOOL_TOKEN="${escapeToml(opts.toolBridge.token)}"`,
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

    // Codex 0.147's exec mode intermittently ignores the mcp_servers
    // config wholesale: no spawn attempt, no error, `required=true` not
    // enforced — the model just runs tool-less and reports it cannot edit.
    // The proxy pings the tool bridge the moment codex really spawned it,
    // so a missing ping inside the window is a detectable dud: kill it and
    // start over, and only a run whose tools are live gets to spend model
    // time. Attempts are bounded; the terminal case is a LOUD error, never
    // a silent tool-less turn.
    const attempts = opts.toolBridge ? MCP_SPAWN_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      const result = await runAttempt(opts, args, out);
      if (result.kind === "ok") return result.text;
      if (result.kind === "toolless" && attempt < attempts) {
        // Brief pause before the respawn: consecutive immediate retries
        // have been observed failing in streaks, and the wait costs
        // nothing against a dud that already burned ten seconds.
        await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
        if (opts.signal.aborted) throw new Error("Codex run cancelled");
        continue;
      }
      if (result.kind === "toolless") {
        throw new Error(
          `Codex never started the Atelier MCP tools in ${attempts} ` +
            "attempts — the codex CLI is not applying the MCP config. " +
            "The run was stopped rather than continuing without tools."
        );
      }
      throw result.error;
    }
  } finally {
    await fs.unlink(out).catch(() => undefined);
    await Promise.all(
      imageFiles.map((file) => fs.unlink(file).catch(() => undefined))
    );
  }
}

/** How many codex spawns may be burned proving the MCP config applied. */
const MCP_SPAWN_ATTEMPTS = 5;

/** Pause between dud spawns; immediate respawns fail in streaks. */
const RETRY_PAUSE_MS = 3000;

/**
 * How long the model gets to make its mandated first `ping` call before
 * the attempt is a dud. The signal is a TOOL CALL, not a process spawn —
 * codex has been observed to spawn the proxy, complete the handshake, and
 * still run the model tool-less — so the window covers codex startup plus
 * the model's first action, and nothing weaker counts as alive.
 */
const MCP_HELLO_TIMEOUT_MS = 45_000;

type AttemptResult =
  | { kind: "ok"; text: string }
  | { kind: "toolless" }
  | { kind: "error"; error: Error };

async function runAttempt(
  opts: CodexExecOptions,
  args: string[],
  out: string
): Promise<AttemptResult> {
  const attemptStart = Date.now();
  let text = "";
  let completed = false;
  const parser = new JsonLineParser((event) => {
    if (event.type === "turn.completed") completed = true;
    const delta = handleCodexEvent(event, opts.telemetry);
    if (delta) text += delta;
  });
  // Interactive runs already carry the provider-neutral executor contract
  // in opts.prompt. Only the bridge-specific ping/tool routing belongs here.
  // Tool-less one-shot calls must not be ordered to ping a bridge they do not
  // have — that contradictory instruction made Codex spend the completion
  // explaining why it could not comply.
  const input = opts.toolBridge
    ? `${ATELIER_CODEX_TOOL_INSTRUCTIONS}\n\n${opts.prompt}`
    : opts.prompt;
  // TEMP diagnostic — remove after the codex MCP investigation.
  if (process.env.ATELIER_CODEX_BRIDGE_DEBUG) {
    console.error(`[codex-args] ${JSON.stringify(args)}`);
  }
  // Diagnostic tap; harmless when the env var is unset.
  if (process.env.ATELIER_DUMP_CODEX_PROMPT) {
    await fs
      .writeFile(process.env.ATELIER_DUMP_CODEX_PROMPT, input, "utf8")
      .catch(() => undefined);
  }
  const child = execa(codexBinary(), args, {
      cwd: opts.cwd,
      input,
      // `codex` is a .cmd on Windows, so it launches through cmd.exe —
      // without this a console window appears on screen for every call.
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
      all: true,
      reject: false,
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
    // Idle watchdog, not a total cap. The old `timeout: 300_000` killed any
    // implementation longer than five minutes flat; a healthy run emits
    // reasoning/tool events continuously, so "no JSONL for three minutes"
    // is the actual death signal.
    let stalled = false;
    let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
    function onIdle(): void {
      stalled = true;
      killTree();
    }
    if (opts.signal.aborted) killTree();
    else opts.signal.addEventListener("abort", killTree, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
      // TEMP diagnostic — remove after the codex MCP investigation.
      if (process.env.ATELIER_CODEX_BRIDGE_DEBUG) {
        void fs
          .appendFile(
            path.join(os.tmpdir(), "atelier-codex-jsonl.log"),
            chunk.toString("utf8")
          )
          .catch(() => undefined);
      }
      parser.push(chunk.toString("utf8"));
    });

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
      // Tool liveness gate: either the proxy phones home inside the
      // window, or this spawn is a dud and dies before it spends model
      // time. The child finishing first (a crash, a config error) falls
      // through to the normal result handling below.
      if (opts.toolBridge) {
        const hello = opts.toolBridge.waitForHello(
          attemptStart,
          MCP_HELLO_TIMEOUT_MS
        );
        const first = await Promise.race([
          hello.then((ok): "hello" | "no-hello" => (ok ? "hello" : "no-hello")),
          child.then((): "exited" => "exited"),
          cancelled,
        ]);
        if (first === "no-hello") {
          killTree();
          await child.catch(() => undefined);
          return { kind: "toolless" };
        }
      }
      const result = await Promise.race([child, cancelled]);
      parser.flush();
      if (stalled) {
        return {
          kind: "error",
          error: new Error(
            `Codex exec stalled — no output for ${IDLE_TIMEOUT_MS / 1000}s`
          ),
        };
      }
      const finalText = await fs.readFile(out, "utf8").catch(() => "");
      const outputText = finalText.trim() || text.trim() || (result.all ?? "").trim();
      if (result.exitCode != null && result.exitCode !== 0) {
        return {
          kind: "error",
          error: new Error(
            `Codex exec failed (${result.exitCode}): ${codexFailure(result)}`
          ),
        };
      }
      if (result.exitCode == null && !completed) {
        return {
          kind: "error",
          error: new Error(`Codex exec failed (unknown): ${codexFailure(result)}`),
        };
      }
      // A run can finish FASTER than the hello window — a tool-less codex
      // answers "I cannot edit" in seconds — and exiting cleanly is not
      // proof the tools were there. The answer only counts when the proxy
      // actually reported in; the short grace covers a ping still in
      // flight while the child was exiting.
      if (opts.toolBridge) {
        const arrived = await opts.toolBridge.waitForHello(attemptStart, 1500);
        if (!arrived) return { kind: "toolless" };
      }
      return { kind: "ok", text: outputText };
    } finally {
      clearTimeout(idleTimer);
      opts.signal.removeEventListener("abort", killTree);
    }
}

function codexFailure(result: {
  all?: string;
  stdout?: string;
  stderr?: string;
  shortMessage?: string;
  message?: string;
}): string {
  return [
    result.all,
    result.stderr,
    result.stdout,
    result.shortMessage,
    result.message,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .replace(/codex_mcp_[A-Za-z0-9_-]+/g, "codex_mcp_[redacted]")
    .slice(-2000);
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
  // Source mode: still prefer the built bundle over mcp-main.ts + tsx.
  // The bundle answers the MCP handshake in ~0.5s; the tsx path spends
  // seconds transforming first, and codex 0.147's tool injection appears
  // to race proxy startup — measured 0/18 tool-carrying runs on the tsx
  // path against a mixed record on the bundle. Falling back to source is
  // for a checkout that has never built; a stale bundle beats a slow one.
  const devBundle = path.join(here, "../../../dist-electron/codex-mcp.mjs");
  if (existsSync(devBundle)) return devBundle;
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
  // The model's reasoning summaries. `codex exec --json` has no token
  // deltas — agent messages land whole — so these are most of the run's
  // live signal. Dropped (the old behavior), the console sat dead for
  // exactly as long as the model was thinking.
  if (item.type === "reasoning" && event.type === "item.completed") {
    const text = item.text ?? "";
    if (text && telemetry) {
      telemetry.bus.publish(
        "agent.thinking.delta",
        { conversationId: telemetry.conversationId, delta: `${text}\n` },
        telemetry.taskId
      );
    }
    return "";
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
