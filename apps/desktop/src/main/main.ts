import { writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { devUrl, packagedIndexHtml } from "./resolve-url";
import { registerIpcHandlers } from "./ipc";
import { registerAppIpc } from "./ipc-app";
import { installAppMenu } from "./menu";
import { mark } from "./boot-trace";
import { ProjectManager, resolveAgentEntry } from "./project-manager";

const projects = new ProjectManager(resolveAgentEntry());

app.whenReady().then(() => {
  mark("app ready");
  installAppMenu();
  registerIpcHandlers();
  registerAppIpc(projects);
  // The agent fork and workspace prewarm are both on the critical path to a
  // usable window and neither one needs the renderer.
  projects.prewarmHost();
  projects.prewarmWorkspace();
  void start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void start();
  });
});

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
  await maybeCapture(win);
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
  projects.shutdown();
});
