import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { bridge } from "./bridge-client.js";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  /** The DOM element the terminal is currently opened into. */
  element: HTMLElement | null;
}

/**
 * Holds live xterm instances outside React state. terminal.data events are
 * written straight to the instance — no re-renders on output streams.
 */
class TerminalRegistry {
  private entries = new Map<string, Entry>();

  themeFor(dark: boolean) {
    // cursor = the block colour, cursorAccent = the glyph UNDER the block.
    // Without a solid accent the character vanishes on a transparent bg,
    // which read as an "invisible white cursor".
    return dark
      ? {
          background: "#00000000",
          foreground: "#e6e6f0",
          cursor: "#ffffff",
          cursorAccent: "#1b1b26",
          selectionBackground: "#4d4a8a66",
        }
      : {
          background: "#00000000",
          foreground: "#22222e",
          cursor: "#000000",
          cursorAccent: "#ffffff",
          selectionBackground: "#c9c5f866",
        };
  }

  /**
   * Opens the terminal into its persistent container exactly once. Called
   * again with the same container (re-renders, theme toggles) it is a
   * no-op, so scrollback and rendered content survive. Each terminal keeps
   * its own container for its whole life — nothing is ever wiped.
   */
  mount(termId: string, container: HTMLElement, dark: boolean): Entry {
    let entry = this.entries.get(termId);
    if (!entry) {
      const term = new Terminal({
        fontFamily:
          '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        fontSize: 12.5,
        cursorBlink: true,
        allowTransparency: true,
        theme: this.themeFor(dark),
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.onData((data) => {
        void bridge.rpc("terminal.write", { termId, data }).catch(() => {});
      });
      entry = { term, fit, element: null };
      this.entries.set(termId, entry);
      void bridge
        .rpc("terminal.getHistory", { termId })
        .then(({ data }) => {
          if (data) entry!.term.write(data);
        })
        .catch(() => {});
    }
    // Only (re)open when the target element actually changed.
    if (entry.element !== container) {
      entry.term.open(container);
      entry.element = container;
      this.fitAndSync(termId);
    }
    return entry;
  }

  write(termId: string, data: string): void {
    this.entries.get(termId)?.term.write(data);
  }

  fitAndSync(termId: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    try {
      entry.fit.fit();
      const { cols, rows } = entry.term;
      void bridge.rpc("terminal.resize", { termId, cols, rows }).catch(() => {});
    } catch {
      // container not visible yet
    }
  }

  setTheme(dark: boolean): void {
    for (const entry of this.entries.values()) {
      entry.term.options.theme = this.themeFor(dark);
    }
  }

  dispose(termId: string): void {
    const entry = this.entries.get(termId);
    if (entry) {
      entry.element = null;
      entry.term.dispose();
      this.entries.delete(termId);
    }
  }

  /** Tear down every terminal — used when switching projects. */
  disposeAll(): void {
    for (const termId of [...this.entries.keys()]) this.dispose(termId);
  }
}

export const terminalRegistry = new TerminalRegistry();
