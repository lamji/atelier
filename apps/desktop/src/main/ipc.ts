import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { writeFile } from "node:fs/promises";
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

  ipcMain.handle(
    IPC_CHANNELS.exportPdf,
    async (event, html: unknown, suggestedName: unknown) => {
      if (typeof html !== "string") return null;
      const parent = BrowserWindow.fromWebContents(event.sender);
      const name =
        typeof suggestedName === "string" && suggestedName ? suggestedName : "export";
      const options = {
        title: "Export PDF",
        defaultPath: `${name}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      };
      const target = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (target.canceled || !target.filePath) return null;
      await writePdf(html, target.filePath);
      return target.filePath;
    }
  );

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

/**
 * Prints an HTML document to a PDF file through an offscreen window.
 *
 * The window is hidden, sandboxed, and loaded from a data: URL with no
 * node integration: the HTML is rendered markdown, and rendering it in
 * the app's own window would give document content a foothold there.
 */
async function writePdf(html: string, filePath: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: false,
    },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    await writeFile(filePath, pdf);
  } finally {
    win.destroy();
  }
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
