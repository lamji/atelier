import type {
  ContextRequestStats,
  ApprovalRequest,
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
import { useMarkdownStore } from "@/state/markdown.store";
import type { IndexingProgress } from "@/state/knowledge.store";
import { useSessionsStore } from "@/state/sessions.store";
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
    default:
      return "";
  }
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

/** Human-readable label for a tool invocation. */
function actionLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.path === "string" ? i.path : "";
  switch (name) {
    case "read_file":
      return `Reading ${path}`;
    case "read_many_files": {
      const files = Array.isArray(i.files) ? i.files : [];
      return `Reading ${files.length} files`;
    }
    case "write_file":
      return `Writing ${path}`;
    case "replace_code":
      return `Editing ${path}`;
    case "replace_many": {
      const edits = Array.isArray(i.edits) ? i.edits : [];
      return `Editing ${edits.length} replacements`;
    }
    case "search_workspace":
      return `Searching "${String(i.query ?? "")}"`;
    case "search_text":
      return `Searching text "${String(i.query ?? "")}"`;
    case "list_dir":
      return `Listing ${path || "workspace"}`;
    case "run_terminal":
      return terminalActionLabel(String(i.command ?? ""));
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

function terminalActionLabel(command: string): string {
  const inner = unwrapShellCommand(command).trim();
  const normalized = inner.replace(/\s+/g, " ");

  if (/^git\s+status\b/i.test(normalized)) return "Checking git status";
  if (/^git\s+diff\b/i.test(normalized)) return "Reading git diff";
  if (/^git\s+log\b/i.test(normalized)) return "Reading git history";
  if (/^git\s+branch(?:es)?\b/i.test(normalized)) return "Listing branches";
  if (/^git\s+checkout\b/i.test(normalized)) return "Switching branch";
  if (/^git\s+(?:add|stage)\b/i.test(normalized)) return "Staging changes";
  if (/^git\s+commit\b/i.test(normalized)) return "Committing changes";
  if (/^git\s+(?:rebase|merge)\b/i.test(normalized)) {
    return "Updating branch";
  }
  if (/^(?:rg|grep|Select-String)\b/i.test(normalized)) {
    return "Searching workspace";
  }
  if (/^(?:Get-Content|cat|type|sed)\b/i.test(normalized)) {
    return "Reading file";
  }
  if (/^(?:Get-ChildItem|ls|dir|find)\b/i.test(normalized)) {
    return "Listing workspace";
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test)\b/i.test(normalized)) {
    return "Running tests";
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|lint)\b/i.test(normalized)) {
    return "Running verification";
  }

  return "Running terminal tool";
}

function unwrapShellCommand(command: string): string {
  const match = /(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)["'\s]*(?:-[^\s]+\s+)*-Command\s+(.+)$/i.exec(command);
  return match?.[1] ?? command;
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
    case "tool.failed": {
      if (convId) {
        // Carry the reason through: without it the feed shows a red X and
        // nothing else, and a failed edit looks like it simply didn't happen.
        const reason = payload.error ? String(payload.error) : undefined;
        sessions.actionFinished(
          convId,
          String(payload.toolCallId),
          "failed",
          reason
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
      }
      break;
    case "task.cancelled":
      if (convId) {
        sessions.taskEnded(convId, "cancelled", undefined, frame.taskId);
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
    case "scope.locked":
    case "skills.selected":
    case "impact.radius":
    case "edit.impact":
      // Pinned into the chat transcript (in addition to the activity feed
      // and the Timeline cards) so the reasoning behind a change stays
      // visible after the task finishes scrolling past it.
      if (convId) {
        sessions.pinLog(
          convId,
          `${frame.topic}:${frame.seq}`,
          frame.topic,
          logSummary(frame.topic, payload)
        );
      }
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
