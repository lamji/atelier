/**
 * Turning a typed app-skill command into the keys that submit it, for a
 * CLI that cannot load the app's skills itself (Codex).
 *
 * Atelier swaps the command word for a lead-in naming the skill file. The
 * simple way is to clear the composer and paste the whole prompt, but a
 * pasted image lives in the composer as an attachment: clearing it throws
 * the image away and leaves only the words "[Image #1]" in the pasted text.
 * So when the composer holds an attachment it is edited in place instead.
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Ctrl+U: clear the composer. */
const CLEAR = "\x15";
/** Ctrl+A: to the start of the line. */
const HOME = "\x01";
/** Delete forward. Not Ctrl+D, which quits a CLI whose composer is empty. */
const DELETE = "\x1b[3~";

/** The placeholder both provider CLIs show for a pasted image. */
const ATTACHMENT = /\[Image #\d+\]/;

/** True when the composer, as the screen shows it, holds a pasted image. */
export function holdsAttachment(shown: string | null): boolean {
  return shown !== null && ATTACHMENT.test(shown);
}

function paste(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`;
}

/**
 * The keys that leave the skill's prompt in the composer, ready for Enter.
 *
 * `token` is the command word as typed (`$document`), `lead` what replaces
 * it, `request` the rest of the line, and `shown` the composer as the
 * screen shows it. Each key was checked against the real Codex TUI.
 */
export function skillSubmitKeys(args: {
  token: string;
  lead: string;
  request: string;
  shown: string | null;
}): string {
  const { token, lead, request, shown } = args;
  if (shown === null || !holdsAttachment(shown)) {
    return `${CLEAR}${paste(`${lead} ${request}`)}`;
  }
  if (shown.toLowerCase().startsWith(token.toLowerCase())) {
    return `${HOME}${DELETE.repeat(token.length)}${paste(lead)}`;
  }
  // The image was pasted first: nothing is removed, the lead-in goes ahead.
  return `${HOME}${paste(`${lead} `)}`;
}
