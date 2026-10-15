import fs from "node:fs";
import path from "node:path";

/**
 * Watches the folder the CLIs' turn-end hook writes into (see
 * cli-hooks/turn-end.mjs) and reports each terminal whose turn ended.
 *
 * One marker per terminal, named by its ATELIER_TERM_ID and rewritten at
 * every turn end with the time it was written. fs.watch reports one write
 * as several events, so a marker counts only when its time is new.
 */
export function watchTurnMarkers(
  dir: string,
  onTurnEnd: (termId: string) => void
): () => void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return () => {};
  }
  const seen = new Map<string, number>();
  const check = (name: string) => {
    const at = markerTime(path.join(dir, name));
    if (at === null || seen.get(name) === at) return;
    seen.set(name, at);
    onTurnEnd(name);
  };
  // Markers from turns that ended before this agent started are old news.
  for (const name of safeList(dir)) {
    const at = markerTime(path.join(dir, name));
    if (at !== null) seen.set(name, at);
  }
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, (_type, name) => {
      if (name) check(String(name));
    });
  } catch {
    return () => {};
  }
  watcher.on("error", () => watcher.close());
  return () => watcher.close();
}

/** The marker's write time, or null while it is missing or half-written. */
function markerTime(file: string): number | null {
  try {
    const marker = JSON.parse(fs.readFileSync(file, "utf8")) as { at?: unknown };
    return typeof marker.at === "number" ? marker.at : null;
  } catch {
    return null;
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
