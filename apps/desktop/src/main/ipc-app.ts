/**
 * App-level IPC: auth + projects. Window chrome and pick-folder stay in
 * ipc.ts. Everything here delegates to the auth module and ProjectManager.
 */
import crypto from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-contract";
import type { ProjectManager } from "./project-manager";

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

export function registerAppIpc(projects: ProjectManager): void {
  // ---- projects ----
  ipcMain.handle(IPC_CHANNELS.projectsList, () => projects.list());

  ipcMain.handle(IPC_CHANNELS.projectsAdd, (_e, path: unknown) => {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("projects.add: path required");
    }
    return projects.add(path);
  });

  ipcMain.handle(IPC_CHANNELS.projectsStart, (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("projects.start: id required");
    return projects.start(id);
  });

  ipcMain.handle(IPC_CHANNELS.projectsStop, (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("projects.stop: id required");
    projects.stop(id);
  });

  ipcMain.handle(IPC_CHANNELS.projectsRemove, (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("projects.remove: id required");
    projects.remove(id);
  });

  /**
   * attach: the MessagePort cannot ride an invoke() return value, so the
   * handler resolves with an attachId and posts the port separately on the
   * workspace-port channel; preload forwards it into the page, where the
   * renderer pairs the two by attachId.
   */
  ipcMain.handle(IPC_CHANNELS.projectsAttach, async (event, id: unknown) => {
    if (typeof id !== "string") throw new Error("projects.attach: id required");
    const port = await projects.attach(id);
    const attachId = crypto.randomBytes(8).toString("hex");
    event.sender.postMessage(IPC_CHANNELS.workspacePort, attachId, [port]);
    return { attachId };
  });

  projects.onChanged((list) =>
    broadcast(IPC_CHANNELS.projectsChanged, list)
  );
}
