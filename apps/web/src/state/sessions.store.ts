import { create } from "zustand";
import type {
  PipelineStage,
  Plan,
  PlanStepStatus,
  TaskStatus,
} from "@atelier/protocol";
import type { ChatItemVm, Conversation } from "@/types";

export type SessionStatus = "idle" | "working" | "error";

export interface AgentAction {
  id: string;
  label: string;
  /**
   * The tool's own name (`replace_code`, `Grep`, `Task`, …), kept unflattened
   * beside the prose label. The label answers "what is it doing"; this
   * answers "with what", which is what you need when a run goes wrong and
   * every row reads like a sentence.
   */
  name: string;
  /**
   * The identifying part of the tool's input — a path, a query, a command —
   * rendered short. Shown under the label, so a row says which file rather
   * than just "Editing".
   */
  detail?: string;
  /** Wall time once it finished, straight from tool.completed. */
  durationMs?: number;
  status: "running" | "done" | "failed";
  /**
   * Why it failed, straight from the tool.failed event. Kept on the action
   * so a red X always comes with its reason — a failed edit that only shows
   * an icon tells you nothing about what went wrong.
   */
  error?: string;
  /** Plan step that was active when this tool call began. */
  stepId?: string;
  /** Persisted/streamed tool output, clipped for the review UI. */
  output?: string;
  /** Completed tool result, shaped for review rather than raw JSON. */
  result?: string;
  /** Feed ordering, shared with LiveDiff so diffs slot in chronologically. */
  seq: number;
}

/**
 * A file edit shown inline in the live activity feed, right under the
 * "Editing <path>" action that produced it. Ephemeral: it lives here only
 * while the task runs, then settles into the transcript (see taskEnded).
 */
export interface LiveDiff {
  id: string;
  seq: number;
  path: string;
  before: string;
  after: string;
  /** Plan step that was active when the edit landed. */
  stepId?: string;
}

/** One task reconstructed from the agent's persisted SQLite timeline. */
export interface ExecutionTimelineVm {
  taskId: string;
  request: string;
  report: string;
  /** Original request time, distinct from a queued task's later start time. */
  requestedAt: number;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
  /** Total wall time of the task execution in milliseconds. */
  durationMs: number | null;
  plan: Plan | null;
  actions: AgentAction[];
  diffs: LiveDiff[];
  logs: ChatItemVm[];
  /** Identifies a standalone Page preview review execution. */
  frontendReview?: boolean;
  /** Persisted screenshot evidence restored from the review request metadata. */
  images?: string[];
}

/**
 * Monotonic feed clock. Actions and live diffs both stamp themselves from
 * it so the feed can interleave them by insertion order across the two
 * arrays. Module-level (not store state) — it's write-only ordering, so
 * React never needs to see it.
 */
let feedSeq = 0;

/**
 * How many tool rows a conversation keeps. A single turn can easily run a
 * hundred reads and searches now that the SDK's own tools report too, and
 * being able to scroll back over what the agent actually did is the point
 * of the rail.
 */
const MAX_ACTIONS = 200;

export interface SessionVm {
  conversation: Conversation;
  items: ChatItemVm[];
  thinking: string;
  activeTaskId: string | null;
  status: SessionStatus;
  lastError: string | null;
  /** Live feed of what the agent is doing right now. */
  actions: AgentAction[];
  /** Diffs from the running task, shown inline in the live feed. */
  liveDiffs: LiveDiff[];
  /** Completed and restored task timelines, newest first. */
  executions: ExecutionTimelineVm[];
  /** Last persisted/live text used by the sidebar before full hydration. */
  previewText: string | null;
  /** Current task plan (pipeline stage 4) with live step statuses. */
  plan: Plan | null;
  /** Pipeline stage the running task is in — the live progress line. */
  stage: PipelineStage | null;
  /** When the running task started, for the elapsed counter. */
  taskStartedAt: number | null;
  /** A cancel was sent; the task has not stopped yet. */
  cancelling: boolean;
  /**
   * Follow-ups typed while this session was busy, oldest first. They are
   * already in the transcript and already persisted by the agent; this only
   * tracks which are still waiting, so the composer can say how many are in
   * line and offer to drop them.
   */
  queuedTaskIds: string[];
  /** Messages loaded from the agent at least once. */
  hydrated: boolean;
}

