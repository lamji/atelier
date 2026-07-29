import fs from "node:fs";
import path from "node:path";
import { toPosix } from "@atelier/shared";

export interface Mention {
  /** Workspace-relative posix path that exists on disk. */
  path: string;
  isDir: boolean;
}

/**
 * Matches an "@" token that looks like a path. The composer inserts these
 * literally into the prompt text, so the agent parses them back out rather
 * than depending on the UI to send a second, structured copy that a typed
 * mention (or a resumed conversation) would not have.
 */
const MENTION = /(^|\s)@([A-Za-z0-9._\-/\\]+)/g;

/** Trailing prose punctuation that is never part of a real path. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

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
    if (!raw || raw.includes("..")) continue;

    const rel = toPosix(raw).replace(/\/+$/, "");
    if (!rel) continue;

    const abs = path.resolve(root, rel);
    // Rejects both traversal and an absolute path pointing outside.
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!seen.has(rel)) {
      seen.set(rel, { path: rel, isDir: stat.isDirectory() });
    }
  }
  return [...seen.values()];
}
