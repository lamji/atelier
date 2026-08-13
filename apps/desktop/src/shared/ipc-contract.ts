/**
 * Single source of truth for the renderer <-> main IPC surface.
 *
 * The app is fully native now: auth, the project registry and agent
 * lifecycle live in the main process; per-project RPC rides a transferred
 * MessagePort (see `workspacePort` below), not a socket.
 */

export const IPC_CHANNELS = {
  // projects
  projectsList: "atelier:projects:list",
  projectsAdd: "atelier:projects:add",
  projectsStart: "atelier:projects:start",
  projectsStop: "atelier:projects:stop",
  projectsRemove: "atelier:projects:remove",
  projectsChanged: "atelier:projects:changed",
  projectsAttach: "atelier:projects:attach",
  /** main -> preload; carries the MessagePort for an attach() call. */
  workspacePort: "atelier:workspace-port",
  // desktop chrome
  pickFolder: "atelier:pick-folder",
  openExternal: "atelier:open-external",
  exportPdf: "atelier:export-pdf",
  windowMinimize: "atelier:window:minimize",
  windowMaximizeToggle: "atelier:window:maximize-toggle",
  windowClose: "atelier:window:close",
  windowIsMaximized: "atelier:window:is-maximized",
  windowMaximizedChanged: "atelier:window:maximized-changed",
} as const;

/** window.postMessage type used by preload to hand a MessagePort to the
 *  main world (ports cannot cross contextBridge). */
export const PORT_MESSAGE_TYPE = "atelier-workspace-port";

export type ProjectRunState = "stopped" | "starting" | "running" | "error";

export interface DesktopProjectInfo {
  id: string;
  name: string;
  path: string;
  status: ProjectRunState;
  working: boolean;
  lastOpenedAt?: number;
  error?: string;
}

export interface DesktopProjectsApi {
  list(): Promise<DesktopProjectInfo[]>;
  add(path: string): Promise<DesktopProjectInfo>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  onChanged(cb: (projects: DesktopProjectInfo[]) => void): () => void;
  /**
   * Ask main for an RPC port to a project's agent (starting it if needed).
   * Resolves when the port has been posted to the main world via a
   * `window.postMessage({type: PORT_MESSAGE_TYPE, attachId}, ports)` — the
   * renderer pairs it up by attachId (see services/desktop-port.ts).
   */
  attach(id: string): Promise<{ attachId: string }>;
}

export interface DesktopWindowApi {
  minimize(): void;
  maximizeToggle(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
}

export interface AtelierDesktopApi {
  platform: "win32" | "darwin" | "linux";
  version: string;
  projects: DesktopProjectsApi;
  /** Native directory picker; resolves null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Filesystem path of a dropped File (null if unavailable). */
  pathForFile(file: File): string | null;
  openExternal(url: string): Promise<void>;
  /**
   * Renders a self-contained HTML document to PDF and asks where to save
   * it. Resolves the saved path, or null when the user cancels.
   */
  exportPdf(html: string, suggestedName: string): Promise<string | null>;
  window: DesktopWindowApi;
}
