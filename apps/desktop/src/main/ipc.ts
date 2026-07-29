import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-contract";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isSafeExternal(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.pickFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Open Folder",
    });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: unknown) => {
    if (typeof url !== "string" || !isSafeExternal(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.on(IPC_CHANNELS.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on(IPC_CHANNELS.windowMaximizeToggle, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on(IPC_CHANNELS.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, (event) => {
    return (
      BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
    );
  });
}

/** Forward maximize/unmaximize to the renderer for the titlebar icon. */
export function wireMaximizedEvents(win: BrowserWindow): void {
  const send = (maximized: boolean): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.windowMaximizedChanged, maximized);
    }
  };
  win.on("maximize", () => send(true));
  win.on("unmaximize", () => send(false));
}

export { isSafeExternal };
