import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS, PORT_MESSAGE_TYPE } from "../shared/ipc-contract";
import type {
  AtelierDesktopApi,
  DesktopCaptureRequest,
  DesktopProjectInfo,
  DesktopUpdateProgress,
} from "../shared/ipc-contract";

/**
 * MessagePorts cannot cross contextBridge, so workspace ports arrive here
 * on `atelier:workspace-port` and are re-posted into the main world with
 * window.postMessage — which DOES transfer ports. The renderer pairs each
 * port with its attach() call via attachId (services/desktop-port.ts).
 */
ipcRenderer.on(IPC_CHANNELS.workspacePort, (event, attachId: string) => {
  window.postMessage({ type: PORT_MESSAGE_TYPE, attachId }, "*", event.ports);
});

const oauthListeners = new Set<(url: string) => void>();
const pendingOAuthCallbacks: string[] = [];
ipcRenderer.on(IPC_CHANNELS.oauthCallback, (_event, url: string) => {
  if (oauthListeners.size === 0) {
    pendingOAuthCallbacks.push(url);
    return;
  }
  for (const listener of oauthListeners) listener(url);
});

const api: AtelierDesktopApi = {
  platform: process.platform as AtelierDesktopApi["platform"],
  version: process.env.ATELIER_APP_VERSION ?? "dev",

  auth: {
    callbackUrl: () => ipcRenderer.invoke(IPC_CHANNELS.oauthCallbackUrl),
    onCallback: (cb: (url: string) => void) => {
      oauthListeners.add(cb);
      for (const url of pendingOAuthCallbacks.splice(0)) cb(url);
      return () => oauthListeners.delete(cb);
    },
  },

  projects: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.projectsList),
    add: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.projectsAdd, path),
    start: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.projectsStart, id),
    stop: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.projectsStop, id),
    remove: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.projectsRemove, id),
    onChanged: (cb: (projects: DesktopProjectInfo[]) => void) => {
      const listener = (_e: unknown, projects: DesktopProjectInfo[]): void =>
        cb(projects);
      ipcRenderer.on(IPC_CHANNELS.projectsChanged, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.projectsChanged, listener);
      };
    },
    attach: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.projectsAttach, id),
  },

  updates: {
    check: (force?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.updatesCheck, force ?? false),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updatesDownload),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall),
    onProgress: (cb: (progress: DesktopUpdateProgress) => void) => {
      const listener = (_e: unknown, progress: DesktopUpdateProgress): void =>
        cb(progress);
      ipcRenderer.on(IPC_CHANNELS.updatesProgress, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.updatesProgress, listener);
      };
    },
    changelog: () => ipcRenderer.invoke(IPC_CHANNELS.updatesChangelog),
    acknowledge: (version: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.updatesAcknowledge, version),
  },

  pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.pickFolder),

  captureRegion: (request: DesktopCaptureRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.captureRegion, request),

  getPreviewContext: (previewUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewContext, previewUrl),

  // File.path was removed in Electron 32; webUtils is the only way to turn
  // a dropped File back into a filesystem path.
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),

  exportPdf: (html: string, suggestedName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportPdf, html, suggestedName),

  window: {
    minimize: () => ipcRenderer.send(IPC_CHANNELS.windowMinimize),
    maximizeToggle: () => ipcRenderer.send(IPC_CHANNELS.windowMaximizeToggle),
    kioskToggle: () => ipcRenderer.send(IPC_CHANNELS.windowKioskToggle),
    close: () => ipcRenderer.send(IPC_CHANNELS.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized),
    isKiosk: () => ipcRenderer.invoke(IPC_CHANNELS.windowIsKiosk),
    onMaximizedChanged: (cb: (maximized: boolean) => void) => {
      const listener = (_e: unknown, maximized: boolean): void =>
        cb(maximized);
      ipcRenderer.on(IPC_CHANNELS.windowMaximizedChanged, listener);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.windowMaximizedChanged,
          listener,
        );
      };
    },
    onKioskChanged: (cb: (kiosk: boolean) => void) => {
      const listener = (_e: unknown, kiosk: boolean): void => cb(kiosk);
      ipcRenderer.on(IPC_CHANNELS.windowKioskChanged, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.windowKioskChanged, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld("atelierDesktop", api);
