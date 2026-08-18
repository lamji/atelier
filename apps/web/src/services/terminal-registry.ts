import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { openExternal } from "@/lib/desktop";
import { retintDarkSurfaces, TuiSurfaceFilter } from "@/lib/tui-surface";
import {
  terminalProfile,
  type TerminalProfileId,
} from "@/services/terminal-appearance";
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
  /**
   * Set for a terminal whose whole job is hosting somebody else's themed TUI
   * — CLI mode's provider consoles. Non-null means its output is re-tinted in
   * light theme; see {@link TuiSurfaceFilter}. A plain shell terminal keeps
   * its bytes exactly as the program wrote them.
   */
  surfaces: TuiSurfaceFilter | null;
  /** Non-null only for the floating modal terminal. */
  profile: TerminalProfileId | null;
}

export interface TerminalMountOptions {
  /**
   * Correct the dark surfaces a provider CLI paints when it could not find
   * out the terminal is light. Only for terminals that exist to run one, and
   * only ever a no-op in dark theme.
   */
  retintDarkSurfaces?: boolean;
  /** Linux-style palette for the floating modal terminal only. */
  profile?: TerminalProfileId;
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

/**
 * `getComputedStyle(...).backgroundColor`, as an xterm OSC 11 colour reply —
 * or null for a fully transparent one, so the caller keeps walking up to the
 * next ancestor instead of reporting "no colour" as a real answer.
 */
function opaqueRgb(cssColor: string): string | null {
  const m = cssColor.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!m) return null;
  const [, r, g, b, a] = m;
  if (a !== undefined && Number(a) === 0) return null;
  const channel = (n: string) => Number(n).toString(16).padStart(2, "0").repeat(2);
  return `rgb:${channel(r!)}/${channel(g!)}/${channel(b!)}`;
}

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
  private inputListeners = new Map<string, Set<(data: string) => void>>();
  private outputListeners = new Map<string, Set<(data: string) => void>>();
  /**
   * The live theme. Kept here rather than read per write because output
   * arrives far more often than the theme changes, and both mount() and
   * setTheme() already carry it.
   */
  private dark = false;

  /** The panel registers here so Ctrl+F inside xterm can open its find bar. */
  onSearchRequest(handler: (termId: string) => void): void {
    this.searchRequest = handler;
  }

  /**
   * Observe the raw bytes the user types into a terminal, as they are sent
   * to the pty. Kept apart from the xterm instances so a listener can be
   * registered before the terminal is ever mounted — CLI mode attaches one
   * the moment a session exists, which is well before its container is on
   * screen. Returns the unsubscribe.
   */
  onInput(termId: string, listener: (data: string) => void): () => void {
    let listeners = this.inputListeners.get(termId);
    if (!listeners) {
      listeners = new Set();
      this.inputListeners.set(termId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.inputListeners.delete(termId);
    };
  }

  /** Observe raw pty output without coupling activity state to xterm mounts. */
  onOutput(termId: string, listener: (data: string) => void): () => void {
    let listeners = this.outputListeners.get(termId);
    if (!listeners) {
      listeners = new Set();
      this.outputListeners.set(termId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.outputListeners.delete(termId);
    };
  }

  themeFor(dark: boolean, profile: TerminalProfileId | null = null) {
    if (profile) return terminalProfile(profile).theme;
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
   * Opens the terminal into its container, preserving the same xterm instance
   * when React replaces that container. xterm's open() is intentionally a
   * no-op after the first call, so an existing terminal must have its rendered
   * element moved or it stays attached to the detached old container.
   */
  mount(
    termId: string,
    container: HTMLElement,
    dark: boolean,
    options: TerminalMountOptions = {}
  ): Entry {
    this.dark = dark;
    let entry = this.entries.get(termId);
    if (!entry) {
      const term = new Terminal({
        fontFamily:
          '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        fontSize: 12.5,
        cursorBlink: true,
        allowTransparency: true,
        theme: this.themeFor(dark, options.profile ?? null),
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
        // Observers must never be able to stop the keystroke reaching the
        // pty, so they run after the write and each is isolated.
        for (const listener of this.inputListeners.get(termId) ?? []) {
          try {
            listener(data);
          } catch {
            // a watcher's problem is not the terminal's
          }
        }
      });
      // Overrides xterm's own OSC 11 answer (see the comment on themeFor)
      // with the colour actually painted behind this terminal. Registered
      // AFTER xterm's built-in handler, and xterm tries handlers most-recent
      // first — so this one runs, and returning false for anything but a
      // bare query hands the sequence straight back to xterm's own handling.
      term.parser.registerOscHandler(11, (data) => {
        if (data !== "?") return false;
        const rgb = this.effectiveBackgroundRgb(termId);
        if (!rgb) return false;
        term.input(`\x1b]11;${rgb}\x1b\\`, false);
        return true;
      });
      entry = {
        term,
        fit,
        search,
        element: null,
        stick: true,
        detach: null,
        lastCtrlC: 0,
        surfaces: options.retintDarkSurfaces ? new TuiSurfaceFilter() : null,
        profile: options.profile ?? null,
      };
      this.entries.set(termId, entry);
      term.attachCustomKeyEventHandler((event) =>
        this.handleKey(termId, event)
      );
      void bridge
        .rpc("terminal.getHistory", { termId })
        .then(({ data }) => {
          if (!data) return;
          // Replayed scrollback gets the same treatment as live output, or a
          // reload would bring the dark surfaces back. Whole and complete, so
          // it goes through the stateless pass rather than the stream filter.
          const replay =
            entry!.surfaces && !this.dark ? retintDarkSurfaces(data) : data;
          // The replay must land at its end, not at line one.
          entry!.term.write(replay, () => entry!.term.scrollToBottom());
        })
        .catch(() => {});
    }
    // A CLI pane is unmounted when CLI mode is switched off, so its
    // replacement is a different node even though the terminal is still live.
    if (entry.element !== container) {
      entry.profile = options.profile ?? null;
      entry.term.options.theme = this.themeFor(dark, entry.profile);
      if (entry.term.element) container.appendChild(entry.term.element);
      else entry.term.open(container);
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
    for (const listener of this.outputListeners.get(termId) ?? []) {
      try {
        listener(data);
      } catch {
        // an activity observer must never interrupt terminal rendering
      }
    }
    const entry = this.entries.get(termId);
    if (!entry) return;
    // Pushed through the filter in BOTH themes, so its held-back tail never
    // straddles a theme change and re-emerges in the wrong one; the filter
    // itself only rewrites anything when told the theme is light.
    if (entry.surfaces) data = entry.surfaces.push(data, !this.dark);
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

  /**
   * The colour actually painted behind this terminal, as an xterm OSC 11
   * reply (`rgb:RRRR/GGGG/BBBB`). The terminal's own background is
   * transparent (see themeFor), so this walks up from its container to the
   * first ancestor that paints something — the panel or editor surface
   * underneath — rather than reporting the transparent placeholder itself.
   */
  private effectiveBackgroundRgb(termId: string): string | null {
    const el = this.entries.get(termId)?.element;
    if (!el) return null;
    let node: HTMLElement | null = el;
    while (node) {
      const rgb = opaqueRgb(getComputedStyle(node).backgroundColor);
      if (rgb) return rgb;
      node = node.parentElement;
    }
    return opaqueRgb(getComputedStyle(document.body).backgroundColor);
  }

  setTheme(dark: boolean): void {
    const changed = this.dark !== dark;
    this.dark = dark;
    for (const entry of this.entries.values()) {
      entry.term.options.theme = this.themeFor(dark, entry.profile);
    }
    if (!changed) return;
    // Re-tinting only touches bytes on their way in, so a TUI's already
    // painted frame keeps the old theme's surfaces until it draws another
    // one. Nudging the size is what asks it to — the same redraw a real
    // terminal gets when its window changes.
    for (const [termId, entry] of this.entries) {
      if (entry.surfaces) this.nudgeRedraw(termId);
    }
  }

  setProfile(profile: TerminalProfileId): void {
    for (const entry of this.entries.values()) {
      if (!entry.profile) continue;
      entry.profile = profile;
      entry.term.options.theme = this.themeFor(this.dark, profile);
      entry.term.refresh(0, entry.term.rows - 1);
    }
  }

  /**
   * Make a full-screen TUI redraw itself, by reporting one column narrower
   * and then the real width again. There is no polite way to ask: the pty is
   * running somebody else's program, and a resize is the one signal every
   * one of them answers by repainting.
   */
  private nudgeRedraw(termId: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    const { cols, rows } = entry.term;
    if (cols < 2) return;
    void bridge
      .rpc("terminal.resize", { termId, cols: cols - 1, rows })
      .then(() => bridge.rpc("terminal.resize", { termId, cols, rows }))
      .catch(() => {});
  }

  focus(termId: string): void {
    this.entries.get(termId)?.term.focus();
  }

  /**
   * Insert text as a paste, same as Ctrl+V. Used for dropped file paths —
   * routing through `term.paste()` rather than a raw pty write is what wraps
   * it in bracketed-paste markers when the running program asked for them.
   */
  pasteText(termId: string, text: string): void {
    this.entries.get(termId)?.term.paste(text);
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
