import type {
  DbApprovalRequest,
  Diff,
  EventFrame,
  GitFlowRequest,
  TerminalSession,
  UsageSnapshot,
} from "@atelier/protocol";
import { bridge } from "./bridge-client.js";
import { terminalRegistry } from "./terminal-registry.js";
import { useConnectionStore } from "@/state/connection.store";
import { useDbApprovalStore } from "@/state/db-approval.store";
import { useGitFlowStore } from "@/state/git-flow.store";
import { useGitStore } from "@/state/git.store";
import { useKnowledgeStore } from "@/state/knowledge.store";
import type { IndexingProgress } from "@/state/knowledge.store";
import { useSessionsStore } from "@/state/sessions.store";
import { useTerminalStore } from "@/state/terminal.store";
import { useTimelineStore } from "@/state/timeline.store";
import { useUsageStore } from "@/state/usage.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/** Topics rendered live elsewhere, not as timeline cards. */
const NON_TIMELINE_TOPICS = new Set([
  "chat.message.delta",
  "chat.message.completed",
  "agent.thinking.delta",
  "terminal.data",
  // High-frequency during scans; rendered live in the Knowledge panel.
  "knowledge.indexing.progress",
  "knowledge.features.scan",
]);

let started = false;

/**
 * Coalesces the heavy knowledge refetch (stats + features + lessons) so a
 * burst of events during a scan can't stutter the UI: bumps at most once
 * per window, with a trailing bump so the final state is never missed.
 */
let lastKnowledgeBump = 0;
let pendingKnowledgeBump: ReturnType<typeof setTimeout> | null = null;
const KNOWLEDGE_BUMP_MS = 1500;

function scheduleKnowledgeRefetch(immediate = false): void {
  const bump = () => {
    lastKnowledgeBump = Date.now();
    useKnowledgeStore.getState().bumpStatsVersion();
  };
  if (pendingKnowledgeBump) {
    clearTimeout(pendingKnowledgeBump);
    pendingKnowledgeBump = null;
  }
  if (immediate || Date.now() - lastKnowledgeBump > KNOWLEDGE_BUMP_MS) {
    bump();
    return;
  }
  pendingKnowledgeBump = setTimeout(() => {
    pendingKnowledgeBump = null;
    bump();
  }, KNOWLEDGE_BUMP_MS);
}

/** Human-readable label for a tool invocation. */
function actionLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.path === "string" ? i.path : "";
  switch (name) {
    case "read_file":
      return `Reading ${path}`;
    case "write_file":
      return `Writing ${path}`;
    case "replace_code":
      return `Editing ${path}`;
    case "search_workspace":
      return `Searching "${String(i.query ?? "")}"`;
    case "list_dir":
      return `Listing ${path || "workspace"}`;
    case "run_terminal":
      return `Running: ${String(i.command ?? "").slice(0, 80)}`;
    case "git":
      return `git ${String(i.action ?? "")}`.trim();
    case "retrieve_knowledge":
      return `Retrieving knowledge: "${String(i.query ?? "")}"`;
    case "query_knowledge_graph":
      return `Querying code graph (${String(i.scope ?? "")})`;
    case "search_symbols":
      return `Searching symbols "${String(i.query ?? "")}"`;
    case "analyze_impact": {
      const files = Array.isArray(i.files) ? (i.files as string[]) : [];
      const symbols = Array.isArray(i.symbols) ? (i.symbols as string[]) : [];
      return `Analyzing impact of ${[...files, ...symbols].slice(0, 3).join(", ")}`;
    }
    case "impact_of_edit": {
      const at = i.symbol ? String(i.symbol) : `${path}:${String(i.line ?? "?")}`;
      return `Checking who uses ${at}`;
    }
    case "save_lesson":
      return `Saving lesson: ${String(i.title ?? "")}`;
    default:
      return name;
  }
}

/**
 * Single subscription point: routes pushed events into the right stores.
 * Session-scoped events resolve their conversation via the payload or the
 * taskId -> conversationId map so parallel agents never cross streams.
 */
export function startEventDispatcher(): void {
  if (started) return;
  started = true;

  bridge.onStatus((state) => {
    useConnectionStore.getState().setState(state);
    if (state === "connected" && bridge.hello) {
      useConnectionStore.getState().setWorkspaceRoot(bridge.hello.workspaceRoot);
    }
  });

  // Subscriptions persist on the client across reconnects; the actual
  // connect() is driven by switchProject once a project is selected.
  bridge.subscribe("*", (frame) => dispatch(frame));
}

