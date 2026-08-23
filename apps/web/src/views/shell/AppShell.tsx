import { useCallback, useEffect, useMemo, useState } from "react";
import { newId } from "@atelier/shared";
import type { ModelOption } from "@atelier/protocol";
import { AnimatePresence } from "framer-motion";
import { Bot, Plus, Trash2, X } from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { HeaderBar, type AgentSurface } from "./HeaderBar";
import { TitleBar } from "./TitleBar";
import { BottomPanel } from "./BottomPanel";
import { CommandPalette } from "./CommandPalette";
import { EditorTabBar } from "./EditorTabBar";
import { RailStatus } from "./RailStatus";
import { UserProfile } from "./UserProfile";
import { ChangelogModal } from "./ChangelogModal";
import { useUpdatesViewModel } from "@/hooks/useUpdatesViewModel";
import { useWebTargetViewModel } from "@/hooks/useWebTargetViewModel";
import { BrandMark } from "@/components/BrandMark";
import { Select } from "@/components/ui/select";
import { Dock } from "./dock/Dock";
import { ChatPanel } from "@/views/chat/ChatPanel";
import { CliConsolePane } from "@/views/cli/CliConsolePane";
import { CliProviderModal } from "@/views/cli/CliProviderModal";
import { CliSessionListPanel } from "@/views/cli/CliSessionListPanel";
import { FileTreePanel } from "@/views/explorer/FileTreePanel";
import { TreeContextMenu } from "@/views/explorer/TreeContextMenu";
import { GitPanel } from "@/views/git/GitPanel";
import { GitFlowHost } from "@/views/git/GitFlowHost";
import { MergeConflictHost } from "@/views/git/MergeConflictHost";
import { GitSyncModal } from "@/views/git/GitSyncModal";
import { AlertHost } from "./AlertHost";
import {
  RenameField,
  SessionListPanel,
} from "@/views/sessions/SessionListPanel";
import { MonitorPanel } from "@/views/monitor/MonitorPanel";
import { KnowledgePanel } from "@/views/knowledge/KnowledgePanel";
import { IndexingWelcome } from "@/views/knowledge/IndexingWelcome";
import { MarkdownPanel } from "@/views/markdown/MarkdownPanel";
import { SettingsPanel } from "@/views/settings/SettingsPanel";
import { SettingsModal } from "@/views/settings/SettingsModal";
import { DbApprovalModal } from "@/views/hooks/DbApprovalModal";
import { FrontendReviewModal } from "@/views/review/FrontendReviewModal";
import { RightDock } from "@/views/right/RightDock";
import {
  ComponentPreviewPane,
  type ScreenshotChatDestination,
} from "@/views/right/ComponentPreviewPane";
import { useTerminalViewModel } from "@/hooks/useTerminalViewModel";
import { useSessionsViewModel } from "@/hooks/useSessionsViewModel";
import { useConnectionViewModel } from "@/hooks/useConnectionViewModel";
import { useTimelineViewModel } from "@/hooks/useTimelineViewModel";
import { useProcessConsoleViewModel } from "@/hooks/useProcessConsoleViewModel";
import { useFileExplorerViewModel } from "@/hooks/useFileExplorerViewModel";
import { useEditorViewModel } from "@/hooks/useEditorViewModel";
import { useGitViewModel } from "@/hooks/useGitViewModel";
import { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";
import { useHooksViewModel } from "@/hooks/useHooksViewModel";
import { useRagInspectorViewModel } from "@/hooks/useRagInspectorViewModel";
import { useMarkdownViewModel } from "@/hooks/useMarkdownViewModel";
import { useDbApprovalViewModel } from "@/hooks/useDbApprovalViewModel";
import { useUsageViewModel } from "@/hooks/useUsageViewModel";
import { useContextStatsViewModel } from "@/hooks/useContextStatsViewModel";
import { useCommandRegistry } from "@/hooks/useCommandRegistry";
import { bridge } from "@/services/bridge-client";
import { setActivePreviewUrl } from "@/services/preview-context";
import {
  createCliSession,
  ensureCliSessions,
  useCliConsoleStore,
} from "@/services/cli-console";
import { useGitStore } from "@/state/git.store";
import { usePreferencesStore } from "@/state/preferences.store";
import { useProvidersStore } from "@/state/providers.store";
import { useSessionsStore } from "@/state/sessions.store";
import { useThemeStore } from "@/state/theme.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import { cn } from "@/lib/cn";
import {
  FRONTEND_REVIEW_REQUEST_EVENT,
  frontendReviewTimelineMarker,
  type FrontendReviewRequest,
} from "@/lib/frontend-review";
import { isDesktop } from "@/lib/desktop";
import { WorkspacePageBody } from "@/components/ui/workspace-page";
import type { PendingImage } from "@/types";

interface PendingFrontendReviewCapture {
  review: FrontendReviewRequest;
  image: PendingImage;
  url: string;
  unsupportedModelLabel: string;
  rejectedModelValue?: string;
}

/** Optional post-task review must never wait indefinitely for consent. */
const FRONTEND_REVIEW_RESPONSE_MS = 30_000;

function reviewModelSupportsImages(
  choice: string,
  models: ModelOption[]
): boolean {
  if (choice === "default" || choice.startsWith("atelier/")) return true;
  return models.find((model) => model.value === choice)?.supportsImages !== false;
}

function reviewModelLabel(choice: string, models: ModelOption[]): string {
  if (choice === "default") return "Default model";
  return models.find((model) => model.value === choice)?.label ?? choice;
}

function isImageCapabilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:image|vision|multimodal).*(?:not supported|unsupported|cannot|can't)|(?:not supported|unsupported).*(?:image|vision|multimodal)/i.test(
    message
  );
}

