import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { openExternal } from "@/lib/desktop";
import { bridge } from "./bridge-client.js";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** The DOM element the terminal is currently opened into. */
  element: HTMLElement | null;
  /**
   * True while the viewport is parked at the bottom, which is what makes new
   * output follow. Cleared the moment the user scrolls up to read back, and
   * re-armed when they return to the bottom — the same contract as VS Code's
   * terminal.
   */
  stick: boolean;
  /** Removes the viewport scroll listener when the terminal is disposed. */
  detach: (() => void) | null;
  /** Timestamp of the last Ctrl+C, for the double-press force stop. */
  lastCtrlC: number;
}

/**
 * How long the first Ctrl+C stays "armed". Long enough to be a deliberate
 * double press, short enough that a copy now and an unrelated copy later are
 * never mistaken for one.
 */
const DOUBLE_CTRL_C_MS = 1000;

/** Slack, in px, for calling a viewport "at the bottom" after rounding. */
const BOTTOM_EPSILON = 2;

/** Highlight colors for search matches — #RRGGBB, as the addon requires. */
const SEARCH_DECORATIONS = {
  matchBackground: "#5b5590",
  matchOverviewRuler: "#5b5590",
  activeMatchBackground: "#c58b2c",
  activeMatchColorOverviewRuler: "#c58b2c",
};

export interface TerminalSearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  /** Keeps the current match while the query is still being typed. */
  incremental?: boolean;
}

/**
 * Holds live xterm instances outside React state. terminal.data events are
 * written straight to the instance — no re-renders on output streams.
 */
class TerminalRegistry {
  private entries = new Map<string, Entry>();
  private searchRequest: (termId: string) => void = () => {};

  /** The panel registers here so Ctrl+F inside xterm can open its find bar. */
  onSearchRequest(handler: (termId: string) => void): void {
    this.searchRequest = handler;
  }

