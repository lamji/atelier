/**
 * Single source of truth for the renderer <-> main IPC surface.
 *
 * Deliberately tiny: all business logic (projects, sessions, files, git,
 * terminals) stays in the existing agent backend behind the WS bridge.
 * This contract only exposes desktop capabilities a web page cannot have.
 */

export const IPC_CHANNELS = {
  pickFolder: "atelier:pick-folder",
  openExternal: "atelier:open-external",
  windowMinimize: "atelier:window:minimize",
  windowMaximizeToggle: "atelier:window:maximize-toggle",
  windowClose: "atelier:window:close",
  windowIsMaximized: "atelier:window:is-maximized",
  windowMaximizedChanged: "atelier:window:maximized-changed",
} as const;

export interface DesktopWindowApi {
  minimize(): void;
  maximizeToggle(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  /** Subscribe to maximize state changes; returns an unsubscribe fn. */
  onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
}

export interface AtelierDesktopApi {
  platform: "win32" | "darwin" | "linux";
  version: string;
  /** Native directory picker; resolves null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Opens http/https/mailto URLs in the system browser/mail client. */
  openExternal(url: string): Promise<void>;
  window: DesktopWindowApi;
}
