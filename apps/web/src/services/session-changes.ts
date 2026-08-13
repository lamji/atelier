/**
 * Per-session file-change tracking.
 *
 * A CLI session writes to disk directly, so the only record of what it did
 * is the working tree — and the working tree belongs to the whole repo, not
 * to one session. It is normally dirty before a session ever opens (another
 * branch mid-flight, an editor, an earlier session), and two sessions can be
 * running at once. Listing `git status` as "this session's changes" would
 * make the rail claim work no session did.
 *
 * So each session is tracked against its own baseline — the tree exactly as
 * it was when the session opened — and every file it moves off that baseline
 * is recorded in that session's ledger. Two sessions therefore never inherit
 * each other's dirt, and a file both of them wrote can name both.
 *
 * Detection is by mark, not by content: `git status` carries a size+mtime
 * mark per file ({@link GitFileStatus.mark}), so deciding what a session
 * touched costs one status call rather than loading every dirty file in the
 * repo. Contents are then loaded only for that session's own files. The
 * honest limit of that trade: a file that was ALREADY dirty when the session
 * opened counts as this session's the moment it is rewritten, even if the
 * rewrite put the same bytes back.
 */

import type { CliSessionChange, GitFileStatus } from "@atelier/protocol";
import { bridge } from "./bridge-client.js";

/** Diffs loaded per capture. Each costs a git.diff RPC, so the rail caps. */
export const MAX_TRACKED_FILES = 25;

/** One of a session's changed files, with both sides of the diff loaded. */
export type SessionChange = CliSessionChange;

/**
 * What the tree looked like when a session opened: the mark of every file
 * that was already dirty, by path.
 *
 * A clean file is simply absent, so "this session made this dirty" is the
 * default and only pre-existing dirt has to be remembered.
 */
type Baseline = Record<string, string>;

/** One file this session moved, and when. */
interface Touch {
  firstAt: number;
  lastAt: number;
  /** The mark as of the last capture, so a re-edit is a new touch. */
  mark: string;
}

/** Every file one session has moved, by path. */
type Ledger = Record<string, Touch>;

/**
 * Baselines and ledgers live in localStorage, keyed by term id.
 *
 * A CLI pty outlives the window — reloading reattaches to the running codex
 * — so state held only in memory would reset on every reload and the whole
 * repo's pre-existing changes would flood back into the rail. Same storage
 * contract as the session names in {@link ./cli-console}.
 */
// Versioned: baselines used to hold content fingerprints, and reading one
// of those as a mark would make every dirty file in the repo look moved.
const BASELINES_KEY = "atelier.cli.baselines.v2";
const LEDGERS_KEY = "atelier.cli.touched";
/** Oldest entries drop past this many, so neither key grows forever. */
const MAX_REMEMBERED = 50;

function read<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function write<T>(key: string, all: Record<string, T>): void {
  const ids = Object.keys(all);
  let kept = all;
  if (ids.length > MAX_REMEMBERED) {
    kept = {};
    for (const id of ids.slice(-MAX_REMEMBERED)) kept[id] = all[id]!;
  }
  try {
    localStorage.setItem(key, JSON.stringify(kept));
  } catch {
    // Storage full or blocked. Tracking still holds for this window.
  }
}

/**
 * The mark to measure a file by.
 *
 * An agent too old to send one leaves every already-dirty file looking
 * unmoved forever — the pre-mark behaviour — rather than flooding the rail
 * with the repo's existing changes, which is the worse of the two failures.
 */
function markOf(file: GitFileStatus): string {
  return file.mark ?? "";
}

function toBaseline(files: GitFileStatus[]): Baseline {
  const baseline: Baseline = {};
  for (const file of files) baseline[file.path] = markOf(file);
  return baseline;
}

/** Every file the working tree currently differs on, marks included. */
async function readStatus(): Promise<GitFileStatus[]> {
  const { status } = await bridge.rpc("git.status", {});
  return status.files;
}

/** Both sides of one file's diff, as the rail renders them. */
async function loadDiff(
  file: GitFileStatus
): Promise<{ before: string; after: string }> {
  // A file with no working-tree mark exists only in the index, so its
  // change is the staged one. Everything else is read against the working
  // tree — that is where the CLI writes.
  const staged = file.workingDir === "";
  const result = await bridge.rpc("git.diff", { path: file.path, staged });
  return { before: result.before ?? "", after: result.after ?? "" };
}

/**
 * Pin a session to the tree as it is right now, unless it is already
 * pinned.
 *
 * Called as a session is created or adopted, so a session sitting in the
 * background is still measured from where it started, not from whatever the
 * tree looks like the first time the user clicks its row. First write wins:
 * a later call must never move the line a session is measured against.
 *
 * Fire-and-forget: a repo-less workspace just leaves the session unpinned
 * and {@link captureSessionChanges} pins it on its first read, which is
 * still the earliest point available.
 */
export async function beginSessionTracking(sessionId: string): Promise<void> {
  if (read<Baseline>(BASELINES_KEY)[sessionId]) return;
  try {
    rememberBaseline(sessionId, await readStatus());
  } catch {
    // Not a repo, or git is mid-operation. Nothing to pin to yet.
  }
}

