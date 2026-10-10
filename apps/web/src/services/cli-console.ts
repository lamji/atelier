import { create } from "zustand";
import type { CliHistoryEntry, TerminalSession } from "@atelier/protocol";
import { conversationTitle } from "@atelier/shared";
import { PtyInputLines } from "@/lib/pty-input-lines";
import { bridge } from "./bridge-client.js";
import {
  beginSessionTracking,
  endSessionTracking,
  seedResumedSessionChanges,
} from "./session-changes.js";
import { terminalRegistry } from "./terminal-registry.js";
import { useSessionsStore } from "@/state/sessions.store";

type Platform = AtelierDesktopApi["platform"];

export interface CliProvider {
  id: string;
  label: string;
  /** Typed at the shell prompt to start the CLI, exactly as a user would. */
  command: string;
  /** The same CLI, reopened onto one of its own past sessions. */
  resume: (sessionId: string) => string;
  /**
   * The key the CLI reads as "paste the clipboard image", as the bytes a
   * terminal sends for it. Pressing Ctrl+V over an image sends this.
   */
  imagePasteKey: (platform: Platform | null) => string;
}

const CTRL_V = "\x16";
const ALT_V = "\x1bv";

/**
 * Providers that can back a CLI-mode session. The first entry remains the
 * automatic default when CLI mode opens with no existing sessions.
 */
export const CLI_PROVIDERS: readonly CliProvider[] = [
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    resume: (sessionId) => `codex resume ${sessionId}`,
    imagePasteKey: () => CTRL_V,
  },
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    resume: (sessionId) => `claude --resume ${sessionId}`,
    // Claude Code binds image paste to Alt+V on Windows, where Ctrl+V is the
    // terminal's own paste; everywhere else it is Ctrl+V.
    imagePasteKey: (platform) => (platform === "win32" ? ALT_V : CTRL_V),
  },
];

export const DEFAULT_CLI_PROVIDER = CLI_PROVIDERS[0]!;

export function cliProvider(id: string): CliProvider {
  return CLI_PROVIDERS.find((p) => p.id === id) ?? DEFAULT_CLI_PROVIDER;
}

/**
 * PTY naming: `cli:<provider>:<ordinal>`.
 *
 * The name is the only thing that outlives a reload — terminal.list() is how
 * the pane finds its sessions again — so it carries both the provider the
 * session belongs to and the number shown in the list.
 */
const CLI_PREFIX = "cli:";
/** The single console this mode shipped with, before sessions were plural. */
const LEGACY_NAME = "codex-cli";

/**
 * True for a pty that belongs to CLI mode. The bottom dock and the terminal
 * roster filter on this: a CLI session replaces the CHAT surface, so it must
 * never also show up as one of the dock's terminals.
 */
export function isCliConsoleSession(name: string): boolean {
  return name === LEGACY_NAME || name.startsWith(CLI_PREFIX);
}

function parseCliName(name: string): { providerId: string; ordinal: number } {
  if (name === LEGACY_NAME) return { providerId: "codex", ordinal: 1 };
  const [, providerId = "codex", raw] = name.split(":");
  const ordinal = Number(raw);
  return {
    providerId,
    ordinal: Number.isFinite(ordinal) && ordinal > 0 ? ordinal : 1,
  };
}

export interface CliSessionVm {
  termId: string;
  providerId: string;
  ordinal: number;
  /** Row label until the session has a topic, e.g. "Codex 2". */
  fallbackTitle: string;
  createdAt: number;
}

function toVm(session: TerminalSession): CliSessionVm {
  const { providerId, ordinal } = parseCliName(session.name);
  return {
    termId: session.id,
    providerId,
    ordinal,
    fallbackTitle: `${cliProvider(providerId).label} ${ordinal}`,
    createdAt: session.createdAt,
  };
}

/**
 * A CLI session's name, and where it came from.
 *
 * `manual` matters because the two sources must not fight: once the user has
 * named a session by hand, the topic watcher stops and a later prompt never
 * overwrites their name.
 */
export interface CliTitle {
  text: string;
  manual: boolean;
}

/**
 * Names live in localStorage, not in the pty.
 *
 * There is no terminal.rename RPC — the agent names a pty once, at create,
 * and that name encodes the provider and ordinal the list is built from. So
 * the topic is a renderer-side label, the same shape the terminal dock uses
 * for its renamed tabs. Keyed by term id, which is stable for as long as the
 * pty lives; that is what makes a name survive reloading the window.
 */
const TITLES_KEY = "atelier.cli.titles";
/** Oldest names are dropped past this many, so the key cannot grow forever. */
const MAX_REMEMBERED_TITLES = 100;

function readTitles(): Record<string, CliTitle> {
  try {
    const raw = localStorage.getItem(TITLES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, CliTitle>) : {};
  } catch {
    return {};
  }
}

