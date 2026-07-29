import { BrowserWindow } from "electron";
import path from "node:path";
import { loadWindowState, trackWindowState } from "./window-state";
import { attachExternalLinkHandling } from "./external-links";
import { wireMaximizedEvents } from "./ipc";

const DARK_BACKGROUND = "#09090b";

export function createMainWindow(): BrowserWindow {
  const state = loadWindowState();

  const win = new BrowserWindow({
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

  win.once("ready-to-show", () => win.show());
  return win;
}
