import { writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { devUrl, packagedIndexHtml } from "./resolve-url";
import { registerIpcHandlers } from "./ipc";
import { registerAppIpc } from "./ipc-app";
import { installAppMenu } from "./menu";
import { handleDeepLink } from "./auth";
import {
  deepLinkInArgv,
  handleColdStartDeepLink,
  registerProtocol,
  wireOpenUrl,
} from "./protocol";
import { ProjectManager, resolveAgentEntry } from "./project-manager";

// Must run before whenReady so the OS knows who owns atelier:// links.
registerProtocol();

const projects = new ProjectManager(resolveAgentEntry());

// One instance: OAuth deep links arrive as a second-instance launch on
// Windows/Linux, so the running app must claim them and stay focused.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = deepLinkInArgv(argv);
    if (link) void handleDeepLink(link);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  wireOpenUrl();

  app.whenReady().then(() => {
    installAppMenu();
    registerIpcHandlers();
    registerAppIpc(projects);
    void start();
    handleColdStartDeepLink();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void start();
    });
  });
}

async function start(): Promise<void> {
  const win = createMainWindow();
  const dev = devUrl();
  if (dev) {
    // Desktop dev reuses Electron's default session, so stale HTTP cache can
    // keep old Vite-transformed modules alive across restarts and produce 404s
    // for deps that no longer exist.
    await win.webContents.session.clearCache();
    await win.loadURL(dev);
  }
  else await win.loadFile(packagedIndexHtml());
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