function writeTitles(titles: Record<string, CliTitle>): Record<string, CliTitle> {
  const ids = Object.keys(titles);
  let kept = titles;
  if (ids.length > MAX_REMEMBERED_TITLES) {
    kept = {};
    for (const id of ids.slice(-MAX_REMEMBERED_TITLES)) kept[id] = titles[id]!;
  }
  try {
    localStorage.setItem(TITLES_KEY, JSON.stringify(kept));
  } catch {
    // storage full or blocked — the name still applies for this window
  }
  return kept;
}

/** The row label for a session: its topic if it has one, its ordinal if not. */
export function cliSessionTitle(
  session: CliSessionVm,
  titles: Record<string, CliTitle>
): string {
  return titles[session.termId]?.text ?? session.fallbackTitle;
}

function byOrdinal(a: CliSessionVm, b: CliSessionVm): number {
  return a.ordinal - b.ordinal;
}

/**
 * Which provider session each live pty is running, by term id.
 *
 * A pty is Atelier's handle; the session id is the CLI's own, the one its
 * `resume` command takes. Knowing the pairing is what stops a running
 * session from being listed twice — once as the live row, once as a row in
 * the provider's history — and it is how a row you resumed goes back to
 * being resumable after you close it. Stored beside the names, for the same
 * reason: term ids survive a reload, so this must too.
 */
const RESUMED_KEY = "atelier.cli.resumed";

function readResumed(): Record<string, string> {
  try {
    const raw = localStorage.getItem(RESUMED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeResumed(map: Record<string, string>): Record<string, string> {
  try {
    localStorage.setItem(RESUMED_KEY, JSON.stringify(map));
  } catch {
    // storage full or blocked — the pairing still holds for this window
  }
  return map;
}

/**
 * Which CLI pty each Agents chat is standing in for, by conversation id.
 *
 * The dock's Claude/Codex tiles open the provider CLI as a row in the SAME
 * Agents list as the chats, so the user has one list of sessions. The row
 * is a real (empty) conversation; this map is what makes selecting it show
 * the terminal instead of the transcript. Stored beside the names because
 * term ids survive a reload and the pairing has to as well.
 */
const CHATS_KEY = "atelier.cli.chats";

export interface CliChatBinding {
  termId: string;
  /**
   * Which provider the row runs, so the row can be reopened after its pty
   * has died (see {@link reviveCliChat}). null only for bindings written
   * before the provider was recorded; those fall back to the history.
   */
  providerId: string | null;
  /** The provider's resume ID, kept with the row even if the pty disappears. */
  sessionId?: string;
  /** When this pty opened; used to recover bindings made before it had an ID. */
  startedAt?: number;
}

function readChats(): Record<string, CliChatBinding> {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const chats: Record<string, CliChatBinding> = {};
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        chats[conversationId] = { termId: value, providerId: null };
      } else if (value && typeof value === "object" && "termId" in value) {
        chats[conversationId] = value as CliChatBinding;
      }
    }
    return chats;
  } catch {
    return {};
  }
}

function writeChats(
  map: Record<string, CliChatBinding>
): Record<string, CliChatBinding> {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(map));
  } catch {
    // storage full or blocked — the pairing still holds for this window
  }
  return map;
}

interface CliConsoleStore {
  /** Live CLI ptys, oldest ordinal first. */
  sessions: CliSessionVm[];
  selectedId: string | null;
  /**
   * Set once this workspace's CLI sessions have been listed. Quitting the
   * last session must leave an empty pane with a button, not an endless
   * respawn loop, so the auto-start only ever fires before this is true.
   */
  bootstrapped: boolean;
  /** Session names by term id — see {@link cliSessionTitle}. */
  titles: Record<string, CliTitle>;
  /**
   * Every session the providers recorded for this project, newest first —
   * including ones started outside Atelier. See {@link refreshCliHistory}.
   */
  history: CliHistoryEntry[];
  historyOffset: number;
  historyHasMore: boolean;
  /** Provider session id per live pty — see {@link RESUMED_KEY}. */
  resumed: Record<string, string>;
  /** The CLI each Agents chat stands in for — see {@link CHATS_KEY}. */
  chats: Record<string, CliChatBinding>;
  bindChat: (
    conversationId: string,
    termId: string,
    providerId: string
  ) => void;
  unbindChat: (conversationId: string) => void;
  /** True only while that CLI is executing, not merely while its pty exists. */
  processing: Record<string, boolean>;
  renameStatus: Record<string, { text: string; error: boolean }>;
  /** New sessions choose a provider; initial bootstrap still uses Codex. */
  providerPickerOpen: boolean;
  setSessions: (sessions: CliSessionVm[]) => void;
  add: (session: CliSessionVm) => void;
  select: (termId: string) => void;
  markClosed: (termId: string) => void;
  setHistoryPage: (history: CliHistoryEntry[], offset: number, hasMore: boolean) => void;
  bindSessionId: (termId: string, sessionId: string) => void;
  setProcessing: (termId: string, processing: boolean) => void;
  setBootstrapped: () => void;
  openProviderPicker: () => void;
  closeProviderPicker: () => void;
  reset: () => void;
}

