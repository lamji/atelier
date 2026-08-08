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
  const header = notePath
    ? `${SOURCE_PREFIX}${notePath}\n` +
      "(That path IS \"this file\"/\"this note\"/\"this md\" in anything " +
      "below. Everything up to the instructions marker is its current " +
      "content. Write updates back to that path — do not resolve the " +
      "reference to some other file.)\n\n"
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
