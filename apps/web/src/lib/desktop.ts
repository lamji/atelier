/**
 * Thin guards around the Electron preload bridge. Every helper degrades
 * to the browser behavior so the web build keeps working unchanged.
 */

export function isDesktop(): boolean {
  return typeof window !== "undefined" && window.atelierDesktop !== undefined;
}

export function desktopPlatform(): AtelierDesktopApi["platform"] | null {
  return window.atelierDesktop?.platform ?? null;
}

/** Native folder picker; null in the browser or when cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!window.atelierDesktop) return null;
  return window.atelierDesktop.pickFolder();
}

/** Opens a link in the system browser (desktop) or a new tab (web). */
export function openExternal(url: string): void {
  if (window.atelierDesktop) {
    void window.atelierDesktop.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
