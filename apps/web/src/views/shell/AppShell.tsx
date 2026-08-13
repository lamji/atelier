import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { HeaderBar } from "./HeaderBar";
import { TitleBar } from "./TitleBar";
import { BottomPanel } from "./BottomPanel";
import { ActivityBar, type ActivityView } from "./ActivityBar";
import { CommandPalette } from "./CommandPalette";
import { EditorTabBar } from "./EditorTabBar";
import { StatusBar } from "./StatusBar";
import { ChatPanel } from "@/views/chat/ChatPanel";
import { CliConsolePane } from "@/views/cli/CliConsolePane";
import { CliProviderModal } from "@/views/cli/CliProviderModal";
import { CliSessionListPanel } from "@/views/cli/CliSessionListPanel";
import { FileTreePanel } from "@/views/explorer/FileTreePanel";
import { GitPanel } from "@/views/git/GitPanel";
import { GitFlowHost } from "@/views/git/GitFlowHost";
import { SessionListPanel } from "@/views/sessions/SessionListPanel";
import { MonitorPanel } from "@/views/monitor/MonitorPanel";
import { KnowledgePanel } from "@/views/knowledge/KnowledgePanel";
import { IndexingWelcome } from "@/views/knowledge/IndexingWelcome";
import { HooksPanel } from "@/views/hooks/HooksPanel";
import { MarkdownPanel } from "@/views/markdown/MarkdownPanel";
import { SettingsPanel } from "@/views/settings/SettingsPanel";
import { DbApprovalModal } from "@/views/hooks/DbApprovalModal";
import { RightDock } from "@/views/right/RightDock";
import { useTerminalViewModel } from "@/hooks/useTerminalViewModel";
import { useSessionsViewModel } from "@/hooks/useSessionsViewModel";
import { useConnectionViewModel } from "@/hooks/useConnectionViewModel";
import { useTimelineViewModel } from "@/hooks/useTimelineViewModel";
import { useProcessConsoleViewModel } from "@/hooks/useProcessConsoleViewModel";
import { useFileExplorerViewModel } from "@/hooks/useFileExplorerViewModel";
import { useEditorViewModel } from "@/hooks/useEditorViewModel";
import { useGitViewModel } from "@/hooks/useGitViewModel";
import { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";
import { useRagInspectorViewModel } from "@/hooks/useRagInspectorViewModel";
import { useHooksViewModel } from "@/hooks/useHooksViewModel";
import { useMarkdownViewModel } from "@/hooks/useMarkdownViewModel";
import { useDbApprovalViewModel } from "@/hooks/useDbApprovalViewModel";
import { useUsageViewModel } from "@/hooks/useUsageViewModel";
import { useContextStatsViewModel } from "@/hooks/useContextStatsViewModel";
import { useCommandRegistry } from "@/hooks/useCommandRegistry";
import { bridge } from "@/services/bridge-client";
import { useCliConsoleStore } from "@/services/cli-console";
import { useGitStore } from "@/state/git.store";
import { usePreferencesStore } from "@/state/preferences.store";
import { useThemeStore } from "@/state/theme.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/desktop";

/**
 * Single-console layout: header tabs (Chat / Editor / Terminal / Activity)
 * drive the one main view. Left column = agent sessions + the rail-selected
 * workspace view. Selecting a session forces Chat forward. Agent file edits
 * render inline in the chat transcript as VS Code-style diffs.
 */
export function AppShell() {
  const activeView = useWorkspaceStore((s) => s.activityView);
  const setActiveView = useWorkspaceStore((s) => s.setActivityView);
  const { theme, toggle } = useThemeStore();
  const connection = useConnectionViewModel();
  const sessions = useSessionsViewModel();
  const timeline = useTimelineViewModel();
  const processConsole = useProcessConsoleViewModel();
  const explorer = useFileExplorerViewModel();
  const editor = useEditorViewModel();
  const git = useGitViewModel();
  const terminal = useTerminalViewModel();
  const knowledge = useKnowledgeViewModel();
  const rag = useRagInspectorViewModel();
  const hooksVm = useHooksViewModel();
  const markdownVm = useMarkdownViewModel();
  const dbApproval = useDbApprovalViewModel();
  const usage = useUsageViewModel();
  const contextStats = useContextStatsViewModel();
  const cliMode = usePreferencesStore((s) => s.cliMode);
  const skillDetail = useWorkspaceStore((s) => s.skillDetail);
  const closeSkillDetail = useWorkspaceStore((s) => s.closeSkillDetail);
  const branch = useGitStore((s) => s.live?.branch ?? s.status?.branch ?? null);
  // Same live git state the status bar reads, badged onto the Source Control
  // rail icon so pending changes are visible without opening the view.
  const changedCount = useGitStore(
    (s) => s.live?.changedFiles ?? s.status?.files.length ?? 0
  );
  const bottomOpen = useWorkspaceStore((s) => s.bottomPanel);
  const setBottomPanel = useWorkspaceStore((s) => s.setBottomPanel);
  const openBottom = useWorkspaceStore((s) => s.openBottom);
  const workbenchVisible = useWorkspaceStore((s) => s.workbenchVisible);
  const setWorkbenchVisible = useWorkspaceStore(
    (s) => s.setWorkbenchVisible
  );
  const bottomRef = useRef<ImperativePanelHandle>(null);
  const [palette, setPalette] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });

  // The panel is the source of truth for its size; the store drives
  // expand/collapse so anything (header tab, Ctrl+`) can toggle it.
  useEffect(() => {
    const panel = bottomRef.current;
    if (!panel) return;
    if (bottomOpen && panel.isCollapsed()) {
      panel.expand();
      // First open starts from defaultSize 0, so give it a real height.
      if (panel.getSize() < 15) panel.resize(30);
    }
    if (!bottomOpen && !panel.isCollapsed()) panel.collapse();
  }, [bottomOpen]);

  // Ctrl+` toggles the bottom dock; Ctrl+P / Ctrl+Shift+P open the palette in
  // its file and command modes. All VS Code conventions.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === "`") {
        event.preventDefault();
        useWorkspaceStore.setState((s) => ({ bottomPanel: !s.bottomPanel }));
        return;
      }
      // Ctrl+P is the browser print dialog until we claim it, and inside
      // Electron it is ours to claim — EXCEPT over the terminal, where
      // Ctrl+P is readline's "previous command" and belongs to the shell.
      if (mod && (event.key === "p" || event.key === "P")) {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.(".xterm")) return;
        event.preventDefault();
        setPalette({ open: true, query: event.shiftKey ? ">" : "" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /*
   * "terminal" toggles the bottom dock; everything else is an editor-area
   * pane, Activity (the execution timeline) included — it moved out of the
   * bottom dock so that dock's bar could become the terminal tab strip.
   */
  const selectHeaderTab = (tab: Parameters<typeof editor.setRightTab>[0]) => {
    if (tab === "terminal") {
      if (bottomOpen) setBottomPanel(false);
      else openBottom();
      return;
    }
    editor.setRightTab(tab);
  };

  // Wildcard subscriptions do not replay, so seed the branch once on
  // connect; git.state.changed keeps it live afterward.
  useEffect(() => {
    if (connection.state !== "connected") return;
    void bridge
      .rpc("git.status", {})
      .then(({ status }) =>
        useGitStore.getState().setLive({
          branch: status.branch,
          isClean: status.isClean,
          changedFiles: status.files.length,
        })
      )
      .catch(() => undefined);
  }, [connection.state]);

  const busy = sessions.busy;
  const showIndexingWelcome =
    knowledge.indexingActive &&
    !knowledge.welcomeDismissed &&
    knowledge.stats?.lastIndexedAt == null;

  const leftPanel =
    activeView === "agents" ? (
      // CLI mode owns the whole conversation surface, so the chat sessions
      // are hidden with it: the rail's Agents slot lists the CLI sessions
      // of each provider instead. The chats are only out of sight — the
      // list comes back untouched when the mode is switched off.
      cliMode ? (
        <CliSessionListPanel
          onActivateSession={() => editor.setRightTab("chat")}
        />
      ) : (
        <SessionListPanel
          sessions={sessions.sessionList}
          selectedId={sessions.selectedId}
          onSelect={sessions.selectSession}
          onCreate={() => void sessions.createSession()}
          onRename={sessions.renameSession}
          onDelete={(id) => void sessions.deleteSession(id)}
        />
      )
    ) : activeView === "explorer" ? (
      <FileTreePanel vm={explorer} />
    ) : activeView === "markdown" ? (
      <MarkdownPanel
        vm={markdownVm}
        onOpenFile={(path) => void explorer.openFile(path)}
      />
    ) : activeView === "git" ? (
      <GitPanel vm={git} />
    ) : activeView === "monitor" ? (
      <MonitorPanel
        sessions={sessions.sessionList}
        workingCount={sessions.workingCount}
        onSelect={sessions.selectSession}
      />
    ) : activeView === "knowledge" ? (
      <KnowledgePanel vm={knowledge} onOpenRag={() => editor.setRightTab("rag")} />
    ) : activeView === "hooks" ? (
      <HooksPanel vm={hooksVm} />
    ) : (
      <SettingsPanel />
    );

  // Memoized so the dock's chat pane keeps a stable element across shell
  // re-renders: ChatPanel and Composer subscribe to their own state, and a
  // fresh element every render would defeat their memoization. Connection
  // trouble is never swapped in here — ConnectionGate covers the whole
  // viewport instead, so the transcript is not torn down and rebuilt on
  // every reconnect.
  // CLI mode swaps the WHOLE chat surface — transcript and composer — for
  // the selected provider CLI. Everything around it (sessions list, editor,
  // terminals, git) stays exactly as it is.
  const chatPane = useMemo(
    () =>
      cliMode ? <CliConsolePane /> : <ChatPanel shellError={sessions.error} />,
    [cliMode, sessions.error]
  );

  /*
   * Command sources. Every entry is the SAME callback the corresponding button
   * already invokes, so the palette can never drift from the UI: memoized
   * because useCommandRegistry keys its list off this object's identity.
   */
  const commandSources = useMemo(
    () => ({
      createSession: () => {
        if (cliMode) useCliConsoleStore.getState().openProviderPicker();
        else void sessions.createSession();
      },
      createTerminal: () => {
        // Open the dock first, or the new terminal is created into a panel
        // the user cannot see.
        openBottom();
        void terminal.create();
      },
      openTerminalPanel: () => openBottom(),
      refreshExplorer: explorer.refresh,
      collapseFolders: explorer.collapseAll,
      refreshGit: git.refresh,
      openFile: (path: string) => void explorer.openFile(path),
    }),
    [
      explorer.collapseAll,
      explorer.openFile,
      explorer.refresh,
      git.refresh,
      cliMode,
      openBottom,
      sessions,
      terminal,
    ]
  );
  const commands = useCommandRegistry(commandSources);

  const headerBar = (
    <HeaderBar
      workingCount={sessions.workingCount}
      rightTab={editor.rightTab}
      terminalCount={terminal.sessions.length}
      workbenchVisible={workbenchVisible}
      bottomOpen={bottomOpen}
      onSelectTab={selectHeaderTab}
      onToggleWorkbench={() => setWorkbenchVisible(!workbenchVisible)}
      onOpenCommands={(query) => setPalette({ open: true, query })}
    />
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {isDesktop() ? (
        <TitleBar>{headerBar}</TitleBar>
      ) : (
        <div className="h-[var(--titlebar-h)] shrink-0 border-b border-border bg-titlebar">
          {headerBar}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="w-[var(--activitybar-w)] shrink-0 border-r border-border bg-activity">
          <ActivityBar
            active={activeView}
            theme={theme}
            workingCount={sessions.workingCount}
            changedCount={changedCount}
            onSelect={setActiveView}
            onToggleTheme={toggle}
          />
        </div>
        <PanelGroup direction="horizontal" className="min-w-0 flex-1">
          {/*
           * Primary sidebar. `minSize` in percent would let the sidebar be
           * squeezed to unreadable at small window widths, so it is floored in
           * pixels too — below ~190px the tree indentation and the header
           * actions stop fitting.
           */}
          <Panel
            defaultSize={22}
            minSize={14}
            maxSize={40}
            className="min-w-[190px]"
          >
            <div className="h-full overflow-hidden border-r border-border bg-sidebar">
              {leftPanel}
            </div>
          </Panel>
          <PanelResizeHandle className="resize-handle w-[3px]" />
          <Panel defaultSize={78} minSize={35} className="min-w-[360px]">
            <PanelGroup direction="vertical">
              {/* 100, not 72: the bottom dock starts collapsed at 0, so the
                  editor owns the whole column until the dock is opened. The
                  old 72/0 pair summed to 72% and react-resizable-panels
                  normalised it away with a console warning on every mount. */}
              <Panel defaultSize={100} minSize={25}>
                <div
                  className={cn(
                    "relative flex h-full flex-col bg-editor",
                    busy && "glow-working"
                  )}
                >
                  <AnimatePresence>
                    {showIndexingWelcome && (
                      <IndexingWelcome
                        vm={knowledge}
                        workspaceRoot={connection.workspaceRoot}
                      />
                    )}
                  </AnimatePresence>
                  {workbenchVisible && (
                    <EditorTabBar
                      rightTab={editor.rightTab}
                      selectedPath={editor.selectedPath}
                      diffPath={git.gitDiff?.path ?? null}
                      onSelectTab={selectHeaderTab}
                    />
                  )}
                  <div className="relative min-h-0 flex-1">
                    <RightDock
                      rightTab={editor.rightTab}
                      chatPane={chatPane}
                      skillDetail={skillDetail}
                      onCloseSkillDetail={closeSkillDetail}
                      selectedPath={editor.selectedPath}
                      fileContent={editor.fileContent}
                      language={editor.language}
                      monacoTheme={editor.monacoTheme}
                      gitDiff={git.gitDiff}
                      onCloseGitDiff={git.closeDiff}
                      knowledgeVm={knowledge}
                      ragVm={rag}
                      appTheme={theme}
                      timelineEntries={timeline.entries}
                      processConsoleVm={processConsole}
                    />
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle className="resize-handle h-[3px]" />
              <Panel
                ref={bottomRef}
                defaultSize={0}
                minSize={12}
                collapsible
                collapsedSize={0}
                onCollapse={() => setBottomPanel(false)}
                onExpand={() => setBottomPanel(true)}
              >
                <BottomPanel
                  open={bottomOpen}
                  onClose={() => setBottomPanel(false)}
                  terminalSessions={terminal.sessions}
                  activeTermId={terminal.activeTermId}
                  onSelectTerm={terminal.setActive}
                  onCreateTerm={() => void terminal.create()}
                  onKillTerm={(id) => void terminal.kill(id)}
                  onRenameTerm={terminal.rename}
                  onMountTerm={terminal.mount}
                  onRefitTerm={terminal.refit}
                  termSearchOpen={terminal.searchOpen}
                  onOpenTermSearch={terminal.openSearch}
                  onCloseTermSearch={terminal.closeSearch}
                />
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
      {/* Shell-level: the palette overlays every region, so it cannot live
          inside one of them. */}
      <CommandPalette
        open={palette.open}
        initialQuery={palette.query}
        commands={commands}
        onOpenFile={(path) => void explorer.openFile(path)}
        onClose={() => setPalette((p) => ({ ...p, open: false }))}
      />
      <CliProviderModal />
      {/* Shell-level: raised by the git panel or by the git-flow hook. */}
      <GitFlowHost />
      {/* Shell-level: the agent's DB command waits on this answer. */}
      <DbApprovalModal vm={dbApproval} />
      <div
        className={cn(
          "h-[var(--statusbar-h)] shrink-0 overflow-hidden border-t",
          "border-border bg-titlebar"
        )}
      >
        <StatusBar
          connection={connection.state}
          agentStatus={connection.agentStatus}
          agentStatusDetail={connection.agentStatusDetail}
          workspaceRoot={connection.workspaceRoot}
          branch={branch}
          usage={usage}
          contextStats={contextStats}
          indexingActive={knowledge.indexingActive}
          indexing={knowledge.indexing}
          lastIndexedAt={knowledge.stats?.lastIndexedAt ?? null}
        />
      </div>
    </div>
  );
}