interface SessionsStore {
  sessions: Record<string, SessionVm>;
  order: string[];
  selectedId: string | null;
  /** taskId -> conversationId, learned from task.start / task.started. */
  taskMap: Record<string, string>;

  upsertConversations: (conversations: Conversation[]) => void;
  addSession: (conversation: Conversation, select?: boolean) => void;
  select: (conversationId: string) => void;
  /** Drops a chat locally; the agent delete is issued by the ViewModel. */
  removeSession: (conversationId: string) => void;
  renameSession: (conversationId: string, title: string) => void;
  setPreview: (conversationId: string, previewText: string | null) => void;
  hydrate: (conversationId: string, items: ChatItemVm[]) => void;
  mapTask: (taskId: string, conversationId: string) => void;
  conversationForTask: (taskId: string) => string | undefined;

  addUserMessage: (
    conversationId: string,
    id: string,
    text: string,
    images?: string[]
  ) => void;
  /** Pins a knowledge/impact log line into the chat transcript. */
  pinLog: (
    conversationId: string,
    id: string,
    topic: string,
    text: string,
    detail?: string
  ) => void;
  /** Pins an agent file edit into the chat transcript as an inline diff. */
  pinDiff: (
    conversationId: string,
    id: string,
    path: string,
    before: string,
    after: string
  ) => void;
  appendAssistantDelta: (
    conversationId: string,
    messageId: string,
    delta: string
  ) => void;
  completeAssistantMessage: (
    conversationId: string,
    messageId: string,
    text: string,
    taskId?: string
  ) => void;
  appendThinking: (conversationId: string, delta: string) => void;
  actionStarted: (
    conversationId: string,
    id: string,
    label: string,
    name: string,
    detail?: string
  ) => void;
  actionFinished: (
    conversationId: string,
    id: string,
    status: "done" | "failed",
    error?: string,
    durationMs?: number,
    result?: string
  ) => void;
  actionOutput: (conversationId: string, id: string, chunk: string) => void;
  setExecutions: (
    conversationId: string,
    executions: ExecutionTimelineVm[]
  ) => void;
  setStage: (conversationId: string, stage: PipelineStage) => void;
  taskCancelling: (conversationId: string) => void;
  /**
   * A send the agent queued behind the running task. Deliberately does NOT
   * touch activeTaskId or status: the running task still owns the live feed,
   * and this turn will announce itself with task.started when it begins.
   */
  taskQueued: (conversationId: string, taskId: string) => void;
  taskStarted: (conversationId: string, taskId: string, title?: string) => void;
  /**
   * After a reload, restores the busy state for tasks the backend reports as
   * still running, and re-maps taskId -> conversationId so live events route
   * again. Without this the composer looks idle while a task is in flight.
   */
  restoreActiveTasks: (
    tasks: { id: string; conversationId: string; startedAt: number }[]
  ) => void;
  /**
   * `taskId` identifies WHICH task ended. A cancelled follow-up that never
   * ran only leaves the queue — without the id it would tear down the live
   * state of the task still running in the same session.
   */
  taskEnded: (
    conversationId: string,
    outcome: "completed" | "cancelled" | "error",
    error?: string,
    taskId?: string
  ) => void;
  setPlan: (conversationId: string, plan: Plan) => void;
  updatePlanStep: (
    conversationId: string,
    stepId: string,
    status: PlanStepStatus,
    note?: string
  ) => void;
}

