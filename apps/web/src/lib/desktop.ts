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

/**
 * The filesystem paths behind a drop, in the order they were dropped.
 *
 * Electron 32 removed `File.path`, and the browser File API never had it, so
 * the preload's `webUtils` bridge is the only way back to a real path —
 * reading `.path` off the File silently yields undefined for every drop. A
 * web build has nothing to return and gets an empty list.
 */
export function droppedFilePaths(transfer: DataTransfer): string[] {
  const desktop = window.atelierDesktop;
  if (!desktop) return [];

  // Windows Explorer can advertise a native "Files" drag while Chromium's
  // FileList is empty by the time React handles the drop. The corresponding
  // DataTransferItems still retain their disk-backed File objects, so inspect
  // both collections instead of treating FileList as the only source.
  const files = Array.from(transfer.files);
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }

  // The same file is normally present in both collections. Resolve every
  // candidate because the item-backed object can retain its native path when
  // the FileList wrapper does not, then deduplicate the successful paths.
  return [
    ...new Set(
      files
        .map((file) => desktop.pathForFile(file))
        .filter((path): path is string => !!path),
    ),
  ];
}

/** Opens a link in the system browser (desktop) or a new tab (web). */
export function openExternal(url: string): void {
  if (window.atelierDesktop) {
    void window.atelierDesktop.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
