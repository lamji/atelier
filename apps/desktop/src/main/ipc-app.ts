/**
 * App-level IPC: auth + projects. Window chrome and pick-folder stay in
 * ipc.ts. Everything here delegates to the auth module and ProjectManager.
 */
import crypto from "node:crypto";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS, type AuthState } from "../shared/ipc-contract";
import {
  authConfigured,
  getSession,
  loginTroubleshootHint,
  logout,
  onAuthChanged,
  startLogin,
} from "./auth";
import type { ProjectManager } from "./project-manager";

/**
 * Dev-only sign-in bypass for working on the UI before a Supabase project
 * is wired up. Requires an explicit env var AND an unpackaged build, so a
 * shipped app can never take this path — unlike an implicit
 * "not configured means no gate" rule, which is a hole.
 */
function devAuthBypass(): boolean {
  return !app.isPackaged && process.env.ATELIER_DEV_SKIP_AUTH === "1";
}

/** Bring Atelier forward — used when a browser round trip completes. */
function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

export function registerAppIpc(projects: ProjectManager): void {
  // ---- auth ----
  ipcMain.handle(IPC_CHANNELS.authSession, async (): Promise<AuthState> => {
    if (devAuthBypass()) {
      return {
        configured: true,
        user: { id: "dev", email: "dev@localhost", name: "Dev" },
      };
    }
    const configured = authConfigured();
    return { configured, user: configured ? await getSession() : null };
  });

  ipcMain.handle(IPC_CHANNELS.authLoginStart, async () => {
    const result = await startLogin();
    // Carried on every start, not just failures: the case it explains is a
    // sign-in that begins fine and then never comes back, which the renderer
    // only discovers later.
    return { ...result, hint: loginTroubleshootHint() };
  });

  ipcMain.handle(IPC_CHANNELS.authLogout, () => logout());

  onAuthChanged((payload) => {
    broadcast(IPC_CHANNELS.authChanged, payload);
    // Sign-in finishes in the browser, so the user is looking at Chrome when
    // it lands. Without this they have to find Atelier themselves, and the
    // app looks like it did nothing.
    if (payload.user) focusMainWindow();
  });

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
