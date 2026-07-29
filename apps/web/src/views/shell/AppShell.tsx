import { useEffect, useMemo, useRef } from "react";
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
import { StatusBar } from "./StatusBar";
import { ConnectionGate } from "./ConnectionGate";
import { WelcomeScreen } from "./WelcomeScreen";
import { ChatPanel } from "@/views/chat/ChatPanel";
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
import { useConnectionGateViewModel } from "@/hooks/useConnectionGateViewModel";
import { useTimelineViewModel } from "@/hooks/useTimelineViewModel";
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
import { bridge } from "@/services/bridge-client";
import { useGitStore } from "@/state/git.store";
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
  const gate = useConnectionGateViewModel();
  const sessions = useSessionsViewModel();
  const timeline = useTimelineViewModel();
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
  const skillDetail = useWorkspaceStore((s) => s.skillDetail);
  const closeSkillDetail = useWorkspaceStore((s) => s.closeSkillDetail);
  const branch = useGitStore((s) => s.live?.branch ?? s.status?.branch ?? null);
  const bottomOpen = useWorkspaceStore((s) => s.bottomPanel);
  const bottomTab = useWorkspaceStore((s) => s.bottomTab);
  const setBottomPanel = useWorkspaceStore((s) => s.setBottomPanel);
  const openBottom = useWorkspaceStore((s) => s.openBottom);
  const bottomRef = useRef<ImperativePanelHandle>(null);

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

  // Ctrl+` toggles the bottom dock, VS Code style.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        useWorkspaceStore.setState((s) => ({ bottomPanel: !s.bottomPanel }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Header Terminal/Activity tabs drive the bottom dock; clicking the
  // already-active one collapses it. Other tabs switch the main view as
  // before.
  const selectHeaderTab = (tab: Parameters<typeof editor.setRightTab>[0]) => {
    if (tab === "terminal" || tab === "activity") {
      const target = tab === "terminal" ? "terminal" : "timeline";
      if (bottomOpen && bottomTab === target) setBottomPanel(false);
      else openBottom(target);
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
      <SessionListPanel
        sessions={sessions.sessionList}
        selectedId={sessions.selectedId}
        onSelect={sessions.selectSession}
        onCreate={() => void sessions.createSession()}
      />
    ) : activeView === "explorer" ? (
      <FileTreePanel
        tree={explorer.tree}
        expanded={explorer.expanded}
        selectedPath={explorer.selectedPath}
        onToggleDir={explorer.toggleDir}
        onOpenFile={(path) => void explorer.openFile(path)}
      />
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
  const chatPane = useMemo(
    () => <ChatPanel shellError={sessions.error} />,
    [sessions.error]
  );

  const headerBar = (
    <HeaderBar
      workingCount={sessions.workingCount}
      rightTab={editor.rightTab}
      terminalCount={terminal.sessions.length}
      onSelectTab={selectHeaderTab}
    />
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {isDesktop() ? (
        <TitleBar>{headerBar}</TitleBar>
      ) : (
        <div className="h-[var(--titlebar-h)] shrink-0 border-b border-border bg-card">
          {headerBar}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="w-[var(--activitybar-w)] shrink-0 border-r border-border bg-card">
          <ActivityBar
            active={activeView}
            theme={theme}
            onSelect={setActiveView}
            onToggleTheme={toggle}
          />
        </div>
        <PanelGroup direction="horizontal" className="min-w-0 flex-1">
          <Panel defaultSize={22} minSize={15}>
            <div className="h-full border-r border-border bg-card">
              {leftPanel}
            </div>
          </Panel>
          <PanelResizeHandle className="w-[3px] bg-transparent transition-colors hover:bg-primary/40 data-[resize-handle-active]:bg-primary/60" />
          <Panel defaultSize={78} minSize={40}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={72} minSize={30}>
                <div className={cn("relative h-full", busy && "glow-working")}>
                  <AnimatePresence>
                    {showIndexingWelcome && (
                      <IndexingWelcome
                        vm={knowledge}
                        workspaceRoot={connection.workspaceRoot}
                      />
                    )}
                  </AnimatePresence>
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
                  />
                </div>
              </Panel>
              <PanelResizeHandle className="h-[3px] bg-transparent transition-colors hover:bg-primary/40 data-[resize-handle-active]:bg-primary/60" />
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
                  tab={bottomTab}
                  onSelectTab={(tab) => openBottom(tab)}
                  onClose={() => setBottomPanel(false)}
                  terminalSessions={terminal.sessions}
                  activeTermId={terminal.activeTermId}
                  onSelectTerm={terminal.setActive}
                  onCreateTerm={() => void terminal.create()}
                  onKillTerm={(id) => void terminal.kill(id)}
                  onMountTerm={terminal.mount}
                  onRefitTerm={terminal.refit}
                  timelineEntries={timeline.entries}
                />
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
      {/* Shell-level: raised by the git panel or by the git-flow hook. */}
      <GitFlowHost />
      {/* Shell-level: the agent's DB command waits on this answer. */}
      <DbApprovalModal vm={dbApproval} />
      {/* Desktop-only: instant open/import screen while no workspace is
          selected. Sits under the gate so real failures still win. */}
      <WelcomeScreen />
      {/* Blocks the whole viewport while there is no live agent behind it. */}
      <ConnectionGate vm={gate} />
      <div className="h-[var(--statusbar-h)] shrink-0 border-t border-border bg-card">
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