export const useCliConsoleStore = create<CliConsoleStore>((set) => ({
  sessions: [],
  selectedId: null,
  bootstrapped: false,
  titles: readTitles(),
  history: [],
  historyOffset: 0,
  historyHasMore: true,
  resumed: readResumed(),
  chats: readChats(),
  processing: {},
  renameStatus: {},
  providerPickerOpen: false,

  bindChat: (conversationId, termId, providerId) =>
    set((s) => {
      const previous = s.chats[conversationId];
      const session = s.sessions.find((item) => item.termId === termId);
      return {
        chats: writeChats({
          ...s.chats,
          [conversationId]: {
            termId,
            providerId,
            sessionId: s.resumed[termId],
            startedAt: session?.createdAt ?? previous?.startedAt,
          },
        }),
      };
    }),

  unbindChat: (conversationId) =>
    set((s) => {
      if (!(conversationId in s.chats)) return {};
      const { [conversationId]: _dropped, ...rest } = s.chats;
      return { chats: writeChats(rest) };
    }),

  setSessions: (sessions) =>
    set((s) => {
      const sorted = [...sessions].sort(byOrdinal);
      return {
        sessions: sorted,
        selectedId:
          s.selectedId && sorted.some((x) => x.termId === s.selectedId)
            ? s.selectedId
            : (sorted[0]?.termId ?? null),
      };
    }),

  add: (session) =>
    set((s) => ({
      sessions: [...s.sessions, session].sort(byOrdinal),
      // A session you just created is the one you want to type into.
      selectedId: session.termId,
    })),

  select: (termId) => set({ selectedId: termId }),

  markClosed: (termId) =>
    set((s) => {
      unwatchTopic(termId);
      unwatchProcessing(termId);
      unwatchSessionSwitch(termId);
      unwatchRenameCommand(termId);
      endSessionTracking(termId);
      const sessions = s.sessions.filter((x) => x.termId !== termId);
      // Drop the name too, or a reused id would inherit a dead session's.
      const { [termId]: _gone, ...titles } = s.titles;
      // Keep the provider ID while an Agents row still points here: that row
      // uses it to reopen its context after a quit or provider switch.
      const resumed = { ...s.resumed };
      if (!Object.values(s.chats).some((chat) => chat.termId === termId)) {
        delete resumed[termId];
      }
      const processing = { ...s.processing };
      delete processing[termId];
      const renameStatus = { ...s.renameStatus };
      delete renameStatus[termId];
      return {
        sessions,
        titles: writeTitles(titles),
        resumed: writeResumed(resumed),
        processing,
        renameStatus,
        selectedId:
          s.selectedId === termId
            ? (sessions[0]?.termId ?? null)
            : s.selectedId,
      };
    }),

  setHistoryPage: (history, offset, hasMore) => set((state) => {
    const merged = new Map<string, CliHistoryEntry>();
    for (const entry of [...state.history, ...history]) {
      const key = `${entry.providerId}:${entry.id}`;
      const previous = merged.get(key);
      if (!previous || entry.updatedAt >= previous.updatedAt) merged.set(key, entry);
    }
    const nextOffset = offset + HISTORY_PAGE_SIZE;
    return {
      history: [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      historyOffset: Math.max(state.historyOffset, nextOffset),
      historyHasMore: nextOffset >= state.historyOffset ? hasMore : state.historyHasMore,
    };
  }),

  bindSessionId: (termId, sessionId) =>
    set((s) => {
      const chats = { ...s.chats };
      for (const [conversationId, binding] of Object.entries(chats)) {
        if (binding.termId === termId) chats[conversationId] = { ...binding, sessionId };
      }
      return {
        resumed: writeResumed({ ...s.resumed, [termId]: sessionId }),
        chats: writeChats(chats),
      };
    }),

  setProcessing: (termId, processing) =>
    set((s) => ({ processing: { ...s.processing, [termId]: processing } })),

  setBootstrapped: () => set({ bootstrapped: true }),

  openProviderPicker: () => set({ providerPickerOpen: true }),

  closeProviderPicker: () => set({ providerPickerOpen: false }),

  reset: () => {
    historyEpoch += 1;
    pendingHistoryPages.clear();
    for (const termId of [...watchers.keys()]) unwatchTopic(termId);
    for (const termId of [...processingWatchers.keys()]) unwatchProcessing(termId);
    for (const termId of [...sessionSwitchWatchers.keys()]) unwatchSessionSwitch(termId);
    for (const termId of [...renameCommandWatchers.keys()]) unwatchRenameCommand(termId);
    // Names and pty→session pairings are NOT cleared: the ptys of the
    // project being left keep running, and coming back to it must find
    // them still named. History is, because it is per-project.
    set({
      sessions: [],
      selectedId: null,
      history: [],
      historyOffset: 0,
      historyHasMore: true,
      processing: {},
      renameStatus: {},
      bootstrapped: false,
      providerPickerOpen: false,
    });
  },
}));

/**
 * Live topic watchers, by term id. A session has at most one, and it is
 * dropped the moment the session has a name — the pane only needs the first
 * thing asked, so listening past that is pure overhead.
 */
const watchers = new Map<string, () => void>();
const sessionSwitchWatchers = new Map<string, () => void>();
const renameCommandWatchers = new Map<string, () => void>();
const renamingCli = new Set<string>();

function setRenameStatus(termId: string, text: string, error = false): void {
  const status = { text, error };
  useCliConsoleStore.setState((state) => ({
    renameStatus: { ...state.renameStatus, [termId]: status },
  }));
  setTimeout(() => {
    useCliConsoleStore.setState((state) => {
      if (state.renameStatus[termId] !== status) return state;
      const { [termId]: _expired, ...renameStatus } = state.renameStatus;
      return { renameStatus };
    });
  }, 5000);
}

async function autoRenameCliSession(termId: string, providerId: string): Promise<void> {
  if (renamingCli.has(termId)) return;
  renamingCli.add(termId);
  setRenameStatus(termId, "Naming session from its context…");
  try {
    let sessionId = useCliConsoleStore.getState().resumed[termId];
    for (let attempt = 0; !sessionId && attempt < 24; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      sessionId = useCliConsoleStore.getState().resumed[termId];
    }
    if (!sessionId) throw new Error("The provider session is not ready yet. Try /rename again shortly.");
    const { title } = await bridge.rpc("cli.title.autoRename", { providerId, sessionId });
    renameCliSession(termId, title);
    useCliConsoleStore.setState((state) => ({
      history: state.history.map((entry) =>
        entry.providerId === providerId && entry.id === sessionId ? { ...entry, title } : entry
      ),
    }));
    const binding = Object.entries(useCliConsoleStore.getState().chats)
      .find(([, chat]) => chat.termId === termId);
    if (binding && useSessionsStore.getState().sessions[binding[0]]) {
      const conversationId = binding[0];
      const previous = useSessionsStore.getState().sessions[conversationId]!.conversation.title;
      useSessionsStore.getState().renameSession(conversationId, title);
      try {
        await bridge.rpc("session.renameConversation", { conversationId, title });
      } catch (error) {
        useSessionsStore.getState().renameSession(conversationId, previous);
        throw error;
      }
    }
    setRenameStatus(termId, `Renamed to ${title}`);
  } catch (error) {
    setRenameStatus(termId, error instanceof Error ? error.message : String(error), true);
  } finally {
    renamingCli.delete(termId);
  }
}

/** Consume /rename at submit, clearing the CLI composer without sending Enter. */
function watchRenameCommand(termId: string, providerId: string): void {
  if (renameCommandWatchers.has(termId)) return;
  const lines = new PtyInputLines();
  renameCommandWatchers.set(termId, terminalRegistry.interceptInput(termId, (data) => {
    if (lines.push(data).some((line) => line.toLowerCase() === "/rename")) {
      void autoRenameCliSession(termId, providerId);
      return "\x15";
    }
    return data;
  }));
}

function unwatchRenameCommand(termId: string): void {
  renameCommandWatchers.get(termId)?.();
  renameCommandWatchers.delete(termId);
  renamingCli.delete(termId);
}

interface ProcessingWatcher {
  stop: () => void;
  startedAt: number;
  sawCursorHidden: boolean;
}

const processingWatchers = new Map<string, ProcessingWatcher>();
const CURSOR_VISIBILITY = /\x1b\[\?25([hl])/g;

function setProcessing(termId: string, processing: boolean): void {
  useCliConsoleStore.getState().setProcessing(termId, processing);
}

function beginProcessing(termId: string): void {
  const watcher = processingWatchers.get(termId);
  if (watcher) {
    watcher.startedAt = Date.now();
    watcher.sawCursorHidden = false;
  }
  setProcessing(termId, true);
}

function unwatchProcessing(termId: string): void {
  processingWatchers.get(termId)?.stop();
  processingWatchers.delete(termId);
}

/**
 * A submitted line starts work. Both provider TUIs hide the cursor while
 * executing and restore it when their composer is ready again; that final
 * hidden -> visible transition ends the spinner.
 */
function watchCliProcessing(termId: string): void {
  if (processingWatchers.has(termId)) return;
  const lines = new PtyInputLines();
  const watcher: ProcessingWatcher = {
    startedAt: 0,
    sawCursorHidden: false,
    stop: () => {},
  };
  const offInput = terminalRegistry.onInput(termId, (data) => {
    if (lines.push(data).length > 0) beginProcessing(termId);
  });
  const offOutput = terminalRegistry.onOutput(termId, (data) => {
    CURSOR_VISIBILITY.lastIndex = 0;
    for (let match = CURSOR_VISIBILITY.exec(data); match; match = CURSOR_VISIBILITY.exec(data)) {
      if (!useCliConsoleStore.getState().processing[termId]) continue;
      if (match[1] === "l") {
        watcher.sawCursorHidden = true;
      } else if (watcher.sawCursorHidden && Date.now() - watcher.startedAt >= 75) {
        setProcessing(termId, false);
      }
    }
  });
  watcher.stop = () => {
    offInput();
    offOutput();
  };
  processingWatchers.set(termId, watcher);
}

function unwatchTopic(termId: string): void {
  watchers.get(termId)?.();
  watchers.delete(termId);
}

/** A provider's /new or /clear keeps the PTY but changes its resume ID. */
function watchSessionSwitch(termId: string, providerId: string, startedAt: number): void {
  if (sessionSwitchWatchers.has(termId)) return;
  const lines = new PtyInputLines();
  let pendingSwitch: { previousId?: string; startedAt: number } | null = null;
  let claiming = false;
  const tryClaim = () => {
    if (!pendingSwitch || claiming) return;
    claiming = true;
    const switchToClaim = pendingSwitch;
    const { previousId, startedAt } = switchToClaim;
    void claimSessionId(termId, providerId, startedAt, previousId).finally(() => {
      claiming = false;
      if (pendingSwitch === switchToClaim &&
          useCliConsoleStore.getState().resumed[termId] !== previousId) {
        pendingSwitch = null;
      }
      if (pendingSwitch && pendingSwitch !== switchToClaim) tryClaim();
    });
  };
  const off = terminalRegistry.onInput(termId, (data) => {
    for (const line of lines.push(data)) {
      if (/^\/(?:new|clear|reset)(?:\s|$)/i.test(line)) {
        pendingSwitch = {
          previousId: useCliConsoleStore.getState().resumed[termId],
          startedAt: Date.now(),
        };
        unwatchTopic(termId);
        useCliConsoleStore.setState((state) => {
          const titles = { ...state.titles };
          delete titles[termId];
          const renameStatus = { ...state.renameStatus };
          delete renameStatus[termId];
          return { titles: writeTitles(titles), renameStatus };
        });
        watchCliTopic(termId);
      } else if (!useCliConsoleStore.getState().resumed[termId] &&
                 line.trim() && !line.trim().startsWith("/")) {
        // Some CLIs do not write a transcript until the first prompt. The
        // initial timed claim may have expired while the user was thinking.
        void claimSessionId(termId, providerId, startedAt);
      }
      tryClaim();
    }
  });
  sessionSwitchWatchers.set(termId, off);
}

function unwatchSessionSwitch(termId: string): void {
  sessionSwitchWatchers.get(termId)?.();
  sessionSwitchWatchers.delete(termId);
}

/** Too short to be a topic — an approval keypress, a "y", a stray Enter. */
const MIN_TOPIC_CHARS = 3;

/**
 * True for a submitted line that says what the session is about.
 *
 * A bare slash command (`/model`, `/init`, `/status`) is how you drive the
 * CLI, not what you came to it for, so it is skipped and the next line gets
 * the chance. `/review my changes` is kept — it carries a subject.
 */
function isTopicLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < MIN_TOPIC_CHARS) return false;
  return !/^\/\S*$/.test(trimmed);
}

