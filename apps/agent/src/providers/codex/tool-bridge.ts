import http from "node:http";
import { newId } from "@atelier/shared";
import type { ToolRegistry } from "../../tools/registry.js";
import { shapeToolOutput } from "../../context/tool-output/index.js";

interface Session {
  taskId: string;
  signal: AbortSignal;
  /** When the MCP proxy last announced itself, epoch ms. 0 = never. */
  helloAt: number;
}

export interface CodexToolBridgeSession {
  url: string;
  token: string;
  /**
   * Resolves true when the MCP proxy has phoned home SINCE `sinceTs` —
   * i.e. codex really spawned it for the current attempt. Codex 0.147's
   * exec mode intermittently ignores the whole mcp_servers config and
   * runs tool-less without any error; this is the detector that turns
   * that silence into something the client can see and retry.
   */
  waitForHello: (sinceTs: number, timeoutMs: number) => Promise<boolean>;
  dispose: () => void;
}

/**
 * Loopback bridge used only by Codex's stdio MCP proxy. The proxy cannot hold
 * this process's ToolRegistry, so it calls back here and the real registry
 * still owns hooks, tool events, shaped output, diffs, and cancellation.
 */
export class CodexToolBridge {
  private server: http.Server | null = null;
  private port = 0;
  private sessions = new Map<string, Session>();

  constructor(private tools: ToolRegistry) {}

  async session(taskId: string, signal: AbortSignal): Promise<CodexToolBridgeSession> {
    await this.ensureStarted();
    const token = newId("codex_mcp");
    const session: Session = { taskId, signal, helloAt: 0 };
    this.sessions.set(token, session);
    const dispose = () => this.sessions.delete(token);
    signal.addEventListener("abort", dispose, { once: true });
    const waitForHello = (sinceTs: number, timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
          if (session.helloAt >= sinceTs) return resolve(true);
          if (Date.now() >= deadline || signal.aborted) return resolve(false);
          setTimeout(check, 100);
        };
        check();
      });
    return {
      url: `http://127.0.0.1:${this.port}/call`,
      token,
      waitForHello,
      dispose,
    };
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.sessions.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        this.port = typeof address === "object" && address ? address.port : 0;
        resolve();
      });
    });
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // TEMP diagnostic — remove after the codex MCP investigation.
    if (process.env.ATELIER_CODEX_BRIDGE_DEBUG) {
      console.error(`[bridge] ${req.method} ${req.url}`);
    }
    // The proxy's sign of life, sent the moment its stdio server is up.
    // A call on /hello is proof codex actually applied the MCP config and
    // spawned the proxy for this attempt.
    if (req.method === "POST" && req.url === "/hello") {
      try {
        const body = (await readJson(req)) as { token?: string };
        const session = body.token ? this.sessions.get(body.token) : undefined;
        if (!session) {
          res.writeHead(401).end("unauthorized");
          return;
        }
        session.helloAt = Date.now();
        writeJson(res, { ok: true });
      } catch (error) {
        writeJson(res, { ok: false, text: `Error: ${String(error)}` });
      }
      return;
    }
    if (req.method !== "POST" || req.url !== "/call") {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = (await readJson(req)) as {
        token?: string;
        name?: string;
        input?: unknown;
      };
      const session = body.token ? this.sessions.get(body.token) : undefined;
      if (!session || !body.name) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const result = await this.tools.run(
        body.name,
        body.input ?? {},
        session.taskId,
        session.signal
      );
      writeJson(res, { ok: true, text: shapeToolOutput(body.name, result) });
    } catch (error) {
      writeJson(res, { ok: false, text: `Error: ${String(error)}` });
    }
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
