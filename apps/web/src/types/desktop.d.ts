// Mirrors AtelierDesktopApi in apps/desktop/src/shared/ipc-contract.ts.
// Kept as a local declaration so @atelier/web has no dependency on the
// desktop package; the preload bridge is the runtime source of truth.
export {};

declare global {
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
    kioskToggle(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    isKiosk(): Promise<boolean>;
    onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
    onKioskChanged(cb: (kiosk: boolean) => void): () => void;
  }

  interface AtelierDesktopCaptureRect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface AtelierDesktopCaptureRequest extends AtelierDesktopCaptureRect {
    previewUrl?: string;
  }

  interface AtelierDesktopCaptureResult {
    dataUrl: string;
    frameUrl: string | null;
  }

  interface AtelierDesktopApi {
    platform: "win32" | "darwin" | "linux";
    version: string;
    projects: AtelierDesktopProjectsApi;
    pickFolder(): Promise<string | null>;
    /** Captures a renderer-relative rectangle and its live preview route. */
    captureRegion(
      request: AtelierDesktopCaptureRequest
    ): Promise<AtelierDesktopCaptureResult | null>;
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