/**
 * Name a session after the first real thing asked in it.
 *
 * The CLI is somebody else's program in a pty: it has no API to ask, and its
 * output is a redrawing TUI that cannot be scraped for meaning. What it does
 * have is the user's own words on the way in, and the first prompt is what
 * the session is about — the same rule Atelier's own chats are named by, via
 * the same {@link conversationTitle}. No provider hook, no config file, and
 * nothing to keep in step when Codex changes its screen.
 *
 * Idempotent, and a no-op for a session that already has a name, so it is
 * safe to call for every session on every re-list.
 */
export function watchCliTopic(termId: string): void {
  if (watchers.has(termId)) return;
  if (useCliConsoleStore.getState().titles[termId]) return;
  const lines = new PtyInputLines();
  const off = terminalRegistry.onInput(termId, (data) => {
    for (const line of lines.push(data)) {
      if (!isTopicLine(line)) continue;
      setCliTitle(termId, conversationTitle(line), false);
      return;
    }
  });
  watchers.set(termId, off);
}

/**
 * Rename a session by hand. Wins over the topic permanently: the watcher is
 * dropped, so a name typed here is never overwritten by a later prompt.
 */
export function renameCliSession(termId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  setCliTitle(termId, conversationTitle(trimmed), true);
}

function setCliTitle(termId: string, text: string, manual: boolean): void {
  unwatchTopic(termId);
  useCliConsoleStore.setState((s) => {
    if (!manual && s.titles[termId]?.manual) return s;
    return { titles: writeTitles({ ...s.titles, [termId]: { text, manual } }) };
  });
}

