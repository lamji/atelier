import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
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

function isCaptureRect(value: unknown): value is {
  x: number;
  y: number;
  width: number;
  height: number;
  previewUrl?: string;
} {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return (
    typeof rect.x === "number" &&
    Number.isFinite(rect.x) &&
    typeof rect.y === "number" &&
    Number.isFinite(rect.y) &&
    typeof rect.width === "number" &&
    Number.isFinite(rect.width) &&
    rect.width > 0 &&
    typeof rect.height === "number" &&
    Number.isFinite(rect.height) &&
    rect.height > 0
  );
}

function localPreviewOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    return local && (url.protocol === "http:" || url.protocol === "https:")
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Resolve the iframe's live URL so SPA navigation becomes screenshot context. */
function previewFrameUrl(webContents: WebContents, requestedUrl: unknown): string | null {
  const origin = localPreviewOrigin(requestedUrl);
  if (!origin) return null;
  for (const frame of webContents.mainFrame.framesInSubtree) {
    try {
      const url = new URL(frame.url);
      if (url.origin === origin) return url.href;
    } catch {
      // Ignore transient or non-URL child frames.
    }
  }
  return null;
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

  ipcMain.handle(
    IPC_CHANNELS.captureRegion,
    async (event, rect: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !isCaptureRect(rect)) return null;
      const contentSize = win.getContentSize();
      const contentWidth = contentSize[0] ?? 0;
      const contentHeight = contentSize[1] ?? 0;
      if (contentWidth < 1 || contentHeight < 1) return null;
      const x = Math.max(0, Math.min(Math.floor(rect.x), contentWidth - 1));
      const y = Math.max(0, Math.min(Math.floor(rect.y), contentHeight - 1));
      const width = Math.min(Math.ceil(rect.width), contentWidth - x);
      const height = Math.min(Math.ceil(rect.height), contentHeight - y);
      if (width < 1 || height < 1) return null;
      const image = await win.webContents.capturePage({ x, y, width, height });
      return {
        dataUrl: image.toDataURL(),
        frameUrl: previewFrameUrl(event.sender, rect.previewUrl),
      };
    }
  );

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
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isKiosk()) return;
    win.minimize();
  });

  ipcMain.on(IPC_CHANNELS.windowMaximizeToggle, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isKiosk()) {
      win.setKiosk(false);
      sendKioskState(win);
      return;
    }
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on(IPC_CHANNELS.windowKioskToggle, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.setKiosk(!win.isKiosk());
    sendKioskState(win);
  });

  ipcMain.on(IPC_CHANNELS.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, (event) => {
    return (
      BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
    );
  });

  ipcMain.handle(IPC_CHANNELS.windowIsKiosk, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isKiosk() ?? false;
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

/** Forward maximize/kiosk changes to the renderer for the titlebar icons. */
export function wireMaximizedEvents(win: BrowserWindow): void {
  const send = (maximized: boolean): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.windowMaximizedChanged, maximized);
    }
  };
  win.on("maximize", () => send(true));
  win.on("unmaximize", () => send(false));
  win.on("enter-full-screen", () => sendKioskState(win));
  win.on("leave-full-screen", () => sendKioskState(win));
}

function sendKioskState(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.windowKioskChanged, win.isKiosk());
  }
}

export { isSafeExternal };
