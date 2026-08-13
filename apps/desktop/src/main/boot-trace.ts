/**
 * Opt-in boot timings: ATELIER_BOOT_TRACE=1.
 *
 * Boot work is spread over the main process, the renderer and a forked
 * agent, so "it feels slow" is never attributable by reading code — the
 * question is always which stage waits on which. One line per stage,
 * measured from process start, is what makes a change to the boot order
 * provable instead of merely plausible.
 */
const enabled = process.env.ATELIER_BOOT_TRACE === "1";
const startedAt = Date.now();

export function mark(stage: string): void {
  if (!enabled) return;
  const ms = String(Date.now() - startedAt).padStart(5);
  console.log(`[boot] ${ms}ms  ${stage}`);
}
