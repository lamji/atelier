import type { EventBus } from "../events/event-bus.js";
import { isNotePath, type NoteAccessRegistry } from "../notes/note-access.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";

export const NOTE_WRITE_HOOK_ID = "builtin-note-write";
export const NOTE_WRITE_HOOK_NAME = "Notes are updated, never replaced";

const EDIT_TOOLS = new Set(["write_file", "replace_code", "replace_many"]);

/** Reports whether a workspace file exists. */
export type NoteExists = (relPath: string) => Promise<boolean>;

/**
 * Protects the user's markdown notes from the runs that read them.
 *
 * Two rules, both learned the hard way:
 *
 * 1. A note may only be touched by a turn that POINTED AT IT — the note
 *    picked in the composer, or a `.atelier/*.md` path the user typed. Every
 *    other note is retrieval material for that turn: read it, quote it,
 *    leave it alone. Without this a run that had merely been shown a note
 *    could decide to file its output there.
 *
 * 2. Even then, an existing note is UPDATED, never restated. write_file
 *    replaces the file wholesale, so one call can drop everything the user
 *    wrote and leave the run's own output in its place — which is exactly
 *    what happened to a sprint note. replace_code / replace_many can only
 *    change the lines they name, so the rest of the note survives by
 *    construction.
 *
 * A note that does not exist yet is not protected by either rule: writing a
 * new file destroys nothing, and "write this up as a note" is a normal ask.
 */
export class NoteWriteGuard {
  constructor(
    private access: NoteAccessRegistry,
    private exists: NoteExists,
    private bus: EventBus
  ) {}

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    if (!EDIT_TOOLS.has(ctx.toolName)) return undefined;

    for (const path of targetPaths(ctx.input)) {
      if (!isNotePath(path)) continue;
      // A new note is created, not overwritten: nothing to protect yet.
      if (!(await this.exists(path))) continue;

      const reason = this.access.allows(ctx.taskId, path)
        ? ctx.toolName === "write_file"
          ? replaceReason(path)
          : null
        : unreferencedReason(path);
      if (reason) return this.block(ctx, reason);
    }
    return undefined;
  }

  private block(ctx: HookGuardContext, reason: string): HookDecision {
    this.bus.publish(
      "hook.blocked",
      { hookId: NOTE_WRITE_HOOK_ID, name: NOTE_WRITE_HOOK_NAME, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }
}

function replaceReason(path: string): string {
  return (
    `${path} is the user's note, so it is updated, never replaced. ` +
    "write_file would write the whole file and drop everything already in " +
    "it. Use replace_code (or replace_many) to change only the lines that " +
    "have to change, or to add a section by anchoring on the text it " +
    "follows. The run's own report is appended to the note automatically " +
    "when the task ends, so it does not need writing here."
  );
}

function unreferencedReason(path: string): string {
  return (
    `${path} was not referenced by this prompt, so it may not be edited. ` +
    "A note is only writable when the user picked it in the composer or " +
    "named its path; every other note is context to read, not a place to " +
    "file work. Do what was asked in the codebase instead, and if the note " +
    "should really change, say so in your answer and let the user ask."
  );
}

/** Every path one edit call would write: `path`, or `edits[].path`. */
function targetPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (typeof record.path === "string" && record.path) return [record.path];
  if (!Array.isArray(record.edits)) return [];
  return record.edits
    .map((edit) =>
      edit && typeof edit === "object"
        ? (edit as Record<string, unknown>).path
        : null
    )
    .filter((path): path is string => typeof path === "string" && path !== "");
}
