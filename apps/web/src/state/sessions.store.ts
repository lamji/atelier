import { create } from "zustand";
import type { PipelineStage, Plan, PlanStepStatus } from "@atelier/protocol";
import type { ChatItemVm, Conversation } from "@/types";

export type SessionStatus = "idle" | "working" | "error";

export interface AgentAction {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  /**
   * Why it failed, straight from the tool.failed event. Kept on the action
   * so a red X always comes with its reason — a failed edit that only shows
   * an icon tells you nothing about what went wrong.
   */
  error?: string;
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
}

/**
 * Monotonic feed clock. Actions and live diffs both stamp themselves from
 * it so the feed can interleave them by insertion order across the two
 * arrays. Module-level (not store state) — it's write-only ordering, so
 * React never needs to see it.
 */
let feedSeq = 0;

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
  /** Current task plan (pipeline stage 4) with live step statuses. */
  plan: Plan | null;
  /** Pipeline stage the running task is in — the live progress line. */
  stage: PipelineStage | null;
  /** When the running task started, for the elapsed counter. */
  taskStartedAt: number | null;
  /** A cancel was sent; the task has not stopped yet. */
  cancelling: boolean;
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
    text: string
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
    text: string
  ) => void;
  appendThinking: (conversationId: string, delta: string) => void;
  actionStarted: (conversationId: string, id: string, label: string) => void;
  actionFinished: (
    conversationId: string,
    id: string,
    status: "done" | "failed",
    error?: string
  ) => void;
  setStage: (conversationId: string, stage: PipelineStage) => void;
  taskCancelling: (conversationId: string) => void;
  taskStarted: (conversationId: string, taskId: string, title?: string) => void;
  /**
   * After a reload, restores the busy state for tasks the backend reports as
   * still running, and re-maps taskId -> conversationId so live events route
   * again. Without this the composer looks idle while a task is in flight.
   */
  restoreActiveTasks: (
    tasks: { id: string; conversationId: string; startedAt: number }[]
  ) => void;
  taskEnded: (
    conversationId: string,
    outcome: "completed" | "cancelled" | "error",
    error?: string
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
            plan: null,
            stage: null,
            taskStartedAt: null,
            cancelling: false,
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
          plan: null,
          stage: null,
          taskStartedAt: null,
          cancelling: false,
          hydrated: true,
        },
      },
      order: [conversation.id, ...s.order.filter((id) => id !== conversation.id)],
      selectedId: select ? conversation.id : s.selectedId,
    })),

  select: (selectedId) => set({ selectedId }),

  hydrate: (conversationId, items) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({
        items,
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
          { id, role: "user", text, ...(images?.length ? { images } : {}) },
        ],
      })),
    })),

  pinLog: (conversationId, id, topic, text) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        items: [...session.items, { id, role: "log", text, logTopic: topic }],
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
          { id, role: "diff" as const, text: path, diff },
        ];
        // While the task runs the transcript copy is hidden (ChatPanel skips
        // ids in liveDiffs) and this live copy renders inside the activity
        // feed, right under the "Editing <path>" action that produced it —
        // so the diff shows up where the work is happening, not detached at
        // the top. On task end liveDiffs clears and the transcript takes over.
        const liveDiffs = [
          ...session.liveDiffs,
          { id, seq: feedSeq++, path, before, after },
        ];
        return { items, liveDiffs };
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
          return { items: updated };
        }
        const index = items.findIndex((i) => i.id === messageId);
        const found = index !== -1 ? items[index] : undefined;
        if (found) {
          const updated = items.slice();
          updated[index] = { ...found, text: found.text + delta };
          return { items: updated };
        }
        return {
          items: [
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
  completeAssistantMessage: (conversationId, messageId, text) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => {
        const rest = session.items.filter((i) => i.id !== messageId);
        const existing = session.items.find((i) => i.id === messageId);
        return {
          items: [
            ...rest,
            {
              ...(existing ?? { id: messageId, role: "assistant" as const }),
              id: messageId,
              role: "assistant" as const,
              text,
              streaming: false,
            },
          ],
          thinking: "",
        };
      }),
    })),

  appendThinking: (conversationId, delta) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        thinking: session.thinking + delta,
      })),
    })),

  actionStarted: (conversationId, id, label) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        actions: [
          ...session.actions.slice(-19),
          { id, label, status: "running", seq: feedSeq++ },
        ],
      })),
    })),

  actionFinished: (conversationId, id, status, error) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        actions: session.actions.map((a) =>
          a.id === id ? { ...a, status, error } : a
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

  taskStarted: (conversationId, taskId, title) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, (session) => ({
        activeTaskId: taskId,
        status: "working",
        lastError: null,
        actions: [],
        liveDiffs: [],
        plan: null,
        stage: null,
        taskStartedAt: Date.now(),
        cancelling: false,
        conversation: title
          ? { ...session.conversation, title }
          : session.conversation,
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

  taskEnded: (conversationId, outcome, error) =>
    set((s) => ({
      sessions: patch(s.sessions, conversationId, () => ({
        activeTaskId: null,
        thinking: "",
        stage: null,
        taskStartedAt: null,
        cancelling: false,
        // Run over: drop the live copies so the (chronologically-placed)
        // transcript diffs become the visible record again.
        liveDiffs: [],
        status: outcome === "error" ? "error" : "idle",
        lastError: outcome === "error" ? (error ?? "task failed") : null,
      })),
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
}));