function patch(
  sessions: Record<string, SessionVm>,
  id: string,
  update: (s: SessionVm) => Partial<SessionVm>
): Record<string, SessionVm> {
  const session = sessions[id];
  if (!session) return sessions;
  return { ...sessions, [id]: { ...session, ...update(session) } };
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: {},
  order: [],
  selectedId: null,
  taskMap: {},

  upsertConversations: (conversations) =>
    set((s) => {
      const sessions = { ...s.sessions };
      const order = [...s.order];
      for (const conversation of conversations) {
        const existing = sessions[conversation.id];
        if (existing) {
          sessions[conversation.id] = { ...existing, conversation };
        } else {
          sessions[conversation.id] = {
            conversation,
            items: [],
            thinking: "",
            activeTaskId: null,
            status: "idle",
            lastError: null,
            actions: [],
            liveDiffs: [],
            executions: [],
            previewText: null,
            plan: null,
            stage: null,
            taskStartedAt: null,
            cancelling: false,
            queuedTaskIds: [],
            hydrated: false,
          };
          order.push(conversation.id);
        }
      }
      const selectedId = s.selectedId ?? order[0] ?? null;
      return { sessions, order, selectedId };
    }),

  addSession: (conversation, select = true) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [conversation.id]: {
          conversation,
          items: [],
          thinking: "",
          activeTaskId: null,
          status: "idle",
          lastError: null,
          actions: [],
          liveDiffs: [],
          executions: [],
          previewText: null,
          plan: null,
          stage: null,
          taskStartedAt: null,
          cancelling: false,
          queuedTaskIds: [],
          hydrated: true,
        },
      },
      order: [conversation.id, ...s.order.filter((id) => id !== conversation.id)],
      selectedId: select ? conversation.id : s.selectedId,
    })),

  select: (selectedId) => set({ selectedId }),

  removeSession: (conversationId) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[conversationId];
      const order = s.order.filter((id) => id !== conversationId);
      // Deleting the open chat must land somewhere, not on a blank pane.
      const selectedId =
        s.selectedId === conversationId ? (order[0] ?? null) : s.selectedId;
      // Its tasks can no longer resolve a conversation; drop the mappings so
      // late events from a cancelled run don't linger in the map.
      const taskMap = Object.fromEntries(
        Object.entries(s.taskMap).filter(([, id]) => id !== conversationId)
      );
      return { sessions, order, selectedId, taskMap };
    }),

  renameSession: (conversationId, title) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        conversation: { ...session.conversation, title },
      })),
    })),

  setPreview: (conversationId, previewText) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({ previewText })),
    })),

  hydrate: (conversationId, items) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({
        items,
        previewText: previewFromItems(items),
        hydrated: true,
      })),
    })),

  mapTask: (taskId, conversationId) =>
    set((s) => ({ taskMap: { ...s.taskMap, [taskId]: conversationId } })),

  conversationForTask: (taskId) => get().taskMap[taskId],

  addUserMessage: (conversationId, id, text, images) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        items: [
          ...session.items,
          {
            id,
            role: "user",
            text,
            createdAt: Date.now(),
            ...(images?.length ? { images } : {}),
          },
        ],
        previewText: text,
      })),
    })),

  pinLog: (conversationId, id, topic, text, detail) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        items: [
          ...session.items,
          {
            id,
            taskId: session.activeTaskId ?? undefined,
            role: "log",
            text,
            logTopic: topic,
            ...(detail ? { logDetail: detail } : {}),
          },
        ],
        previewText: text,
      })),
    })),

  pinDiff: (conversationId, id, path, before, after) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => {
        const diff = { path, before, after };
        // Persist into the transcript for the permanent record (order matters:
        // the diff belongs between the edit and any later assistant message).
        const items = [
          ...session.items,
          {
            id,
            taskId: session.activeTaskId ?? undefined,
            role: "diff" as const,
            text: path,
            diff,
          },
        ];
        // While the task runs the transcript copy is hidden (ChatPanel skips
        // ids in liveDiffs) and this live copy renders inside the activity
        // feed, right under the "Editing <path>" action that produced it —
        // so the diff shows up where the work is happening, not detached at
        // the top. On task end liveDiffs clears and the transcript takes over.
        const liveDiffs = [
          ...session.liveDiffs,
          {
            id,
            seq: feedSeq++,
            path,
            before,
            after,
            stepId:
              activePlanStepId(session.plan) ??
              lastOwnedStepId(session.actions),
          },
        ];
        return { items, liveDiffs, previewText: path };
      }),
    })),

  appendAssistantDelta: (conversationId, messageId, delta) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => {
        const items = session.items;
        const lastIndex = items.length - 1;
        // Common streaming case: the token belongs to the last item, so we
        // can skip the scan entirely.
        const last = lastIndex >= 0 ? items[lastIndex] : undefined;
        if (last && last.id === messageId) {
          const updated = items.slice();
          updated[lastIndex] = { ...last, text: last.text + delta };
          return {
            items: updated,
            previewText: updated[lastIndex]?.text ?? session.previewText,
            thinking: session.activeTaskId
              ? liveStatusLine(session.thinking, delta)
              : session.thinking,
          };
        }
        const index = items.findIndex((i) => i.id === messageId);
        const found = index !== -1 ? items[index] : undefined;
        if (found) {
          const updated = items.slice();
          updated[index] = { ...found, text: found.text + delta };
          return {
            items: updated,
            previewText: updated[index]?.text ?? session.previewText,
            thinking: session.activeTaskId
              ? liveStatusLine(session.thinking, delta)
              : session.thinking,
          };
        }
        return {
          // During a run, assistant deltas are progress chatter. Keep them
          // out of the transcript until chat.message.completed supplies the
          // final answer, and surface only one replacing status line.
          thinking: session.activeTaskId
            ? liveStatusLine(session.thinking, delta)
            : session.thinking,
          previewText: session.activeTaskId ? session.previewText : delta,
          items: session.activeTaskId
            ? items
            : [
                ...items,
                { id: messageId, role: "assistant", text: delta, streaming: true },
              ],
        };
      }),
    })),

  /**
   * Finishes the run's assistant message AND moves it to the end.
   *
   * Every streamed token of a task shares one message id, so the item is
   * created at the first delta — before the edits, diffs, and review that
   * follow — and it would otherwise sit above them with the final report
   * (written last) stranded near the top. Reloading already puts it last,
   * since it is persisted with the task's end time; this makes the live
   * transcript agree with that order instead of asking for a scroll up.
   */
  completeAssistantMessage: (conversationId, messageId, text, taskId) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => {
        const rest = session.items.filter((i) => i.id !== messageId);
        const existing = session.items.find((i) => i.id === messageId);
        const owner = taskId ?? session.activeTaskId ?? existing?.taskId;
        return {
          items: [
            ...rest,
            {
              ...(existing ?? { id: messageId, role: "assistant" as const }),
              id: messageId,
              taskId: owner,
              createdAt: existing?.createdAt ?? Date.now(),
              role: "assistant" as const,
              text,
              streaming: false,
            },
          ],
          previewText: text,
          thinking: "",
          executions: owner
            ? session.executions.map((execution) =>
                execution.taskId === owner ? { ...execution, report: text } : execution
              )
            : session.executions,
        };
      }),
    })),

  appendThinking: (conversationId, delta) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        thinking: liveStatusLine(session.thinking, delta),
      })),
    })),

  actionStarted: (conversationId, id, label, name, detail) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        actions: [
          // A busy turn now reports the SDK's own searches too, so 20 rows
          // covered barely the tail of one. This is a per-conversation
          // in-memory list of small objects; the render decides what to show.
          ...session.actions.slice(-(MAX_ACTIONS - 1)),
          {
            id,
            label,
            name,
            detail,
            status: "running",
            seq: feedSeq++,
            stepId: activePlanStepId(session.plan),
          },
        ],
      })),
    })),

  actionOutput: (conversationId, id, chunk) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        actions: session.actions.map((action) =>
          action.id === id
            ? { ...action, output: appendOutput(action.output, chunk) }
            : action
        ),
      })),
    })),

  actionFinished: (conversationId, id, status, error, durationMs, result) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        actions: session.actions.map((a) =>
          a.id === id ? { ...a, status, error, durationMs, result } : a
        ),
      })),
    })),

  setStage: (conversationId, stage) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({ stage })),
    })),

  /** Optimistic: the stop button reacts before the task actually ends. */
  taskCancelling: (conversationId) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({ cancelling: true })),
    })),

  taskQueued: (conversationId, taskId) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        queuedTaskIds: session.queuedTaskIds.includes(taskId)
          ? session.queuedTaskIds
          : [...session.queuedTaskIds, taskId],
        items: tagLatestRequest(session.items, taskId),
      })),
      taskMap: { ...s.taskMap, [taskId]: conversationId },
    })),

  taskStarted: (conversationId, taskId, title) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        // Its turn came: it leaves the line and takes the live feed.
        queuedTaskIds: session.queuedTaskIds.filter((id) => id !== taskId),
        items: tagLatestRequest(session.items, taskId),
        activeTaskId: taskId,
        status: "working",
        lastError: null,
        actions: [],
        liveDiffs: [],
        plan: null,
        stage: null,
        taskStartedAt: Date.now(),
        cancelling: false,
        // Starting a run is the strongest "last active" signal there is, so
        // stamp it here — that is what floats the chat to the top of the list.
        conversation: {
          ...session.conversation,
          ...(title ? { title } : {}),
          updatedAt: Date.now(),
        },
      })),
      taskMap: { ...s.taskMap, [taskId]: conversationId },
    })),

  restoreActiveTasks: (tasks) =>
    set((s) => {
      const sessions = { ...s.sessions };
      const taskMap = { ...s.taskMap };
      for (const t of tasks) {
        taskMap[t.id] = t.conversationId;
        const session = sessions[t.conversationId];
        if (!session) continue;
        // Already live in this tab (event beat the restore) — don't clobber
        // its accumulated feed.
        if (session.activeTaskId === t.id) continue;
        sessions[t.conversationId] = {
          ...session,
          activeTaskId: t.id,
          status: "working",
          taskStartedAt: t.startedAt,
          cancelling: false,
          lastError: null,
        };
      }
      return { sessions, taskMap };
    }),

  taskEnded: (conversationId, outcome, error, taskId) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) =>
        taskId && session.queuedTaskIds.includes(taskId)
          ? { queuedTaskIds: session.queuedTaskIds.filter((id) => id !== taskId) }
          : finishExecution(session, outcome, error, taskId)
      ),
    })),

  setPlan: (conversationId, plan) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({ plan })),
    })),

  updatePlanStep: (conversationId, stepId, status, note) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        plan: session.plan
          ? {
              ...session.plan,
              steps: session.plan.steps.map((step) =>
                step.id === stepId
                  ? { ...step, status, note: note ?? step.note }
                  : step
              ),
            }
          : null,
      })),
    })),

  setExecutions: (conversationId, executions) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({
        executions: sortExecutions(executions),
      })),
    })),
}));

