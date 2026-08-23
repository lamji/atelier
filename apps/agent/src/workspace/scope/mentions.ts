import fs from "node:fs";
import path from "node:path";
import { toPosix } from "@atelier/shared";

export interface Mention {
  /**
   * Posix path that exists on disk: workspace-relative normally, absolute
   * when the user pointed at something outside the workspace.
   */
  path: string;
  isDir: boolean;
  /** Outside the workspace — readable as a reference, never writable. */
  outside: boolean;
}

/**
 * Matches an "@" token that looks like a path. The composer inserts these
 * literally into the prompt text, so the agent parses them back out rather
 * than depending on the UI to send a second, structured copy that a typed
 * mention (or a resumed conversation) would not have.
 */
const MENTION = /(^|\s)@([A-Za-z0-9._\-/\\]+(?::[\\/][A-Za-z0-9._\-/\\]*)?)/g;

/** Trailing prose punctuation that is never part of a real path. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * A path typed WITHOUT the "@" — `.atelier/notes.md`, `src/app/page.tsx`.
 * Requires a separator, so ordinary prose and bare filenames never match;
 * every candidate still has to exist on disk before it counts.
 */
const BARE_PATH = /(?:^|[\s"'`(\[])([A-Za-z0-9._-]+(?:[/\\][A-Za-z0-9._-]+)+)/g;

/**
 * Absolute paths explicitly typed by the user, quoted or unquoted. These
 * are references, not workspace scope: resolving them here lets the runtime
 * grant the exact path without opening its parent directory.
 */
const ABSOLUTE_PATH =
  /(?:^|[\s(\[])(?:"([A-Za-z]:[\\/][^"]+|\/[^"]+)"|'([A-Za-z]:[\\/][^']+|\/[^']+)'|`([A-Za-z]:[\\/][^`]+|\/[^`]+)`|([A-Za-z]:[\\/][^\s"'`,;!?)}\]]+|\/[^\s"'`,;!?)}\]]+))/g;

/**
 * Paths the user typed literally, without an "@".
 *
 * Naming a file IS pointing at it. Only "@" mentions used to register, so a
 * prompt like "update .atelier/foo.md" left the session's lock untouched and
 * the guard then refused to read the very file the request named. Workspace
 * paths become per-turn grants; absolute external paths become exact read-only
 * references. Neither form re-locks the session or opens a parent directory.
 */
export function parseTypedPaths(
  prompt: string,
  workspaceRoot: string
): string[] {
  const root = path.resolve(workspaceRoot);
  const found = new Set<string>();

  for (const pattern of [BARE_PATH, ABSOLUTE_PATH]) {
    for (const match of prompt.matchAll(pattern)) {
      const raw = (
        match[1] ??
        match[2] ??
        match[3] ??
        match[4] ??
        ""
      ).replace(TRAILING, "");
      if (!raw || raw.includes("..")) continue;
      const cleaned = toPosix(raw).replace(/\/+$/, "");
      if (!cleaned) continue;

      const abs = path.isAbsolute(cleaned)
        ? path.resolve(cleaned)
        : path.resolve(root, cleaned);
      const outside = abs !== root && !abs.startsWith(root + path.sep);
      try {
        fs.statSync(abs);
      } catch {
        continue; // a path-shaped string that names nothing real
      }
      found.add(outside ? toPosix(abs) : cleaned);
    }
  }
  return [...found];
}

/**
 * Pulls the "@path" mentions out of a prompt, keeping only the ones that
 * resolve to something real inside the workspace. An "@" that turns out to
 * be an email, a decorator, or a typo simply drops out — a mention only
 * ever narrows the agent's world, so a wrong guess must never be able to
 * lock the session onto a path that does not exist.
 */
export function parseMentions(
  prompt: string,
  workspaceRoot: string
): Mention[] {
  const root = path.resolve(workspaceRoot);
  const seen = new Map<string, Mention>();

  for (const match of prompt.matchAll(MENTION)) {
    const raw = (match[2] ?? "").replace(TRAILING, "");
    // ".." stays banned: an escape spelled as traversal is never a
    // deliberate reference, it is a path guard being probed.
    if (!raw || raw.includes("..")) continue;

    const cleaned = toPosix(raw).replace(/\/+$/, "");
    if (!cleaned) continue;

    const abs = path.resolve(root, cleaned);
    // A path that lands outside the workspace is kept as a reference
    // rather than dropped: the user named it on purpose, and refusing to
    // read what you were just pointed at is the worse failure. It travels
    // as an absolute path, and the guard only ever grants it reads.
    const outside = abs !== root && !abs.startsWith(root + path.sep);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    const wire = outside ? toPosix(abs) : cleaned;
    if (!seen.has(wire)) {
      seen.set(wire, { path: wire, isDir: stat.isDirectory(), outside });
    }
  }
  return [...seen.values()];
}
