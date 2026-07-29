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

/** The note body plus the typed instructions, in the agreed format. */
export function composePromptFilePrompt(
  noteBody: string,
  typed: string
): string {
  return typed ? `${noteBody}${INSTRUCTIONS_MARKER}${typed}` : noteBody;
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
  const head = stripFrontmatter(noteBody).trim().slice(0, HEAD_MATCH_CHARS);
  const body = stripFrontmatter(prompt).trimStart();
  return head && body.startsWith(head) ? "" : prompt.trim();
}
