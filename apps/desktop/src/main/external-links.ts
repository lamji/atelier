import { shell } from "electron";
import type { BrowserWindow } from "electron";
import { isSafeExternal } from "./ipc";

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * The renderer is a local app shell: only localhost may load in-window.
 * Everything else (existing target="_blank" links such as PR URLs and
 * provider dashboards) opens in the system browser.
 */
export function attachExternalLinkHandling(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url) && !isLocal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });
}
