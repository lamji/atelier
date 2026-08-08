/**
 * Which terminals a workspace has, by name and in order, across restarts.
 *
 * What can and cannot survive: a terminal is a real PTY owned by the agent
 * process, and that process dies with the app. So the *processes* cannot be
 * restored — no live shell, no scrollback. What is restored is the roster:
 * reopening a workspace recreates the same terminals, with the same names, in
 * the same order, so the panel you left is the panel you come back to.
 *
 * Scoped per project, like the composer preferences: terminals belong to the
 * workspace you opened them in.
 */

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

/** Saved terminal names, oldest first. Empty when nothing is on record. */
export function readRoster(): string[] {
  if (!scope) return [];
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, MAX_TERMINALS);
  } catch {
    return [];
  }
}

/** Record the current terminals. Called whenever the set or a name changes. */
export function writeRoster(names: string[]): void {
  if (!scope) return;
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify(names.slice(0, MAX_TERMINALS))
    );
  } catch {
    // A full or blocked localStorage costs the roster, not the terminals.
  }
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