/** In-flight acquisition; cleared on settle so a retry re-lists honestly. */
let pending: Promise<void> | null = null;

/**
 * Adopt this workspace's already-running CLI sessions.
 *
 * Reuse-first: toggling CLI mode off and on, switching tabs, or reloading
 * the window reattaches to the live ptys — scrollback and the running CLI
 * processes intact — rather than stacking up new ones. An empty workspace
 * stays empty until the user explicitly chooses New CLI session.
 */
export function ensureCliSessions(): Promise<void> {
  pending ??= (async () => {
    const { sessions } = await bridge.rpc("terminal.list", {});
    const live = sessions.filter((s) => isCliConsoleSession(s.name)).map(toVm);
    const store = useCliConsoleStore.getState();
    store.setSessions(live);
    store.setBootstrapped();
    // A session adopted after a reload may still be unnamed — the user can
    // have opened it and not typed yet — so every one gets a watcher, and
    // the already-named ones decline it. Same for change tracking: a
    // reloaded session already has a baseline stored and keeps it, so only
    // a session that has never had one pins itself here.
    for (const session of live) {
      watchCliTopic(session.termId);
      watchCliProcessing(session.termId);
      watchSessionSwitch(session.termId, session.providerId, session.createdAt);
      watchRenameCommand(session.termId, session.providerId);
      void beginSessionTracking(session.termId);
    }
    // The rest of this project's sessions — the ones the providers recorded,
    // including any started outside Atelier — are listed alongside the live
    // ones, so the list matches what the CLI's own resume screen offers.
    void refreshCliHistory();
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** The lowest unused ordinal for a provider, so numbering closes its gaps. */
function nextOrdinal(providerId: string): number {
  const taken = new Set(
    useCliConsoleStore
      .getState()
      .sessions.filter((s) => s.providerId === providerId)
      .map((s) => s.ordinal)
  );
  let n = 1;
  while (taken.has(n)) n += 1;
  return n;
}

/**
 * Run one command in a fresh pty and adopt it as a CLI session.
 *
 * The CLI is launched exactly as a user would from a prompt — its own default
 * flow, with none of Atelier's pipeline attached. The shell buffers input
 * written before its prompt is up, so the command is safe to send straight
 * after create.
 */
async function spawnCliSession(
  provider: CliProvider,
  command: string
): Promise<string> {
  const ordinal = nextOrdinal(provider.id);
  const { session } = await bridge.rpc("terminal.create", {
    name: `${CLI_PREFIX}${provider.id}:${ordinal}`,
  });
  useCliConsoleStore.getState().add(toVm(session));
  watchCliProcessing(session.id);
  watchSessionSwitch(session.id, provider.id, session.createdAt);
  watchRenameCommand(session.id, provider.id);
  beginProcessing(session.id);
  await bridge.rpc("terminal.write", {
    termId: session.id,
    data: `${command}\r`,
  });
  // Pin the rail to the tree as it is right now: whatever was already dirty
  // when this session opened is not this session's work.
  void beginSessionTracking(session.id);
  return session.id;
}

const pendingCreates = new Map<string, Promise<string>>();

/** Start a fresh CLI session for the chosen provider. */
export async function createCliSession(
  providerId: string = DEFAULT_CLI_PROVIDER.id
): Promise<string> {
  const provider = cliProvider(providerId);
  const pendingCreate = pendingCreates.get(provider.id);
  if (pendingCreate) return pendingCreate;
  const creating = (async () => {
    const startedAt = Date.now();
    const termId = await spawnCliSession(provider, provider.command);
    watchCliTopic(termId);
    void claimSessionId(termId, provider.id, startedAt);
    return termId;
  })();
  pendingCreates.set(provider.id, creating);
  try {
    return await creating;
  } finally {
    pendingCreates.delete(provider.id);
  }
}

/**
 * Reopen one of the provider's own past sessions, in a new pty.
 *
 * This is the CLI's `resume` command and nothing more — the provider
 * reloads its transcript itself, so the session comes back with its full
 * context, exactly as picking it from the CLI's own resume screen would.
 */
export async function resumeCliSession(
  entry: CliHistoryEntry
): Promise<string> {
  // Already running: select that pty instead of resuming the same provider
  // session twice.
  const open = useCliConsoleStore.getState();
  const live = open.sessions.find(
    (s) => s.providerId === entry.providerId && open.resumed[s.termId] === entry.id
  );
  if (live) {
    open.select(live.termId);
    return live.termId;
  }
  const provider = cliProvider(entry.providerId);
  try {
    await seedResumedSessionChanges(provider.id, entry.id);
  } catch {
    // Review persistence is additive; it must never prevent native resume.
  }
  const termId = await spawnCliSession(provider, provider.resume(entry.id));
  useCliConsoleStore.getState().bindSessionId(termId, entry.id);
  if (entry.title) {
    // Pinned, not watched: a resumed session already knows what it is
    // about, and the next thing asked in it must not rename it.
    setCliTitle(termId, conversationTitle(entry.title), true);
  } else {
    watchCliTopic(termId);
  }
  void refreshCliHistory();
  return termId;
}

/**
 * Bring an Agents CLI row back after its pty has died — the agent was
 * restarted, or the CLI was quit — by reopening the provider session it
 * was running in a new pty, the provider's own `resume`, and binding the
 * row to that. The transcript comes back because the provider reloads it.
 *
 * Resolves to the term id now showing, or null when no native resume ID can
 * be identified safely. The caller then lets the user choose from history.
 */
export async function reviveCliChat(
  conversationId: string,
  conversationCreatedAt?: number
): Promise<string | null> {
  const state = useCliConsoleStore.getState();
  const binding = state.chats[conversationId];
  if (!binding) return null;
  if (state.sessions.some((s) => s.termId === binding.termId)) {
    state.select(binding.termId);
    return binding.termId;
  }
  let sessionId = binding.sessionId ?? state.resumed[binding.termId];
  // A stored native ID is sufficient for the provider's resume command.
  // Avoid making a full history scan a prerequisite for every app restart.
  const entries = sessionId && binding.providerId
    ? state.history
    : await refreshCliHistory();
  // Older bindings can predate the first provider transcript. Recover only
  // when exactly one unclaimed transcript started near that row's creation.
  if (!sessionId && binding.providerId) {
    const latest = useCliConsoleStore.getState();
    const startedAt = binding.startedAt ?? conversationCreatedAt;
    if (startedAt) {
      const claimed = new Set(Object.entries(latest.chats)
        .filter(([id]) => id !== conversationId)
        .map(([, chat]) => chat.sessionId ?? latest.resumed[chat.termId])
        .filter((id): id is string => Boolean(id)));
      const matches = entries.filter((entry) =>
        entry.providerId === binding.providerId &&
        !claimed.has(entry.id) &&
        Math.abs(entry.startedAt - startedAt) <= 30_000
      );
      if (matches.length === 1) sessionId = matches[0]!.id;
    }
  }
  if (!sessionId) return null;
  const found = entries.find((entry) =>
    entry.id === sessionId &&
    (!binding.providerId || entry.providerId === binding.providerId)
  );
  const providerId = found?.providerId ?? binding.providerId;
  if (!providerId) return null;
  const entry: CliHistoryEntry = found ?? {
    id: sessionId,
    providerId,
    title: "",
    startedAt: 0,
    updatedAt: 0,
    cwd: "",
  };
  const termId = await resumeCliSession(entry);
  useCliConsoleStore.getState().bindChat(conversationId, termId, providerId);
  return termId;
}

/** Rows kept per provider — the resume picker's own order, newest first. */
const HISTORY_PAGE_SIZE = 30;
const HISTORY_REQUEST_TIMEOUT_MS = 15_000;
const pendingHistoryPages = new Map<number, Promise<CliHistoryEntry[]>>();
let historyEpoch = 0;

async function fetchCliHistoryPage(offset: number): Promise<CliHistoryEntry[]> {
  const pending = pendingHistoryPages.get(offset);
  if (pending) return pending;
  const epoch = historyEpoch;
  const request = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { entries, hasMore } = await Promise.race([
        bridge.rpc("cli.history", { offset, limit: HISTORY_PAGE_SIZE }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("CLI history took too long. Try again.")), HISTORY_REQUEST_TIMEOUT_MS);
        }),
      ]);
      if (epoch !== historyEpoch) return useCliConsoleStore.getState().history;
      useCliConsoleStore.getState().setHistoryPage(entries, offset, hasMore);
      return useCliConsoleStore.getState().history;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })().finally(() => {
    if (pendingHistoryPages.get(offset) === request) pendingHistoryPages.delete(offset);
  });
  pendingHistoryPages.set(offset, request);
  return request;
}

