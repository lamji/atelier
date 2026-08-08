import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadWindowState, trackWindowState } from "./window-state";
import { attachExternalLinkHandling } from "./external-links";
import { wireMaximizedEvents } from "./ipc";

const DARK_BACKGROUND = "#09090b";

// Frameless with a renderer-drawn title bar on Windows/Linux; macOS keeps
// native traffic lights over the drag region.
const frameOptions: Electron.BrowserWindowConstructorOptions =
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" }
    : { frame: false };

/**
 * Taskbar icon for the dev window. A packaged build gets its icon from the
 * exe's own resources, but `electron dist/main.cjs` would otherwise show the
 * stock Electron atom — which is how you end up debugging the wrong window.
 * Silently skipped if the PNG has not been generated yet (pnpm build:icon).
 */
function devIcon(): { icon?: string } {
  const file = path.join(__dirname, "..", "build", "icon.png");
  return fs.existsSync(file) ? { icon: file } : {};
}

export function createMainWindow(): BrowserWindow {
  const state = loadWindowState();

  const win = new BrowserWindow({
    ...frameOptions,
    ...devIcon(),
    width: state.bounds?.width ?? 1440,
    height: state.bounds?.height ?? 900,
    x: state.bounds?.x,
    y: state.bounds?.y,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: DARK_BACKGROUND,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (state.maximized) win.maximize();
  trackWindowState(win);
  attachExternalLinkHandling(win);
  wireMaximizedEvents(win);
  wireRendererDiagnostics(win);

  win.once("ready-to-show", () => win.show());
  // ready-to-show depends on the renderer painting. If the bundle throws
  // before first paint the event never fires and the app would be an
  // invisible process, so show the window regardless.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 4000);
  return win;
}

/**
 * Surface renderer failures in the terminal that launched the app. Without
 * this a crashing bundle just shows an empty window and the only clue is
 * inside DevTools, which nobody has open on the run that broke.
 */
function wireRendererDiagnostics(win: BrowserWindow): void {
  const levels = ["debug", "info", "warning", "error"] as const;
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level < 2) return; // warnings and errors only
    const file = source ? `${source}:${line}` : "renderer";
    console.error(`[renderer:${levels[level] ?? level}] ${message}  (${file})`);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, code, description, url) => {
      console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
    },
  );
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason}`);
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[renderer] preload failed (${preloadPath}): ${error.message}`);
  });
}
