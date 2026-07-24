import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeInfo } from "../config/token.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

/** Snapshot of index readiness for the /atelier/ready endpoint. */
export interface ReadyStatus {
  ready: boolean;
  files: number;
  indexed: number;
}

/**
 * Serves the built web UI over HTTP on the bridge port (packaged mode).
 * index.html is rewritten on the fly to carry the current bridge token so
 * the UI auto-connects with no manual paste. A /atelier/ready endpoint
 * lets the CLI wait for the first index pass before opening the browser.
 */
export class WebHost {
  private indexHtml: string | null = null;

  constructor(
    private distPath: string,
    private info: BridgeInfo,
    private getReady: () => ReadyStatus,
    /** Window global the port+token are injected as. The supervisor serves
     * the same UI but injects "__ATELIER_HUB__" instead of the bridge. */
    private globalName = "__ATELIER_BRIDGE__"
  ) {}

  /** Returns true if it served the request (so the WS upgrade path skips it). */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/atelier/ready") {
      const status = this.getReady();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(status));
      return true;
    }

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(this.renderIndex());
      return true;
    }

    // Static asset (path-guarded to the dist directory).
    const rel = pathname.replace(/^\/+/, "");
    const abs = path.resolve(this.distPath, rel);
    if (!abs.startsWith(path.resolve(this.distPath))) {
      res.writeHead(403).end("forbidden");
      return true;
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": ext === ".html" ? "no-cache" : "max-age=31536000",
      });
      fs.createReadStream(abs).pipe(res);
      return true;
    }

    // SPA fallback: unknown non-asset routes get index.html.
    if (!path.extname(pathname)) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(this.renderIndex());
      return true;
    }

    res.writeHead(404).end("not found");
    return true;
  }

  private renderIndex(): string {
    if (this.indexHtml === null) {
      const file = path.join(this.distPath, "index.html");
      this.indexHtml = fs.readFileSync(file, "utf8");
    }
    const inject =
      `<script>window.${this.globalName}=${JSON.stringify({
        port: this.info.port,
        token: this.info.token,
      })};</script>`;
    // Inject right after <head> so it runs before the app bundle.
    return this.indexHtml.replace(/<head[^>]*>/i, (m) => `${m}${inject}`);
  }
}
