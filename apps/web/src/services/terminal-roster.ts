/**
 * Which terminals a workspace has, by name and in order, across restarts.
 *
 * What can and cannot survive: a terminal is a real PTY owned by the agent
 * process, and that process dies with the app. So the *processes* cannot be
 * restored — no live shell, no scrollback. What is restored is the roster:
 * reopening a workspace recreates the same terminals, with the same names, in
 * the same order and each in the directory it was left in, so the panel you
 * left is the panel you come back to — without a `cd` to get back to work.
 *
 * Scoped per project, like the composer preferences: terminals belong to the
 * workspace you opened them in.
 */

import { useTerminalStore } from "@/state/terminal.store";

const KEY = "atelier.terminals";
/** A runaway roster would spawn that many shells on the next launch. */
const MAX_TERMINALS = 12;

let scope = "";

/** Re-point at a project's roster; called on every workspace switch. */
export function setRosterScope(projectId: string | null): void {
  scope = projectId ?? "";
}

function storageKey(): string {
  return scope ? `${KEY}::${scope}` : KEY;
}

export interface RosterEntry {
  name: string;
  /** Where the shell was last seen; absent on rosters saved before this. */
  cwd?: string;
}

/** Rosters used to be bare names, so a string is still a valid entry. */
function toEntry(value: unknown): RosterEntry | null {
  if (typeof value === "string") {
    const name = value.trim();
    return name ? { name } : null;
  }
  if (!value || typeof value !== "object") return null;
  const { name, cwd } = value as { name?: unknown; cwd?: unknown };
  if (typeof name !== "string" || !name.trim()) return null;
  const entry: RosterEntry = { name: name.trim() };
  if (typeof cwd === "string" && cwd) entry.cwd = cwd;
  return entry;
}

/** Saved terminals, oldest first. Empty when nothing is on record. */
export function readRoster(): RosterEntry[] {
  if (!scope) return [];
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(toEntry)
      .filter((entry): entry is RosterEntry => entry !== null)
      .slice(0, MAX_TERMINALS);
  } catch {
    return [];
  }
}

/** Record the current terminals. */
export function writeRoster(entries: RosterEntry[]): void {
  if (!scope) return;
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify(entries.slice(0, MAX_TERMINALS))
    );
  } catch {
    // A full or blocked localStorage costs the roster, not the terminals.
  }
}

/**
 * Persist the dock's terminals as they stand — tab order, display names and
 * current directories — for the next launch. Called whenever any of those
 * change.
 */
export function syncRoster(): void {
  const { sessions, labels } = useTerminalStore.getState();
  writeRoster(
    sessions.map((session) => ({
      name: labels[session.id] ?? session.name,
      cwd: session.cwd,
    }))
  );
}

/**
 * The name a new terminal gets: the lowest unused "Terminal N". Counting the
 * list rather than a running counter keeps numbering stable across restarts,
 * where the counter would have reset but the names come back.
 */
export function nextTerminalName(existing: string[]): string {
  const taken = new Set(existing);
  for (let n = 1; n <= MAX_TERMINALS + 1; n++) {
    const candidate = `Terminal ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `Terminal ${existing.length + 1}`;
}

export { MAX_TERMINALS };
