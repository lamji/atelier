import http from "node:http";
import { newId } from "@atelier/shared";
import type { ToolRegistry } from "../../tools/registry.js";
import { shapeToolOutput } from "../../context/tool-output/index.js";

interface Session {
  taskId: string;
  signal: AbortSignal;
}

export interface CodexToolBridgeSession {
  url: string;
  token: string;
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
    this.sessions.set(token, { taskId, signal });
    const dispose = () => this.sessions.delete(token);
    signal.addEventListener("abort", dispose, { once: true });
    return {
      url: `http://127.0.0.1:${this.port}/call`,
      token,
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
