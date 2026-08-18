import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { devUrl, packagedIndexHtml } from "./resolve-url";
import { registerIpcHandlers } from "./ipc";
import { registerAppIpc } from "./ipc-app";
import { installAppMenu } from "./menu";
import { mark } from "./boot-trace";
import { ProjectManager, resolveAgentEntry } from "./project-manager";

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

const projects = new ProjectManager(resolveAgentEntry());

app.whenReady().then(() => {
  mark("app ready");
  installAppMenu();
  registerIpcHandlers();
  registerAppIpc(projects);
  // The host fork can overlap renderer load. Opening a workspace is left to
  // the renderer so heavy db/watch/indexer work cannot run before first paint.
  projects.prewarmHost();
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
