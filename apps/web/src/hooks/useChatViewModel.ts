import type { PipelineStage, Plan } from "@atelier/protocol";
import { useConnectionStore } from "@/state/connection.store";
import {
  useSessionsStore,
  type AgentAction,
  type ExecutionTimelineVm,
  type LiveDiff,
  type SessionVm,
} from "@/state/sessions.store";
import type { ChatItemVm } from "@/types";

/** Shared empties so "no session" never hands the view a fresh array. */
const NO_ITEMS: ChatItemVm[] = [];
const NO_ACTIONS: AgentAction[] = [];
const NO_DIFFS: LiveDiff[] = [];
const NO_EXECUTIONS: ExecutionTimelineVm[] = [];

export interface ChatViewModel {
  /** Bridge is up AND a session is selected. */
  connected: boolean;
  sessionTitle: string;
  items: ChatItemVm[];
  thinking: string;
  actions: AgentAction[];
  liveDiffs: LiveDiff[];
  executions: ExecutionTimelineVm[];
  activeTaskId: string | null;
  plan: Plan | null;
  stage: PipelineStage | null;
  taskStartedAt: number | null;
  cancelling: boolean;
  busy: boolean;
  lastError: string | null;
}

/**
 * ViewModel for the chat transcript. Every field is read through its own
 * selector so the panel re-renders on streaming deltas without dragging the
 * rest of the console (Monaco, xterm, timeline, 3D graph) along with it —
 * the shell deliberately does NOT subscribe to any of this.
 */
export function useChatViewModel(): ChatViewModel {
  const online = useConnectionStore((s) => s.state === "connected");
  const hasSession = useSessionsStore((s) => s.selectedId !== null);
  const sessionTitle = useSessionsStore((s) => {
    const id = s.selectedId;
    return (id ? s.sessions[id]?.conversation.title : null) ?? "No session";
  });
  const items = useSessionsStore((s) => pick(s, (v) => v.items));
  const thinking = useSessionsStore((s) => pick(s, (v) => v.thinking));
  const actions = useSessionsStore((s) => pick(s, (v) => v.actions));
  const liveDiffs = useSessionsStore((s) => pick(s, (v) => v.liveDiffs));
  const executions = useSessionsStore((s) => pick(s, (v) => v.executions));
  const activeTaskId = useSessionsStore((s) => pick(s, (v) => v.activeTaskId));
  const plan = useSessionsStore((s) => pick(s, (v) => v.plan));
  const stage = useSessionsStore((s) => pick(s, (v) => v.stage));
  const taskStartedAt = useSessionsStore((s) => pick(s, (v) => v.taskStartedAt));
  const cancelling = useSessionsStore((s) => pick(s, (v) => v.cancelling));
  const status = useSessionsStore((s) => pick(s, (v) => v.status));
  const lastError = useSessionsStore((s) => pick(s, (v) => v.lastError));

  return {
    connected: online && hasSession,
    sessionTitle,
    items: items ?? NO_ITEMS,
    thinking: thinking ?? "",
    actions: actions ?? NO_ACTIONS,
    liveDiffs: liveDiffs ?? NO_DIFFS,
    executions: executions ?? NO_EXECUTIONS,
    activeTaskId: activeTaskId ?? null,
    plan: plan ?? null,
    stage: stage ?? null,
    taskStartedAt: taskStartedAt ?? null,
    cancelling: cancelling ?? false,
    busy: status === "working",
    lastError: lastError ?? null,
  };
}

interface SessionsSlice {
  selectedId: string | null;
  sessions: Record<string, SessionVm>;
}

/** Reads one field of the selected session, undefined when none is. */
function pick<T>(
  state: SessionsSlice,
  read: (session: SessionVm) => T
): T | undefined {
  const id = state.selectedId;
  if (!id) return undefined;
  const session = state.sessions[id];
  return session ? read(session) : undefined;
}
