const HEAD_LINES = 20;
const TAIL_LINES = 40;
const MAX_SIGNAL_LINES = 20;
const SIGNAL = /error|fail|exception|warn/i;

/**
 * Long terminal output keeps the head (the command echo/context), the
 * tail (the outcome), and any error/warning lines from the omitted
 * middle — the parts that change what the model does next.
 */
export function shapeTerminal(result: unknown): string | null {
  const r = result as {
    exitCode?: number | null;
    output?: string;
    truncated?: boolean;
    timedOut?: boolean;
  };
  if (typeof r?.output !== "string") return null;

  const lines = r.output.split(/\r?\n/);
  let body = r.output;
  if (lines.length > HEAD_LINES + TAIL_LINES + 10) {
    const head = lines.slice(0, HEAD_LINES);
    const tail = lines.slice(-TAIL_LINES);
    const middle = lines.slice(HEAD_LINES, -TAIL_LINES);
    const signal = middle
      .filter((line) => SIGNAL.test(line))
      .slice(0, MAX_SIGNAL_LINES);
    const omitted = middle.length - signal.length;
    body = [
      ...head,
      `[... ${omitted} line(s) omitted; error/warning lines kept below ...]`,
      ...signal,
      ...tail,
    ].join("\n");
  }

  const flags =
    (r.timedOut ? " (timed out)" : "") +
    (r.truncated ? " (output truncated upstream)" : "");
  return `exit ${r.exitCode ?? "?"}${flags}\n${body}`;
}
