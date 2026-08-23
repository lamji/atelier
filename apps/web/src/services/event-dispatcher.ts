import type {
  ContextRequestStats,
  ApprovalRequest,
  LlmRequest,
  DbApprovalRequest,
  Diff,
  EventFrame,
  GitFlowRequest,
  Plan,
  TerminalSession,
  TaskInfo,
  UsageSnapshot,
} from "@atelier/protocol";
import { bridge } from "./bridge-client.js";
import { actionDetail, actionLabel, actionResult } from "@/lib/tool-labels";
import { isImagePath } from "@/lib/image-file";
import {
  llmRequestDetail,
  llmRequestSummary,
  stripHiddenContext,
} from "@atelier/shared";
import {
  FRONTEND_REVIEW_REQUEST_EVENT,
  frontendReviewRequest,
  frontendReviewTimelineContext,
} from "@/lib/frontend-review";
import { isCliConsoleSession, useCliConsoleStore } from "./cli-console.js";
import { terminalRegistry } from "./terminal-registry.js";
import { useConnectionStore } from "@/state/connection.store";
import { useDbApprovalStore } from "@/state/db-approval.store";
import { useGitFlowStore } from "@/state/git-flow.store";
import { useGitStore } from "@/state/git.store";
import { useKnowledgeStore } from "@/state/knowledge.store";
import { useMarkdownStore } from "@/state/markdown.store";
import { useProcessConsoleStore } from "@/state/process-console.store";
import type { ConsoleSource } from "@/state/process-console.store";
import type { IndexingProgress } from "@/state/knowledge.store";
import {
  useSessionsStore,
  type AgentAction,
  type ExecutionTimelineVm,
  type LiveDiff,
} from "@/state/sessions.store";
import { useTerminalStore } from "@/state/terminal.store";
import { useTimelineStore } from "@/state/timeline.store";
import { useUsageStore } from "@/state/usage.store";
import { useContextStore } from "@/state/context.store";
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

/**
 * The events that rebuild the process rail (plan + activity feed) for a task
 * that is still running. Deliberately narrow: the transcript is restored from
 * the agent's own message history, so replaying chat/diff topics here would
 * duplicate it, and `task.started` would wipe the very feed being rebuilt.
 */
const PROCESS_REPLAY_TOPICS = new Set([
  "plan.created",
  "plan.step.updated",
  "pipeline.stage.started",
  "tool.started",
  "tool.completed",
  "tool.failed",
]);

/** One page of timeline per round trip; a long run pages until it is drained. */
const REPLAY_PAGE = 200;

/**
 * Rebuild the process rail for a task from the agent's persisted timeline.
 *
 * The rail's state (plan, activity feed) only ever lived in renderer memory,
 * so leaving a workspace and coming back — which resets every workspace-scoped
 * store — showed an empty rail for a task that was still running. The agent
 * kept the record all along; this reads it back.
 *
 * Call AFTER the task is mapped to its conversation: frames carry a taskId and
 * resolve their conversation through that map.
 */
export async function replayProcessTimeline(taskId: string): Promise<void> {
  let cursor: number | undefined;
  do {
    const { entries, nextCursor } = await bridge.rpc("task.getTimeline", {
      taskId,
      cursor,
      limit: REPLAY_PAGE,
    });
    for (const frame of entries) {
      if (PROCESS_REPLAY_TOPICS.has(frame.topic)) dispatch(frame);
    }
    cursor = nextCursor ?? undefined;
  } while (cursor !== undefined);
}

