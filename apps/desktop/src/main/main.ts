import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { resolveStartUrl } from "./resolve-url";

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

async function start(): Promise<void> {
  const win = createMainWindow();
  const url = resolveStartUrl();
  await win.loadURL(url ?? MISSING_URL_PAGE);
}

app.whenReady().then(() => {
  void start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void start();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
