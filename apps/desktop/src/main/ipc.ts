import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { writeFile } from "node:fs/promises";
import {
  IPC_CHANNELS,
  type DesktopPreviewConsoleEntry,
  type DesktopPreviewContextResult,
} from "../shared/ipc-contract";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MAX_PREVIEW_CONSOLE_ENTRIES = 200;
const previewConsoleByContents = new WeakMap<
  WebContents,
  DesktopPreviewConsoleEntry[]
>();

const PREVIEW_CONTEXT_SCRIPT = `(() => {
  const selectorFor = (element) => {
    if (element.id) {
      return element.tagName.toLowerCase() + '#' + CSS.escape(element.id);
    }
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current.tagName
        );
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return ['html', ...parts].join(' > ');
  };
  const stylesheets = Array.from(document.styleSheets).map((sheet, index) => {
    const source = sheet.href || 'inline stylesheet ' + (index + 1);
    try {
      return '/* ' + source + ' */\\n' +
        Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\\n');
    } catch {
      return '/* ' + source + ' — rules unavailable to CSSOM */';
    }
  });
  const interactive = Array.from(document.querySelectorAll(
    'button, a[href], input, select, textarea, [role="button"], [tabindex]'
  )).map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim(),
      ariaLabel: element.getAttribute('aria-label'),
      role: element.getAttribute('role'),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      style: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        font: style.font,
        display: style.display,
        visibility: style.visibility,
      },
    };
  });
  return {
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
    css: stylesheets.join('\\n\\n'),
    interactive,
  };
})()`;

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

/** Resolve the exact live iframe so SPA navigation and runtime state are preserved. */
function previewFrame(
  webContents: WebContents,
  requestedUrl: unknown
): WebFrameMain | null {
  const origin = localPreviewOrigin(requestedUrl);
  if (!origin) return null;
  for (const frame of webContents.mainFrame.framesInSubtree) {
    try {
      if (new URL(frame.url).origin === origin) return frame;
    } catch {
      // Ignore transient or non-URL child frames.
    }
  }
  return null;
}

function previewFrameUrl(webContents: WebContents, requestedUrl: unknown): string | null {
  return previewFrame(webContents, requestedUrl)?.url ?? null;
}

/** Keep a bounded DevTools-style buffer for local preview frames. */
export function wirePreviewContextEvents(win: BrowserWindow): void {
  const entries: DesktopPreviewConsoleEntry[] = [];
  previewConsoleByContents.set(win.webContents, entries);
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level < 2 || !localPreviewOrigin(source)) return;
    entries.push({
      level: level >= 3 ? "error" : "warning",
      message: message.slice(0, 2_000),
      source: source || null,
      line: Number.isFinite(line) ? line : null,
      timestamp: Date.now(),
    });
    if (entries.length > MAX_PREVIEW_CONSOLE_ENTRIES) {
      entries.splice(0, entries.length - MAX_PREVIEW_CONSOLE_ENTRIES);
    }
  });
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

  ipcMain.handle(
    IPC_CHANNELS.previewContext,
    async (event, requestedUrl: unknown): Promise<DesktopPreviewContextResult | null> => {
      const frame = previewFrame(event.sender, requestedUrl);
      const origin = localPreviewOrigin(requestedUrl);
      if (!frame || !origin) return null;
      const snapshot = (await frame.executeJavaScript(PREVIEW_CONTEXT_SCRIPT)) as
        | Omit<DesktopPreviewContextResult, "console" | "capturedAt">
        | null;
      if (!snapshot || typeof snapshot.html !== "string") return null;
      const consoleEntries = previewConsoleByContents.get(event.sender) ?? [];
      return {
        ...snapshot,
        console: consoleEntries.filter(
          (entry) => localPreviewOrigin(entry.source) === origin
        ),
        capturedAt: Date.now(),
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