const MAX_REVIEW_OUTPUT = 4_000;

function appendOutput(current: string | undefined, chunk: string): string {
  return `${current ?? ""}${chunk}`.slice(-MAX_REVIEW_OUTPUT);
}

function activePlanStepId(plan: Plan | null): string | undefined {
  return plan?.steps.find((step) => step.status === "in-progress")?.id;
}

function lastOwnedStepId(actions: AgentAction[]): string | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (actions[index]?.stepId) return actions[index]?.stepId;
  }
  return undefined;
}

function tagLatestRequest(items: ChatItemVm[], taskId: string): ChatItemVm[] {
  let index = -1;
  for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
    const item = items[cursor];
    if (item?.role === "user" && item.taskId === undefined) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return items;
  const next = items.slice();
  next[index] = { ...next[index]!, taskId };
  return next;
}

function previewFromItems(items: ChatItemVm[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const text = items[index]?.text?.replaceAll("\n", " ").trim();
    if (text) return text;
  }
  return null;
}

function finishExecution(
  session: SessionVm,
  outcome: "completed" | "cancelled" | "error",
  error?: string,
  taskId?: string
): Partial<SessionVm> {
  const owner = taskId ?? session.activeTaskId;
  const request = owner
    ? session.items.find((item) => item.taskId === owner && item.role === "user")
        ?.text ?? ""
    : "";
  const requestedAt = owner
    ? session.items.find((item) => item.taskId === owner && item.role === "user")
        ?.createdAt ?? session.taskStartedAt ?? Date.now()
    : session.taskStartedAt ?? Date.now();
  const report = owner
    ? [...session.items]
        .reverse()
        .find((item) => item.taskId === owner && item.role === "assistant")
        ?.text ?? ""
    : "";
  const execution = owner
    ? {
        taskId: owner,
        request,
        report,
        requestedAt,
        status: outcome,
        startedAt: session.taskStartedAt ?? Date.now(),
        endedAt: Date.now(),
        durationMs: session.taskStartedAt ? Date.now() - session.taskStartedAt : null,
        plan: session.plan,
        actions: session.actions,
        diffs: session.liveDiffs,
        logs: session.items.filter(
          (item) => item.taskId === owner && item.role === "log"
        ),
      }
    : null;
  return {
    activeTaskId: null,
    thinking: "",
    stage: null,
    taskStartedAt: null,
    cancelling: false,
    actions: [],
    liveDiffs: [],
    plan: null,
    executions: execution
      ? sortExecutions([
          ...session.executions.filter((item) => item.taskId !== owner),
          execution,
        ])
      : session.executions,
    status: outcome === "error" ? "error" : "idle",
    lastError: outcome === "error" ? (error ?? "task failed") : null,
  };
}

