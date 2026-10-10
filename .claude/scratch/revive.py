ROOT = r"C:\Users\akrizu\atelier\apps\web\src"


def patch(path, pairs):
    full = ROOT + "\\" + path
    s = open(full, encoding="utf-8").read()
    for old, new in pairs:
        assert old in s, "missing in " + path + ":\n" + old[:200]
        s = s.replace(old, new, 1)
    open(full, "w", encoding="utf-8", newline="\n").write(s)


patch("services\\cli-console.ts", [
    (
        """const CHATS_KEY = "atelier.cli.chats";

function readChats(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeChats(map: Record<string, string>): Record<string, string> {""",
        """const CHATS_KEY = "atelier.cli.chats";

export interface CliChatBinding {
  termId: string;
  /**
   * Which provider the row runs, so the row can be reopened after its pty
   * has died (see {@link reviveCliChat}). null only for bindings written
   * before the provider was recorded; those fall back to the history.
   */
  providerId: string | null;
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
): Record<string, CliChatBinding> {""",
    ),
    (
        """  /** Term id per Agents chat that stands in for a CLI — see {@link CHATS_KEY}. */
  chats: Record<string, string>;
  bindChat: (conversationId: string, termId: string) => void;""",
        """  /** The CLI each Agents chat stands in for — see {@link CHATS_KEY}. */
  chats: Record<string, CliChatBinding>;
  bindChat: (
    conversationId: string,
    termId: string,
    providerId: string
  ) => void;""",
    ),
    (
        """  bindChat: (conversationId, termId) =>
    set((s) => ({
      chats: writeChats({ ...s.chats, [conversationId]: termId }),
    })),""",
        """  bindChat: (conversationId, termId, providerId) =>
    set((s) => ({
      chats: writeChats({
        ...s.chats,
        [conversationId]: { termId, providerId },
      }),
    })),""",
    ),
    (
        """export async function resumeCliSession(entry: CliHistoryEntry): Promise<void> {
  // Already running: select it instead of starting a second pty on the same
  // session. Resuming a session that is open is how one Codex ends up
  // twice in the list — and the second copy is the one whose `resume` finds
  // nothing to reopen and drops the user on the CLI's own session picker.
  const open = useCliConsoleStore.getState();
  const live = open.sessions.find((s) => open.resumed[s.termId] === entry.id);
  if (live) {
    open.select(live.termId);
    return;
  }""",
        """export async function resumeCliSession(
  entry: CliHistoryEntry
): Promise<string> {
  // Already running: select it instead of starting a second pty on the same
  // session. Resuming a session that is open is how one Codex ends up
  // twice in the list — and the second copy is the one whose `resume` finds
  // nothing to reopen and drops the user on the CLI's own session picker.
  const open = useCliConsoleStore.getState();
  const live = open.sessions.find((s) => open.resumed[s.termId] === entry.id);
  if (live) {
    open.select(live.termId);
    return live.termId;
  }""",
    ),
    (
        """  void refreshCliHistory();
}

/** Rows kept per provider — the resume picker's own order, newest first. */""",
        """  void refreshCliHistory();
  return termId;
}

/**
 * Bring an Agents CLI row back after its pty has died — the agent was
 * restarted, or the CLI was quit — by reopening the provider session it
 * was running in a new pty, the provider's own `resume`, and binding the
 * row to that. The transcript comes back because the provider reloads it.
 *
 * Resolves to the term id now showing, or null when there is nothing to
 * reopen: the pty never got paired with a provider session (it died before
 * the CLI had written one), or the history no longer lists it.
 */
export async function reviveCliChat(
  conversationId: string
): Promise<string | null> {
  const state = useCliConsoleStore.getState();
  const binding = state.chats[conversationId];
  if (!binding) return null;
  if (state.sessions.some((s) => s.termId === binding.termId)) {
    state.select(binding.termId);
    return binding.termId;
  }
  const sessionId = state.resumed[binding.termId];
  if (!sessionId) return null;
  const entries = await refreshCliHistory();
  const found = entries.find((entry) => entry.id === sessionId);
  const providerId = found?.providerId ?? binding.providerId;
  if (!providerId) return null;
  const entry: CliHistoryEntry = found ?? {
    id: sessionId,
    providerId,
    startedAt: 0,
    title: null,
  };
  const termId = await resumeCliSession(entry);
  useCliConsoleStore.getState().bindChat(conversationId, termId, providerId);
  return termId;
}

/** Rows kept per provider — the resume picker's own order, newest first. */""",
    ),
])