/**
 * Single-console layout on a card canvas. The header carries the workspace
 * destinations; the left card shows whichever one is selected, and the main
 * card shows one pane at a time (Chat / Editor / Output / …) chosen by its
 * segmented switcher. Selecting a session forces Chat forward. Agent file
 * edits render inline in the chat transcript as unified diffs.
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
  const knowledge = useKnowledgeViewModel();
  const hooks = useHooksViewModel();
  const terminal = useTerminalViewModel();
  const markdownVm = useMarkdownViewModel();
  const dbApproval = useDbApprovalViewModel();
  const usage = useUsageViewModel();
  const contextStats = useContextStatsViewModel();
  const cliMode = usePreferencesStore((s) => s.cliMode);
  const setCliMode = usePreferencesStore((s) => s.setCliMode);
  const cliSessions = useCliConsoleStore((s) => s.sessions);
  const selectedCliId = useCliConsoleStore((s) => s.selectedId);
  const providerRevision = useProvidersStore((s) => s.revision);
  const setComposer = usePreferencesStore((s) => s.setComposer);
  const skillDetail = useWorkspaceStore((s) => s.skillDetail);
  const closeSkillDetail = useWorkspaceStore((s) => s.closeSkillDetail);
  const branch = useGitStore((s) => s.live?.branch ?? s.status?.branch ?? null);
  // Same live git state the status bar reads, badged onto the Changes tile in
  // the top nav so pending changes are visible without opening the view.
  const changedCount = useGitStore(
    (s) => s.live?.changedFiles ?? s.status?.files.length ?? 0
  );
  const conflictCount = useGitStore(
    (s) => s.live?.conflicts ?? s.status?.conflicts.length ?? 0
  );
  const bottomOpen = useWorkspaceStore((s) => s.bottomPanel);
  const setBottomPanel = useWorkspaceStore((s) => s.setBottomPanel);
  const openBottom = useWorkspaceStore((s) => s.openBottom);
  const workbenchVisible = useWorkspaceStore((s) => s.workbenchVisible);
  const workspaceEpoch = useWorkspaceStore((s) => s.workspaceEpoch);
  const settingsOpen = useWorkspaceStore((s) => s.settingsOpen);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const closeSettings = useWorkspaceStore((s) => s.closeSettings);
  const [palette, setPalette] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  const [agentSurface, setAgentSurface] = useState<AgentSurface>("agent");
  const [pagePreviewTermId, setPagePreviewTermId] = useState<string | null>(null);
  const [pagePreviewUrl, setPagePreviewUrl] = useState<string | null>(null);
  const [previewSessionMenu, setPreviewSessionMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [previewRenamingId, setPreviewRenamingId] = useState<string | null>(null);
  const [previewDeletingId, setPreviewDeletingId] = useState<string | null>(null);
  const [frontendReviewOffer, setFrontendReviewOffer] =
    useState<FrontendReviewRequest | null>(null);
  const [frontendReviewExpiresAt, setFrontendReviewExpiresAt] =
    useState<number | null>(null);
  const [approvedFrontendReview, setApprovedFrontendReview] =
    useState<FrontendReviewRequest | null>(null);
  const [frontendReviewAwaitingCapture, setFrontendReviewAwaitingCapture] =
    useState<FrontendReviewRequest | null>(null);
  const [frontendReviewError, setFrontendReviewError] = useState<string | null>(null);
  const [pendingFrontendReviewCapture, setPendingFrontendReviewCapture] =
    useState<PendingFrontendReviewCapture | null>(null);
  const [frontendReviewModel, setFrontendReviewModel] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const frontendReviewModelOptions = useMemo(
    () =>
      models
        .filter(
          (model) =>
            model.supportsImages === true &&
            model.value !== pendingFrontendReviewCapture?.rejectedModelValue
        )
        .map((model) => ({
          value: model.value,
          label: model.label,
          ...(model.description ? { hint: model.description } : {}),
        })),
    [models, pendingFrontendReviewCapture?.rejectedModelValue]
  );
  const currentSessionTitle = sessions.selectedId
    ? sessions.sessionList.find(
        (session) => session.conversation.id === sessions.selectedId
      )?.conversation.title ?? null
    : null;

  useEffect(() => {
    setAgentSurface("agent");
    setPagePreviewTermId(null);
    setPagePreviewUrl(null);
    setFrontendReviewOffer(null);
    setFrontendReviewExpiresAt(null);
    setApprovedFrontendReview(null);
    setFrontendReviewAwaitingCapture(null);
    setFrontendReviewError(null);
    setPendingFrontendReviewCapture(null);
    setFrontendReviewModel("");
  }, [workspaceEpoch]);

  useEffect(() => {
    if (agentSurface === "preview") return;
    setPreviewSessionMenu(null);
    setPreviewRenamingId(null);
    setPreviewDeletingId(null);
  }, [agentSurface]);

  useEffect(() => {
    setActivePreviewUrl(agentSurface === "preview" ? pagePreviewUrl : null);
    return () => setActivePreviewUrl(null);
  }, [agentSurface, pagePreviewUrl]);

  useEffect(() => {
    const onFrontendReviewRequested = (event: Event) => {
      const request = (event as CustomEvent<FrontendReviewRequest>).detail;
      if (!request?.taskId) return;
      // A new offer supersedes any older approved/captured review. This keeps
      // a stale preview from starting later without approval for this task.
      setApprovedFrontendReview(null);
      setFrontendReviewAwaitingCapture(null);
      setPendingFrontendReviewCapture(null);
      setFrontendReviewModel("");
      setFrontendReviewError(null);
      setFrontendReviewExpiresAt(Date.now() + FRONTEND_REVIEW_RESPONSE_MS);
      setFrontendReviewOffer(request);
    };
    window.addEventListener(
      FRONTEND_REVIEW_REQUEST_EVENT,
      onFrontendReviewRequested
    );
    return () =>
      window.removeEventListener(
        FRONTEND_REVIEW_REQUEST_EVENT,
        onFrontendReviewRequested
      );
  }, []);


  useEffect(() => {
    if (!pagePreviewTermId) return;
    const stillRunning = terminal.sessions.some(
      (session) => session.id === pagePreviewTermId && session.alive
    );
    if (!stillRunning) setPagePreviewTermId(null);
  }, [pagePreviewTermId, terminal.sessions]);

  const stopPagePreview = useCallback(() => {
    if (!pagePreviewTermId) return;
    const termId = pagePreviewTermId;
    setPagePreviewTermId(null);
    setAgentSurface("agent");
    void terminal.kill(termId);
  }, [pagePreviewTermId, terminal.kill]);

  const attachPreviewScreenshot = useCallback(
    async (image: PendingImage, destination: ScreenshotChatDestination) => {
      if (destination === "new") {
        const createdId = await sessions.createSession();
        if (!createdId) throw new Error("Atelier could not create a new chat.");
      } else if (!sessions.selectedId) {
        throw new Error("Select a chat or choose New chat for this screenshot.");
      }

      window.dispatchEvent(
        new CustomEvent("atelier:screenshot-captured", { detail: image })
      );
      editor.setRightTab("chat");
      setAgentSurface("agent");
      setActiveView("agents");
    },
    [editor.setRightTab, sessions.createSession, sessions.selectedId, setActiveView]
  );

  const showFrontendReviewModelPicker = useCallback(
    (capture: PendingFrontendReviewCapture) => {
      const fallback = models.find(
        (model) =>
          model.supportsImages === true &&
          model.value !== capture.rejectedModelValue
      );
      setApprovedFrontendReview(null);
      setPendingFrontendReviewCapture(capture);
      setFrontendReviewModel(fallback?.value ?? "");
      setFrontendReviewError(null);
      setFrontendReviewExpiresAt(Date.now() + FRONTEND_REVIEW_RESPONSE_MS);
      setFrontendReviewOffer(capture.review);
      setAgentSurface("agent");
      setActiveView("agents");
    },
    [models, setActiveView]
  );

  const startFrontendReview = useCallback(
    async (
      capture: PendingFrontendReviewCapture,
      modelOverride?: string
    ) => {
      const { review, image, url } = capture;
      const prefs = usePreferencesStore.getState();
      const pick = { ...prefs.defaults, ...prefs.byChat[review.conversationId] };
      const choice = modelOverride ?? pick.model;
      const model =
        choice === "default" || choice.startsWith("atelier/")
          ? undefined
          : choice;
      const visiblePrompt = `Review the completed frontend in Page preview · ${url}`;
      const prompt = [
        frontendReviewTimelineMarker({
          ...(image.path ? { screenshotPath: image.path } : {}),
          displayRequest: visiblePrompt,
        }),
        "FRONTEND REVIEW ONLY. Do not modify files, run fixes, or start another server.",
        `Review the completed frontend task at ${url}.`,
        "Use the attached live preview screenshot as visual evidence. Then call " +
          "preview_review with this exact URL for the headless Playwright desktop " +
          "and mobile audit. Correlate its console, network, accessibility, layout, " +
          "and screenshot evidence with the requested change.",
        "Obey preview_review's decision. If unavailable, ask the user to start or " +
          "reopen Page preview and stop without retrying or starting a server. If " +
          "failed, report the tool error and skip. If issues are present, report " +
          "the exact console/network/page evidence and skip because this review is read-only.",
        "The verdict is about the original requested UI outcome, not whether the " +
          "preview merely loaded or had clean console diagnostics. preview_review status " +
          "ready/continue means evidence collection succeeded; it is never proof that the " +
          "requested change passed.",
        "PASS only when the attached screenshot and the settled Playwright evidence " +
          "actually show the requested outcome on the target route and viewport. A modal " +
          "or overlay obscuring the target, screenshot/DOM disagreement, the wrong route " +
          "or state, an expected layout/content mismatch, or missing visual evidence is a " +
          "blocking review failure. Never say no blocking issue in those cases.",
        "Report findings in severity order with concrete routes and elements. End with " +
          "exactly FRONTEND REVIEW: PASS or FRONTEND REVIEW: FAIL; use FAIL whenever the " +
          "requested outcome was not verified.",
        `Original request: ${review.request}`,
        `Changed frontend files: ${review.changedFiles.join(", ")}`,
      ].join("\n\n");
      const store = useSessionsStore.getState();
      const requestedAt = Date.now();
      try {
        const { taskId, queued } = await bridge.rpc("task.start", {
          conversationId: review.conversationId,
          prompt,
          model,
          effort: pick.effort === "default" ? undefined : pick.effort,
          systemKnowledge: false,
          autoReview: false,
          autoValidate: false,
          images: [{ mediaType: image.mediaType, data: image.data }],
        });
        store.addUserMessage(
          review.conversationId,
          newId("local"),
          visiblePrompt,
          [image.dataUrl]
        );
        const existing =
          store.sessions[review.conversationId]?.executions ?? [];
        store.setExecutions(review.conversationId, [
          ...existing.filter((execution) => execution.taskId !== taskId),
          {
            taskId,
            request: visiblePrompt,
            report: "",
            requestedAt,
            status: queued ? "queued" : "running",
            startedAt: requestedAt,
            endedAt: null,
            durationMs: null,
            plan: null,
            actions: [],
            diffs: [],
            logs: [],
            frontendReview: true,
            images: [image.dataUrl],
          },
        ]);
        if (queued) {
          store.taskQueued(review.conversationId, taskId);
        } else {
          store.taskStarted(review.conversationId, taskId);
        }
        setApprovedFrontendReview(null);
        setPendingFrontendReviewCapture(null);
        setFrontendReviewModel("");
        editor.setRightTab("chat");
        setAgentSurface("agent");
        setActiveView("agents");
      } catch (error) {
        if (isImageCapabilityError(error)) {
          showFrontendReviewModelPicker({
            ...capture,
            unsupportedModelLabel: reviewModelLabel(choice, models),
            rejectedModelValue: choice,
          });
          return;
        }
        setApprovedFrontendReview(null);
        setFrontendReviewError(
          error instanceof Error
            ? error.message
            : "The frontend review could not be started."
        );
        setFrontendReviewExpiresAt(Date.now() + FRONTEND_REVIEW_RESPONSE_MS);
        setFrontendReviewOffer(review);
      }
    },
    [editor.setRightTab, models, setActiveView, showFrontendReviewModelPicker]
  );

  const dismissFrontendReview = useCallback(() => {
    setFrontendReviewOffer(null);
    setFrontendReviewExpiresAt(null);
    setApprovedFrontendReview(null);
    setFrontendReviewAwaitingCapture(null);
    setPendingFrontendReviewCapture(null);
    setFrontendReviewModel("");
    setFrontendReviewError(null);
  }, []);

  useEffect(() => {
    if (!frontendReviewOffer || frontendReviewExpiresAt === null) return;
    const timer = window.setTimeout(
      dismissFrontendReview,
      Math.max(0, frontendReviewExpiresAt - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [dismissFrontendReview, frontendReviewExpiresAt, frontendReviewOffer]);

  const approveFrontendReview = useCallback(() => {
    if (pendingFrontendReviewCapture) {
      const selected = models.find(
        (model) =>
          model.value === frontendReviewModel && model.supportsImages === true
      );
      if (!selected) return;
      setComposer(pendingFrontendReviewCapture.review.conversationId, {
        model: selected.value,
        effort: "default",
      });
      const capture = pendingFrontendReviewCapture;
      setFrontendReviewOffer(null);
      setFrontendReviewExpiresAt(null);
      setPendingFrontendReviewCapture(null);
      setFrontendReviewError(null);
      void startFrontendReview(capture, selected.value);
      return;
    }
    if (!frontendReviewOffer) return;
    setFrontendReviewAwaitingCapture(frontendReviewOffer);
    setFrontendReviewOffer(null);
    setFrontendReviewExpiresAt(null);
    setFrontendReviewError(null);
  }, [
    frontendReviewModel,
    frontendReviewOffer,
    models,
    pendingFrontendReviewCapture,
    setComposer,
    startFrontendReview,
  ]);

  const captureApprovedFrontendReview = useCallback(() => {
    if (!frontendReviewAwaitingCapture) return;
    setApprovedFrontendReview(frontendReviewAwaitingCapture);
    setFrontendReviewAwaitingCapture(null);
    setAgentSurface("preview");
    setActiveView("agents");
  }, [frontendReviewAwaitingCapture, setActiveView]);

  const captureFrontendReview = useCallback(
    async (image: PendingImage, url: string) => {
      const review = approvedFrontendReview;
      if (!review) return;
      const prefs = usePreferencesStore.getState();
      const pick = { ...prefs.defaults, ...prefs.byChat[review.conversationId] };
      const capture: PendingFrontendReviewCapture = {
        review,
        image,
        url,
        unsupportedModelLabel: reviewModelLabel(pick.model, models),
      };
      if (!reviewModelSupportsImages(pick.model, models)) {
        showFrontendReviewModelPicker(capture);
        return;
      }
      await startFrontendReview(capture);
    },
    [approvedFrontendReview, models, showFrontendReviewModelPicker, startFrontendReview]
  );

  const openTerminalWindow = useCallback(() => {
    openBottom();
    if (terminal.sessions.length === 0) void terminal.create();
  }, [openBottom, terminal.create, terminal.sessions.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === "`") {
        event.preventDefault();
        if (useWorkspaceStore.getState().bottomPanel) setBottomPanel(false);
        else openTerminalWindow();
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
  }, [openTerminalWindow, setBottomPanel]);

  // Migrate a hot-reloaded shell that was already on the old full-page
  // Settings destination into the new preferences window.
  useEffect(() => {
    if (activeView !== "settings") return;
    openSettings();
    setActiveView("agents");
  }, [activeView, openSettings, setActiveView]);

  /*
   * "terminal" toggles terminal mode; everything else is an editor-area
   * pane, Activity (the execution timeline) included — it moved out of the
   * bottom dock so that dock's bar could become the terminal tab strip.
   */
  const selectHeaderTab = (tab: Parameters<typeof editor.setRightTab>[0]) => {
    if (tab === "terminal") {
      if (bottomOpen) setBottomPanel(false);
      else openTerminalWindow();
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
          conflicts: status.conflicts.length,
          mergeKind: status.mergeState?.kind ?? null,
        })
      )
      .catch(() => undefined);
  }, [connection.state]);

  // Live model roster, so the dock's provider tiles can point at the
  // flagship Claude and Codex rows rather than a hardcoded alias. Same
  // trigger the composer watches: a key saved in Settings bumps the
  // revision and brings the new roster in without a reload.
  useEffect(() => {
    if (connection.state !== "connected") return;
    void bridge
      .rpc("models.list", {})
      .then(({ models }) => setModels(models))
      .catch(() => undefined);
  }, [connection.state, providerRevision]);

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
        compact
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

  const previewSessionOptions = useMemo(
    () =>
      sessions.sessionList.length > 0
        ? sessions.sessionList.map((session) => ({
            value: session.conversation.id,
            label: session.conversation.title,
            hint:
              session.status === "working"
                ? "Working…"
                : session.status === "error"
                  ? "Needs attention"
                  : "Ready",
          }))
        : [{ value: "", label: "Creating a session…", hint: "Please wait" }],
    [sessions.sessionList]
  );

  const previewRenamingSession =
    sessions.sessionList.find(
      (session) => session.conversation.id === previewRenamingId
    ) ?? null;
  const previewDeletingSession =
    sessions.sessionList.find(
      (session) => session.conversation.id === previewDeletingId
    ) ?? null;

  const previewAgentPanel =
    !cliMode && agentSurface === "preview" ? (
      <div className="flex h-full flex-col">
        <div className="island-header justify-between">
          <span className="icon-tile icon-tile-sm">
            <Bot className="h-3.5 w-3.5" />
          </span>
          <span className="island-title">Agents</span>
          <button
            type="button"
            title="New agent session"
            aria-label="New agent session"
            onClick={() => void sessions.createSession()}
            className="tool-btn ml-auto"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-border/60 px-2 pb-2">
          <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
            <span className="text-[10px] font-medium text-muted-foreground">
              Active session
            </span>
            <span className="text-[10px] text-muted-foreground/60">
              {sessions.sessionList.length} total
            </span>
          </div>
          {previewRenamingSession ? (
            <div className="flex h-9 items-center">
              <RenameField
                initial={previewRenamingSession.conversation.title}
                onCommit={(title) => {
                  sessions.renameSession(previewRenamingSession.conversation.id, title);
                  setPreviewRenamingId(null);
                }}
                onCancel={() => setPreviewRenamingId(null)}
              />
            </div>
          ) : previewDeletingSession ? (
            <div className="flex h-9 items-center gap-1 rounded-xl border border-destructive/30 bg-destructive/5 px-2">
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                Delete {previewDeletingSession.conversation.title}?
              </span>
              <button
                type="button"
                title="Cancel"
                aria-label="Cancel delete"
                onClick={() => setPreviewDeletingId(null)}
                className="tool-btn"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Confirm delete"
                aria-label={`Confirm deleting ${previewDeletingSession.conversation.title}`}
                onClick={() => {
                  const id = previewDeletingSession.conversation.id;
                  setPreviewDeletingId(null);
                  void sessions.deleteSession(id);
                }}
                className="tool-btn text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <Select
              value={sessions.selectedId ?? ""}
              onChange={sessions.selectSession}
              options={previewSessionOptions}
              disabled={sessions.sessionList.length === 0}
              className="h-9 w-full justify-between rounded-xl border border-border/70 bg-muted/40 px-2.5 text-xs text-foreground"
              menuClassName="max-w-[20rem]"
              onOptionContextMenu={(option, event) => {
                setPreviewSessionMenu({
                  id: option.value,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            />
          )}
          {previewSessionMenu && (
            <TreeContextMenu
              x={previewSessionMenu.x}
              y={previewSessionMenu.y}
              onClose={() => setPreviewSessionMenu(null)}
              items={[
                {
                  label: "Rename",
                  onSelect: () => {
                    setPreviewDeletingId(null);
                    setPreviewRenamingId(previewSessionMenu.id);
                  },
                },
                {},
                {
                  label: "Delete",
                  danger: true,
                  onSelect: () => {
                    setPreviewRenamingId(null);
                    setPreviewDeletingId(previewSessionMenu.id);
                  },
                },
              ]}
            />
          )}
        </div>
        <div className="min-h-0 flex-1">
          <ChatPanel compact shellError={sessions.error} />
        </div>
      </div>
    ) : (
      leftPanel
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
        if (terminal.sessions.length === 0) openTerminalWindow();
        else {
          openBottom();
          void terminal.create();
        }
      },
      openTerminalPanel: openTerminalWindow,
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
      openTerminalWindow,
      sessions,
      terminal,
    ]
  );
  const commands = useCommandRegistry(commandSources);

  // App-level, not workspace-level: a release is news about Atelier itself,
  // so it survives project switches and lives in the header, not the rail.
  const updates = useUpdatesViewModel();
  // Whether this workspace has a web app at all. Decides if Page preview is
  // offered — an API or a native-only project has no page to preview.
  const webTarget = useWebTargetViewModel();

  const headerBar = (
    <HeaderBar
      activeAgentSurface={activeView === "agents" ? agentSurface : null}
      pagePreviewRunning={pagePreviewTermId !== null}
      showPagePreview={webTarget.runtime !== null}
      pagePreviewLabel={
        webTarget.runtime?.framework === "Expo (web)"
          ? "Web preview"
          : "Page preview"
      }
      onSelectAgent={() => {
        setAgentSurface("agent");
        setActiveView("agents");
      }}
      onSelectPagePreview={() => {
        setAgentSurface("preview");
        setActiveView("agents");
      }}
      onStopPagePreview={stopPagePreview}
      onOpenPalette={(query) => setPalette({ open: true, query })}
      updateAvailable={updates.available}
      onInstallUpdate={updates.install}
      updateStage={updates.stage}
      updatePercent={updates.percent}
      updateError={updates.error}
    />
  );

  // Provider CLI tiles own the conversation surface: entering one enables
  // CLI mode, swaps the transcript for that provider's real terminal, and
  // swaps the left rail from Atelier chats to CLI sessions. Reuse a live
  // session before creating one so switching providers preserves scrollback.
  const selectedCliProvider = cliSessions.find(
    (session) => session.termId === selectedCliId
  )?.providerId;
  const claudeActive = cliMode && selectedCliProvider === "claude";
  const codexActive = cliMode && selectedCliProvider === "codex";
  const selectCliProvider = useCallback(
    (providerId: "claude" | "codex") => {
      setCliMode(true);
      editor.setRightTab("chat");
      setAgentSurface("agent");
      setActiveView("agents");
      void ensureCliSessions()
        .then(() => {
          const cli = useCliConsoleStore.getState();
          const existing = cli.sessions.find(
            (session) => session.providerId === providerId
          );
          if (existing) {
            cli.select(existing.termId);
            return;
          }
          return createCliSession(providerId);
        })
        .catch(() => useCliConsoleStore.getState().openProviderPicker());
    },
    [editor.setRightTab, setActiveView, setCliMode]
  );
  const selectClaude = useCallback(
    () => selectCliProvider("claude"),
    [selectCliProvider]
  );
  const selectCodex = useCallback(
    () => selectCliProvider("codex"),
    [selectCliProvider]
  );

  // Every icon control in the app, in one bar at the bottom of the canvas.
  const dock = (
    <Dock
      activeView={activeView}
      onSelectView={(view) => {
        if (view === "explorer" || view === "markdown") {
          editor.setRightTab("editor");
        }
        if (view === "agents") setAgentSurface("agent");
        setActiveView(view);
      }}
      workingCount={sessions.workingCount}
      changedCount={changedCount}
      conflictCount={conflictCount}
      terminalCount={terminal.sessions.length}
      bottomOpen={bottomOpen}
      theme={theme}
      usage={usage}
      settingsOpen={settingsOpen}
      onToggleSettings={settingsOpen ? closeSettings : openSettings}
      onToggleTheme={toggle}
      onSelectTab={selectHeaderTab}
      claudeActive={claudeActive}
      codexActive={codexActive}
      onSelectClaude={selectClaude}
      onSelectCodex={selectCodex}
    />
  );

  /*
   * Canvas, not regions. The shell is a tinted page with cards floating on
   * it: the gutter between them is the resize handle's own width, so the
   * spacing and the drag target are the same 10px and neither has to be
   * faked with margins that the panel library would then fight.
   */
  return (
    <div className="app-canvas relative flex h-full flex-col overflow-hidden">
      {isDesktop() ? (
        <TitleBar>{headerBar}</TitleBar>
      ) : (
        <div className="h-[var(--topnav-h)] shrink-0">{headerBar}</div>
      )}
      {/*
       * The dock rail down the left edge, then the editor region with the
       * bottom panel docked under it. `relative` is what a maximized panel
       * anchors to: it covers the editor and nothing else, leaving the
       * header, the status bar and the rail reachable.
       */}
      <div className="flex min-h-0 flex-1">
        <aside className="dock-rail" aria-label="Dock">
          {dock}
          <RailStatus
            connection={connection.state}
            agentStatusDetail={connection.agentStatusDetail}
            workspaceRoot={connection.workspaceRoot}
            contextStats={contextStats}
            indexingActive={knowledge.indexingActive}
            indexing={knowledge.indexing}
            lastIndexedAt={knowledge.stats?.lastIndexedAt ?? null}
          />
          <UserProfile />
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {activeView === "agents" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <WorkspacePageBody
                  wide
                  className="flex min-h-0 flex-1"
                >
                  <PanelGroup direction="horizontal" className="min-w-0 flex-1">
              {/*
               * Primary sidebar. The percentage is what the drag handle moves;
               * `.sidebar-panel` is the pixel floor underneath it, because 15%
               * of a 1366px laptop is 205px and the panel opened cramped there.
               * The default is now chosen so a normal window opens ABOVE the
               * floor rather than being clamped up to it.
               */}
              <Panel
                defaultSize={20}
                minSize={16}
                maxSize={26}
                className="sidebar-panel max-w-[340px]"
              >
                <div className="island h-full">{previewAgentPanel}</div>
              </Panel>
              <PanelResizeHandle className="resize-handle w-px" />
              <Panel defaultSize={80} minSize={68} className="min-w-[360px]">
                <div
                  className={cn(
                    "island island-main relative flex h-full flex-col",
                    busy && "glow-working"
                  )}
                >
                  <AnimatePresence>
                    {agentSurface === "agent" && showIndexingWelcome && (
                      <IndexingWelcome
                        vm={knowledge}
                        workspaceRoot={connection.workspaceRoot}
                      />
                    )}
                  </AnimatePresence>
                  {agentSurface === "agent" && workbenchVisible && (
                    <EditorTabBar
                      rightTab={editor.rightTab}
                      selectedPath={editor.selectedPath}
                      diffPath={null}
                      onSelectTab={selectHeaderTab}
                    />
                  )}
                  <div className="relative min-h-0 flex-1">
                    <div
                      className={cn(
                        "absolute inset-0",
                        agentSurface !== "agent" && "invisible pointer-events-none"
                      )}
                      aria-hidden={agentSurface !== "agent"}
                    >
                      <RightDock
                        rightTab={editor.rightTab}
                        chatPane={agentSurface === "agent" ? chatPane : null}
                        skillDetail={skillDetail}
                        onCloseSkillDetail={closeSkillDetail}
                        selectedPath={editor.selectedPath}
                        fileContent={editor.fileContent}
                        language={editor.language}
                        monacoTheme={editor.monacoTheme}
                        gitDiff={null}
                        onCloseGitDiff={git.closeDiff}
                        appTheme={theme}
                        timelineEntries={timeline.entries}
                        processConsoleVm={processConsole}
                      />
                    </div>
                    <div
                      className={cn(
                        "absolute inset-0",
                        agentSurface !== "preview" && "invisible pointer-events-none"
                      )}
                      aria-hidden={agentSurface !== "preview"}
                    >
                      <ComponentPreviewPane
                        managedTermId={pagePreviewTermId}
                        onManagedTermChange={setPagePreviewTermId}
                        currentSessionTitle={currentSessionTitle}
                        onAttachScreenshot={attachPreviewScreenshot}
                        reviewTaskId={approvedFrontendReview?.taskId ?? null}
                        onPreviewUrlChange={setPagePreviewUrl}
                        onCaptureForReview={captureFrontendReview}
                      />
                    </div>
                  </div>
                </div>
              </Panel>
                  </PanelGroup>
                </WorkspacePageBody>
              </div>
            ) : activeView === "explorer" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <WorkspacePageBody className="flex min-h-0 flex-1">
                  <PanelGroup direction="horizontal" className="min-w-0 flex-1">
                    <Panel
                      defaultSize={30}
                      minSize={18}
                      maxSize={45}
                      className="sidebar-panel"
                    >
                      <div className="island h-full">{leftPanel}</div>
                    </Panel>
                    <PanelResizeHandle className="resize-handle w-px" />
                    <Panel defaultSize={70} minSize={40} className="min-w-[360px]">
                      <div className="island island-main h-full overflow-hidden">
                        <RightDock
                          rightTab="editor"
                          chatPane={chatPane}
                          skillDetail={skillDetail}
                          onCloseSkillDetail={closeSkillDetail}
                          selectedPath={editor.selectedPath}
                          fileContent={editor.fileContent}
                          language={editor.language}
                          monacoTheme={editor.monacoTheme}
                          gitDiff={git.gitDiff}
                          onCloseGitDiff={git.closeDiff}
                          appTheme={theme}
                          timelineEntries={timeline.entries}
                          processConsoleVm={processConsole}
                        />
                      </div>
                    </Panel>
                  </PanelGroup>
                </WorkspacePageBody>
              </div>
            ) : activeView === "markdown" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <WorkspacePageBody className="flex min-h-0 flex-1">
                  <PanelGroup direction="horizontal" className="min-w-0 flex-1">
                    <Panel
                      defaultSize={30}
                      minSize={18}
                      maxSize={45}
                      className="sidebar-panel"
                    >
                      <div className="island h-full">{leftPanel}</div>
                    </Panel>
                    <PanelResizeHandle className="resize-handle w-px" />
                    <Panel defaultSize={70} minSize={40} className="min-w-[360px]">
                      <div className="island island-main h-full overflow-hidden">
                        <RightDock
                          rightTab="editor"
                          chatPane={chatPane}
                          skillDetail={skillDetail}
                          onCloseSkillDetail={closeSkillDetail}
                          selectedPath={editor.selectedPath}
                          fileContent={editor.fileContent}
                          language={editor.language}
                          monacoTheme={editor.monacoTheme}
                          gitDiff={null}
                          onCloseGitDiff={git.closeDiff}
                          appTheme={theme}
                          timelineEntries={timeline.entries}
                          processConsoleVm={processConsole}
                        />
                      </div>
                    </Panel>
                  </PanelGroup>
                </WorkspacePageBody>
              </div>
            ) : (
              <main className="island island-main w-full min-w-0 flex-1 overflow-hidden">
                {leftPanel}
              </main>
            )}
          </div>

          <BottomPanel
            open={bottomOpen}
            onClose={() => setBottomPanel(false)}
            terminalSessions={terminal.sessions}
            activeTermId={terminal.activeTermId}
            onSelectTerm={terminal.setActive}
            onCreateTerm={() => void terminal.create()}
            onKillTerm={(id) => {
              if (terminal.sessions.length <= 1) setBottomPanel(false);
              void terminal.kill(id);
            }}
            onRenameTerm={terminal.rename}
            onMountTerm={terminal.mount}
            onRefitTerm={terminal.refit}
            termSearchOpen={terminal.searchOpen}
            terminalProfileId={terminal.profile}
            onTerminalProfileChange={terminal.setProfile}
            onOpenTermSearch={terminal.openSearch}
            onCloseTermSearch={terminal.closeSearch}
          />
        </div>
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
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
      {/* Shell-level: raised by the git panel or by the git-flow hook. */}
      <GitFlowHost />
      {/* Shell-level: finishes AI conflict resolutions and announces new
          conflicts (from a pull here or a terminal) wherever the user is. */}
      <MergeConflictHost />
      {/* Shell-level: the pull-from / push-to / checkout pickers. */}
      <GitSyncModal />
      {/* Shell-level: one stack for every git operation's outcome. */}
      <AlertHost />
      {/* Shell-level: what changed, once, on the first launch after an
          upgrade. */}
      <ChangelogModal
        entry={updates.changelog}
        onClose={updates.dismissChangelog}
      />
      {/* Shell-level: the agent's DB command waits on this answer. */}
      <DbApprovalModal vm={dbApproval} />
      <FrontendReviewModal
        request={frontendReviewOffer}
        expiresAt={frontendReviewExpiresAt}
        previewReady={pagePreviewUrl !== null}
        error={frontendReviewError}
        modelSelectionRequired={pendingFrontendReviewCapture !== null}
        unsupportedModelLabel={
          pendingFrontendReviewCapture?.unsupportedModelLabel ?? null
        }
        selectedModel={frontendReviewModel}
        modelOptions={frontendReviewModelOptions}
        onModelChange={setFrontendReviewModel}
        onApprove={approveFrontendReview}
        onDismiss={dismissFrontendReview}
        onClosed={captureApprovedFrontendReview}
      />
    </div>
  );
}
