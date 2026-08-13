/**
 * Reconstructs the lines a user submits into a pty from the raw bytes their
 * keystrokes produce.
 *
 * A CLI running in a pty has no API — the only thing Atelier can observe
 * about "what is this session about?" is what the user types into it. xterm
 * hands us those keystrokes one chunk at a time, mixed in with editing keys
 * and escape sequences, so a line has to be rebuilt the way the program on
 * the other end rebuilds it: printable characters accumulate, Backspace
 * removes, Enter submits.
 *
 * Deliberately approximate. Cursor movement, history recall and multi-line
 * composers are not modelled, because the caller only wants the gist of the
 * first thing asked, not a faithful replica of the CLI's own editor.
 */

const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Final byte of a CSI sequence — the run of parameters ends here. */
function isCsiFinal(ch: string): boolean {
  return ch >= "\x40" && ch <= "\x7e";
}

/**
 * Length of the escape sequence starting at `i`, or 0 when the chunk ends
 * mid-sequence and the rest has to wait for the next one.
 */
function escapeLength(data: string, i: number): number {
  const next = data[i + 1];
  if (next === undefined) return 0;
  if (next !== "[" && next !== "O") return 2; // Alt+key and friends
  for (let j = i + 2; j < data.length; j += 1) {
    if (isCsiFinal(data[j]!)) return j - i + 1;
  }
  return 0;
}

export class PtyInputLines {
  private buffer = "";
  /** Tail of the last chunk that ended mid-escape-sequence. */
  private pending = "";
  /** Inside a bracketed paste, where newlines are text rather than submits. */
  private pasting = false;

  /** Feeds one chunk of input and returns whatever lines it completed. */
  push(chunk: string): string[] {
    const data = this.pending + chunk;
    this.pending = "";
    const lines: string[] = [];

    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;

      if (this.pasting) {
        if (data.startsWith(PASTE_END, i)) {
          this.pasting = false;
          i += PASTE_END.length;
          continue;
        }
        // A pasted newline is part of one prompt, not the end of it.
        this.buffer += ch === "\r" || ch === "\n" ? " " : ch;
        i += 1;
        continue;
      }

      if (data.startsWith(PASTE_START, i)) {
        this.pasting = true;
        i += PASTE_START.length;
        continue;
      }

      if (ch === ESC) {
        const length = escapeLength(data, i);
        if (length === 0) {
          this.pending = data.slice(i);
          return lines;
        }
        i += length;
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        // Runs of whitespace collapse: a pasted CRLF contributes two spaces
        // and the caller wants a label, not the original's layout.
        const line = this.buffer.trim().replace(/\s+/g, " ");
        this.buffer = "";
        if (line) lines.push(line);
        i += 1;
        continue;
      }

      if (ch === "\x7f" || ch === "\b") {
        this.buffer = this.buffer.slice(0, -1);
        i += 1;
        continue;
      }

      // Ctrl+C and Ctrl+U throw away the line being typed, so anything the
      // caller reads after them must not carry what came before.
      if (ch === "\x03" || ch === "\x15") {
        this.buffer = "";
        i += 1;
        continue;
      }

      // Every other control byte (Tab, Ctrl+key) is a command, not text.
      if (ch < " ") {
        i += 1;
        continue;
      }

      this.buffer += ch;
      i += 1;
    }

    return lines;
  }
}