patch("views\\shell\\AppShell.tsx", [
    (
        """  ensureCliSessions,
  useCliConsoleStore,
} from "@/services/cli-console";""",
        """  ensureCliSessions,
  reviveCliChat,
  useCliConsoleStore,
} from "@/services/cli-console";""",
    ),
    (
        """  const boundTermId =
    sessions.selectedId !== null
      ? (cliChats[sessions.selectedId] ?? null)
      : null;""",
        """  const boundTermId =
    sessions.selectedId !== null
      ? (cliChats[sessions.selectedId]?.termId ?? null)
      : null;""",
    ),
    (
        """  const cliBootstrapped = useCliConsoleStore((s) => s.bootstrapped);
  const boundCliPending = boundTermId !== null && !cliBootstrapped;
  const showCliConsole = cliMode || boundCliLive || boundCliPending;
  useEffect(() => {
    if (cliMode || !boundCliLive || boundTermId === null) return;
    useCliConsoleStore.getState().select(boundTermId);
  }, [boundCliLive, boundTermId, cliMode]);
""",
        """  const cliBootstrapped = useCliConsoleStore((s) => s.bootstrapped);
  // A bound row whose pty is gone (the agent restarted, the CLI was quit)
  // is reopened on the provider's own session once, so the user lands
  // back in that session's transcript rather than on an empty chat. Tried
  // once per pty: a session that cannot be reopened becomes a chat.
  const [revivingId, setRevivingId] = useState<string | null>(null);
  const revived = useRef(new Set<string>());
  useEffect(() => {
    if (cliMode || !cliBootstrapped || boundCliLive) return;
    if (boundTermId === null || sessions.selectedId === null) return;
    const conversationId = sessions.selectedId;
    if (revived.current.has(boundTermId)) return;
    revived.current.add(boundTermId);
    setRevivingId(conversationId);
    void reviveCliChat(conversationId)
      .catch(() => null)
      .finally(() =>
        setRevivingId((id) => (id === conversationId ? null : id))
      );
  }, [boundCliLive, boundTermId, cliBootstrapped, cliMode, sessions.selectedId]);
  const boundCliPending =
    boundTermId !== null &&
    (!cliBootstrapped || revivingId === sessions.selectedId);
  const showCliConsole = cliMode || boundCliLive || boundCliPending;
  useEffect(() => {
    if (cliMode || !boundCliLive || boundTermId === null) return;
    useCliConsoleStore.getState().select(boundTermId);
  }, [boundCliLive, boundTermId, cliMode]);
""",
    ),
    (
        """      const termId = useCliConsoleStore.getState().chats[conversationId];
      if (termId) {
        useCliConsoleStore.getState().unbindChat(conversationId);
        await closeCliSession(termId).catch(() => undefined);
      }""",
        """      const binding = useCliConsoleStore.getState().chats[conversationId];
      if (binding) {
        useCliConsoleStore.getState().unbindChat(conversationId);
        await closeCliSession(binding.termId).catch(() => undefined);
      }""",
    ),
    (
        """          const termId = await createCliSession(providerId);
          useCliConsoleStore.getState().bindChat(conversationId, termId);""",
        """          const termId = await createCliSession(providerId);
          useCliConsoleStore
            .getState()
            .bindChat(conversationId, termId, providerId);""",
    ),
    (
        """import { useCallback, useEffect, useMemo, useState } from "react";""",
        """import { useCallback, useEffect, useMemo, useRef, useState } from "react";""",
    ),
])
print("ok")
