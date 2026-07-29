import { app, BrowserWindow, dialog } from "electron";
import { createMainWindow } from "./window";
import { devUrl, hubUrl, workspaceFromArgv } from "./resolve-url";
import { registerIpcHandlers } from "./ipc";
import { installAppMenu } from "./menu";
import { ensureBackend, hasPackagedBackend, stopBackend } from "./backend";

const MISSING_URL_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="background:#09090b;color:#a1a1aa;font-family:system-ui;
        display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center">
        <h2 style="color:#e4e4e7">Atelier backend not found</h2>
        <p>Start the dev stack with <code>pnpm dev:desktop</code>,
        or set <code>ATELIER_DEV_URL</code>.</p>
      </div>
    </body>`,
  );

// Second instances focus the existing window instead of spawning a
// competing backend connection.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    installAppMenu();
    registerIpcHandlers();
    void start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void start();
    });
  });
}

async function resolveStartUrl(): Promise<string | null> {
  const dev = devUrl();
  if (dev) return dev;
  if (!hasPackagedBackend()) return null;
  const workspace = workspaceFromArgv(process.argv);
  const backend = await ensureBackend(workspace);
  return hubUrl(backend.hubPort, workspace);
}

async function start(): Promise<void> {
  const win = createMainWindow();
  try {
    const url = await resolveStartUrl();
    await win.loadURL(url ?? MISSING_URL_PAGE);
  } catch (error) {
    dialog.showErrorBox(
      "Atelier failed to start",
      error instanceof Error ? error.message : String(error),
    );
    await win.loadURL(MISSING_URL_PAGE);
  }
}

app.on("window-all-closed", () => {
  app.quit();
});

// Only stops a supervisor this process spawned; a CLI-owned one is left
// running, matching `atelier run` semantics.
app.on("will-quit", () => {
  stopBackend();
});
