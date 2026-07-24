import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { ClientFrame, CLOSE_UNAUTHORIZED } from "@atelier/protocol";
import type { Logger } from "pino";
import type { AgentConfig } from "../config/agent-config.js";
import type { BridgeInfo } from "../config/token.js";
import { Connection } from "./connection.js";
import type { EventHub } from "./event-hub.js";
import type { WebHost } from "./web-host.js";
import { Router, RpcError, type HandlerContext } from "./router.js";

const HANDSHAKE_TIMEOUT_MS = 5000;

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private http: http.Server | null = null;

  constructor(
    private config: AgentConfig,
    private info: BridgeInfo,
    private router: Router,
    private hub: EventHub,
    private log: Logger,
    private webHost: WebHost | null = null
  ) {}

  start(): void {
    // One HTTP server carries both the WS bridge and (packaged mode) the
    // static web UI, so the whole app lives on a single port.
    this.http = http.createServer((req, res) => {
      if (this.webHost) {
        this.webHost.handle(req, res);
      } else {
        res.writeHead(426).end("upgrade required");
      }
    });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.http.listen(this.config.port, this.config.host, () => {
      const scheme = this.webHost ? "http" : "ws";
      this.log.info(
        `bridge listening on ${scheme}://${this.config.host}:${this.config.port}` +
          (this.webHost ? " (serving web UI)" : "")
      );
    });
  }

  stop(): void {
    this.wss?.close();
    this.http?.close();
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients
    try {
      const host = new URL(origin).hostname;
      return host === "localhost" || host === "127.0.0.1";
    } catch {
      return false;
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!this.originAllowed(req)) {
      ws.close(CLOSE_UNAUTHORIZED, "origin not allowed");
      return;
    }
    const conn = new Connection(ws);
    this.hub.attach(conn);
    this.log.debug({ connId: conn.id }, "connection opened");

    const handshakeTimer = setTimeout(() => {
      if (!conn.authenticated) {
        conn.close(CLOSE_UNAUTHORIZED, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("message", (data) => {
      void this.onMessage(conn, String(data));
    });
    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      conn.abortAll();
      this.hub.detach(conn);
      this.log.debug({ connId: conn.id }, "connection closed");
    });
    ws.on("error", (error) => {
      this.log.warn({ err: error }, "socket error");
    });
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = ClientFrame.parse(JSON.parse(raw));
    } catch {
      this.log.warn({ connId: conn.id }, "unparseable frame dropped");
      return;
    }

    switch (frame.kind) {
      case "req":
        await this.handleRequest(conn, frame.id, frame.method, frame.params);
        return;
      case "cancel": {
        conn.inflight.get(frame.id)?.abort();
        return;
      }
      case "sub": {
        if (!conn.authenticated) return;
        this.hub.subscribe(conn, frame.id, frame.topic, frame.filter, frame.since);
        return;
      }
      case "unsub": {
        this.hub.unsubscribe(conn, frame.subId);
        return;
      }
    }
  }

  private async handleRequest(
    conn: Connection,
    id: string,
    method: string,
    params: unknown
  ): Promise<void> {
    const abort = new AbortController();
    conn.inflight.set(id, abort);
    const ctx: HandlerContext = {
      connectionId: conn.id,
      authenticated: conn.authenticated,
      signal: abort.signal,
      progress: (value) => conn.send({ kind: "progress", id, value }),
    };
    try {
      if (method === "session.hello") {
        this.verifyToken(params);
        conn.authenticated = true;
        ctx.authenticated = true;
      }
      const result = await this.router.dispatch(method, params, ctx);
      if (method === "session.hello") {
        conn.sessionId = (result as { sessionId: string }).sessionId;
      }
      conn.send({ kind: "res", id, ok: true, result });
    } catch (error) {
      if (error instanceof RpcError) {
        conn.send({ kind: "res", id, ok: false, error: error.toBridgeError() });
        if (error.code === "UNAUTHORIZED" && method === "session.hello") {
          conn.close(CLOSE_UNAUTHORIZED, "bad token");
        }
      } else if (abort.signal.aborted) {
        conn.send({
          kind: "res",
          id,
          ok: false,
          error: { code: "CANCELLED", message: "request cancelled" },
        });
      } else {
        this.log.error({ err: error, method }, "handler failed");
        conn.send({
          kind: "res",
          id,
          ok: false,
          error: { code: "INTERNAL", message: String(error) },
        });
      }
    } finally {
      conn.inflight.delete(id);
    }
  }

  private verifyToken(params: unknown): void {
    const token = (params as { token?: string } | undefined)?.token;
    if (typeof token !== "string" || token !== this.info.token) {
      throw new RpcError("UNAUTHORIZED", "invalid bridge token");
    }
  }
}
