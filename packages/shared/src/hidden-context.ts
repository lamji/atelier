/**
 * Context that rides WITH a prompt but is never part of what the user wrote.
 *
 * The page-preview bridge attaches the displayed iframe's HTML, CSS, console
 * and interactive elements to the turn — tens of kilobytes of machine
 * evidence the model needs and the user never asked to read. Sent inline it
 * became the transcript: the chat showed the whole DOM dump as "your
 * message", and the conversation title was named after it.
 *
 * The block is wrapped in these markers instead, so the prompt that reaches
 * the model is unchanged while every surface that shows a prompt back to a
 * human strips it first.
 */
const OPEN = "<atelier-hidden-context>";
const CLOSE = "</atelier-hidden-context>";

/** Wraps a block so it survives to the model and disappears from the UI. */
export function wrapHiddenContext(block: string): string {
  return `${OPEN}\n${block}\n${CLOSE}`;
}

/**
 * The human half of a prompt: every hidden block removed, whatever the user
 * typed left byte for byte. Safe on any prompt — one that carries no hidden
 * context comes back unchanged.
 *
 * An unterminated block (a truncated or clipped prompt) still cuts from the
 * marker to the end: a half-written DOM dump is no more readable than a
 * whole one.
 */
export function stripHiddenContext(prompt: string): string {
  if (!prompt.includes(OPEN)) return prompt;
  let out = "";
  let at = 0;
  for (;;) {
    const start = prompt.indexOf(OPEN, at);
    if (start === -1) {
      out += prompt.slice(at);
      break;
    }
    out += prompt.slice(at, start);
    const end = prompt.indexOf(CLOSE, start);
    if (end === -1) break;
    at = end + CLOSE.length;
  }
  return out.trim();
}
