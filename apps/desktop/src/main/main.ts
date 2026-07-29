import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { resolveStartUrl } from "./resolve-url";
import { registerIpcHandlers } from "./ipc";
import { installAppMenu } from "./menu";

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

async function start(): Promise<void> {
  const win = createMainWindow();
  const url = resolveStartUrl();
  await win.loadURL(url ?? MISSING_URL_PAGE);
}

app.on("window-all-closed", () => {
  app.quit();
});
