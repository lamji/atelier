import { typedTailOf } from "@atelier/shared";

/** Notes live under the app's own folder; only these are guarded. */
const NOTE_DIR = ".atelier/";

/** A `.atelier/...md` path written anywhere in a prompt, with or without "@". */
const NOTE_MENTION = /\.atelier\/[A-Za-z0-9._\-/]+\.md/gi;

/** Tasks remembered; the oldest is dropped once the map is full. */
const MAX_TASKS = 64;

/** True for a path the note guard is responsible for. */
export function isNotePath(path: string): boolean {
  const posix = normalizeNotePath(path);
  return posix.startsWith(NOTE_DIR) && /\.md$/i.test(posix);
}

/** Comparable form of a note path: posix, root-relative, lower case. */
export function normalizeNotePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

/**
 * The notes a prompt actually points at: the one picked in the composer,
 * plus any `.atelier/*.md` path the user typed themselves.
 *
 * Only the TYPED half of a note-driven prompt is scanned. The note's own
 * body is the task, not a list of permissions — a sprint note that quotes
 * `.atelier/8-10-2026-sprint.md` is talking about it, not asking for it to
 * be rewritten.
 */
export function referencedNotes(prompt: string, promptFile?: string): string[] {
  const found = new Set<string>();
  if (promptFile && isNotePath(promptFile)) {
    found.add(normalizeNotePath(promptFile));
  }
  for (const match of typedTailOf(prompt).matchAll(NOTE_MENTION)) {
    if (!match[0].includes("..")) found.add(normalizeNotePath(match[0]));
  }
  return [...found];
}

/**
 * Which notes each running task is allowed to change.
 *
 * A markdown note is the user's own writing, and the agent reads a lot of
 * them: they are indexed, retrieved, and quoted into prompts. That made
 * every note a plausible edit target, and the model took the invitation —
 * a sprint note came back replaced by the SQL the run had produced, with
 * the user's text gone. Nothing in the workspace is cheaper to destroy or
 * harder to notice, because a note has no build that breaks.
 *
 * So access is granted per task, from the prompt, and nowhere else: the
 * note picked in the composer and the notes the user named. Everything
 * else is off limits for that turn, and even a granted note may only be
 * patched — see NoteWriteGuard.
 */
export class NoteAccessRegistry {
  /** taskId → normalized note paths that task may edit. */
  private granted = new Map<string, Set<string>>();

  /** Records what this task's prompt pointed at. Call once, at launch. */
  grant(taskId: string, prompt: string, promptFile?: string): void {
    const paths = referencedNotes(prompt, promptFile);
    this.granted.set(taskId, new Set(paths));
    // Map keeps insertion order, so the first key is the oldest task. The
    // bound is a backstop: release() normally clears the entry.
    if (this.granted.size > MAX_TASKS) {
      const oldest = this.granted.keys().next();
      if (!oldest.done) this.granted.delete(oldest.value);
    }
  }

  release(taskId: string): void {
    this.granted.delete(taskId);
  }

  /** True when this task's prompt pointed at that note. */
  allows(taskId: string, path: string): boolean {
    return this.granted.get(taskId)?.has(normalizeNotePath(path)) ?? false;
  }
}