/**
 * Re-read the providers' session history.
 *
 * Best-effort by design: an agent without the method, a provider that has
 * never run here, or a home directory that cannot be read all mean "no rows
 * to add", never a broken session list.
 */
export async function refreshCliHistory(): Promise<CliHistoryEntry[]> {
  try {
    return await fetchCliHistoryPage(0);
  } catch {
    return useCliConsoleStore.getState().history;
  }
}

/** First page with errors visible to the history picker. */
export function loadFirstCliHistory(): Promise<CliHistoryEntry[]> {
  return fetchCliHistoryPage(0);
}

/** Fetch the next provider transcript batch for the history list. */
export async function loadMoreCliHistory(): Promise<CliHistoryEntry[]> {
  const state = useCliConsoleStore.getState();
  if (!state.historyHasMore) return state.history;
  return fetchCliHistoryPage(state.historyOffset);
}

/** Clock slack between the transcript's own timestamp and ours. */
const CLAIM_SKEW_MS = 5000;

/**
 * The recorded sessions that live ptys are already running.
 *
 * The same rule {@link claimSessionId} uses, but DERIVED on every read
 * instead of raced once: a pty whose claim has not landed yet — or never
 * will, because a reset cut it short — still keeps its own session out of
 * the resumable rows. Without this, a running Codex is listed twice, and
 * the copy under "Recent" is a trap: clicking it starts a second pty for a
 * session that is already open.
 *
 * Each pty covers at most ONE entry, oldest pty taking the oldest entry
 * that started after it, so a session genuinely started elsewhere after the
 * pty is still offered rather than silently swallowed.
 */
