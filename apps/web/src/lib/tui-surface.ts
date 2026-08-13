/**
 * Re-tints the dark surfaces a provider CLI paints into a light terminal.
 *
 * Codex — and any TUI that themes itself — picks its light or dark palette by
 * asking the terminal what colour it is painted on: the OSC 11 query. Atelier
 * answers that (see TerminalRegistry's OSC 11 handler) with the real colour of
 * the surface behind the pane, and everywhere the question reaches us that is
 * the whole fix.
 *
 * On Windows it never reaches us. A ConPTY does not forward its program's
 * bytes: it parses them into a console buffer and re-emits what it understood,
 * and an OSC colour query is consumed on the way through — verified by writing
 * one from inside a pty and watching nothing come out the other end. So the
 * CLI's question is answered by no one, it assumes dark, and it fills its
 * composer with a near-black surface, over which the terminal's own dark
 * default foreground is all but unreadable.
 *
 * The byte stream is the last place that colour can still be corrected, so
 * that is where this corrects it. Deliberately narrow:
 *
 * - light theme only — in dark theme the CLI's assumption was right;
 * - NEUTRAL near-blacks only. A grey surface is what a TUI paints when it
 *   believes the terminal is dark. Coloured backgrounds carry meaning — diff
 *   red and green, syntax highlighting, a selection — and are left untouched;
 * - backgrounds only. Foregrounds are the CLI's own accent colours, and they
 *   were already legible on the pane.
 */

/** Above this, a background is a deliberate mid-tone rather than a surface. */
const DARK_SURFACE_MAX = 96;

/** Spread between the channels that still counts as neutral grey. */
const NEUTRAL_SPREAD = 16;

/**
 * How much of a dark surface's depth survives the flip. Codex's #292929 lands
 * on #e8e8e8 — the same "slightly off the page" step it was reaching for,
 * measured from white instead of from black.
 */
const LIGHT_DEPTH = 0.55;

/** Longest trailing fragment held back waiting for the rest of its sequence. */
const MAX_PENDING = 32;

/** A complete SGR sequence: ESC [ <params> m. */
const SGR = /\u001b\[([0-9;]*)m/g;

/** A trailing SGR that the next chunk still has to finish. */
const PARTIAL_SGR = /\u001b\[?[0-9;]*$/;

function flip(channel: number): number {
  return 255 - Math.round(channel * LIGHT_DEPTH);
}

/** The light counterpart of a dark neutral, or null if it is neither. */
function lighten(r: number, g: number, b: number): [number, number, number] | null {
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  if (high > DARK_SURFACE_MAX) return null;
  if (high - low > NEUTRAL_SPREAD) return null;
  return [flip(r), flip(g), flip(b)];
}

/**
 * The grey an xterm palette index stands for: 0 is black, and 232-255 are the
 * 24-step greyscale ramp. Every other index is either a colour or one of the
 * themeable ANSI slots, which the terminal's own palette already resolves.
 */
function paletteGrey(index: number): number | null {
  if (index === 0) return 0;
  if (index >= 232 && index <= 255) return 8 + (index - 232) * 10;
  return null;
}

/**
 * Rewrite one SGR sequence's parameters, or return them unchanged.
 *
 * Parameters have to be walked rather than pattern-matched, because 38 and 48
 * swallow the parameters after them: `1;48;2;41;41;41;22` is one bold, one
 * background and one un-bold, and a naive match would read the 41s as codes in
 * their own right.
 */
function retintParams(raw: string): string {
  const params = raw.split(";");
  let changed = false;
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    const mode = params[i + 1];
    // 38 (foreground) and 48 (background) share this shape; only 48 is ours.
    if (code !== "38" && code !== "48") {
      i += 1;
      continue;
    }
    if (mode === "2") {
      const rgb = params.slice(i + 2, i + 5).map(Number);
      const [r, g, b] = rgb;
      const light =
        code === "48" && rgb.length === 3 && rgb.every(Number.isFinite)
          ? lighten(r!, g!, b!)
          : null;
      if (light) {
        params[i + 2] = String(light[0]);
        params[i + 3] = String(light[1]);
        params[i + 4] = String(light[2]);
        changed = true;
      }
      i += 5;
      continue;
    }
    if (mode === "5") {
      const index = Number(params[i + 2]);
      const grey = code === "48" ? paletteGrey(index) : null;
      const light = grey === null ? null : lighten(grey, grey, grey);
      if (light) {
        // Spliced as truecolour: the palette index itself is shared with the
        // rest of the screen, so it cannot be redefined for one cell.
        params.splice(i, 3, "48", "2", ...light.map(String));
        changed = true;
        i += 5;
        continue;
      }
      i += 3;
      continue;
    }
    i += 1;
  }
  return changed ? params.join(";") : raw;
}

/** Every dark neutral background in `text`, re-tinted for a light terminal. */
export function retintDarkSurfaces(text: string): string {
  if (!text.includes("\u001b[")) return text;
  return text.replace(SGR, (whole, params: string) => {
    const retinted = retintParams(params);
    return retinted === params ? whole : `\u001b[${retinted}m`;
  });
}

/**
 * {@link retintDarkSurfaces} over a stream.
 *
 * A pty hands over whatever bytes have arrived, which can cut an escape
 * sequence in half. The tail of a chunk that could still grow into an SGR is
 * held back and prepended to the next one, so a colour is never half-read and
 * left as it was. Anything longer than a plausible sequence is passed straight
 * through, so a lone ESC at the end of a stream cannot stall the terminal.
 */
export class TuiSurfaceFilter {
  private pending = "";

  /**
   * `retint` is per chunk rather than per filter so the theme can change
   * mid-stream: the buffering happens either way, and only the rewrite is
   * switched off, so a held-back tail can never surface under the wrong
   * theme or go missing because the theme flipped while it waited.
   */
  push(chunk: string, retint: boolean): string {
    const text = this.pending + chunk;
    const partial = PARTIAL_SGR.exec(text);
    const holdFrom =
      partial && partial[0].length <= MAX_PENDING ? partial.index : text.length;
    this.pending = text.slice(holdFrom);
    const ready = text.slice(0, holdFrom);
    return retint ? retintDarkSurfaces(ready) : ready;
  }
}
