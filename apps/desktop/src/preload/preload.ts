import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-contract";
import type { AtelierDesktopApi } from "../shared/ipc-contract";

const api: AtelierDesktopApi = {
  platform: process.platform as AtelierDesktopApi["platform"],
  version: process.env.ATELIER_APP_VERSION ?? "dev",

  pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.pickFolder),

  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),

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