function sortExecutions(executions: ExecutionTimelineVm[]): ExecutionTimelineVm[] {
  return [...executions].sort(
    (left, right) => left.requestedAt - right.requestedAt
  );
}

/** Below this, a freshly started sentence keeps the previous one for company. */
const MIN_LIVE_CHARS = 24;

/**
 * Sentences that hand the turn back to the user ("exit plan mode on your
 * side", "say the word and I'll implement it"). They are addressed to a
 * reader, not a description of work in flight, so leaving one frozen under
 * a spinning THINKING header is what makes a running task look stuck.
 * Dropped from the live line; the full text still lands in the transcript.
 */
const HANDBACK =
  /\b(?:exit plan mode|uncheck plan|re-?run without it|say the word|let me know (?:if|when|whether)|shall i|would you like me to|on your side)\b/i;

/**
 * The single line of live thinking under the THINKING header.
 *
 * Sentences end at punctuation FOLLOWED BY SPACE. Splitting on every "."
 * made a sentence out of every file name and host the model reasoned about
 * — "powertranz.go", "x.com" — so the panel flashed fragments like "com ."
 * instead of the thought.
 */
function liveStatusLine(current: string, delta: string): string {
  const text = `${current}${delta}`.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && !HANDBACK.test(sentence));
  // Nothing left means the model spent this stretch talking to the user; the
  // block falls back to the current step, which is the honest status.
  if (sentences.length === 0) return "";
  const latest = sentences[sentences.length - 1]?.trim() ?? text;
  // A sentence begins life two characters long; showing that alone reads
  // as noise, so the one before it stays until the new one has grown.
  const previous = sentences[sentences.length - 2];
  const line =
    latest.length < MIN_LIVE_CHARS && previous
      ? `${previous.trim()} ${latest}`.trim()
      : latest;
  return line.length > 180 ? line.slice(-180).trimStart() : line;
}
