import { writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { createMainWindow } from "./window";
import { devUrl, packagedIndexHtml } from "./resolve-url";
import { registerIpcHandlers } from "./ipc";
import { registerAppIpc } from "./ipc-app";
import { installAppMenu } from "./menu";
import { mark } from "./boot-trace";
import { ProjectManager, resolveAgentEntry } from "./project-manager";
import { IPC_CHANNELS } from "../shared/ipc-contract";

function configureAppIdentity(): void {
  if (app.isPackaged) {
    app.setAppUserModelId("dev.atelier.desktop");
    return;
  }
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  const devDataDir = path.join(base, "atelier-dev");
  process.env.ATELIER_DATA_DIR = process.env.ATELIER_DATA_DIR ?? devDataDir;
  app.setName("Atelier Dev");
  app.setPath("userData", devDataDir);
  app.setAppUserModelId("dev.atelier.desktop.dev");
}

configureAppIdentity();

const AUTH_PROTOCOL = "atelier";
const OAUTH_LOOPBACK_HOST = "127.0.0.1";
const OAUTH_LOOPBACK_PORT = 43119;
const OAUTH_CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signed in to Atelier</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #09090b;
      color: #f4f4f5;
    }
    main {
      width: min(100%, 420px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      padding: 36px;
      border: 1px solid #27272a;
      border-radius: 20px;
      background: #18181b;
      text-align: center;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .45);
    }
    .mark {
      width: 56px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 16px;
      background: #f4f4f5;
      color: #18181b;
      font-size: 22px;
      font-weight: 750;
    }
    .check { color: #34d399; font-size: 34px; line-height: 1; }
    h1 { margin: 0; font-size: 24px; letter-spacing: -.02em; }
    p { margin: 0; color: #a1a1aa; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">A</div>
    <div class="check" aria-hidden="true">✓</div>
    <h1>You can close this tab now</h1>
    <p>Atelier is open and finishing your Google sign-in.</p>
  </main>
</body>
</html>`;

let pendingAuthCallback = findAuthCallback(process.argv);
let oauthLoopbackServer: http.Server | null = null;
let oauthLoopbackPromise: Promise<string> | null = null;
const projects = new ProjectManager(resolveAgentEntry());
const primaryInstance = app.requestSingleInstanceLock();

if (!primaryInstance) {
  app.quit();
} else {
  registerAuthProtocol();

  app.on("second-instance", (_event, argv) => {
    const callback = findAuthCallback(argv);
    if (callback) deliverAuthCallback(callback);
    else focusMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (isAuthCallback(url)) deliverAuthCallback(url);
  });

  app.whenReady().then(() => {
    mark("app ready");
    installAppMenu();
    registerIpcHandlers();
    ipcMain.handle(IPC_CHANNELS.oauthCallbackUrl, () => ensureAuthLoopback());
    registerAppIpc(projects);
    // The host fork can overlap renderer load. Opening a workspace is left to
    // the renderer so heavy db/watch/indexer work cannot run before first paint.
    projects.prewarmHost();
    void start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void start();
    });
  });
}

async function start(): Promise<void> {
  const win = createMainWindow();
  mark("window created");
  const dev = devUrl();
  if (dev) {
    // Desktop dev reuses Electron's default session, so stale HTTP cache can
    // keep old Vite-transformed modules alive across restarts and produce
    // 404s for deps that no longer exist. Clearing it also throws away the
    // cache that makes every *other* boot fast, so it is opt-in: set
    // ATELIER_DEV_CLEAR_CACHE=1 for the run after a dependency change.
    if (process.env.ATELIER_DEV_CLEAR_CACHE === "1") {
      await win.webContents.session.clearCache();
      mark("dev http cache cleared");
    }
    await win.loadURL(dev);
  }
  else await win.loadFile(packagedIndexHtml());
  mark("renderer loaded");
  flushAuthCallback(win);
  await maybeCapture(win);
}

function ensureAuthLoopback(): Promise<string> {
  if (oauthLoopbackPromise) return oauthLoopbackPromise;

  oauthLoopbackPromise = new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${OAUTH_LOOPBACK_HOST}:${OAUTH_LOOPBACK_PORT}`
      );

      if (request.method !== "GET" || requestUrl.pathname !== "/auth/callback") {
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end("Not found");
        return;
      }

      const callback = new URL("atelier://auth/callback");
      callback.search = requestUrl.search;

      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(OAUTH_CALLBACK_HTML);
      deliverAuthCallback(callback.toString());
    });

    const onStartupError = (error: Error) => {
      oauthLoopbackPromise = null;
      reject(error);
    };
    server.once("error", onStartupError);
    server.listen(OAUTH_LOOPBACK_PORT, OAUTH_LOOPBACK_HOST, () => {
      server.removeListener("error", onStartupError);
      server.on("error", (error) => {
        console.error("[auth] OAuth loopback server failed", error);
      });
      server.once("close", () => {
        if (oauthLoopbackServer !== server) return;
        oauthLoopbackServer = null;
        oauthLoopbackPromise = null;
      });
      oauthLoopbackServer = server;
      server.unref();
      resolve(
        `http://${OAUTH_LOOPBACK_HOST}:${OAUTH_LOOPBACK_PORT}/auth/callback`
      );
    });
  });

  return oauthLoopbackPromise;
}

function registerAuthProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
    return;
  }
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
}

function isAuthCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === `${AUTH_PROTOCOL}:` &&
      url.hostname === "auth" &&
      url.pathname === "/callback"
    );
  } catch {
    return false;
  }
}

function findAuthCallback(argv: string[]): string | null {
  return argv.find(isAuthCallback) ?? null;
}

function focusMainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function deliverAuthCallback(url: string): void {
  pendingAuthCallback = url;
  const win = focusMainWindow();
  if (!win) {
    if (app.isReady()) void start();
    return;
  }
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", () => flushAuthCallback(win));
    return;
  }
  flushAuthCallback(win);
}

function flushAuthCallback(win: BrowserWindow): void {
  if (!pendingAuthCallback || win.isDestroyed()) return;
  const callback = pendingAuthCallback;
  pendingAuthCallback = null;
  win.webContents.send(IPC_CHANNELS.oauthCallback, callback);
}

/**
 * Dev aid: ATELIER_DEV_CAPTURE=<file.png> writes a screenshot once the
 * renderer has settled. Verifying a UI change by looking at it beats
 * inferring it from logs.
 */
async function maybeCapture(win: BrowserWindow): Promise<void> {
  const target = process.env.ATELIER_DEV_CAPTURE;
  if (!target) return;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  if (win.isDestroyed()) return;
  const image = await win.webContents.capturePage();
  await writeFile(target, image.toPNG());
  console.log(`[desktop] captured window -> ${target}`);
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  oauthLoopbackServer?.close();
  projects.shutdown();
});