function coveredByLive(
  history: CliHistoryEntry[],
  sessions: CliSessionVm[],
  claimed: Set<string>
): Set<string> {
  const covered = new Set<string>();
  for (const session of [...sessions].sort((a, b) => a.createdAt - b.createdAt)) {
    const match = history
      .filter(
        (entry) =>
          entry.providerId === session.providerId &&
          !claimed.has(entry.id) &&
          !covered.has(entry.id) &&
          entry.startedAt >= session.createdAt - CLAIM_SKEW_MS
      )
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (match) covered.add(match.id);
  }
  return covered;
}

/** A provider's past sessions that are not already open in a live pty. */
export function resumableCliHistory(
  history: CliHistoryEntry[],
  resumed: Record<string, string>,
  providerId: string,
  sessions: CliSessionVm[]
): CliHistoryEntry[] {
  const claimed = new Set(
    sessions.map((session) => resumed[session.termId]).filter((id): id is string => Boolean(id))
  );
  const covered = coveredByLive(history, sessions, claimed);
  return history.filter(
    (entry) =>
      entry.providerId === providerId &&
      !claimed.has(entry.id) &&
      !covered.has(entry.id)
  );
}

/** How long to keep looking for the session a new pty just started. */
const CLAIM_DELAYS_MS = [1500, 3000, 6000, 12000];

