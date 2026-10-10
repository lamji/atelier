import re

PATH = r"C:\Users\akrizu\atelier\apps\web\src\views\shell\AppShell.tsx"

s = open(PATH, encoding="utf-8").read()


def lit(old, new):
    global s
    assert old in s, "missing:\n" + old[:200]
    s = s.replace(old, new, 1)


def rx(pattern, new):
    global s
    m = re.search(pattern, s, re.S)
    assert m, "regex missing: " + pattern[:80]
    s = s[: m.start()] + new + s[m.end() :]


lit(
    """import {
  createCliSession,
  ensureCliSessions,
  useCliConsoleStore,
} from "@/services/cli-console";""",
    """import {
  cliProvider,
  closeCliSession,
  createCliSession,
  ensureCliSessions,
  useCliConsoleStore,
} from "@/services/cli-console";""",
)

lit(
    """  const selectedCliId = useCliConsoleStore((s) => s.selectedId);""",
    """  const selectedCliId = useCliConsoleStore((s) => s.selectedId);
  const cliChats = useCliConsoleStore((s) => s.chats);""",
)

rx(
    r"  /\*\*\n   \* Provider picked from the dock's Claude/Codex tiles\..*?"
    r"  >\(null\);\n",
    "",
)

rx(
    r"        // Picking or creating a chat while a dock provider console is\n"
    r".*?onDelete=\{\(id\) => void sessions\.deleteSession\(id\)\}",
    """        <SessionListPanel
          sessions={sessions.sessionList}
          selectedId={sessions.selectedId}
          onSelect={sessions.selectSession}
          onCreate={() => void sessions.createSession()}
          onRename={sessions.renameSession}
          onDelete={(id) => void deleteAgentSession(id)}""",
)

rx(
    r"  // CLI mode swaps the WHOLE chat surface.*?"
    r"  const showCliConsole = cliMode \|\| dockCliProvider !== null;\n",
    """  // CLI mode swaps the WHOLE chat surface — transcript and composer — for
  // the selected provider CLI. Everything around it (sessions list, editor,
  // terminals, git) stays exactly as it is. Outside the mode the same swap
  // happens for one row at a time: an Agents chat that a dock provider
  // tile created stands in for a CLI pty (cli-console `chats`), and while
  // that row is selected — and its pty still runs — the box is that
  // terminal. Any other row is a chat as usual.
  const boundTermId =
    sessions.selectedId !== null
      ? (cliChats[sessions.selectedId] ?? null)
      : null;
  const boundCliLive =
    boundTermId !== null &&
    cliSessions.some((session) => session.termId === boundTermId);
  const showCliConsole = cliMode || boundCliLive;
  useEffect(() => {
    if (cliMode || !boundCliLive || boundTermId === null) return;
    useCliConsoleStore.getState().select(boundTermId);
  }, [boundCliLive, boundTermId, cliMode]);

  // A CLI row's pty goes with the row: deleting the chat kills the CLI.
  const deleteAgentSession = useCallback(
    async (conversationId: string) => {
      const termId = useCliConsoleStore.getState().chats[conversationId];
      if (termId) {
        useCliConsoleStore.getState().unbindChat(conversationId);
        await closeCliSession(termId).catch(() => undefined);
      }
      await sessions.deleteSession(conversationId);
    },
    [sessions]
  );
""",
)

lit(
    """        setAgentSurface("agent");
        setDockCliProvider(null);
        setActiveView("agents");""",
    """        setAgentSurface("agent");
        setActiveView("agents");""",
)

rx(
    r"  // Provider CLI tiles swap the chat box.*?"
    r"      setActiveView,\n    \]\n  \);\n",
    """  // Provider CLI tiles open that provider's real terminal as a NEW session
  // in the shared Agents list, every click: a fresh conversation row named
  // after the provider, bound to a fresh pty. Agent mode stays on screen —
  // same session rail, same preview and editor tabs — which is what makes
  // this different from the CLI mode preference in Settings, where the
  // whole surface is the CLI and the tiles only pick a provider.
  const selectedCliProvider = cliSessions.find(
    (session) => session.termId === selectedCliId
  )?.providerId;
  const claudeActive = showCliConsole && selectedCliProvider === "claude";
  const codexActive = showCliConsole && selectedCliProvider === "codex";
  const selectCliProvider = useCallback(
    (providerId: "claude" | "codex") => {
      editor.setRightTab("chat");
      setAgentSurface("agent");
      setActiveView("agents");
      if (cliMode) {
        void ensureCliSessions()
          .then(() => createCliSession(providerId))
          .catch(() => useCliConsoleStore.getState().openProviderPicker());
        return;
      }
      void (async () => {
        const conversationId = await sessions.createSession();
        if (!conversationId) return;
        sessions.renameSession(
          conversationId,
          `${cliProvider(providerId).label} CLI`
        );
        try {
          // ensureCliSessions only reattaches the running ptys, so the new
          // one lands in the same list and gets the next ordinal.
          await ensureCliSessions();
          const termId = await createCliSession(providerId);
          useCliConsoleStore.getState().bindChat(conversationId, termId);
        } catch {
          useCliConsoleStore.getState().openProviderPicker();
        }
      })();
    },
    [cliMode, editor.setRightTab, sessions, setActiveView]
  );
""",
)

lit(
    """        if (view === "agents") {
          setAgentSurface("agent");
          setDockCliProvider(null);
        }
        setActiveView(view);""",
    """        if (view === "agents") setAgentSurface("agent");
        setActiveView(view);""",
)

open(PATH, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
