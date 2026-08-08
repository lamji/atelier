// Mirrors AtelierDesktopApi in apps/desktop/src/shared/ipc-contract.ts.
// Kept as a local declaration so @atelier/web has no dependency on the
// desktop package; the preload bridge is the runtime source of truth.
export {};

declare global {
  interface AtelierAuthUser {
    id: string;
    email: string;
    name?: string;
    avatar?: string;
  }

  interface AtelierAuthState {
    /** False when Supabase isn't configured — the login gate is disabled. */
    configured: boolean;
    user: AtelierAuthUser | null;
  }

  type AtelierProjectRunState = "stopped" | "starting" | "running" | "error";

  interface AtelierProjectInfo {
    id: string;
    name: string;
    path: string;
    status: AtelierProjectRunState;
    working: boolean;
    lastOpenedAt?: number;
    error?: string;
  }

  interface AtelierDesktopAuthApi {
    getSession(): Promise<AtelierAuthState>;
    startLogin(): Promise<{ ok: boolean; error?: string; hint?: string }>;
    logout(): Promise<void>;
    onChanged(
      cb: (user: AtelierAuthUser | null, error?: string) => void
    ): () => void;
  }

  interface AtelierDesktopProjectsApi {
    list(): Promise<AtelierProjectInfo[]>;
    add(path: string): Promise<AtelierProjectInfo>;
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    onChanged(cb: (projects: AtelierProjectInfo[]) => void): () => void;
    attach(id: string): Promise<{ attachId: string }>;
  }

  interface AtelierDesktopWindowApi {
    minimize(): void;
    maximizeToggle(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
  }

  interface AtelierDesktopApi {
    platform: "win32" | "darwin" | "linux";
    version: string;
    auth: AtelierDesktopAuthApi;
    projects: AtelierDesktopProjectsApi;
    pickFolder(): Promise<string | null>;
    /** Filesystem path of a dropped File (null if unavailable). */
    pathForFile(file: File): string | null;
    openExternal(url: string): Promise<void>;
    /** Renders HTML to PDF and prompts for a save location. */
    exportPdf(html: string, suggestedName: string): Promise<string | null>;
    window: AtelierDesktopWindowApi;
  }

  interface Window {
    atelierDesktop?: AtelierDesktopApi;
  }
}