function dispatch(frame: EventFrame): void {
  const sessions = useSessionsStore.getState();
  const payload = frame.payload as Record<string, unknown>;
  const payloadConvId =
    typeof payload?.conversationId === "string"
      ? payload.conversationId
      : undefined;
  const convId =
    payloadConvId ??
    (frame.taskId ? sessions.conversationForTask(frame.taskId) : undefined);

  switch (frame.topic) {
    case "chat.message.delta":
      if (convId) {
        sessions.appendAssistantDelta(
          convId,
          String(payload.messageId),
          String(payload.delta)
        );
      }
      break;
    case "chat.message.completed":
      if (convId) {
        sessions.completeAssistantMessage(
          convId,
          String(payload.messageId),
          String(payload.text)
        );
      }
      break;
    case "agent.thinking.delta":
      if (convId) sessions.appendThinking(convId, String(payload.delta));
      break;
    case "agent.status":
      useConnectionStore
        .getState()
        .setAgentStatus(
          payload.status as never,
          payload.detail as string | undefined
        );
      break;
    case "usage.updated":
      useUsageStore.getState().set(frame.payload as UsageSnapshot);
      break;
    case "task.started":
      if (convId && frame.taskId) {
        sessions.taskStarted(convId, frame.taskId);
      }
      break;
    case "pipeline.stage.started":
      // Keeps the chat moving between the model's own messages.
      if (convId) sessions.setStage(convId, payload.stage as never);
      break;
    case "tool.started":
      if (convId) {
        sessions.actionStarted(
          convId,
          String(payload.toolCallId),
          actionLabel(String(payload.name), payload.input)
        );
      }
      break;
    case "tool.completed":
      if (convId) {
        sessions.actionFinished(convId, String(payload.toolCallId), "done");
      }
      break;
    case "tool.failed":
      if (convId) {
        sessions.actionFinished(convId, String(payload.toolCallId), "failed");
      }
      break;
    case "task.completed":
      if (convId) sessions.taskEnded(convId, "completed");
      break;
    case "task.cancelled":
      if (convId) sessions.taskEnded(convId, "cancelled");
      break;
    case "task.error":
      if (convId) {
        sessions.taskEnded(convId, "error", String(payload.message));
      }
      break;
    case "diff.created":
      useWorkspaceStore.getState().addDiff(frame.payload as Diff);
      break;
    case "terminal.data":
      terminalRegistry.write(String(payload.termId), String(payload.data));
      break;
    case "terminal.session.created": {
      const store = useTerminalStore.getState();
      if (!store.sessions.some((s) => s.id === payload.termId)) {
        void bridge
          .rpc("terminal.list", {})
          .then(({ sessions }: { sessions: TerminalSession[] }) =>
            useTerminalStore.getState().setSessions(sessions)
          )
          .catch(() => undefined);
      }
      break;
    }
    case "terminal.session.closed": {
      const termId = String(payload.termId);
      useTerminalStore.getState().removeSession(termId);
      terminalRegistry.dispose(termId);
      break;
    }
    case "git.state.changed":
      useGitStore.getState().setLive({
        branch: String(payload.branch),
        isClean: Boolean(payload.isClean),
        changedFiles: Number(payload.changedFiles ?? 0),
      });
      useGitStore.getState().bumpStateVersion();
      break;
    case "db.approval.requested":
      // The agent is parked on a DB command until the user answers.
      useDbApprovalStore.getState().add(frame.payload as DbApprovalRequest);
      break;
    case "db.approval.resolved":
      // Answered here, or expired / cancelled agent-side — either way, go.
      useDbApprovalStore.getState().remove(String(payload.id));
      break;
    case "git.flow.requested":
      // The agent was blocked from running git itself — ask the user.
      useGitFlowStore.getState().requestFlow(frame.payload as GitFlowRequest);
      break;
    case "knowledge.indexing.progress": {
      const progress = frame.payload as IndexingProgress;
      const store = useKnowledgeStore.getState();
      store.setIndexing(progress.done >= progress.total ? null : progress);
      break;
    }
    case "knowledge.updated": {
      const store = useKnowledgeStore.getState();
      store.noteUpdate({
        files: (payload.files as string[]) ?? [],
        symbolsDelta: Number(payload.symbolsDelta ?? 0),
        edgesDelta: Number(payload.edgesDelta ?? 0),
        embeddingsDelta: Number(payload.embeddingsDelta ?? 0),
        ts: frame.ts,
      });
      store.bumpStatsVersion();
      break;
    }
    case "knowledge.feature.updated":
    case "knowledge.lesson.saved":
      scheduleKnowledgeRefetch();
      break;
    case "knowledge.features.scan": {
      const phase = String(payload.phase) as "discover" | "summarize" | "done";
      const done = Number(payload.done ?? 0);
      const store = useKnowledgeStore.getState();
      // Progress state is cheap — update it every event so the counter is
      // smooth without re-rendering the panel's data.
      store.setFeatureScan(
        phase === "done"
          ? null
          : {
              phase,
              done,
              total: Number(payload.total ?? 0),
              current: payload.current as string | undefined,
            }
      );
      // The heavy refetch is time-throttled; the end forces a final bump.
      scheduleKnowledgeRefetch(phase === "done");
      break;
    }
    // knowledge.retrieved / impact.radius / edit.impact no longer pin lines
    // into the chat transcript — they remain live in the activity feed while
    // a task runs, and as cards in the Timeline.
    case "plan.created":
      if (convId) {
        sessions.setPlan(convId, frame.payload as never);
      }
      break;
    case "plan.step.updated":
      if (convId) {
        sessions.updatePlanStep(
          convId,
          String(payload.stepId),
          payload.status as never,
          payload.note as string | undefined
        );
      }
      break;
    case "file.changed": {
      const ws = useWorkspaceStore.getState();
      ws.bumpTreeVersion();
      const changedPath = String(payload.path);
      if (ws.selectedPath === changedPath) {
        void bridge
          .rpc("fs.readFile", { path: changedPath })
          .then((file) =>
            useWorkspaceStore
              .getState()
              .refreshSelectedFile(file.content, file.mtime)
          )
          .catch(() => useWorkspaceStore.getState().clearSelected());
      }
      break;
    }
  }

  if (!NON_TIMELINE_TOPICS.has(frame.topic)) {
    useTimelineStore.getState().add({
      key: `${frame.topic}:${frame.seq}`,
      topic: frame.topic,
      ts: frame.ts,
      taskId: frame.taskId,
      conversationId: convId,
      payload: frame.payload,
    });
  }
}
