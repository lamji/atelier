import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS, PORT_MESSAGE_TYPE } from "../shared/ipc-contract";
import type {
  AtelierDesktopApi,
  DesktopProjectInfo,
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

const api: AtelierDesktopApi = {
  platform: process.platform as AtelierDesktopApi["platform"],
  version: process.env.ATELIER_APP_VERSION ?? "dev",

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

  pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.pickFolder),

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
    close: () => ipcRenderer.send(IPC_CHANNELS.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized),
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
  },
};

contextBridge.exposeInMainWorld("atelierDesktop", api);
