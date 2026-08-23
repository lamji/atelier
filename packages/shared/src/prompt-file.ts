import { stripFrontmatter } from "./frontmatter.js";

/**
 * A markdown note picked in the composer becomes the BODY of the prompt,
 * with whatever the user typed appended under this marker.
 *
 * Both halves of the app need the exact format: the composer builds it, and
 * the agent splits it back apart when it writes the run's report into that
 * same note. Without the split the note would quote its own full text back
 * into itself once per run.
 */
const INSTRUCTIONS_MARKER = "\n\nAdditional instructions:\n";

/** How much of the note has to match for a prompt to be "just the note". */
const HEAD_MATCH_CHARS = 200;

/**
 * Names the note the prompt was built from.
 *
 * The body alone left the note anonymous: "update this md file" had no
 * referent, and the model resolved "this" to whichever markdown file
 * retrieval had put in front of it — confidently, and wrongly. The pill in
 * the composer says which file it is; the prompt has to say so too.
 */
const SOURCE_PREFIX = "Prompt file: ";

/** The note body plus the typed instructions, in the agreed format. */
export function composePromptFilePrompt(
  noteBody: string,
  typed: string,
  notePath?: string
): string {
  // Two jobs, and the wording has burned us in both directions. The path
  // must be named, or "update this md" resolves to whichever markdown file
  // retrieval surfaced. But the old header then said "write updates back
  // to that path", and models took that as the ASSIGNMENT — a note that
  // spec'd a feature came back as a nicely edited note and no feature.
  // The note is the prompt: the default is to DO what it says, and the
  // note is only ever the edit target when its instructions say so.
  const header = notePath
    ? `${SOURCE_PREFIX}${notePath}\n` +
      "(The content below, up to any instructions marker, is that file's " +
      "current text, given as the TASK for this turn — instructions to " +
      "carry out in the codebase, not a document to improve. When it says " +
      '"this file"/"this note"/"this md", it means exactly that path, no ' +
      "other file. Edit the note itself ONLY if its instructions " +
      "explicitly ask for changes to that file; a run report is appended " +
      "to it automatically after the task, so do not write one yourself. " +
      "When it does ask, UPDATE the note with replace_code — write_file " +
      "on a note replaces everything the user wrote and is refused.)\n\n"
    : "";
  const body = typed ? `${noteBody}${INSTRUCTIONS_MARKER}${typed}` : noteBody;
  return `${header}${body}`;
}

/**
 * The note path a prompt-file prompt was built from, or "" for any other
 * prompt. Lets the agent unlock the note for the run that is about to
 * rewrite it.
 */
export function promptFilePathOf(prompt: string): string {
  if (!prompt.startsWith(SOURCE_PREFIX)) return "";
  const end = prompt.indexOf("\n");
  const path = prompt.slice(SOURCE_PREFIX.length, end === -1 ? undefined : end);
  return path.trim();
}

/**
 * The typed half of a prompt built by `composePromptFilePrompt` — `""` when
 * the note was the whole prompt. A prompt that never went through the
 * composer's prompt-file path is returned unchanged, so a caller can run
 * this on any prompt without checking first.
 *
 * Frontmatter is stripped from both sides before they are compared: the
 * note's `status:` line is rewritten the moment its task starts, so the
 * prompt captured at send time no longer matches the file byte for byte.
 */
export function typedInstructionsOf(prompt: string, noteBody: string): string {
  const at = prompt.lastIndexOf(INSTRUCTIONS_MARKER);
  if (at !== -1) return prompt.slice(at + INSTRUCTIONS_MARKER.length).trim();
  // The path header is ours, not the user's: left in, it would fail the
  // head match below and the note would quote its own body back into itself.
  const withoutHeader = stripSourceHeader(prompt);
  const head = stripFrontmatter(noteBody).trim().slice(0, HEAD_MATCH_CHARS);
  const body = stripFrontmatter(withoutHeader).trimStart();
  return head && body.startsWith(head) ? "" : withoutHeader.trim();
}

function stripSourceHeader(prompt: string): string {
  if (!prompt.startsWith(SOURCE_PREFIX)) return prompt;
  const at = prompt.indexOf("\n\n");
  return at === -1 ? "" : prompt.slice(at + 2);
}

/**
 * The half of a prompt-file prompt the user actually TYPED — "" when the
 * note was sent as-is, and the whole prompt when it never came from a note.
 *
 * Unlike `typedInstructionsOf` this needs no copy of the note, so a caller
 * that only has the prompt (the task launcher, the note guard) can still
 * tell the user's words apart from the note's body. That distinction is
 * what keeps a path quoted INSIDE a note from reading as a request to
 * edit that file.
 */
export function typedTailOf(prompt: string): string {
  if (!prompt.startsWith(SOURCE_PREFIX)) return prompt;
  const at = prompt.lastIndexOf(INSTRUCTIONS_MARKER);
  return at === -1 ? "" : prompt.slice(at + INSTRUCTIONS_MARKER.length).trim();
}