/**
 * Work out which provider session a freshly started pty became.
 *
 * The CLI is not ours to ask — but it writes its transcript the moment it
 * starts, so the newest session that appeared after this pty did, and that
 * no other pty has claimed, is this one. Without this, a session started
 * here would show up twice the moment it was recorded: once as the live row
 * and once as a resumable one.
 */
async function claimSessionId(
  termId: string,
  providerId: string,
  startedAt: number,
  previousId?: string
): Promise<void> {
  for (const delay of CLAIM_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const state = useCliConsoleStore.getState();
    // Already paired by a later refresh — nothing left to do.
    if (state.resumed[termId] && state.resumed[termId] !== previousId) return;
    // Closed. Guarded on `bootstrapped`, because reset() empties the list
    // WITHOUT the pty going anywhere: reading that as "closed" is what
    // abandoned the claim for good, leaving a running session listed as
    // resumable for the rest of its life.
    if (state.bootstrapped && !state.sessions.some((s) => s.termId === termId)) {
      return;
    }
    const entries = await refreshCliHistory();
    const current = useCliConsoleStore.getState();
    const claimed = new Set(
      current.sessions
        .filter((session) => session.termId !== termId)
        .map((session) => current.resumed[session.termId])
        .filter((id): id is string => Boolean(id))
    );
    const match = entries
      .filter(
        (entry) =>
          entry.providerId === providerId &&
          entry.id !== previousId &&
          !claimed.has(entry.id) &&
          entry.startedAt >= startedAt - CLAIM_SKEW_MS
      )
      // Oldest first: two sessions opened back to back each take the one
      // that started nearest to them, rather than both taking the newest.
      .sort((a, b) => a.startedAt - b.startedAt);
    if (match[0]) {
      useCliConsoleStore.getState().bindSessionId(termId, match[0].id);
      return;
    }
  }
}

/**
 * Kill a CLI session. The row goes now rather than on the close event, so a
 * pty that is already gone still leaves the list.
 */
export async function closeCliSession(termId: string): Promise<void> {
  try {
    await bridge.rpc("terminal.kill", { termId });
  } finally {
    useCliConsoleStore.getState().markClosed(termId);
    // It is a past session again now, so it belongs in the resumable rows.
    void refreshCliHistory();
  }
}
