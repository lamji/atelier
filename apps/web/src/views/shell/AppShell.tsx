import { useState } from "react";
import { motion } from "framer-motion";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { HeaderBar } from "./HeaderBar";
import { ActivityBar, type ActivityView } from "./ActivityBar";
import { StatusBar } from "./StatusBar";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { ConnectPanel } from "./ConnectPanel";
import { ChatPanel } from "@/views/chat/ChatPanel";
import { FileTreePanel } from "@/views/explorer/FileTreePanel";
import { GitPanel } from "@/views/git/GitPanel";
import { SessionListPanel } from "@/views/sessions/SessionListPanel";
import { MonitorPanel } from "@/views/monitor/MonitorPanel";
import { RightDock } from "@/views/right/RightDock";
import { useTerminalViewModel } from "@/hooks/useTerminalViewModel";
import { useSessionsViewModel } from "@/hooks/useSessionsViewModel";
import { useConnectionViewModel } from "@/hooks/useConnectionViewModel";
import { useTimelineViewModel } from "@/hooks/useTimelineViewModel";
import { useFileExplorerViewModel } from "@/hooks/useFileExplorerViewModel";
import { useEditorViewModel } from "@/hooks/useEditorViewModel";
import { useGitViewModel } from "@/hooks/useGitViewModel";
import { useThemeStore } from "@/state/theme.store";
import { cn } from "@/lib/cn";

const SIDE_PANELS: Record<
  Exclude<ActivityView, "agents" | "explorer" | "git" | "monitor">,
  { title: string; phase: string }
> = {
  knowledge: { title: "Knowledge Graph", phase: "Phase 5" },
  hooks: { title: "Hook Configuration", phase: "Phase 6" },
  settings: { title: "Settings", phase: "Phase 8" },
};

function Island(props: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        type: "spring",
        stiffness: 260,
        damping: 26,
        delay: props.delay ?? 0,
      }}
      className={cn("island h-full", props.className)}
    >
      {props.children}
    </motion.div>
  );
}

/**
 * Single-console layout: header tabs (Chat / Editor / Diffs / Terminal /
 * Activity) drive the one main view. Left column = agent sessions + the
 * rail-selected workspace view. Selecting a session forces Chat forward.
 */
export function AppShell() {
  const [activeView, setActiveView] = useState<ActivityView>("agents");
  const { theme, toggle } = useThemeStore();
  const connection = useConnectionViewModel();
  const sessions = useSessionsViewModel();
  const timeline = useTimelineViewModel();
  const explorer = useFileExplorerViewModel();
  const editor = useEditorViewModel();
  const git = useGitViewModel();
  const terminal = useTerminalViewModel();

  const needsManualConnect =
    connection.state === "disconnected" || connection.state === "unauthorized";
  const busy = sessions.selected?.status === "working";

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
    ) : activeView === "git" ? (
      <GitPanel vm={git} />
    ) : activeView === "monitor" ? (
      <MonitorPanel
        sessions={sessions.sessionList}
        workingCount={sessions.workingCount}
        onSelect={sessions.selectSession}
      />
    ) : (
      <PlaceholderPanel
        title={SIDE_PANELS[activeView].title}
        phase={SIDE_PANELS[activeView].phase}
      />
    );

  const chatPane = needsManualConnect ? (
    <ConnectPanel
      state={connection.state}
      port={connection.port}
      token={connection.token}
      onPortChange={connection.setPort}
      onTokenChange={connection.setToken}
      onConnect={connection.saveAndConnect}
    />
  ) : (
    <ChatPanel
      sessionTitle={sessions.selected?.conversation.title ?? "No session"}
      items={sessions.selected?.items ?? []}
      thinking={sessions.selected?.thinking ?? ""}
      actions={sessions.selected?.actions ?? []}
      input={sessions.input}
      busy={busy ?? false}
      connected={sessions.connected && sessions.selected !== null}
      error={sessions.error ?? sessions.selected?.lastError ?? null}
      model={sessions.model}
      effort={sessions.effort}
      planMode={sessions.planMode}
      attachments={sessions.attachments}
      attachCandidate={editor.selectedPath}
      onInputChange={sessions.setInput}
      onSend={() => void sessions.send()}
      onCancel={() => void sessions.cancel()}
      onModelChange={sessions.changeModel}
      onEffortChange={sessions.changeEffort}
      onPlanModeChange={sessions.setPlanMode}
      onAttach={sessions.addAttachment}
      onRemoveAttachment={sessions.removeAttachment}
    />
  );

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <Island className="h-12 shrink-0" delay={0}>
        <HeaderBar
          workingCount={sessions.workingCount}
          rightTab={editor.rightTab}
          diffCount={editor.diffs.length}
          terminalCount={terminal.sessions.length}
          onSelectTab={editor.setRightTab}
        />
      </Island>
      <div className="flex min-h-0 flex-1 gap-2">
        <Island className="w-[56px] shrink-0" delay={0.03}>
          <ActivityBar
            active={activeView}
            theme={theme}
            onSelect={setActiveView}
            onToggleTheme={toggle}
          />
        </Island>
        <PanelGroup direction="horizontal" className="min-w-0 flex-1">
          <Panel defaultSize={22} minSize={15}>
            <Island delay={0.06}>{leftPanel}</Island>
          </Panel>
          <PanelResizeHandle className="w-2" />
          <Panel defaultSize={78} minSize={40}>
            <Island delay={0.12} className={cn(busy && "glow-working")}>
              <RightDock
                rightTab={editor.rightTab}
                chatPane={chatPane}
                selectedPath={editor.selectedPath}
                fileContent={editor.fileContent}
                language={editor.language}
                monacoTheme={editor.monacoTheme}
                diffs={editor.diffs}
                activeDiff={editor.activeDiff}
                onShowDiff={editor.showDiff}
                gitDiff={git.gitDiff}
                onCloseGitDiff={git.closeDiff}
                terminalSessions={terminal.sessions}
                activeTermId={terminal.activeTermId}
                onSelectTerm={terminal.setActive}
                onCreateTerm={() => void terminal.create()}
                onKillTerm={(id) => void terminal.kill(id)}
                onMountTerm={terminal.mount}
                onRefitTerm={terminal.refit}
                timelineEntries={timeline.entries}
              />
            </Island>
          </Panel>
        </PanelGroup>
      </div>
      <Island className="h-8 shrink-0" delay={0.2}>
        <StatusBar
          connection={connection.state}
          agentStatus={connection.agentStatus}
          agentStatusDetail={connection.agentStatusDetail}
          workspaceRoot={connection.workspaceRoot}
        />
      </Island>
    </div>
  );
}