function rememberBaseline(
  sessionId: string,
  files: GitFileStatus[]
): Baseline {
  const all = read<Baseline>(BASELINES_KEY);
  const existing = all[sessionId];
  if (existing) return existing;
  const baseline = toBaseline(files);
  all[sessionId] = baseline;
  write(BASELINES_KEY, all);
  return baseline;
}

/** Drop a dead session's tracking, or a reused id would inherit it. */
export function endSessionTracking(sessionId: string): void {
  for (const key of [BASELINES_KEY, LEDGERS_KEY]) {
    const all = read<unknown>(key);
    if (!(sessionId in all)) continue;
    delete all[sessionId];
    write(key, all);
  }
}

/**
 * Which tracked sessions have moved a file, newest touch first.
 *
 * The answer to "who changed this?" — including sessions that are no longer
 * selected, and sessions that have since been closed only if their tracking
 * has not been dropped yet.
 */
export function sessionsTouching(path: string): string[] {
  const ledgers = read<Ledger>(LEDGERS_KEY);
  return Object.entries(ledgers)
    .filter(([, ledger]) => ledger[path])
    .sort((a, b) => b[1][path]!.lastAt - a[1][path]!.lastAt)
    .map(([sessionId]) => sessionId);
}

/**
 * Everything one session has changed, right now, with diffs loaded.
 *
 * The single entry point the rail uses: it reads the tree, decides which
 * files belong to this session, records them in the session's ledger, and
 * loads the diffs for those files only.
 *
 * A file the session edited and then reverted lands back on its baseline
 * mark... except that reverting rewrites it, so the mark moves and the file
 * stays listed until it is clean again — at which point git drops it from
 * status and it leaves on its own. Committing has the same effect, which is
 * right: there is nothing left to review.
 */
export async function captureSessionChanges(
  sessionId: string,
  now: number = Date.now()
): Promise<SessionChange[]> {
  const files = await readStatus();
  const baseline =
    read<Baseline>(BASELINES_KEY)[sessionId] ??
    rememberBaseline(sessionId, files);

  const ledgers = read<Ledger>(LEDGERS_KEY);
  const ledger: Ledger = {};
  const mine: GitFileStatus[] = [];

  for (const file of files) {
    const mark = markOf(file);
    const at = baseline[file.path];
    // Absent from the baseline: the session made this file dirty. Present
    // but moved: the session rewrote a file that was already dirty.
    if (at !== undefined && at === mark) continue;
    const previous = ledgers[sessionId]?.[file.path];
    ledger[file.path] =
      previous && previous.mark === mark
        ? previous
        : { firstAt: previous?.firstAt ?? now, lastAt: now, mark };
    mine.push(file);
  }

  // The ledger is rebuilt, not merged: a file that has gone clean is no
  // longer this session's outstanding change, and leaving it behind would
  // have sessionsTouching() name a session for a file with nothing in it.
  ledgers[sessionId] = ledger;
  write(LEDGERS_KEY, ledgers);

  const others = Object.entries(ledgers).filter(([id]) => id !== sessionId);
  return Promise.all(
    mine.slice(0, MAX_TRACKED_FILES).map(async (file) => ({
      path: file.path,
      ...(await loadDiff(file)),
      firstTouchedAt: ledger[file.path]!.firstAt,
      lastTouchedAt: ledger[file.path]!.lastAt,
      alsoTouchedBy: others
        .filter(([, other]) => other[file.path])
        .map(([id]) => id),
    }))
  );
}

/** Load the last reviewable snapshot saved for a provider session. */
export async function loadSessionChanges(
  providerId: string,
  sessionId: string
): Promise<SessionChange[]> {
  const { changes } = await bridge.rpc("cli.diff.get", {
    providerId,
    sessionId,
  });
  return changes;
}

/** Merge the latest live capture into durable provider-session review data. */
export async function saveSessionChanges(
  providerId: string,
  sessionId: string,
  changes: SessionChange[]
): Promise<void> {
  if (changes.length === 0) return;
  await bridge.rpc("cli.diff.save", { providerId, sessionId, changes });
}

/**
 * Give a pre-existing provider session its first durable review snapshot.
 * Called only from explicit resume: unlike a new session, a resumed Codex
 * already owns the working-tree diff its native terminal review displays.
 */
export async function seedResumedSessionChanges(
  providerId: string,
  sessionId: string,
  now: number = Date.now()
): Promise<void> {
  if ((await loadSessionChanges(providerId, sessionId)).length > 0) return;
  const files = await readStatus();
  const changes = await Promise.all(
    files.slice(0, MAX_TRACKED_FILES).map(async (file) => ({
      path: file.path,
      ...(await loadDiff(file)),
      firstTouchedAt: now,
      lastTouchedAt: now,
      alsoTouchedBy: [],
    }))
  );
  await saveSessionChanges(providerId, sessionId, changes);
}

/** Live content wins for a path; stored-only paths stay reviewable. */
export function mergeSessionChanges(
  stored: SessionChange[],
  live: SessionChange[]
): SessionChange[] {
  const merged = new Map(stored.map((change) => [change.path, change]));
  for (const change of live) merged.set(change.path, change);
  return [...merged.values()].sort(
    (a, b) => b.lastTouchedAt - a.lastTouchedAt || a.path.localeCompare(b.path)
  );
}
