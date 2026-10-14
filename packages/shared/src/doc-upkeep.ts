/**
 * Keeping a session's `document` reports current.
 *
 * A report is a snapshot of the code at the moment it was written. When a
 * file it cites changes later in the session, Atelier asks the same CLI
 * session to run the skill's `update` mode over the reports that went out
 * of date. What to ask for, and whether now is a safe moment to ask, is
 * decided here, apart from the pty and the store, so it can be tested.
 */

import { holdsAttachment } from "./skill-submit.js";

/** The part of a listed report the upkeep decision reads. */
export interface UpkeepDoc {
  id: string;
  /** Cited files written after the report; empty while it is current. */
  changedFiles: string[];
  /** Last write among `changedFiles`, ms. */
  changedAt: number;
}

export interface DocUpkeepPlan {
  /** What follows the skill command: `update <id>...; changed: <file>...`. */
  request: string;
  /** Per report, the `changedAt` this request answers. */
  asked: Record<string, number>;
}

/**
 * Reports and changed files named in one request. The request is pasted
 * into the CLI's composer, and a CLI folds a long paste into a placeholder
 * that no longer reads as a command, so it has to stay short. Reports past
 * the limit are asked about when the turn this one starts has ended.
 */
const MAX_REPORTS = 3;
const MAX_NAMED_FILES = 6;

/**
 * The one update request that covers every out-of-date report in `docs`, or
 * null when there is nothing to ask.
 *
 * `asked` is what stops a loop: a report is asked about once per change. If
 * the update turn leaves the report untouched, it still reads as out of
 * date, and without this every turn end would ask again, forever.
 */
export function planDocUpkeep(
  docs: readonly UpkeepDoc[],
  asked: ReadonlyMap<string, number>
): DocUpkeepPlan | null {
  const due = docs
    .filter(
      (doc) =>
        doc.changedFiles.length > 0 && asked.get(doc.id) !== doc.changedAt
    )
    .slice(0, MAX_REPORTS);
  if (due.length === 0) return null;
  const files = [...new Set(due.flatMap((doc) => doc.changedFiles))];
  const named = files.slice(0, MAX_NAMED_FILES);
  const more = files.length - named.length;
  const changed = more > 0 ? [...named, `and ${more} more`] : named;
  const ids = due.map((doc) => doc.id).join(" ");
  return {
    request: `update ${ids}; changed: ${changed.join(", ")}`,
    asked: Object.fromEntries(due.map((doc) => [doc.id, doc.changedAt])),
  };
}

/**
 * True when a request Atelier types by itself can go into the session.
 *
 * `typed` is what the user has keyed into the composer; `composer` is the
 * composer as the screen shows it, null when there is none. The screen's
 * text is not required to be empty, because a CLI shows a placeholder
 * there. No composer means something else has the keyboard. A pasted
 * image is the exception: it takes one control key, so nothing was typed,
 * yet clearing the composer for the request would throw the image away.
 *
 * This only clears the request to be pasted. Its Enter waits on
 * {@link composerShows}: a dialog draws the same mark in front of its
 * selected option, and an Enter sent into one would answer it.
 */
export function canSendDocUpkeep(state: {
  processing: boolean;
  typed: string;
  composer: string | null;
}): boolean {
  if (state.processing) return false;
  if (state.typed.trim() !== "") return false;
  if (holdsAttachment(state.composer)) return false;
  return state.composer !== null;
}

/** How much of a pasted request has to be seen before Enter is sent. */
const ECHO_CHARS = 24;

/**
 * True when the composer, as the screen shows it, holds the request that
 * was just pasted - the proof that it is a composer and Enter will submit
 * the request rather than confirm whatever else had the keyboard.
 *
 * Spacing is ignored: a wrapped line comes off the screen with a break in
 * the middle of a word. Only the start is compared, since the rows under a
 * composer (its footer) are read along with it.
 */
export function composerShows(shown: string | null, request: string): boolean {
  if (!shown) return false;
  const squeeze = (text: string) => text.replace(/\s+/g, "");
  const head = squeeze(request).slice(0, ECHO_CHARS);
  return head !== "" && squeeze(shown).startsWith(head);
}