  themeFor(dark: boolean) {
    // cursor = the block colour, cursorAccent = the glyph UNDER the block.
    // Without a solid accent the character vanishes on a transparent bg,
    // which read as an "invisible white cursor".
    // Background stays fully transparent so the terminal sits on the bottom
    // panel's own surface; the rest tracks the --atelier-* tokens.
    return dark
      ? {
          background: "#00000000",
          foreground: "#e7eeee",
          cursor: "#68aeb8",
          cursorAccent: "#111a1c",
          selectionBackground: "#35666e66",
        }
      : {
          background: "#00000000",
          foreground: "#152527",
          cursor: "#224248",
          cursorAccent: "#ffffff",
          selectionBackground: "#68aeb866",
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
        // Typing must always bring the prompt back into view, however far
        // back the user had scrolled to read.
        scrollOnUserInput: true,
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          // Ctrl/Cmd+click, like every editor: a bare click in a terminal
          // is how you place a selection, not how you leave the app.
          if (event.ctrlKey || event.metaKey) openExternal(uri);
        })
      );
      term.onData((data) => {
        void bridge.rpc("terminal.write", { termId, data }).catch(() => {});
      });
      entry = {
        term,
        fit,
        search,
        element: null,
        stick: true,
        detach: null,
        lastCtrlC: 0,
      };
      this.entries.set(termId, entry);
      term.attachCustomKeyEventHandler((event) =>
        this.handleKey(termId, event)
      );
      void bridge
        .rpc("terminal.getHistory", { termId })
        .then(({ data }) => {
          if (!data) return;
          // The replay must land at its end, not at line one.
          entry!.term.write(data, () => entry!.term.scrollToBottom());
        })
        .catch(() => {});
    }
    // Only (re)open when the target element actually changed.
    if (entry.element !== container) {
      entry.term.open(container);
      entry.element = container;
      this.watchViewport(entry);
      this.fitAndSync(termId);
    }
    return entry;
  }

  /**
   * Tracks whether the viewport is at the bottom. xterm's own scroll event
   * fires for output as well as for the user, so the DOM element's scroll
   * position — the thing the user actually manipulates with the wheel and
   * the scrollbar — is the only honest source for "am I following?".
   */
  private watchViewport(entry: Entry): void {
    entry.detach?.();
    const viewport = entry.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (!viewport) return;
    const onScroll = () => {
      const distance =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      entry.stick = distance <= BOTTOM_EPSILON;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    entry.detach = () => viewport.removeEventListener("scroll", onScroll);
  }

  write(termId: string, data: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    // The callback runs after the write is parsed and rendered, so the
    // scroll lands past the new rows rather than where they used to end.
    entry.term.write(data, () => {
      if (entry.stick) entry.term.scrollToBottom();
    });
  }

  fitAndSync(termId: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    try {
      entry.fit.fit();
      const { cols, rows } = entry.term;
      void bridge.rpc("terminal.resize", { termId, cols, rows }).catch(() => {});
      // A terminal written to while hidden (collapsed dock, background tab)
      // comes back with a stale viewport: the rows are there but the scroll
      // area was never synced, so the newest output sits below the fold and
      // the scrollbar has nothing to drag. Repainting every row re-syncs the
      // scroll area, and re-anchoring is what makes "the latest line is the
      // visible one" actually hold.
      entry.term.refresh(0, entry.term.rows - 1);
      if (entry.stick) entry.term.scrollToBottom();
    } catch {
      // container not visible yet
    }
  }

  setTheme(dark: boolean): void {
    for (const entry of this.entries.values()) {
      entry.term.options.theme = this.themeFor(dark);
    }
  }

  focus(termId: string): void {
    this.entries.get(termId)?.term.focus();
  }

  /** Runs a find; `back` searches upwards. Returns whether it matched. */
  find(
    termId: string,
    query: string,
    options: TerminalSearchOptions,
    back = false
  ): boolean {
    const entry = this.entries.get(termId);
    if (!entry) return false;
    if (!query) {
      entry.search.clearDecorations();
      return false;
    }
    const searchOptions: ISearchOptions = {
      ...options,
      decorations: SEARCH_DECORATIONS,
    };
    return back
      ? entry.search.findPrevious(query, searchOptions)
      : entry.search.findNext(query, searchOptions);
  }

  clearFind(termId: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    entry.search.clearDecorations();
    entry.term.clearSelection();
  }

  /** Match counts for the find bar's "3 of 12". */
  subscribeResults(
    termId: string,
    listener: (found: { index: number; count: number }) => void
  ): () => void {
    const entry = this.entries.get(termId);
    if (!entry) return () => {};
    const sub = entry.search.onDidChangeResults((event) =>
      listener({ index: event.resultIndex, count: event.resultCount })
    );
    return () => sub.dispose();
  }

  /**
   * Clipboard and find keys, resolved before xterm turns them into bytes.
   * Returning false keeps the key out of the pty.
   *
   * Ctrl+C is the interesting one: the first press copies the selection (or
   * sends ^C when there is nothing selected), and a second press within a
   * second force-stops whatever the shell is running. ^C alone does not do
   * that on Windows — see TerminalManager.interrupt.
   */
  private handleKey(termId: string, event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;
    const mod = (event.ctrlKey && !event.altKey) || event.metaKey;
    if (!mod) return true;
    const entry = this.entries.get(termId);
    if (!entry) return true;
    const key = event.key.toLowerCase();

    // Every branch below stops the browser as well as xterm. Ctrl+V is the
    // reason: xterm also listens for the native `paste` event on its helper
    // textarea, so leaving the default alone pastes the clipboard twice.
    // Ctrl+Shift+C is copy and only copy — it never force-stops, so there is
    // always a way to copy without arming the second press.
    if (key === "c" && event.shiftKey) {
      if (entry.term.hasSelection()) {
        const selection = entry.term.getSelection();
        void navigator.clipboard?.writeText(selection).catch(() => undefined);
      }
      event.preventDefault();
      return false;
    }
    if (key === "c") {
      const now = Date.now();
      const doubled = now - entry.lastCtrlC <= DOUBLE_CTRL_C_MS;
      entry.lastCtrlC = doubled ? 0 : now;
      if (doubled) {
        this.forceStop(termId);
        event.preventDefault();
        return false;
      }
      if (entry.term.hasSelection()) {
        const selection = entry.term.getSelection();
        void navigator.clipboard?.writeText(selection).catch(() => undefined);
        // Cleared so the next Ctrl+C is unambiguously about the process.
        entry.term.clearSelection();
        event.preventDefault();
        return false;
      }
      // Nothing selected: let xterm send ^C, the ordinary interrupt.
      return true;
    }
    if (key === "v") {
      void this.pasteFromClipboard(termId);
      event.preventDefault();
      return false;
    }
    if (key === "f") {
      this.searchRequest(termId);
      event.preventDefault();
      return false;
    }
    if (key === "a" && event.shiftKey) {
      entry.term.selectAll();
      event.preventDefault();
      return false;
    }
    return true;
  }

  /**
   * Takes down every process the shell started, leaving the shell itself at
   * its prompt. The notice is written locally rather than into the pty so it
   * cannot be mistaken for output from the program that just died.
   */
  private forceStop(termId: string): void {
    void bridge
      .rpc("terminal.interrupt", { termId })
      .then(({ killed }) => {
        const entry = this.entries.get(termId);
        if (!entry) return;
        const notice = killed
          ? `stopped ${killed} process${killed === 1 ? "" : "es"}`
          : "nothing was running";
        entry.term.write(`\r\n\x1b[2m[atelier] ${notice}\x1b[0m\r\n`);
      })
      .catch(() => {});
  }

  /**
   * Goes through term.paste() rather than writing the text straight to the
   * pty: that is what wraps it in bracketed-paste markers when the running
   * program asked for them, so a shell or editor treats a multi-line paste
   * as pasted text instead of a burst of typed Enter keys.
   */
  private async pasteFromClipboard(termId: string): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.entries.get(termId)?.term.paste(text);
    } catch {
      // clipboard unavailable (browser permission) — nothing to paste
    }
  }

  dispose(termId: string): void {
    const entry = this.entries.get(termId);
    if (entry) {
      entry.detach?.();
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
