import type { Diff, EventFrame, TerminalSession } from "@atelier/protocol";
import { bridge } from "./bridge-client.js";
import { terminalRegistry } from "./terminal-registry.js";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";
import { useSessionsStore } from "@/state/sessions.store";
import { useTerminalStore } from "@/state/terminal.store";
import { useTimelineStore } from "@/state/timeline.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/** Topics rendered live elsewhere, not as timeline cards. */
const NON_TIMELINE_TOPICS = new Set([
  "chat.message.delta",
  "chat.message.completed",
  "agent.thinking.delta",
  "terminal.data",
]);

let started = false;

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

  bridge.subscribe("*", (frame) => dispatch(frame));
  bridge.connect();
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
    case "task.started":
      if (convId && frame.taskId) {
        sessions.taskStarted(convId, frame.taskId);
      }
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
      useGitStore.getState().bumpStateVersion();
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
