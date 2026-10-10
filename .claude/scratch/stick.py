p = r"C:\Users\akrizu\atelier\apps\web\src\services\terminal-registry.ts"
s = open(p, encoding="utf-8").read()

old = '''/** Slack, in px, for calling a viewport "at the bottom" after rounding. */
const BOTTOM_EPSILON = 2;
'''
new = '''/** Slack, in px, for calling a viewport "at the bottom" after rounding. */
const BOTTOM_EPSILON = 2;

function viewportAtBottom(viewport: HTMLElement): boolean {
  const distance =
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  return distance <= BOTTOM_EPSILON;
}
'''
assert old in s
s = s.replace(old, new, 1)

start = s.index("  /**\n   * Tracks whether the viewport is at the bottom.")
end = s.index("  write(termId: string, data: string): void {")
new_watch = '''  /**
   * Tracks whether the terminal should follow its output.
   *
   * Following is released by the USER scrolling up — a wheel up, or a grab
   * of the scrollbar — and never by the viewport merely being off the
   * bottom: xterm scrolls the viewport itself while it reflows for a resize
   * or a full-screen TUI redraws, and a `scroll` event from one of those
   * used to flip the flag off for good, after which new output (a CLI's
   * prompt, drawn in the bottom rows) stayed below the fold. So `scroll`
   * only ever re-arms following, when the viewport reaches the bottom by
   * any route, including xterm's own scrollOnUserInput.
   */
  private watchViewport(entry: Entry): void {
    entry.detach?.();
    const viewport = entry.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (!viewport) return;
    const settle = () => {
      entry.stick = viewportAtBottom(viewport);
    };
    const onScroll = () => {
      if (viewportAtBottom(viewport)) entry.stick = true;
    };
    // Decided after the wheel has scrolled, so a wheel up with no
    // scrollback to reveal leaves following on.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) setTimeout(settle, 0);
    };
    // The scrollbar is the viewport's own; a press on it is a grab.
    const onGrab = () => {
      entry.stick = false;
      window.addEventListener("mouseup", () => setTimeout(settle, 0), {
        once: true,
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("mousedown", onGrab);
    entry.detach = () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("mousedown", onGrab);
    };
  }

'''
s = s[:start] + new_watch + s[end:]
open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
