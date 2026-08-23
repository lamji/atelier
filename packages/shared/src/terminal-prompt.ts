/**
 * Recognises a dev server that has stopped to ask the user a question.
 *
 * A preview launch writes one command into an integrated terminal and then
 * waits for a URL to appear. When the command asks something instead — "port
 * 3000 is in use, use 3001?", "Ok to proceed?", "Terminate batch job?" — no
 * URL is ever printed, so the launch just spins until its timeout and blames
 * the server for not becoming reachable. The question is sitting in the
 * terminal the whole time; nothing was reading it.
 *
 * Detection is deliberately tail-anchored. A prompt is the LAST thing on
 * screen because the process is blocked on it, so only the final lines are
 * considered — that keeps a question quoted in earlier build output, or one
 * the user already answered, from raising a dialog that answers nothing.
 */

const ANSI_ESCAPE =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/** Trailing "(Y/n)", "[y/N]", "(y)", "› (Y/n)" — the answer hint itself. */
const YES_NO_TAIL =
  /(?:\(\s*y(?:es)?\s*[/|]\s*n(?:o)?\s*\)|\(\s*n(?:o)?\s*[/|]\s*y(?:es)?\s*\)|\[\s*y(?:es)?\s*[/|]\s*n(?:o)?\s*\]|\[\s*n(?:o)?\s*[/|]\s*y(?:es)?\s*\]|\(\s*y\s*\))\s*[?:.]?\s*$/i;

/**
 * Prompts that end in a bare question mark with no hint. Kept to an explicit
 * list: "?" alone is far too common in build output to treat as a question
 * someone is waiting on.
 */
const KNOWN_BARE_PROMPT =
  /\b(?:ok to proceed|do you want to continue|would you like to (?:proceed|continue)|proceed\?|overwrite\?|continue\?)\s*\??\s*$/i;

/** How much of the tail is considered. A prompt is never far from the end. */
const TAIL_CHARS = 4000;

/** How many trailing lines may hold the question the hint belongs to. */
const QUESTION_LOOKBACK = 4;

export interface TerminalPrompt {
  /** The question as printed, without the answer hint's decoration. */
  question: string;
  /** The exact final line, for callers that want to show it verbatim. */
  line: string;
}

/**
 * The question a terminal is currently blocked on, or null.
 *
 * `output` is raw terminal history; escapes and carriage returns are
 * stripped here so callers can pass it straight through.
 */
export function pendingTerminalPrompt(output: string): TerminalPrompt | null {
  const lines = tailLines(output);
  const line = lines.at(-1);
  if (!line) return null;
  if (!YES_NO_TAIL.test(line) && !KNOWN_BARE_PROMPT.test(line)) return null;

  return { question: questionFrom(lines), line };
}

/**
 * The text to write for an answer, including the newline that submits it.
 *
 * A bare newline is a valid answer — it takes whichever option the prompt
 * capitalised as its default — so an empty string is not treated as "no".
 */
export function terminalAnswer(answer: "yes" | "no" | "default"): string {
  if (answer === "default") return "\r";
  return `${answer === "yes" ? "y" : "n"}\r`;
}

/** Non-empty trailing lines, cleaned of escapes and progress redraws. */
function tailLines(output: string): string[] {
  return output
    .slice(-TAIL_CHARS)
    .replace(ANSI_ESCAPE, "")
    // A spinner or progress bar redraws with \r; only the final paint of
    // such a line is on screen, and that is what the user is answering.
    .split(/\r?\n/)
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The human-readable question. Frameworks print the sentence on one line and
 * the hint on the next ("… use another port instead?" / "› (Y/n)"), so when
 * the final line carries no words of its own, look back for the sentence it
 * belongs to.
 */
function questionFrom(lines: string[]): string {
  const last = lines.at(-1) ?? "";
  const stripped = decorated(last);
  if (stripped.length > 0) return stripped;

  const start = Math.max(0, lines.length - QUESTION_LOOKBACK);
  for (let i = lines.length - 2; i >= start; i -= 1) {
    const candidate = decorated(lines[i] ?? "");
    if (candidate.length > 0) return candidate;
  }
  return last.trim();
}

/** One line minus the answer hint and the prompt glyphs around it. */
function decorated(line: string): string {
  return line
    .replace(YES_NO_TAIL, "")
    .replace(/^[?›»>*✔✖•\s-]+/u, "")
    .replace(/[›»>\s]+$/u, "")
    .trim();
}