/** Reconstruct one reviewable execution from the persisted SQLite event log. */
export async function loadExecutionTimeline(
  task: TaskInfo
): Promise<ExecutionTimelineVm> {
  const entries: EventFrame[] = [];
  let cursor: number | undefined;
  do {
    const page = await bridge.rpc("task.getTimeline", {
      taskId: task.id,
      cursor,
      limit: REPLAY_PAGE,
    });
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const execution = buildExecutionTimeline(task, entries);
  const review = frontendReviewTimelineContext(task.prompt);
  if (!review) return execution;
  const images = review.screenshotPath
    ? await bridge
        .rpc("fs.readImage", { path: review.screenshotPath })
        .then((image) => [image.dataUrl])
        .catch(() => [])
    : [];
  return {
    ...execution,
    frontendReview: true,
    ...(review.displayRequest ? { request: review.displayRequest } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

function buildExecutionTimeline(
  task: TaskInfo,
  entries: EventFrame[]
): ExecutionTimelineVm {
  let plan: Plan | null = null;
  let activeStepId: string | undefined;
  let order = 0;
  const actions: AgentAction[] = [];
  const diffs: LiveDiff[] = [];
  const logs: ExecutionTimelineVm["logs"] = [];

  for (const frame of entries) {
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (frame.topic === "plan.created") {
      plan = structuredClone(frame.payload as NonNullable<typeof plan>);
      activeStepId = activePlanStep(plan);
      continue;
    }
    if (frame.topic === "plan.step.updated" && plan) {
      const currentPlan: Plan = plan;
      const stepId = String(payload.stepId);
      const status = String(payload.status) as (typeof currentPlan.steps)[number]["status"];
      plan = {
        ...currentPlan,
        steps: currentPlan.steps.map((step) =>
          step.id === stepId
            ? {
                ...step,
                status,
                note: payload.note ? String(payload.note) : step.note,
              }
            : step
        ),
      };
      activeStepId = status === "in-progress" ? stepId : activePlanStep(plan);
      continue;
    }
    if (frame.topic === "tool.started") {
      const name = String(payload.name);
      actions.push({
        id: String(payload.toolCallId),
        label: actionLabel(name, payload.input),
        name,
        detail: actionDetail(name, payload.input),
        status: "running",
        stepId: activeStepId,
        seq: order++,
      });
      continue;
    }
    if (frame.topic === "tool.output") {
      const action = actions.find((item) => item.id === String(payload.toolCallId));
      if (action) action.output = appendReviewOutput(action.output, String(payload.chunk));
      continue;
    }
    if (frame.topic === "tool.completed" || frame.topic === "tool.failed") {
      const action = actions.find((item) => item.id === String(payload.toolCallId));
      if (action) {
        action.status = frame.topic === "tool.failed" ? "failed" : "done";
        action.error = payload.error ? String(payload.error) : undefined;
        action.durationMs = numberOrUndefined(payload.durationMs);
        if (frame.topic === "tool.completed") {
          action.result = actionResult(action.name, payload.result);
        }
      }
      continue;
    }
    if (frame.topic === "diff.created") {
      const diff = frame.payload as Diff;
      diffs.push({
        id: diff.id,
        path: diff.path,
        before: diff.before,
        after: diff.after,
        stepId: activeStepId ?? lastActionStepId(actions),
        seq: order++,
      });
      continue;
    }
    if (frame.topic === "validation.output") {
      const kind = String(payload.kind);
      const id = `validation:${kind}:${activeStepId ?? "unassigned"}`;
      let action = actions.find((item) => item.id === id);
      if (!action) {
        action = {
          id,
          label: `Validation · ${kind}`,
          name: `validation.${kind}`,
          status: "done",
          stepId: activeStepId,
          seq: order++,
        };
        actions.push(action);
      }
      action.output = appendReviewOutput(action.output, String(payload.chunk));
      continue;
    }
    if (PERSISTED_LOG_TOPICS.has(frame.topic)) {
      const text = logSummary(frame.topic, payload);
      if (text) {
        const detail = logDetail(frame.topic, payload);
        logs.push({
          id: `${task.id}:${frame.topic}:${frame.seq}:${frame.ts}`,
          role: "log",
          text,
          logTopic: frame.topic,
          ...(detail ? { logDetail: detail } : {}),
        });
      }
    }
  }

  return {
    taskId: task.id,
    // The stored prompt is what was SENT, hidden page-preview evidence and
    // all. The card shows the request, so it gets the human half only.
    request: stripHiddenContext(task.prompt),
    report: "",
    requestedAt: task.startedAt,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    durationMs: task.endedAt ? task.endedAt - task.startedAt : null,
    plan,
    actions,
    diffs,
    logs,
  };
}

const PERSISTED_LOG_TOPICS = new Set([
  "knowledge.retrieved",
  "session.recalled",
  "working-memory.reused",
  "scope.escaped",
  "wiki.recalled",
  "wiki.updated",
  "llm.request",
  "scope.locked",
  "skills.selected",
  "impact.radius",
  "edit.impact",
]);

function activePlanStep(plan: ExecutionTimelineVm["plan"]): string | undefined {
  return plan?.steps.find((step) => step.status === "in-progress")?.id;
}

function lastActionStepId(actions: AgentAction[]): string | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (actions[index]?.stepId) return actions[index]?.stepId;
  }
  return undefined;
}

function appendReviewOutput(current: string | undefined, chunk: string): string {
  return `${current ?? ""}${chunk}`.slice(-4_000);
}

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

/** Summary line for a knowledge/impact log pinned into the chat transcript. */
function logSummary(topic: string, payload: Record<string, unknown>): string {
  switch (topic) {
    case "knowledge.retrieved": {
      const chunks = Array.isArray(payload.chunks) ? payload.chunks.length : 0;
      return `Retrieved ${chunks} chunk(s) · ${String(payload.strategy ?? "")}`;
    }
    case "session.recalled":
      return sessionRecalledSummary(payload);
    case "working-memory.reused":
      return workingMemorySummary(payload);
    case "wiki.recalled": {
      const pages = Array.isArray(payload.pages) ? payload.pages : [];
      const labels = pages.map((page) => {
        const p = page as { title?: string; moved?: string[] };
        const moved = Array.isArray(p.moved) ? p.moved.length : 0;
        return `${String(p.title ?? "")}${moved > 0 ? ` (stale: ${moved} source(s) moved)` : ""}`;
      });
      return `Feature wiki: ${labels.join("; ") || "no page"} · ~${Number(payload.tokens ?? 0)} tok`;
    }
    case "wiki.updated": {
      const sections = Array.isArray(payload.changedSections)
        ? payload.changedSections.map(String)
        : [];
      const what = payload.created ? "created" : "updated";
      const detail = sections.length > 0 ? ` — ${sections.slice(0, 4).join(", ")}` : "";
      return `Feature wiki ${what}: ${String(payload.title ?? "")} (${String(payload.path ?? "")})${detail}`;
    }
    case "scope.escaped":
      return `Scope lock let ${String(payload.tool ?? "a tool")} through to ${String(payload.path ?? "")}`;
    case "scope.locked":
      return scopeLockedSummary(payload);
    case "skills.selected": {
      const skills = Array.isArray(payload.skills) ? payload.skills : [];
      const names = skills
        .map((skill) =>
          typeof skill === "object" && skill && "name" in skill
            ? String((skill as { name?: unknown }).name ?? "")
            : ""
        )
        .filter(Boolean);
      return names.length > 0
        ? `Using skills: ${names.map((name) => `/${name}`).join(", ")}`
        : "No task skills selected";
    }
    case "impact.radius":
      return String(payload.summary ?? "Impact radius computed");
    case "edit.impact": {
      const symbol = String(payload.symbol ?? "");
      const reach = String(payload.reach ?? "");
      const summary = String(payload.summary ?? "").slice(0, 90);
      return `${symbol} · ${reach} · ${summary}`;
    }
    case "llm.request":
      return llmRequestSummary(payload as unknown as LlmRequest);
    default:
      return "";
  }
}

/**
 * The expandable body behind a log line. Mirrors the agent's copy in
 * orchestrator.ts so a live row and its reloaded twin read the same.
 */
function logDetail(topic: string, payload: Record<string, unknown>): string {
  if (topic !== "llm.request") return "";
  return llmRequestDetail(payload as unknown as LlmRequest);
}


/**
 * What earlier turns' investigation this turn started from, in one line.
 * Mirrored in apps/web/src/services/event-dispatcher.ts.
 */
function workingMemorySummary(payload: Record<string, unknown>): string {
  const inlined = Number(payload.inlined ?? 0);
  const listed = Number(payload.listed ?? 0);
  const changed = Number(payload.changed ?? 0);
  const searches = Number(payload.searches ?? 0);
  const tokens = Number(payload.tokens ?? 0);
  const paths = Array.isArray(payload.paths)
    ? payload.paths.map(String).filter(Boolean)
    : [];
  const parts: string[] = [];
  if (inlined > 0) parts.push(`${inlined} file(s) re-used from earlier turns`);
  if (changed > 0) parts.push(`${changed} changed since`);
  if (listed > 0) parts.push(`${listed} more remembered by path`);
  const seeded = Number(payload.seeded ?? 0);
  if (seeded > 0) parts.push(`${seeded} owner file(s) from the feature wiki`);
  if (searches > 0) parts.push(`${searches} earlier search(es)`);
  const head = parts.length > 0 ? parts.join(" · ") : "nothing to reuse";
  const tail =
    paths.length > 0
      ? ` — ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}`
      : "";
  return `Reused gathered context: ${head} · ~${tokens} tok${tail}`;
}

/**
 * What the turn remembered, in one line. Mirrors the same function in
 * apps/agent/src/orchestrator/orchestrator.ts so a reloaded transcript reads
 * identically to the live console.
 */
function sessionRecalledSummary(payload: Record<string, unknown>): string {
  const chunks = Number(payload.chunks ?? 0);
  const summaries = Number(payload.summaries ?? 0);
  const turns = Number(payload.turns ?? 0);
  const tokens = Number(payload.tokens ?? 0);
  const labels = Array.isArray(payload.labels)
    ? payload.labels.map(String).filter(Boolean)
    : [];
  const parts: string[] = [];
  if (chunks > 0) parts.push(`${chunks} memory chunk(s)`);
  if (summaries > 0) parts.push(`${summaries} task summary(ies)`);
  if (turns > 0) parts.push(`${turns} prior turn(s)`);
  const head = parts.length > 0 ? parts.join(" · ") : "nothing to recall";
  const tail = labels.length > 0 ? ` — ${labels.join("; ")}` : "";
  return `Recalled session: ${head} · ~${tokens} tok${tail}`;
}

/**
 * The working-set lock, phrased so an inherited lock reads as deliberate.
 * A user who mentioned a folder four turns ago needs to see that it is
 * still the only place the agent can touch.
 */
function scopeLockedSummary(payload: Record<string, unknown>): string {
  const roots = Array.isArray(payload.roots)
    ? payload.roots.map(String).filter(Boolean)
    : [];
  const anchors = Array.isArray(payload.anchors)
    ? payload.anchors.map(String).filter(Boolean)
    : [];
  const repo = typeof payload.repo === "string" ? payload.repo : "";

  if (roots.length === 0) {
    return anchors.length > 0
      ? `Anchored to ${anchors.length} file(s) from earlier turns`
      : "No scope lock";
  }
  const verb = payload.source === "inherited" ? "Still locked to" : "Locked to";
  const where = roots.map((root) => `${root}/`).join(", ");
  const git = repo && repo !== "." ? ` · git: ${repo}` : "";
  const anchored =
    anchors.length > 0 ? ` · ${anchors.length} file(s) anchored` : "";
  return `${verb} ${where}${git}${anchored}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


/**
 * Single subscription point: routes pushed events into the right stores.
 * Session-scoped events resolve their conversation via the payload or the
 * taskId -> conversationId map so parallel agents never cross streams.
 */
export function startEventDispatcher(): void {
  if (started) return;
  started = true;

  // workspaceRoot is stamped by openWorkspace() from the project record;
  // the old hello handshake (and its token) no longer exists.
  bridge.onStatus((state) => {
    useConnectionStore.getState().setState(state);
  });

  // Subscriptions persist on the client across reconnects; the actual
  // connect() is driven by switchProject once a project is selected.
  bridge.subscribe("*", (frame) => dispatch(frame));
}

function dispatch(frame: EventFrame): void {
  const sessions = useSessionsStore.getState();
  const processConsole = useProcessConsoleStore.getState();
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
          String(payload.text),
          frame.taskId
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
    case "context.stats":
      useContextStore.getState().add(frame.payload as ContextRequestStats);
      break;
    case "task.queued":
      // The agent accepted a follow-up behind the running task. The sender's
      // own tab already recorded it; this is what tells every OTHER tab.
      if (convId && frame.taskId) {
        sessions.taskQueued(convId, frame.taskId);
      }
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
        const name = String(payload.name);
        sessions.actionStarted(
          convId,
          String(payload.toolCallId),
          actionLabel(name, payload.input),
          name,
          // The label is prose and sometimes drops the specifics to stay
          // short. This keeps them: which file, which query, which command.
          actionDetail(name, payload.input)
        );
      }
      break;
    case "tool.output":
      // Already published by the agent for every shell command it runs; it
      // had no consumer here, so the output was crossing the wire and being
      // dropped. The console pane is what reads it.
      if (convId) {
        sessions.actionOutput(
          convId,
          String(payload.toolCallId),
          String(payload.chunk)
        );
        processConsole.append(convId, "shell", String(payload.chunk));
      }
      break;
    case "validation.output":
      if (convId) {
        processConsole.append(
          convId,
          payload.kind as ConsoleSource,
          String(payload.chunk)
        );
      }
      break;
    case "tool.completed":
      if (convId) {
        sessions.actionFinished(
          convId,
          String(payload.toolCallId),
          "done",
          undefined,
          numberOrUndefined(payload.durationMs),
          actionResult(String(payload.name), payload.result)
        );
      }
      break;
    case "tool.failed": {
      if (convId) {
        // Carry the reason through: without it the feed shows a red X and
        // nothing else, and a failed edit looks like it simply didn't happen.
        const reason = payload.error ? String(payload.error) : undefined;
        sessions.actionFinished(
          convId,
          String(payload.toolCallId),
          "failed",
          reason,
          numberOrUndefined(payload.durationMs)
        );
        console.error(
          `[tool.failed] ${String(payload.name ?? "tool")}: ${reason ?? "no reason reported"}`
        );
      }
      break;
    }
    // The taskId rides along on all three: a follow-up cancelled before it
    // ever ran must leave the queue WITHOUT tearing down the live state of
    // the task still running in the same session.
    case "task.completed":
      if (convId) {
        sessions.taskEnded(convId, "completed", undefined, frame.taskId);
        if (frame.taskId) {
          void refreshFinishedExecution(convId, frame.taskId).catch(() => undefined);
        }
      }
      break;
    case "task.cancelled":
      if (convId) {
        sessions.taskEnded(convId, "cancelled", undefined, frame.taskId);
        if (frame.taskId) {
          void refreshFinishedExecution(convId, frame.taskId).catch(() => undefined);
        }
      }
      break;
    case "task.error":
      if (convId) {
        sessions.taskEnded(
          convId,
          "error",
          String(payload.message),
          frame.taskId
        );
        if (frame.taskId) {
          void refreshFinishedExecution(convId, frame.taskId).catch(() => undefined);
        }
      }
      break;
    case "diff.created": {
      const diff = frame.payload as Diff;
      if (convId) {
        sessions.pinDiff(convId, diff.id, diff.path, diff.before, diff.after);
      }
      // .atelier is invisible to the watcher (ignored), so writes to the
      // markdown cache refresh its catalog from here instead.
      if (diff.path.startsWith(".atelier/")) {
        void useMarkdownStore.getState().forceRefresh();
      }
      break;
    }
    case "terminal.data":
      terminalRegistry.write(String(payload.termId), String(payload.data));
      break;
    case "terminal.session.created": {
      const store = useTerminalStore.getState();
      if (!store.sessions.some((s) => s.id === payload.termId)) {
        void bridge
          .rpc("terminal.list", {})
          .then(({ sessions }: { sessions: TerminalSession[] }) =>
            // CLI-mode sessions are ptys too, but they live in the main
            // view — they must never appear as bottom-dock tabs.
            useTerminalStore
              .getState()
              .setSessions(
                sessions.filter((s) => !isCliConsoleSession(s.name))
              )
          )
          .catch(() => undefined);
      }
      break;
    }
    case "terminal.session.closed": {
      const termId = String(payload.termId);
      // If this was a CLI-mode session, drop its row from that list too —
      // quitting the CLI is how a session ends.
      useCliConsoleStore.getState().markClosed(termId);
      useTerminalStore.getState().removeSession(termId);
      terminalRegistry.dispose(termId);
      break;
    }
    case "git.state.changed":
      useGitStore.getState().setLive({
        branch: String(payload.branch),
        isClean: Boolean(payload.isClean),
        changedFiles: Number(payload.changedFiles ?? 0),
        conflicts: Number(payload.conflicts ?? 0),
        mergeKind:
          typeof payload.mergeKind === "string" ? payload.mergeKind : null,
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
    case "npm.approval.requested":
      // Package commands share the same approval queue and modal.
      useDbApprovalStore.getState().add(frame.payload as ApprovalRequest);
      break;
    case "npm.approval.resolved":
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
    case "knowledge.retrieved":
    case "session.recalled":
    case "working-memory.reused":
    case "scope.escaped":
    case "wiki.recalled":
    case "wiki.updated":
    case "scope.locked":
    case "skills.selected":
    case "impact.radius":
    case "edit.impact":
    case "llm.request":
      // Pinned into the chat transcript (in addition to the activity feed
      // and the Timeline cards) so the reasoning behind a change stays
      // visible after the task finishes scrolling past it.
      if (convId) {
        sessions.pinLog(
          convId,
          `${frame.topic}:${frame.seq}`,
          frame.topic,
          logSummary(frame.topic, payload),
          logDetail(frame.topic, payload) || undefined
        );
      }
      // A compiled page is knowledge too: the panel's wiki list refetches
      // on the same version bump the features and lessons use.
      if (frame.topic === "wiki.updated") scheduleKnowledgeRefetch(true);
      break;
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
      // A deleted folder takes the open file with it, and its own path
      // never matches selectedPath — so check containment explicitly.
      if (
        payload.type === "unlinkDir" &&
        ws.selectedPath?.startsWith(`${changedPath}/`)
      ) {
        ws.clearSelected();
      } else if (ws.selectedPath === changedPath) {
        const refreshed = isImagePath(changedPath)
          ? bridge.rpc("fs.readImage", { path: changedPath }).then((image) => ({
              content: image.dataUrl,
              mtime: image.mtime,
            }))
          : bridge.rpc("fs.readFile", { path: changedPath });
        void refreshed
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
      /*
       * topic:seq alone was not unique. Unsequenced topics all carry seq 0, so
       * every `scope.locked` (and `knowledge.retrieved`, `session.recalled`, …)
       * produced the same key — React warned about duplicate keys, and the
       * store's dedup silently dropped every occurrence after the first.
       * `ts` separates distinct events and is carried by the frame itself, so
       * it stays identical when a reconnect replays them — which is the one
       * property the dedup actually depends on.
       */
      key: `${frame.topic}:${frame.seq}:${frame.ts}`,
      topic: frame.topic,
      ts: frame.ts,
      taskId: frame.taskId,
      conversationId: convId,
      payload: frame.payload,
    });
  }
}

const offeredFrontendReviews = new Set<string>();

async function refreshFinishedExecution(
  conversationId: string,
  taskId: string
): Promise<void> {
  const [{ tasks }, { messages }] = await Promise.all([
    bridge.rpc("task.list", { conversationId }),
    bridge.rpc("session.getMessages", { conversationId }),
  ]);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;
  const execution = await loadExecutionTimeline(task);
  const request = messages.find(
    (message) => message.taskId === taskId && message.role === "user"
  );
  const report = [...messages]
    .reverse()
    .find((message) => message.taskId === taskId && message.role === "assistant");
  const restored: ExecutionTimelineVm = {
    ...execution,
    request: execution.frontendReview
      ? execution.request
      : request?.text ?? execution.request,
    report: report?.text ?? execution.report,
    requestedAt: request?.createdAt ?? execution.requestedAt,
  };
  const store = useSessionsStore.getState();
  const existing = store.sessions[conversationId]?.executions ?? [];
  store.setExecutions(conversationId, [
    ...existing.filter((item) => item.taskId !== taskId),
    restored,
  ]);
  const reviewRequest = frontendReviewRequest(conversationId, restored);
  if (reviewRequest && !offeredFrontendReviews.has(taskId)) {
    offeredFrontendReviews.add(taskId);
    window.dispatchEvent(
      new CustomEvent(FRONTEND_REVIEW_REQUEST_EVENT, {
        detail: reviewRequest,
      })
    );
  }
}
