// Mirrors AtelierDesktopApi in apps/desktop/src/shared/ipc-contract.ts.
// Kept as a local declaration so @atelier/web has no dependency on the
// desktop package; the preload bridge is the runtime source of truth.
export {};

declare global {
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
    pickFolder(): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    window: AtelierDesktopWindowApi;
  }

  interface Window {
    atelierDesktop?: AtelierDesktopApi;
  }
}
