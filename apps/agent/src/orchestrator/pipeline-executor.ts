import {
  query,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import { approxTokens, newId } from "@atelier/shared";
import type {
  ContextPurpose,
  Feature,
  ImageAttachment,
  ImpactRadius,
  LlmProvider,
  LlmTranscriptEntry,
  Plan,
  PlanStep,
  PipelineStage,
  RetrievalResult,
  ValidationKind,
  ValidationResult,
} from "@atelier/protocol";
import type { AgentConfig } from "../config/agent-config.js";
import type { AttachmentStore } from "../context/attachments/attachment-store.js";
import type { Db } from "../storage/db.js";
import type { EventBus } from "../events/event-bus.js";
import type { FileService } from "../workspace/file-service.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SymbolGraph } from "../knowledge/graph/symbol-graph.js";
import type { CloneHit, CloneScanner } from "../knowledge/impact/clone-scan.js";
import type { ImpactAnalyzer } from "../knowledge/impact/impact-analyzer.js";
import { companionFilesFor } from "../knowledge/impact/companion-files.js";
import type { IncrementalIndexer } from "../knowledge/indexer/incremental-indexer.js";
import type { HooksEngine } from "../hooks/hooks-engine.js";
import type { DirectTaskRegistry } from "../hooks/direct-tasks.js";
import type { ValidationRunners } from "../validation/runners.js";
import type { SettingsRepo } from "../storage/repositories/settings.js";
import { runOneShot } from "../providers/one-shot.js";
import {
  codexModelName,
  isCodexModel,
  isGrokModel,
  grokModelName,
  isOllamaModel,
  ollamaModelName,
  ollamaTargetOf,
  sdkModel,
} from "../providers/model-routing.js";
import {
  runOllamaAgentLoop,
  type OllamaTranscript,
} from "../providers/ollama/agent-loop.js";
import { resolveNumCtx } from "../providers/ollama/client.js";
import { runGrokAgentLoop } from "../providers/grok/agent-loop.js";
import { runCodexExec } from "../providers/codex/client.js";
import { ATELIER_EXECUTOR_CONTRACT } from "../providers/executor-contract.js";
import type { CodexToolBridge } from "../providers/codex/tool-bridge.js";
import type { PlanTracker } from "./plan-tracker.js";
import type { TaskOptions } from "./orchestrator.js";
import {
  createAtelierMcpServer,
  MCP_SERVER_NAME,
  type SdkToolContext,
} from "./sdk-tools.js";
import { buildReviewFixPrompt, buildReviewPrompt } from "./review-prompt.js";
import {
  DIRECT_RULES,
  DIRECT_TOOLS,
  isDirectMode,
  renderPriorTurns,
} from "./direct-mode.js";
import { trace } from "./trace.js";
import {
  BlockerLedger,
  harnessPrompt,
  loopHarnessLimits,
  reportsHardBlocker,
} from "./loop-harness.js";
import {
  buildLlmRequest,
  contextSections,
  contextText,
  publishLlmRequest,
  type AppendContext,
  type ContextSection,
} from "./llm-request.js";
import { effortFor, isTrivialChat } from "./trivial-chat.js";
import {
  CLAUDE_FAST_BUILTINS,
  CLAUDE_TURN_LIMIT_CONTINUATIONS,
  claudeContinuationBudget,
  claudeEffort,
  claudeTurnBudget,
  tolerateTurnLimit,
} from "./claude-budget.js";
import { userRulesPrompt } from "./user-rules.js";
import { VIBE_RULES } from "./vibe-rules.js";
import type { UsageMonitor } from "./usage-monitor.js";
import type { SdkUsage, TokenLedger } from "../context/ledger/index.js";
import type { PromptAssembler } from "../context/assemble/index.js";
import type { RetrieverLike } from "../context/cache/index.js";
import {
  buildTaskSummary,
  type TaskSummaryStore,
} from "../context/summaries/index.js";
import type {
  SharedSessionContext,
  SharedSessionContextBuilder,
} from "../context/session/index.js";
import {
  isGlobalSessionCommand,
  parseGeneratedGlobalAlias,
  type GlobalSessionStore,
} from "../context/global-session/index.js";
import { rankCandidates } from "../context/rank/index.js";
import {
  detectWorkspaceProfile,
  renderProjectTree,
  renderWorkspaceProfile,
} from "../workspace/profile/index.js";
import type { WorkspaceProfile } from "../workspace/profile/index.js";
import {
  EMPTY_SCOPE,
  inScope,
  renderScope,
  scopeGlob,
  workingSet,
  type SessionScope,
  type SessionScopeStore,
} from "../workspace/scope/index.js";
import type { WorkspaceIgnore } from "../workspace/ignore.js";
import type { GitService } from "../git/git-service.js";
import type { ScopeGuard } from "../tools/scope-guard.js";
import { testOnlyPaths, touchesCode } from "./change-scale/index.js";
import type { SkillLoader } from "./skill-loader.js";
import {
  EMPTY_RECALL,
  type RecalledWorkingMemory,
  type WorkingMemoryStore,
} from "../context/working-memory/index.js";
import {
  renderWikiPageForContext,
  WIKI_FEATURES_DIR,
  type WikiCompiler,
  type WikiPage,
  type WikiStore,
} from "../knowledge/wiki/index.js";

/** Built-in SDK tools stay disabled: everything flows through Atelier. */
/**
 * Builtins that stay off because Atelier owns what they do: every write
 * must pass the modularity guard and register as a changed file, and every
 * shell command must pass the git-flow and database hooks, which only the
 * MCP tools route through. Read is Atelier's too — read_file feeds the
 * working set the pipeline tracks.
 */
const DISABLED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "NotebookEdit",
];

/**
 * The read-only tool surface, shared by the two phases that must look
 * without touching. Everything that can mutate the workspace — write_file,
 * replace_code, replace_many, run_terminal — is withheld, so the reviewer
 * can only judge the change rather than quietly repair what it is supposed
 * to be reporting, and the plan pass can only read the code it is planning
 * against. `git` is present for the diff action; the git-flow hook still
 * blocks commit/push.
 */
const READ_ONLY_TOOLS = [
  "read_file",
  "read_many_files",
  "list_dir",
  "search_workspace",
  "search_text",
  "search_symbols",
  "retrieve_knowledge",
  "query_knowledge_graph",
  "impact_of_edit",
  "analyze_impact",
  "git",
].map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);

/** Small, fast model for the remaining tool-less stage calls. */
const STAGE_MODEL = "claude-haiku-4-5";

/**
 * Anchors allowed to boost the ranking on a turn that names nothing. Short
 * on purpose: the previous twelve meant a session's whole recent history
 * competed with the current question, and stale entries never aged out.
 */
const RANK_ANCHOR_TARGETS = 4;

/**
 * Body of the plan-mode system reminder for the plan pass the user asks for
 * with the Plan checkbox. The CLI wraps this with its own read-only preamble
 * and ExitPlanMode protocol footer, so it only has to say what a good
 * Atelier plan looks like.
 */
const SYSTEM_PLAN_INSTRUCTIONS =
  "Read the code you are about to change before you plan it. Then call " +
  "ExitPlanMode with a numbered plan in which every step names the real " +
  "files it touches and says what changes in them. Plan ONLY what the " +
  "request requires — no cleanup, refactors, or follow-up work on files the " +
  "user did not ask about. Never restate the request as a step " +
  '("implement the request") and never add a bare verify step. Keep ' +
  "exploration proportionate to the job: read what you need to make the " +
  "steps concrete, then stop. ExitPlanMode IS how this plan is delivered " +
  "and the same turn continues straight into the edits, so do not ask the " +
  "user anything, do not offer to implement, and do not end the turn with " +
  "a question. Settle any open decision on the most reasonable default and " +
  "note it in the plan.";

/**
 * Sent when a turn that was supposed to change code did not. By the time
 * this runs the planning is over either way — this is the turn that has to
 * produce edits.
 */
const PROCEED_PROMPT =
  "Planning is finished and you now have full edit permissions in this " +
  "same session. Implement what you just described, using the tools. Do " +
  "not restate the plan, do not ask whether to proceed, and do not wait " +
  "for confirmation — settle any open question on the most reasonable " +
  "default and note the assumption in one line in your final report. If " +
  "the work genuinely needs no code change, say why in one line and stop.";

/** Exact evidence still missing when the first implementation pass returns. */
export function completionGatePrompt(
  steps: PlanStep[],
  verificationMissing: boolean,
  nothingImplemented = false,
  planMissing = false
): string {
  if (
    steps.length === 0 &&
    !verificationMissing &&
    !nothingImplemented &&
    !planMissing
  ) {
    return "";
  }
  const lines = [
    "The completion gate found outstanding work. Continue in this same session and finish only the items below:",
  ];
  if (planMissing) {
    lines.push(
      "- No execution timeline exists. Call set_plan before doing or reporting any change work."
    );
  }
  for (const step of steps) {
    const detail = step.detail && step.detail !== step.title
      ? ` — ${step.detail}`
      : "";
    const files = step.files.length > 0
      ? ` (files: ${step.files.join(", ")})`
      : "";
    lines.push(`- [${step.status}] ${step.title}${detail}${files}`);
  }
  if (verificationMissing) {
    lines.push(
      "- No successful verification was observed after the latest source edit. Run the narrowest relevant check and fix any failure before reporting."
    );
  }
  if (nothingImplemented) {
    lines.push(
      "- Not one file was changed, on a turn that asked for a change, and the tool budget is spent. Make the edits now from what you have already read. If the request truly needs no code change, say why in one line."
    );
  }
  lines.push(
    "Do not render a progress or final report while this gate is open. Execute the timeline in order: start the current step, do its work, then explicitly mark it done. Pending, in-progress, failed, cancelled, and skipped are all incomplete. If necessary work is discovered, call set_plan with only the new steps; it appends them and cannot replace or remove the existing timeline."
  );
  return lines.join("\n");
}

/**
 * Claude's Stop hook verdict for a live completion gate.
 *
 * A blocked Stop feeds the reason back into the same SDK session, before
 * Atelier accepts the assistant's report as the end of the turn. An
 * immediately retried Stop arrives with stop_hook_active, but that flag is
 * not completion evidence: accepting it is the bypass that let Claude repeat
 * a partial report and end the task. Keep blocking until the live gate clears;
 * SDK maxTurns and Atelier's continuation budgets bound an uncooperative loop.
 */
export function completionReportText(
  candidate: string,
  completionAccepted: boolean
): string {
  return completionAccepted ? candidate : "";
}

/**
 * Ollama returns before Claude's read-only interactive Plan branch. It must
 * not inherit that branch's completion-gate exemption: doing so disabled
 * Ollama's only final-report guard while still letting the model execute —
 * the exact "0 edits, done" failure this gate exists to prevent.
 */
export function completionGateRequired(opts: {
  actionable: boolean;
  planMode: boolean;
  model?: string;
}): boolean {
  if (!opts.actionable) return false;
  return !opts.planMode || isOllamaModel(opts.model);
}

export function completionStopHookDecision(
  outstanding: string,
  _stopHookActive: boolean
):
  | { decision: "block"; reason: string }
  | { decision?: undefined; reason?: undefined } {
  if (!outstanding) return {};
  return { decision: "block", reason: outstanding };
}

/**
 * Consecutive same-session passes allowed without observable progress.
 * A STALL cap, never a task-size cap: rounds that land an edit, finish a
 * step, or verify reset it. Read from the loop harness so a machine can
 * raise it — or set it to 0 for "loop until done".
 */
export const COMPLETION_GATE_RETRIES = loopHarnessLimits().gateStallLimit;

interface CompletionGateProgress {
  completedSteps: number;
  appliedEdits: number;
  verificationObserved: boolean;
}

/** A bounded retry budget resets only when live completion evidence advances. */
export function completionGateMadeProgress(
  before: CompletionGateProgress,
  after: CompletionGateProgress
): boolean {
  return (
    after.completedSteps > before.completedSteps ||
    after.appliedEdits > before.appliedEdits ||
    (!before.verificationObserved && after.verificationObserved)
  );
}

export function canRunNudge(opts: {
  nudges: number;
  gateNudges: number;
  turnLimitContinuations: number;
  gateRetry?: boolean;
  aborted: boolean;
  /** Overrides the harness stall limit; tests only. */
  gateStallLimit?: number;
}): boolean {
  if (opts.aborted) return false;
  if (opts.gateRetry === true) {
    return opts.gateNudges < (opts.gateStallLimit ?? COMPLETION_GATE_RETRIES);
  }
  return opts.nudges === 0 && opts.turnLimitContinuations === 0;
}

/**
 * Sent when a session spends its turn ceiling with work still open. The
 * session is RESUMED, so everything it read is still in context — what it
 * must not do is start over.
 */
const TURN_LIMIT_PROMPT =
  "The SDK turn ceiling was reached, but the task is not complete and " +
  "Atelier is continuing this same session. A turn ceiling is not permission " +
  "to report partial work. Do not start new exploration — no broad searches " +
  "or opening files you have not already read. Use the tools to finish the " +
  "remaining implementation and verification now. Do not produce a progress " +
  "or final report while any live plan item is not explicitly done, or " +
  "while the latest source edit is unverified.";

/**
 * The wrap-up prompt for a turn that spent the whole ceiling on discovery
 * and wrote nothing.
 *
 * The implementation branch is explicit because every discovery round has
 * already been paid for. Like the ordinary continuation, it contains no
 * report-only escape: a provider ceiling is a scheduling boundary, not task
 * completion evidence.
 */
const TURN_LIMIT_UNSTARTED_PROMPT =
  "The SDK turn ceiling was reached before you changed a file, but Atelier " +
  "is continuing this same task. Do not start new exploration — no broad " +
  "searches, opening files you have not already read, or re-reading earlier " +
  "context. Make the requested edits now with the tools, then run the " +
  "narrowest relevant verification. Reporting findings, restating the " +
  "problem, or describing a future change is not completion evidence. Only " +
  "if the request objectively requires no workspace change may you explain " +
  "that in one line and stop.";

/**
 * Appended when the ceiling is spent and no continuation is left. The user
 * keeps the answer and the edits either way; what they must not be left
 * with is a turn that looks complete when it stopped early.
 */
const TURN_LIMIT_NOTE =
  "\n\n_Atelier exhausted its bounded continuation budget while the live " +
  "completion gate was still open; the task is incomplete._";

/** Exact live work rides into every ceiling continuation. */
export function turnLimitContinuationPrompt(
  outstanding: string,
  unstarted: boolean
): string {
  const base = unstarted ? TURN_LIMIT_UNSTARTED_PROMPT : TURN_LIMIT_PROMPT;
  return outstanding ? `${base}\n\n${outstanding}` : base;
}

/**
 * Appended when the completion gate is STILL open after its continuation —
 * or when no continuation could run because the nudge budget was already
 * spent on the offer path.
 *
 * The gate used to trust the continuation: it fired, appended whatever the
 * model wrote next, and the turn reported as finished. So the two failures
 * it exists to catch both ended in a confident report — the nudge that
 * silently returned "" because a nudge had already been spent, and the
 * continuation that answered in prose without touching the outstanding
 * steps. A gate that cannot fail its own check is a formality; this is what
 * makes it verify rather than trust.
 */
const GATE_OPEN_NOTE =
  "\n\n_The completion gate is still open — plan steps remained unfinished " +
  "(or the latest edit went unverified) when this turn ended, so the report " +
  "above may describe work that is not done. Send the next message to carry " +
  "on in the same session._";

const GATE_BLOCKED_NOTE =
  "\n\n_The completion gate is still open because of the blocker named " +
  "above. Resolve it (for example by widening the session scope or " +
  "approving the command) and send the next message to carry on._";

/** Hide intermediate ceiling notes; surface one gate verdict only at the end. */
export function completionGateResultText(
  text: string,
  gateStillOpen: boolean
): string {
  const clean = text.replaceAll(TURN_LIMIT_NOTE, "").trim();
  if (!gateStillOpen) return clean;
  if (reportsHardBlocker(clean)) return `${clean}${GATE_BLOCKED_NOTE}`;
  return clean ? `${clean}${GATE_OPEN_NOTE}` : GATE_OPEN_NOTE.trim();
}

/** Direct mode's tool surface, as MCP names. */
const DIRECT_TOOL_NAMES = DIRECT_TOOLS.map(
  (name) => `mcp__${MCP_SERVER_NAME}__${name}`
);

export class HookBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

export class AbortError extends Error {
  constructor() {
    super("aborted");
  }
}

export interface Intent {
  kind: string;
  summary: string;
  targets: string[];
  constraints: string[];
}

export interface PipelineDeps {
  config: AgentConfig;
  db: Db;
  bus: EventBus;
  tools: ToolRegistry;
  /** Workspace file access, for the Ollama path's edit-repair pass. */
  files: FileService;
  retriever: RetrieverLike;
  graph: SymbolGraph;
  clones: CloneScanner;
  impact: ImpactAnalyzer;
  indexer: IncrementalIndexer;
  hooks: HooksEngine;
  /** Tasks running with system knowledge off, for the code guards to skip. */
  directTasks: DirectTaskRegistry;
  /**
   * Whether the modularity guard will actually block on this workspace.
   * Supplied by the runtime, which owns the guard, so the rule the prompt
   * states and the rule the write guard enforces come from one answer.
   */
  modularityInForce: () => boolean;
  validators: ValidationRunners;
  planTracker: PlanTracker;
  settings: SettingsRepo;
  usage: UsageMonitor;
  ledger: TokenLedger;
  assembler: PromptAssembler;
  summaries: TaskSummaryStore;
  sharedSessions: SharedSessionContextBuilder;
  globalSessions: GlobalSessionStore;
  codexTools: CodexToolBridge;
  skillLoader: SkillLoader;
  /** Per-conversation working-set lock, seeded by "@folder" mentions. */
  scope: SessionScopeStore;
  /**
   * What earlier turns of the conversation already read and searched.
   * Optional so the smokes that build a bare deps object keep working;
   * the runtime always supplies it.
   */
  workingMemory?: WorkingMemoryStore;
  /**
   * The feature wiki: compiled pages read at turn start and updated after
   * a task that changed a feature. Optional for the same reason.
   */
  wiki?: WikiStore;
  wikiCompiler?: WikiCompiler;
  /** Shared ignore rules, so the scoped directory map skips build output. */
  ignore: WorkspaceIgnore;
  /** Routes git at the checkout the scope points to. */
  git: GitService;
  /** Enforces the lock at the tool boundary, where prose cannot. */
  scopeGuard: ScopeGuard;
  /** Attached images, addressable by path after the turn that carried them. */
  attachments: AttachmentStore;
  log: Logger;
}

/**
 * What the task has produced so far. Filled progressively by the stages so a
 * run that never reaches the summary stage — cancelled or crashed — can still
 * be written to session memory. Losing an interrupted task was the case that
 * hurt most: the user cancels, switches provider, and asks to continue.
 */
export interface TaskRecord {
  changedFiles: Set<string>;
  /** Classified intent ("fix", "feature", "question", …). */
  intentKind: string;
  intentSummary: string;
  planGoal: string;
  steps: Array<{
    title: string;
    detail?: string;
    files: string[];
    status?: string;
  }>;
  validation: ValidationResult[];
  reviewVerdict: "pass" | "fail" | null;
  /** Every applied edit, repeats to one file included — see the loops. */
  editCount: number;
  /** Set once the summary stage has written the final record. */
  summarized: boolean;
}

export function newTaskRecord(): TaskRecord {
  return {
    changedFiles: new Set<string>(),
    intentKind: "",
    intentSummary: "",
    planGoal: "",
    steps: [],
    validation: [],
    reviewVerdict: null,
    editCount: 0,
    summarized: false,
  };
}

export interface TaskContext {
  taskId: string;
  conversationId: string;
  prompt: string;
  /** Persisted unfinished plan, injected only for an explicit continuation. */
  recoveryPlan: string;
  /** Prior conversation turns (oldest→newest), including assistant answers. */
  priorTurns: Array<{
    role: "user" | "assistant";
    text: string;
  }>;
  messageId: string;
  /** Images attached on THIS turn, sent inline with the first message. */
  images: ImageAttachment[];
  /**
   * Paths of the conversation's current images — this turn's, or the last
   * set it carried. Named in the context and in session memory so a later
   * turn can open one with view_image instead of re-reading a description.
   */
  imagePaths: string[];
  opts: TaskOptions;
  abort: AbortController;
  sdkSessionId: string | null;
  onSdkSessionId: (sessionId: string) => void;
  /**
   * Ollama's equivalent of `sdkSessionId`. /api/chat is stateless, so the
   * task's session IS this array: every pass the task makes — execute, a
   * nudge, a gate retry, a validation fix — continues it instead of meeting
   * the workspace for the first time. The independent reviewer runs without
   * it, exactly as it runs without `resume` on Claude.
   */
  ollamaTranscript: OllamaTranscript;
  /** Streamed assistant text so far — survives cancellation. */
  collectedText: string;
  /** How many times this run has been pushed to stop planning and edit. */
  nudges: number;
  /** Consecutive completion-gate retries without observable progress. */
  gateNudges: number;
  /**
   * Whether this turn owes the user a code change — set once the execute
   * stage has the intent, and read by the turn-ceiling path, which has to
   * decide how to wrap a spent session up without seeing the intent itself.
   */
  mustEdit: boolean;
  /** How many times this run has been carried past a spent turn ceiling. */
  turnLimitContinuations: number;
  /**
   * Consecutive ceiling continuations that moved no completion evidence.
   * Reset by any continuation that lands an edit or finishes a step; only
   * this counter — never the total — ends the loop.
   */
  turnLimitStalls: number;
  /** Refusals and failures since the last continuation round began. */
  blockers?: BlockerLedger;
  /** Feature-wiki pages matched for this turn, best first, with what moved. */
  wiki: Array<{ page: WikiPage; moved: string[] }>;
  /** Progressive record of the work, for summaries and interrupted saves. */
  record: TaskRecord;
  /** The working-set lock in force for this turn. Resolved before stage 1. */
  scope: SessionScope;
  /**
   * The files this turn is about: what the user named, plus the anchors
   * this turn's own retrieval re-earned. Filled by the retrieve stage and
   * read by the scope block, so a file touched by mistake earlier in the
   * session stops being presented as the working set.
   */
  workingSet: string[];
}

export interface PipelineOutcome {
  assistantText: string;
  sdkSessionId: string | null;
}

/**
 * The 9-stage pipeline: understand -> retrieve -> plan -> hooks -> execute
 * -> validate -> knowledge -> review -> summary, in order, with stage
 * events published around each. The SDK is only ever invoked inside a
 * stage, never free-running.
 *
 * Only ONE of those stages costs a model call on the happy path: `execute`.
 * `understand` and `plan` are regex and bookkeeping (the two classifier
 * round-trips and the planning round-trip are gone); `retrieve` is local;
 * `validate` and `review` are both opt-in and skipped by default. `impact`
 * is not in the list at all — the blast radius is computed at the edit site
 * by the pre-write hook instead.
 */
export class PipelineExecutor {
  /**
   * Detected once per process and reused verbatim. It must stay
   * byte-stable: it rides in the static half of the system prompt, so a
   * value that changed mid-session would invalidate the provider prompt
   * cache on every turn.
   */
  private workspaceBlock?: Promise<string>;

  /** Cached workspace profile — the scope lock maps mentions onto it. */
  private profile?: Promise<WorkspaceProfile>;

  /** The rule block for the task in flight; see userRules(). */
  private userRuleBlock?: { taskId: string; text: Promise<string> };

  /**
   * Directory maps, cached per locked root. Each is byte-stable for the
   * process, so a conversation that stays in one project keeps its prompt
   * prefix intact across turns.
   */
  private treeBlocks = new Map<string, Promise<string>>();

  constructor(private deps: PipelineDeps) {}

  private workspaceProfile(): Promise<WorkspaceProfile> {
    this.profile ??= detectWorkspaceProfile(this.deps.config.workspaceRoot);
    return this.profile;
  }

  /**
   * The per-conversation half of the layout story: which project this
   * session is locked to, which files it has already touched, and the
   * directory map of the locked project.
   *
   * The map is the fix for the failure the static block could not prevent.
   * That block is depth-1 by necessity — it rides on every turn for every
   * project — so it can only say "src/ exists", and the model filled the
   * rest in from convention. Scoping the deep map to the locked project is
   * what makes the real folder names affordable.
   */
  private async scopeContext(ctx: TaskContext): Promise<string> {
    const scope = ctx.scope;
    if (scope.roots.length === 0 && scope.anchors.length === 0) return "";

    const trees = await Promise.all(
      scope.roots.map((root) => this.projectTree(root))
    );
    // ctx.workingSet is filled by the retrieve stage. It is empty on the
    // warm-up call above, which only exists to prime the tree cache and
    // whose text is discarded.
    return [renderScope(scope, ctx.workingSet), ...trees]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Resolves this turn's scope before any stage runs, and points git at
   * the checkout it names.
   *
   * Order matters: retrieval is the first stage that can go wide, so the
   * lock has to exist before it, not alongside it.
   */
  private async applyScope(ctx: TaskContext): Promise<void> {
    let scope: SessionScope;
    try {
      const explicit = ctx.opts.scopeRoots;
      if (explicit && explicit.length > 0) {
        // The caller already knows the project — the git wizard dispatches
        // its fix agent about one checkout, and a prompt made of command
        // output names no folder for `resolve` to find.
        scope = this.deps.scope.lock(ctx.conversationId, explicit);
      } else {
        const profile = await this.workspaceProfile();
        scope = this.deps.scope.resolve(ctx.conversationId, ctx.prompt, profile);
      }
    } catch (error) {
      // A scope we cannot compute must not take the task down with it —
      // an unlocked turn is the old behavior, not a broken one.
      this.deps.log.warn({ error }, "scope resolution failed");
      return;
    }
    ctx.scope = scope;
    this.deps.scopeGuard.bind(ctx.taskId, scope);
    if (scope.roots.length === 0 && scope.anchors.length === 0) return;

    // Pointing the git PANEL at the locked checkout is presentation, and it
    // costs a status sweep over every repo in the workspace — seconds on a
    // busy monorepo. Nothing in the pipeline reads it, so it must not sit
    // between task.start and the first stage: the run would show a blank
    // PROCESS rail for the whole sweep and read as hung.
    const first = scope.roots[0];
    if (first) {
      void this.deps.git
        .focus(first)
        .catch((error) =>
          this.deps.log.warn({ error, root: first }, "git focus failed")
        );
    }
    const repo = this.deps.git.activeRepo;
    this.deps.bus.publish(
      "scope.locked",
      {
        roots: scope.roots,
        anchors: scope.anchors.slice(0, 12),
        source: scope.source,
        changed: scope.changed,
        repo,
      },
      ctx.taskId
    );
  }

  /**
   * Promotes a strong plain-language feature match into this conversation's
   * working set before retrieval applies the existing lock.
   */
  private async applyFeatureScope(
    ctx: TaskContext,
    queryText: string
  ): Promise<void> {
    if (ctx.scope.source === "mention" || ctx.scope.source === "explicit") {
      return;
    }
    const files = this.featureScopeFiles(queryText, ctx.scope.anchors);
    if (files.length === 0) return;

    const profile = await this.workspaceProfile();
    const focused = this.deps.scope.focusFiles(
      ctx.conversationId,
      files,
      profile
    );
    // Keep this turn's typed-path grants; feature focus is a working-set
    // anchor, not a reason to reject a file the user named now.
    ctx.scope = { ...focused, allowed: ctx.scope.allowed };
    this.deps.scopeGuard.bind(ctx.taskId, ctx.scope);
    const first = ctx.scope.roots[0];
    if (first) {
      void this.deps.git
        .focus(first)
        .catch((error) =>
          this.deps.log.warn({ error, root: first }, "git focus failed")
        );
    }
    this.deps.bus.publish(
      "scope.locked",
      {
        roots: ctx.scope.roots,
        anchors: ctx.scope.anchors.slice(0, 12),
        source: ctx.scope.source,
        changed: ctx.scope.changed,
        repo: this.deps.git.activeRepo,
      },
      ctx.taskId
    );
  }

  private featureScopeFiles(
    queryText: string,
    currentAnchors: string[]
  ): string[] {
    const terms = featureTerms(queryText);
    if (terms.length === 0) return [];
    const rows = this.deps.db
      .prepare(
        "SELECT id, name, slug, summary FROM features " +
          "WHERE status != 'building' LIMIT 200"
      )
      .all() as Array<Pick<Feature, "id" | "name" | "slug" | "summary">>;
    const filesFor = this.deps.db.prepare(
      "SELECT f.path FROM feature_files ff JOIN files f ON f.id = ff.file_id " +
        "WHERE ff.feature_id = ? ORDER BY ff.weight DESC, f.path LIMIT 20"
    );
    // Two independent hits, at least one of them in the feature's own name.
    // The old bar was a single term appearing anywhere, which any feature
    // whose summary contained a common word could clear — and clearing it
    // RE-LOCKS the conversation's scope onto that feature's files. One
    // stray word must not be able to move the session somewhere else.
    const matches = rows
      .map((row) => {
        const nameSlug = `${row.name} ${row.slug}`.toLowerCase();
        const summary = row.summary.toLowerCase();
        let nameHits = 0;
        let score = 0;
        for (const term of terms) {
          if (nameSlug.includes(term)) {
            nameHits += 1;
            score += 3;
          } else if (summary.includes(term)) {
            score += 1;
          }
        }
        return { row, score, nameHits };
      })
      .filter((match) => match.nameHits >= 1 && match.score >= 4)
      .sort((a, b) => b.score - a.score);
    if (matches.length === 0) return [];

    const best = matches[0]!;
    const tied = matches.filter((match) => match.score === best.score);
    const anchorSet = new Set(currentAnchors);
    const selected =
      tied.length === 1
        ? tied
        : tied.filter((match) =>
            (filesFor.all(match.row.id) as Array<{ path: string }>).some(
              (file) => anchorSet.has(file.path)
            )
          );
    const finalMatches = selected.length > 0 ? selected : tied.slice(0, 3);
    return [
      ...new Set(
        finalMatches.flatMap((match) =>
          (filesFor.all(match.row.id) as Array<{ path: string }>).map(
            (file) => file.path
          )
        )
      ),
    ];
  }

  private projectTree(root: string): Promise<string> {
    let block = this.treeBlocks.get(root);
    if (!block) {
      block = renderProjectTree(
        this.deps.config.workspaceRoot,
        root,
        this.deps.ignore
      ).catch((error) => {
        this.deps.log.warn({ error, root }, "project tree render failed");
        return "";
      });
      this.treeBlocks.set(root, block);
    }
    return block;
  }

  /**
   * Tells the model what kind of folder it is in — one project, a
   * monorepo, or a container of unrelated checkouts — and the real
   * top-level directories of each. Without it the model infers a layout
   * from convention and calls tools with paths that never existed.
   */
  private workspaceLayout(): Promise<string> {
    this.workspaceBlock ??= this.workspaceProfile()
      .then(renderWorkspaceProfile)
      .catch((error) => {
        this.deps.log.warn({ error }, "workspace profile detection failed");
        return "";
      });
    return this.workspaceBlock;
  }

  /**
   * The user's own rule files, read once per TASK rather than once per
   * provider call. A turn that nudges, validates and repairs used to walk
   * `.atelier/rules` again for each of them.
   *
   * Keyed on taskId on purpose: cached across a task, never across turns, so
   * a rule the user just edited still applies to the very next send. Two
   * conversations running at once trade the slot and simply re-read, which
   * is the behaviour this replaced — never a stale block.
   */
  private userRules(ctx: TaskContext): Promise<string> {
    if (this.userRuleBlock?.taskId !== ctx.taskId) {
      this.userRuleBlock = {
        taskId: ctx.taskId,
        text: userRulesPrompt(this.deps.config.workspaceRoot).catch((error) => {
          this.deps.log.warn({ error }, "user rules unreadable");
          return "";
        }),
      };
    }
    return this.userRuleBlock.text;
  }

  async run(ctx: TaskContext): Promise<PipelineOutcome> {
    if (isGlobalSessionCommand(ctx.prompt)) {
      const aliasContext = this.deps.globalSessions.aliasContext(ctx.conversationId);
      const alias =
        aliasContext.existingAlias ??
        parseGeneratedGlobalAlias(
          await this.shortSdkCall(
            ctx,
            "Name a durable cross-session memory from its conversation. " +
              "Return strict JSON only: {\"alias\":\"three-to-six-lowercase-words\"}. " +
              "Choose an existing alias only when this is clearly the same continuing flow; " +
              "otherwise create a distinct concise alias. Do not add commentary.",
            `SESSION TITLE:\n${aliasContext.title}\n\n` +
              `EXISTING GLOBAL ALIASES:\n${aliasContext.knownAliases.join("\n") || "(none)"}\n\n` +
              `SESSION TRANSCRIPT:\n${aliasContext.transcript}`,
            false,
            3
          )
        );
      const result = await this.deps.globalSessions.promote(
        ctx.conversationId,
        alias
      );
      const action = result.updated ? "Updated" : "Created";
      return {
        assistantText:
          `${action} global session \"${result.alias}\" (${result.id}) with ` +
          `${result.chunks} detailed RAG chunk(s). Cross-session retrieval ` +
          `uses it only while Experimental global session knowledge is enabled in Settings.`,
        sdkSessionId: null,
      };
    }
    // The user unticked "System knowledge": nothing below this line runs.
    if (isDirectMode(ctx.opts)) return this.runDirect(ctx);
    // The execution-timeline contract is armed after `understand`, not here:
    // a question owes an answer, not a checklist. See below.
    //
    // Lives on the context, not this frame: the orchestrator needs it to
    // write a summary if the task is cancelled or crashes before stage 9.
    const changedFiles = ctx.record.changedFiles;
    // Unlike changedFiles, this advances for every successful mutation —
    // including the repeated same-file edits common in a large UI redesign.
    // The completion retry loop uses it to distinguish real convergence from
    // a model that merely repeats its report without doing more work.
    let appliedEdits = 0;
    let verificationObserved = false;
    // Inputs of in-flight tool calls, so a finished read can be remembered
    // with the path and range it was asked for (the completion event only
    // carries the result).
    const toolInputs = new Map<string, { name: string; input: unknown }>();
    // What stopped the model this round — refusals, failures, blocked
    // hooks. Drained into the next continuation's harness prompt so the
    // retry knows what to route around instead of repeating it.
    const blockers = new BlockerLedger();
    ctx.blockers = blockers;
    const unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.taskId !== ctx.taskId) return;
      if (event.topic === "hook.blocked") {
        const payload = event.payload as { name?: string; reason?: string };
        if (payload.name !== "Completion gate") {
          blockers.note(`hook ${payload.name ?? ""}`, payload.reason ?? "");
        }
      }
      if (event.topic === "tool.started") {
        const payload = event.payload as {
          toolCallId: string;
          name: string;
          input: unknown;
        };
        toolInputs.set(payload.toolCallId, {
          name: payload.name,
          input: payload.input,
        });
      }
      if (event.topic === "tool.failed") {
        const payload = event.payload as {
          toolCallId: string;
          name?: string;
          error?: string;
        };
        toolInputs.delete(payload.toolCallId);
        blockers.note(`tool ${payload.name ?? ""}`, payload.error ?? "");
      }
      if (event.topic === "edit.applied") {
        const path = (event.payload as { path: string }).path;
        changedFiles.add(path);
        appliedEdits += 1;
        ctx.record.editCount += 1;
        verificationObserved = false;
        // Advance the plan checklist live from real edits, so it moves even
        // when the model doesn't call update_plan_step itself.
        this.deps.planTracker.noteFileEdited(ctx.taskId, path);
        // An edited file becomes an anchor: the next turn is usually "now
        // make it do X" with no path named at all.
        this.deps.scope.noteTouched(ctx.conversationId, path);
      }
      if (event.topic === "tool.completed") {
        const payload = event.payload as {
          toolCallId?: string;
          name?: string;
          result?: { exitCode?: number; timedOut?: boolean };
        };
        if (
          payload.name === "run_terminal" &&
          payload.result?.exitCode === 0 &&
          payload.result.timedOut !== true
        ) {
          verificationObserved = true;
        }
        // What this turn looked at, remembered for the next one. Failures
        // are swallowed: memory is a side effect of the turn, never a way
        // to fail it.
        const started = payload.toolCallId
          ? toolInputs.get(payload.toolCallId)
          : undefined;
        if (payload.toolCallId) toolInputs.delete(payload.toolCallId);
        if (started && payload.name) {
          try {
            this.deps.workingMemory?.noteTool({
              conversationId: ctx.conversationId,
              taskId: ctx.taskId,
              name: payload.name,
              input: started.input,
              result: payload.result,
            });
          } catch (error) {
            this.deps.log.warn({ err: error }, "could not note tool result");
          }
        }
      }
    });

    // NOT marked as a direct task. That mark exists for one thing: a turn
    // running with system knowledge OFF is not offered impact_of_edit at
    // all, so gating its edits on it would be a wall with no door. A
    // pipeline turn HAS that tool on every provider, so the impact hook is
    // armed here and the rule it enforces rides in FAST_RULES — stated and
    // enforced, which is the only pairing that works.

    try {
      await this.applyScope(ctx);
      // Nothing below reads these, and every one of them is memoised — so
      // starting them here means the workspace layout, the locked project's
      // directory map and the user's rule files resolve DURING retrieval
      // instead of after it, on the far side of the only stage that waits on
      // I/O. Failures are already swallowed inside each.
      void this.workspaceLayout();
      void this.scopeContext(ctx);
      void this.userRules(ctx);
      // Intent WITHOUT a model call. Two classifier round-trips used to run
      // here — each one a provider process spawn — before a single token of
      // the answer existed. What they bought (a kind label, a summary, the
      // file names the user typed) is available from the prompt itself, and
      // the one thing they genuinely decided — "does this need the code?" —
      // is now answered by retrieval scoring rather than by asking a model.
      const intent = await this.stage(ctx, "understand", async () => {
        const result = readIntent(ctx.prompt);
        ctx.record.intentKind = result.kind;
        ctx.record.intentSummary = result.summary;
        this.deps.bus.publish("intent.resolved", result, ctx.taskId);
        return {
          value: result,
          detail: `${result.kind}: ${clip(result.summary, 80)}`,
        };
      });

      // "Where did you put it?", "are you editing the right file?", "what
      // does this hook do?" — the user asked to be TOLD something. Such a
      // turn owed an answer and got an implementation instead, because
      // every clause pointing at the timeline and at autonomous execution
      // rode on it regardless of intent. An answer-only turn publishes no
      // execution contract, so no plan-before-edit gate and no checklist:
      // the model reads what it needs and replies.
      const answerOnly = isReadOnly(intent);
      if (!answerOnly) this.deps.planTracker.requirePlan(ctx.taskId);

      const retrieval = await this.stage(ctx, "retrieve", async () => {
        // Small talk is the one turn with nothing to look up, and the test
        // for it is a regex, not a model.
        if (isTrivialChat(ctx.prompt, ctx.images.length > 0)) {
          return { value: emptyRetrieval(), detail: "skipped — small talk" };
        }
        const base =
          [ctx.prompt, ...intent.targets].join(" ").trim() || ctx.prompt;
        const queryText = anchoredQuery(base, ctx.priorTurns);
        await this.applyFeatureScope(ctx, base);
        // Over-fetch, then re-rank with signals retrieval cannot see
        // (target proximity, recency, lesson priority) and keep the top.
        // The lock is a filter here, not a ranking hint: three checkouts
        // holding a near-identical badge.tsx score the same on similarity,
        // so nothing but a hard glob keeps the other two out.
        const raw = await this.deps.retriever.retrieve(queryText, 24, {
          conversationId: ctx.conversationId,
          pathGlob: scopeGlob(ctx.scope),
          includeGlobalSessions:
            this.deps.settings.get().globalSessionKnowledge,
        });
        // The glob prunes at the source for a single-root lock; this is
        // what makes a two-folder lock exact, and it also catches chunk
        // kinds the glob arm does not reach.
        const scoped = raw.chunks.filter(
          (chunk) =>
            chunk.kind === "session-memory" ||
            chunk.kind === "global-session-memory" ||
            inScope(ctx.scope, chunk.path)
        );
        // Anchors boost the ranking ONLY on a turn that names nothing of
        // its own. When the user does name a file, a route, or a component,
        // that is the subject — letting forty previously-touched files
        // compete with it is how a single wrong edit kept winning every
        // later turn's ranking for the rest of the session.
        const anchorTargets =
          ctx.scope.named.length === 0 && intent.targets.length === 0
            ? ctx.scope.anchors.slice(0, RANK_ANCHOR_TARGETS)
            : [];
        const result = {
          ...raw,
          chunks: rankCandidates({
            chunks: scoped,
            targets: [
              ...intent.targets,
              ...ctx.scope.named,
              ...anchorTargets,
              ...raw.features.flatMap((feature) => feature.files).slice(0, 12),
            ],
            graph: this.deps.graph,
            db: this.deps.db,
            k: 12,
          }),
        };
        // What the model will be shown as "the files we are working on":
        // named paths, plus the anchors this turn's own hits re-earned.
        ctx.workingSet = workingSet(
          ctx.scope,
          result.chunks.map((chunk) => chunk.path)
        );
        this.deps.bus.publish("knowledge.retrieved", result, ctx.taskId);
        // Compiled feature pages for this turn — matched by the prompt's
        // words and by the files retrieval and the lock already point at.
        this.matchWiki(ctx, intent, result.chunks.map((chunk) => chunk.path));
        return {
          value: result,
          detail: `${result.strategy} · ${result.chunks.length} chunks`,
        };
      });

      // Skills are opt-in: only what the user typed as a leading slash
      // command. Nothing is published on a plain prompt, so a turn that
      // invoked no skill shows no skill line at all.
      const skills = this.deps.skillLoader.load(ctx.prompt);
      if (skills.skills.length > 0) {
        this.deps.bus.publish(
          "skills.selected",
          {
            skills: skills.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
            })),
          },
          ctx.taskId
        );
      }

      // Impact is a PRE-EDIT check and it now happens where the edit does:
      // the built-in impact hook computes the blast radius at the edit site,
      // against the files actually being changed. Doing it here as well meant
      // a graph walk over whatever retrieval happened to return, on every
      // turn, to inform a plan the model no longer needs.
      const impact = {
        paths: [] as string[],
        deps: emptyDeps(),
        riskNotes: [] as string[],
      };
      const radius = emptyRadius([]);

      // No planning model call, and — deliberately — no published plan yet.
      //
      // This used to seed a one-step "Respond" placeholder into the tracker
      // and announce it, which is why a plan never appeared: that stub WAS
      // the plan, every time, and the UI (reasonably) hides a checklist of
      // one. The real plan now arrives mid-turn from `set_plan`, once the
      // model has read enough to commit to one, at the cost of no extra
      // round-trip. Until then the rail has the stage and the live tool
      // rows, which is honestly what is known at this point.
      //
      // The stub survives only as a local value: the assembler wants a plan
      // section and the summary wants a goal, and neither is worth a branch.
      // It is never registered with the tracker, so nothing publishes step
      // updates against a plan the UI was never given.
      const plan = await this.stage(ctx, "plan", async () => {
        const result = this.trivialPlan(ctx, intent);
        ctx.record.planGoal = result.goal;
        ctx.record.steps = recordSteps(result.steps);
        return { value: result, detail: "the model plans as it works" };
      });

      await this.stage(ctx, "hooks", async () => {
        const decision = await this.deps.hooks.evaluatePreTask(
          ctx.prompt,
          ctx.taskId
        );
        if (!decision.allowed) {
          throw new HookBlockedError(decision.reason ?? "blocked by hook");
        }
        return { value: undefined, detail: "passed" };
      });

      // Hoisted out of the stage so the summary can read it too: a turn
      // that ends with the gate open must not be recorded as a finished one.
      let gateStillOpen = false;
      const exec = await this.stage(ctx, "execute", async () => {
        // Token-budgeted assembly through the compression ladder; the
        // assembler records estimated cost + savings in the ledger.
        const { text: context } = this.deps.assembler.assemble({
          taskId: ctx.taskId,
          conversationId: ctx.conversationId,
          intentKind: intent.kind,
          retrieval,
          radius,
          plan,
          constraints: intent.constraints,
        });
        // Recall is COMPLEMENTARY to retrieval, never replaced by it: RAG
        // finds the relevant old work, the shared block carries the recent
        // exchange, and it drops the summaries RAG already returned. Both
        // ride into every provider identically — this is what survives a
        // model or provider switch mid-conversation.
        const recalled = this.recallSession(ctx, retrieval, intent.kind);
        // What earlier turns already READ, on top of what they said. This
        // is the block that lets "now also handle X" start from the three
        // files the last turn gathered instead of reading them again.
        const gathered = await this.recallWorkingMemory(ctx, intent.kind);
        // Named, not joined: the provider gets the same bytes either way,
        // and the names are what the timeline's "sent to model" row shows
        // beside each block's size, so a heavy turn can be read at a glance.
        const appendContext: ContextSection[] = [
          { name: "answer-only rules", text: answerOnly ? ANSWER_ONLY_RULES : "" },
          { name: "session memory", text: recalled.text },
          { name: "feature wiki", text: this.renderWiki(ctx, intent.kind) },
          { name: "previously gathered", text: gathered.text },
          { name: "attachments", text: attachmentBlock(ctx) },
          { name: "go-ahead", text: goAheadBlock(ctx) },
          { name: "recovery plan", text: ctx.recoveryPlan },
          { name: "skills", text: skills.context },
          { name: "knowledge context", text: context },
        ];
        // Whether this turn owes the user an EDIT, decided before the model
        // is called rather than after — the turn-ceiling path runs inside
        // streamSession, so by the time control returns here it has already
        // chosen how to wrap the session up. It needs to know this.
        //
        // Trivial chat is excluded outright: a greeting classifies as
        // `work` (it is imperative in form), and a reply that happens to
        // end "what would you like to do?" reads as an offer — so without
        // this guard, saying hello could cost a second full model turn.
        const actionable =
          !isReadOnly(intent) &&
          !isTrivialChat(ctx.prompt, ctx.images.length > 0);
        ctx.mustEdit = actionable;
        const guardCompletion = completionGateRequired({
          actionable,
          planMode: ctx.opts.planMode === true,
          model: ctx.opts.model,
        });
        // Read at completion time, not when the query starts: edits and plan
        // updates happen inside the stream, and every provider hook must judge
        // the checklist as it exists when the model tries to finish.
        const gateOutstanding = (): string =>
          completionGatePrompt(
            this.deps.planTracker.unfinishedSteps(ctx.taskId),
            touchesCode([...changedFiles]) &&
              !verificationObserved &&
              ctx.opts.autoValidate !== true,
            // This closure exists only on actionable change turns. Ollama
            // has no Claude turn-limit continuation counter, so delaying the
            // no-edit verdict until that counter moves lets a model check its
            // plan done and finish with 0 edits forever.
            changedFiles.size === 0,
            this.deps.planTracker.get(ctx.taskId) === undefined
          );
        // Images ride on this first turn — either the ones attached now or
        // the conversation's last set, when the prompt asks about them. The
        // whole tool surface is offered and the model decides what it needs
        // — deciding that for it is what the classifier calls used to cost.
        const result = await this.streamSession(
          ctx,
          ctx.prompt,
          appendContext,
          ctx.images,
          "execute",
          {
            systemPlan: false,
            // Interactive Plan mode intentionally stops for user approval.
            // Autonomous execution is the mode where an early final report
            // must be refused while its checklist is still open.
            completionGate: guardCompletion
              ? gateOutstanding
              : undefined,
            // The files inlined above ARE current bytes the model holds, so
            // Ollama's edit-grounding guard must count them as read.
            preGrounded: gathered.groundedPaths,
          }
        );
        // A turn that asked to implement and changed nothing has, in
        // practice, ended by offering to implement instead. Push it once.
        //
        // "Changed nothing" is necessary but nowhere near sufficient: an
        // imperative prompt that was always going to be answered in prose
        // ("compare these two approaches") also changes nothing, and the
        // nudge then bought a second full model turn to be told the same
        // thing again. The offer itself is the signal the nudge is named
        // for, and it is right there in the text.
        if (
          actionable &&
          changedFiles.size === 0 &&
          endsWithAnOffer(result.text)
        ) {
          result.text += await this.nudgeToImplement(ctx, appendContext);
        }
        // All evidence is live — the tracker holds current step states and
        // the bus subscription keeps changed files and verification current.
        // The retry cap is a STALL cap, not a task-size cap: a large Claude
        // task may need many bounded SDK chunks, but every chunk that completes
        // a step, applies another edit, or verifies the edit earns the next.
        if (guardCompletion) {
          const gateProgress = (): CompletionGateProgress => ({
            completedSteps:
              this.deps.planTracker
                .get(ctx.taskId)
                ?.steps.filter((step) => step.status === "done").length ?? 0,
            appliedEdits,
            verificationObserved,
          });
          let outstanding = gateOutstanding();
          let rounds = 0;
          while (outstanding) {
            const progressBefore = gateProgress();
            const attemptsBefore = ctx.gateNudges;
            rounds += 1;
            const plan = this.deps.planTracker.get(ctx.taskId);
            const round = await this.nudgeToImplement(
              ctx,
              appendContext,
              harnessPrompt({
                outstanding,
                changedFiles: [...changedFiles],
                stepsDone: progressBefore.completedSteps,
                stepsTotal: plan?.steps.length ?? 0,
                attempt: rounds,
                stalled: ctx.gateNudges,
                blockers: blockers.drain(),
              }),
              {
                gateRetry: true,
                maxTurns: claudeContinuationBudget(
                  "execute",
                  changedFiles.size === 0
                ),
                completionGate: gateOutstanding,
              }
            );
            result.text += round;
            if (ctx.gateNudges === attemptsBefore) break;
            if (completionGateMadeProgress(progressBefore, gateProgress())) {
              ctx.gateNudges = 0;
            }
            // The one honest exit while items stay open: the model named a
            // blocker only the user can clear. Looping past it would spend
            // rounds re-hitting the same wall.
            if (reportsHardBlocker(round)) break;
            outstanding = gateOutstanding();
          }
          gateStillOpen = outstanding !== "";
          result.text = completionGateResultText(result.text, gateStillOpen);
        }
        return {
          value: result,
          detail:
            `${changedFiles.size} file(s) changed` +
            (gateStillOpen ? " · completion gate still open" : ""),
        };
      });
      let assistantText = exec.text;

      const validation = await this.stage(ctx, "validate", async () => {
        // Opt-IN, for the same reason review is. These are package scripts
        // over the whole project — a `test` script here is the full suite —
        // and they run sequentially AFTER the answer has finished streaming,
        // with the turn unable to end until they return. On a send the user
        // is watching, that is minutes of the run refusing to finish over a
        // verdict they can get from their own terminal. Callers that want
        // it — a long unattended run — pass autoValidate: true.
        if (ctx.opts.autoValidate !== true) {
          return {
            value: [] as ValidationResult[],
            detail: "validation off — skipped",
          };
        }
        if (changedFiles.size === 0) {
          return {
            value: [] as ValidationResult[],
            detail: "no changes to validate",
          };
        }
        // Typecheck/lint/test read code. A turn that only moved an env
        // value or a line of prose cannot change their verdict, so running
        // the whole suite is minutes spent to re-confirm the last result.
        if (!touchesCode([...changedFiles])) {
          return {
            value: [] as ValidationResult[],
            detail: "no code changed — validators skipped",
          };
        }
        const { results, extraText } = await this.validateWithFixLoop(ctx, [
          ...changedFiles,
        ]);
        assistantText += extraText;
        const failed = results.filter((r) => !r.ok).length;
        return {
          value: results,
          detail:
            results.length === 0
              ? "no validators configured"
              : failed === 0
                ? `${results.length} validator(s) green`
                : `${failed} validator(s) still failing`,
        };
      });
      ctx.record.validation = validation;

      // Review is the ONLY thing downstream that needs the index current —
      // it probes the code as it is now, so a stale index would have it
      // judging the version it replaced. Everything else that reads the
      // index is a LATER task, and `drainFor` is itself the barrier those
      // take. So the wait happens only when review is actually going to
      // run; otherwise the parse + embed of the changed files continues in
      // the background and the turn ends on the answer, not on the indexer.
      const reviewWillRun = ctx.opts.autoReview === true && changedFiles.size > 0;
      await this.stage(ctx, "knowledge", async () => {
        const drained = this.deps.indexer.drainFor([...changedFiles]);
        if (!reviewWillRun) {
          // Nothing awaits this, so nothing would surface a rejection.
          void drained.catch(() => undefined);
          return {
            value: undefined,
            detail:
              changedFiles.size === 0
                ? "nothing to index"
                : `indexing ${changedFiles.size} file(s) in background`,
          };
        }
        await drained;
        return {
          value: undefined,
          detail: `index current for ${changedFiles.size} file(s)`,
        };
      });

      // Runs after the index caught up, so the sweep probes the code as
      // it is NOW — the changed version, not what it replaced. An
      // independent reviewer agent (fresh session, no edit tools) checks
      // it and can send it back for a fix + re-review before passing.
      let reviewVerdict: "pass" | "fail" | null = null;
      await this.stage(ctx, "review", async () => {
        // Opt-IN, not opt-out. A single review pass costs 30-45% of the
        // execute stage and each attempt is a fresh SDK session; on a turn
        // the user is watching, that lands entirely after the answer has
        // finished streaming and reads as the run refusing to end. Callers
        // that want it — a long unattended run — pass autoReview: true.
        if (ctx.opts.autoReview !== true) {
          return { value: undefined, detail: "auto review off — skipped" };
        }
        if (changedFiles.size === 0) {
          return { value: undefined, detail: "no changes to review" };
        }
        const { text, detail, passed } = await this.independentReview(
          ctx,
          changedFiles,
          intent
        );
        assistantText += text;
        reviewVerdict = passed ? "pass" : "fail";
        ctx.record.reviewVerdict = reviewVerdict;
        return { value: undefined, detail, ok: passed };
      });

      await this.stage(ctx, "summary", async () => {
        // Keep live statuses honest. The execute-stage completion gate already
        // resumed the model once with every open step; anything still open is
        // unfinished work, not evidence that summary may silently mark done.
        const text = buildSummary(
          intent,
          [...changedFiles],
          validation,
          plan,
          reviewVerdict,
          gateStillOpen
        );
        this.deps.bus.publish(
          "summary.created",
          { text, changedFiles: [...changedFiles], validation },
          ctx.taskId
        );
        // Conversation memory: later tasks receive this compressed record
        // instead of replayed history, and each unit of work becomes its own
        // retrievable chunk so a switch mid-thread can recall just that part.
        ctx.record.summarized = true;
        // Live statuses, captured before the tracker entry is cleared: the
        // record is what the note report and the interrupted-save path read.
        ctx.record.steps = recordSteps(
          this.deps.planTracker.get(ctx.taskId)?.steps ?? plan.steps
        );
        // Not awaited. Every SQL write inside `save` runs synchronously
        // before its first await, so the memory row and its chunks exist by
        // the time this returns — only the embedding is still outstanding,
        // and nothing in THIS turn reads it. Waiting for the model to embed
        // a summary the user has already finished reading is pure tail.
        const saved = this.deps.summaries.save(
          buildTaskSummary({
            taskId: ctx.taskId,
            conversationId: ctx.conversationId,
            intentSummary: intent.summary,
            originalPrompt: ctx.prompt,
            attachmentPaths: ctx.imagePaths,
            assistantText,
            changedFiles: [...changedFiles],
            validation,
            planGoal: plan.goal,
            // Live statuses from the tracker reflect only model updates and
            // edit evidence; summary never manufactures completion.
            steps: ctx.record.steps,
            reviewVerdict,
            status: "completed",
          })
        );
        // Nothing awaits it, so nothing would surface a rejection.
        void saved.catch(() => undefined);
        return { value: undefined, detail: clip(text, 100) };
      });

      // The wiki compiles AFTER the answer, off the critical path: the
      // user's turn is over, and the page is for the next one.
      if (!answerOnly && changedFiles.size > 0) {
        void this.compileWiki(ctx, assistantText).catch((error) =>
          this.deps.log.warn({ err: error }, "wiki compile failed")
        );
      }
      return { assistantText, sdkSessionId: ctx.sdkSessionId };
    } finally {
      unsubscribe();
      // The lock is stored per conversation; this only drops the per-task
      // binding so a finished taskId cannot leak into a later run.
      this.deps.scopeGuard.release(ctx.taskId);
    }
  }

  /**
   * The bypass path: a plain provider turn, the way Claude Code or Codex
   * behaves on its own.
   *
   * Two stages run and no more. `hooks` stays because a preTask hook is the
   * USER's rule, not Atelier's knowledge; `execute` is the turn itself.
   * Everything the other seven stages produce — intent classification,
   * retrieval, blast radius, the plan, validators, the independent review,
   * the session-memory record — is skipped, so this costs one model call
   * plus whatever the model itself decides to do.
   *
   * Edits are still tracked into the task record: the diffs, the file
   * events and the chat history are how the UI shows work at all, and none
   * of that is knowledge. What is deliberately NOT tracked is the
   * conversation's scope anchors and the plan checklist, which only exist
   * to feed later pipeline runs.
   */
  private async runDirect(ctx: TaskContext): Promise<PipelineOutcome> {
    const changedFiles = ctx.record.changedFiles;
    // Tells the impact / modularity / rewrite guards to stand down for the
    // life of this task — their preconditions cannot be met without the
    // tools this mode withholds.
    this.deps.directTasks.mark(ctx.taskId);
    const unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.topic === "edit.applied" && event.taskId === ctx.taskId) {
        changedFiles.add((event.payload as { path: string }).path);
      }
    });

    try {
      await this.stage(ctx, "hooks", async () => {
        const decision = await this.deps.hooks.evaluatePreTask(
          ctx.prompt,
          ctx.taskId
        );
        if (!decision.allowed) {
          throw new HookBlockedError(decision.reason ?? "blocked by hook");
        }
        return { value: undefined, detail: "passed" };
      });

      const exec = await this.stage(ctx, "execute", async () => {
        const result = await this.streamSession(
          ctx,
          ctx.prompt,
          // The only context this turn gets: the chat transcript itself.
          // Ollama receives it as real user/assistant messages instead (see
          // streamSession), and rendering it here as well would send the
          // same exchange twice.
          [
            isOllamaModel(ctx.opts.model)
              ? ""
              : renderPriorTurns(ctx.priorTurns),
            ctx.recoveryPlan,
          ]
            .filter(Boolean)
            .join("\n"),
          ctx.images,
          "execute",
          { allowedTools: DIRECT_TOOL_NAMES }
        );
        return {
          value: result,
          detail: `direct mode · ${changedFiles.size} file(s) changed`,
        };
      });

      // Enough of a record for the note report and the history list; no
      // session memory is written, which is the point of the mode.
      ctx.record.intentKind = "direct";
      ctx.record.intentSummary = clip(ctx.prompt, 120);
      return { assistantText: exec.text, sdkSessionId: ctx.sdkSessionId };
    } finally {
      unsubscribe();
      this.deps.directTasks.release(ctx.taskId);
    }
  }

  // -------------------------------------------------------------- stages

  private async stage<T>(
    ctx: TaskContext,
    stage: PipelineStage,
    fn: () => Promise<{ value: T; detail?: string; ok?: boolean }>
  ): Promise<T> {
    if (ctx.abort.signal.aborted) throw new AbortError();
    const startedAt = Date.now();
    this.deps.bus.publish("pipeline.stage.started", { stage }, ctx.taskId);
    try {
      const { value, detail, ok = true } = await fn();
      const durationMs = Date.now() - startedAt;
      this.deps.bus.publish(
        "pipeline.stage.completed",
        { stage, ok, detail, durationMs },
        ctx.taskId
      );
      trace({ kind: "stage", taskId: ctx.taskId, stage, ms: durationMs, ok, detail });
      return value;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const detail = clip(String(error), 200);
      this.deps.bus.publish(
        "pipeline.stage.completed",
        { stage, ok: false, detail, durationMs },
        ctx.taskId
      );
      trace({ kind: "stage", taskId: ctx.taskId, stage, ms: durationMs, ok: false, detail });
      throw error;
    }
  }

  /**
   * The goal, with no steps — a placeholder for the things downstream that
   * want a Plan object (the assembler's plan section, the summary line).
   *
   * Stepless ON PURPOSE. It used to carry one invented step, and because
   * that step had a minted id it was rendered into the model's context
   * under "PLAN (report progress via update_plan_step)" — an id the tracker
   * had never been given, so the one call it invited came back "Unknown
   * step id for this task". An empty step list makes the assembler skip the
   * section entirely, and the model writes the real plan with `set_plan`.
   */
  private trivialPlan(ctx: TaskContext, intent: Intent): Plan {
    return {
      id: newId("plan"),
      taskId: ctx.taskId,
      goal: intent.summary,
      steps: [],
      createdAt: Date.now(),
    };
  }

  /**
   * Bounded independent-review loop over what the task actually changed.
   * Each attempt runs in a FRESH SDK session (no resume, read-only tools)
   * so the reviewer has no memory of writing the code and cannot silently
   * "fix" what it should instead be judging — the same agent grading its
   * own work is exactly what let broken edits through before. A `fail`
   * verdict is fed back to the ORIGINAL implementer session for a fix,
   * then re-reviewed, up to maxReviewRetries times; the two inputs the
   * reviewer could not gather itself are computed here: near-identical
   * code in files no import edge reaches (so an unfixed twin surfaces),
   * and the companion files of everything touched (so a template change
   * is judged against its class).
   */
  private async independentReview(
    ctx: TaskContext,
    /** Live set: a repair round adds to it, and the re-review must see that. */
    changed: Set<string>,
    intent: Intent
  ): Promise<{ text: string; detail: string; passed: boolean }> {
    // Review depth follows the change. When no code moved there is nothing
    // for a repair round to legitimately repair, so the reviewer reports
    // once and the loop stops: the findings still reach the user, but no
    // agent is dispatched to act on them. The clone sweep goes with it —
    // an env file has no twin to find, and the probe boots the embedder.
    const deep = touchesCode([...changed]);
    // Retry budget follows the size of the change. Measured across ~50 real
    // reviews: a single pass costs ~30-45% of the execute stage, two costs
    // ~160%, three costs 200-450%. Spending three rounds on a one- or
    // two-file edit is where that went — the budget was flat regardless of
    // how much there was to get wrong.
    const maxAttempts = deep
      ? 1 + Math.min(this.deps.settings.get().maxReviewRetries, retryBudget(changed.size))
      : 1;
    let text = "";
    let verdict: "pass" | "fail" = "fail";
    let findings: string[] = [];
    let attempt = 0;
    /** Previous round's findings, to detect a loop that is not converging. */
    let lastFindings = "";
    let changedFiles: string[] = [];
    let similar: CloneHit[] = [];
    let companionFiles: string[] = [];

    while (attempt < maxAttempts) {
      attempt++;
      // A repair can touch files the first round never saw. Re-derive the
      // reviewer's extra inputs whenever that happens, so round two judges
      // the change as it stands now — clone sweep and companions included.
      const current = [...changed];
      if (current.length !== changedFiles.length) {
        changedFiles = current;
        similar = deep
          ? await this.deps.clones
              .siblingsOf(changedFiles)
              .catch((error: unknown) => {
                this.deps.log.warn({ err: error }, "clone scan failed");
                return [];
              })
          : [];
        companionFiles = companionFilesFor(
          this.deps.config.workspaceRoot,
          changedFiles
        );
      }
      // The reviewer used to open with a `git diff` tool call and then read
      // each changed file — every one a model round trip on a cold session.
      // Fetching it here costs milliseconds and hands the reviewer the thing
      // it was going to ask for anyway, so the turn starts with the evidence
      // instead of spending itself collecting it.
      const diff = await this.reviewDiff(ctx);
      const result = await this.streamSession(
        ctx,
        buildReviewPrompt({
          changedFiles,
          similar,
          companionFiles,
          request: ctx.prompt,
          constraints: intent.constraints,
          diff,
        }),
        "",
        undefined,
        "review",
        { resume: false, allowedTools: READ_ONLY_TOOLS }
      );
      const parsed = extractVerdict(result.text);
      verdict = parsed.verdict;
      findings = parsed.findings;
      // The VERDICT_JSON line is the pipeline's wire format, not something
      // to read: the verdict drives the fix loop and the summary, and the
      // findings ride the review.checked event. Keep it out of the chat.
      const report = withoutVerdictLine(result.text);
      text += report ? `\n\n${report}` : "";

      this.deps.bus.publish(
        "review.checked",
        {
          changedFiles,
          similar: similar.map((hit) => ({
            path: hit.path,
            symbol: hit.symbol,
            score: hit.score,
            resembles: hit.resembles,
          })),
          companionFiles,
          verdict,
          attempt,
          findings,
        },
        ctx.taskId
      );

      if (verdict === "pass" || attempt === maxAttempts) break;

      // A repair round that changed nothing the reviewer cares about means
      // the loop is not converging, and another round costs another review
      // plus another fix to arrive at the same place. The worst runs in the
      // timeline are exactly this shape — fail, fail, fail across three
      // rounds, ending failed anyway, on a two-file change. Stop and report.
      const signature = findings.join("\n");
      if (signature === lastFindings) {
        this.deps.log.warn(
          { taskId: ctx.taskId, attempt },
          "review findings unchanged after repair; stopping the loop"
        );
        break;
      }
      lastFindings = signature;

      // Failed with nothing actionable (the reviewer broke protocol): spend
      // the remaining attempt on another review rather than handing the
      // implementer an empty list of things to fix.
      if (findings.length === 0) continue;

      const fix = await this.streamSession(
        ctx,
        buildReviewFixPrompt({
          findings,
          changedFiles,
          request: ctx.prompt,
          attempt,
          maxAttempts,
        }),
        this.repairContext(ctx),
        undefined,
        "fix"
      );
      text += fix.text ? `\n\n${fix.text}` : "";
    }

    return {
      text,
      passed: verdict === "pass",
      detail:
        verdict === "pass"
          ? `review PASSED (attempt ${attempt}/${maxAttempts})`
          : `review FAILED after ${attempt} attempt(s): ` +
            `${findings.length} finding(s)` +
            (deep ? "" : " — reported only, no code changed to repair"),
    };
  }

  /** Bounded fix loop: run validators, feed failures back, retry. */
  private async validateWithFixLoop(
    ctx: TaskContext,
    changedFiles: string[]
  ): Promise<{ results: ValidationResult[]; extraText: string }> {
    const kinds = this.deps.validators.detect();
    if (kinds.length === 0) return { results: [], extraText: "" };
    const maxRetries = this.deps.settings.get().maxValidationRetries;
    const testPaths = testOnlyPaths(changedFiles);
    let extraText = "";
    let results: ValidationResult[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      results = [];
      for (const kind of kinds) {
        if (ctx.abort.signal.aborted) throw new AbortError();
        this.deps.bus.publish("validation.started", { kind }, ctx.taskId);
        const result = await this.deps.validators.run(kind, {
          signal: ctx.abort.signal,
          paths: testPaths,
          // Streamed so the run is visible while it happens; a validator is
          // the longest stretch of a task with nothing else to show.
          onChunk: (chunk) =>
            this.deps.bus.publish(
              "validation.output",
              { kind, chunk },
              ctx.taskId
            ),
        });
        this.deps.bus.publish("validation.result", result, ctx.taskId);
        this.recordTestRun(ctx.taskId, kind, result);
        results.push(result);
      }
      const failures = results.filter((r) => !r.ok);
      if (failures.length === 0 || attempt === maxRetries) break;

      // Feed the failures back into the same session (bounded).
      const feedback =
        "Validation failed after your changes. Fix these findings now " +
        "using the available tools, then stop:\n" +
        failures
          .map(
            (f) =>
              `## ${f.kind}\n` +
              (f.findings.length > 0
                ? f.findings
                    .slice(0, 20)
                    .map(
                      (finding) =>
                        `- ${finding.path ?? "?"}:${finding.row ?? "?"} ` +
                        `${finding.severity}: ${finding.message}`
                    )
                    .join("\n")
                : clip(f.rawOutput ?? "unknown failure", 1500))
          )
          .join("\n");
      const fix = await this.streamSession(
        ctx,
        feedback,
        this.repairContext(ctx),
        undefined,
        "fix"
      );
      extraText += fix.text;
    }
    return { results, extraText };
  }

  /**
   * The provider-neutral memory for this turn: the session-memory chunks
   * retrieval already surfaced, plus the recent exchange those chunks do not
   * cover. Publishes `session.recalled` so recall is visible in the chat
   * console exactly like knowledge retrieval and impact analysis are.
   */
  private recallSession(
    ctx: TaskContext,
    retrieval: RetrievalResult,
    intentKind: string
  ): SharedSessionContext {
    const chunks = retrieval.chunks.filter((c) => c.kind === "session-memory");
    // Whatever RAG already returned is not worth sending a second time as a
    // summary line; the chunk carries strictly more of the same task.
    const excludeTaskIds = this.deps.summaries.taskIdsForChunks(
      chunks.map((chunk) => chunk.id)
    );
    const shared = this.deps.sharedSessions.build({
      conversationId: ctx.conversationId,
      currentTaskId: ctx.taskId,
      excludeTaskIds,
      maxTokens: sessionTokensFor(intentKind),
      // Ollama carries the newest turns as real messages, so summarising
      // them here as well would pay for the same exchange twice.
      verbatimTurns: isOllamaModel(ctx.opts.model) ? ctx.priorTurns.length : 0,
    });
    if (chunks.length === 0 && shared.tokens === 0) return shared;

    const chunkTokens = chunks.reduce((n, c) => n + (c.tokenCount ?? 0), 0);
    this.deps.bus.publish(
      "session.recalled",
      {
        chunks: chunks.length,
        summaries: shared.summaries,
        turns: shared.turns,
        tokens: shared.tokens + chunkTokens,
        labels: [
          ...chunks.slice(0, 3).map((chunk) => chunkLabel(chunk.preview)),
          ...shared.labels,
        ]
          .filter(Boolean)
          .slice(0, 4),
      },
      ctx.taskId
    );
    return shared;
  }

  /**
   * Feature-wiki pages for this turn. Matching is deterministic (words of
   * the prompt vs page names, files of the turn vs page sources) so it
   * costs nothing and never surprises; the pages themselves are what the
   * turn reads instead of re-deriving the feature from its files.
   */
  private matchWiki(
    ctx: TaskContext,
    intent: Intent,
    retrievedPaths: string[]
  ): void {
    const store = this.deps.wiki;
    if (!store) return;
    try {
      const matched = store.match({
        terms: featureTerms(ctx.prompt),
        namedFiles: [...ctx.scope.named, ...intent.targets],
        files: [...ctx.scope.anchors.slice(0, 8), ...retrievedPaths],
      });
      ctx.wiki = matched.map(({ page }) => ({ page, moved: store.moved(page) }));
      if (ctx.wiki.length === 0) return;
      this.deps.bus.publish(
        "wiki.recalled",
        {
          pages: ctx.wiki.map(({ page, moved }) => ({
            slug: page.slug,
            title: page.title,
            status: moved.length > 0 ? "stale" : page.status,
            moved,
          })),
          tokens: approxTokens(this.renderWiki(ctx, intent.kind)),
        },
        ctx.taskId
      );
    } catch (error) {
      this.deps.log.warn({ err: error }, "wiki match failed");
      ctx.wiki = [];
    }
  }

  private renderWiki(ctx: TaskContext, intentKind: string): string {
    if (ctx.wiki.length === 0) return "";
    const total = wikiTokensFor(intentKind);
    const each = Math.floor(total / ctx.wiki.length);
    const pages = ctx.wiki.map(({ page, moved }) =>
      renderWikiPageForContext(page, moved, each)
    );
    return (
      "\nFEATURE WIKI (compiled knowledge about the features this turn is " +
      "about — read the Flow instead of re-reading every file; verify the " +
      "steps that cite a moved source before editing; the page's Files list " +
      "names the owners):\n" +
      pages.join("\n\n") +
      "\n"
    );
  }

  /**
   * One model call after a change task: update (or create) the page for
   * the feature the task touched, from what the task itself read and
   * changed. Runs after the answer has streamed; a failure is logged.
   */
  private async compileWiki(ctx: TaskContext, report: string): Promise<void> {
    const store = this.deps.wiki;
    const compiler = this.deps.wikiCompiler;
    if (!store || !compiler) return;
    if (process.env.ATELIER_WIKI?.trim() === "0") return;
    if (isDirectMode(ctx.opts)) return;
    const changedFiles = [...ctx.record.changedFiles];
    // Pages already matched for the turn win; otherwise any page whose
    // sources this task edited is the one to update.
    const candidates =
      ctx.wiki.length > 0
        ? ctx.wiki.map(({ page }) => page)
        : store.pagesForFiles(changedFiles);
    const diffs: string[] = [];
    for (const file of changedFiles.slice(0, 6)) {
      try {
        const { diff } = await this.deps.git.diff(file);
        if (diff) diffs.push(diff);
      } catch {
        // No repo, or a file git does not track — the page still compiles
        // from the report and the files.
      }
    }
    const readPaths =
      this.deps.workingMemory?.readsForTask(ctx.conversationId, ctx.taskId) ??
      [];
    const result = await compiler.compile({
      taskId: ctx.taskId,
      request: ctx.prompt,
      report,
      changedFiles,
      readPaths,
      planSteps: ctx.record.steps.map((step) => ({
        title: step.title,
        files: step.files,
        status: step.status,
      })),
      diff: clip(diffs.join("\n"), WIKI_DIFF_CHARS),
      candidates,
    });
    if (!result) return;
    this.deps.bus.publish(
      "wiki.updated",
      {
        slug: result.page.slug,
        title: result.page.title,
        created: result.created,
        changedSections: result.changedSections,
        sources: result.page.sources.length,
        path: `${WIKI_FEATURES_DIR}/${result.page.slug}.md`,
      },
      ctx.taskId
    );
  }

  /**
   * The investigation earlier turns already did, rendered for this one.
   * Publishes the evidence line the rail shows; the block itself rides in
   * the execute context under "previously gathered".
   */
  private async recallWorkingMemory(
    ctx: TaskContext,
    intentKind: string
  ): Promise<RecalledWorkingMemory> {
    const store = this.deps.workingMemory;
    if (!store) return EMPTY_RECALL;
    // Small talk looks nothing up and should not pay to carry old reads.
    if (isTrivialChat(ctx.prompt, ctx.images.length > 0)) return EMPTY_RECALL;
    try {
      // On Ollama the block competes with the rules and the tool loop for
      // one fixed window, and a model that reports no window gets a small
      // default — so the budget also bows to the window it will ride in.
      const window = isOllamaModel(ctx.opts.model)
        ? await resolveNumCtx(
            ollamaModelName(ctx.opts.model as string),
            ollamaTargetOf(ctx.opts.model) ?? "ollama-cloud"
          ).catch(() => undefined)
        : undefined;
      const maxTokens = Math.min(
        workingMemoryTokensFor(intentKind),
        window ? Math.floor(window * WORKING_MEMORY_WINDOW_SHARE) : Infinity
      );
      const gathered = await store.recall({
        conversationId: ctx.conversationId,
        currentTaskId: ctx.taskId,
        files: this.deps.files,
        maxTokens,
        // The matched wiki page names the feature's owner files; the first
        // few ride in as content, so the turn can edit without opening them.
        seedPaths: ctx.wiki.flatMap(({ page }) =>
          page.sources.map((source) => source.path)
        ),
      });
      if (gathered.tokens > 0) {
        this.deps.bus.publish(
          "working-memory.reused",
          {
            inlined: gathered.inlined,
            listed: gathered.listed,
            changed: gathered.changed,
            searches: gathered.searches,
            tokens: gathered.tokens,
            paths: gathered.inlinedPaths,
            seeded: gathered.seeded,
          },
          ctx.taskId
        );
      }
      return gathered;
    } catch (error) {
      this.deps.log.warn({ err: error }, "working memory recall failed");
      return EMPTY_RECALL;
    }
  }

  private repairContext(ctx: TaskContext): string {
    const current =
      ctx.collectedText.trim().length > 0
        ? "CURRENT TASK TRANSCRIPT SO FAR:\n" + clip(ctx.collectedText, 1600)
        : "";
    const shared = this.deps.sharedSessions.build({
      conversationId: ctx.conversationId,
      currentTaskId: ctx.taskId,
    });
    return [shared.text, current].filter(Boolean).join("\n");
  }

  /**
   * Writes session memory for a task that never reached the summary stage.
   * Without this a cancelled task leaves no retrievable trace, which is
   * exactly the turn a user is most likely to follow with "continue" on a
   * different provider.
   */
  /**
   * Copies the tracker's live step statuses into the task record. Has to run
   * while the tracker entry still exists — a task's end clears it, and
   * without the refresh a step that genuinely got done is reported as work
   * the run never reached.
   *
   * Split out of the save because a cancelled task is now reported as over
   * BEFORE its memory is written: the statuses are taken on the way out, the
   * embedding work that follows no longer holds the user's stop button.
   */
  captureLivePlanSteps(ctx: TaskContext): void {
    const live = this.deps.planTracker.get(ctx.taskId)?.steps;
    if (live) ctx.record.steps = recordSteps(live);
  }

  async saveInterruptedSummary(
    ctx: TaskContext,
    status: "cancelled" | "error"
  ): Promise<void> {
    // A direct turn writes no memory when it succeeds, so it must not write
    // any when it is cancelled either — that record would come back as a
    // retrievable chunk in the next pipeline run.
    if (isDirectMode(ctx.opts) || ctx.record.summarized) return;
    const record = ctx.record;
    this.captureLivePlanSteps(ctx);
    const hasWork =
      record.changedFiles.size > 0 ||
      ctx.collectedText.trim().length > 0 ||
      record.intentSummary.length > 0;
    if (!hasWork) return;
    ctx.record.summarized = true;
    await this.deps.summaries.save(
      buildTaskSummary({
        taskId: ctx.taskId,
        conversationId: ctx.conversationId,
        intentSummary: record.intentSummary || clip(ctx.prompt, 120),
        originalPrompt: ctx.prompt,
        attachmentPaths: ctx.imagePaths,
        changedFiles: [...record.changedFiles],
        validation: record.validation,
        planGoal: record.planGoal,
        steps: record.steps,
        reviewVerdict: record.reviewVerdict,
        status,
        partialText: ctx.collectedText,
      })
    );
  }

  // ----------------------------------------------------------- SDK calls

  /**
   * One-shot structured call: no tools, one turn. Routed by provider — an
   * Ollama selection runs on the local daemon, anything else on the small
   * Claude model. The prompt is built identically either way, so the RAG,
   * knowledge and impact context in it is unaffected by the choice.
   */
  /**
   * `withImages` is for the stages that classify the REQUEST rather than the
   * code: when the user's message is a screenshot plus five words, the text
   * alone names no subject, and a classifier that cannot see the picture
   * hands retrieval a query with nothing in it. Off by default — the stages
   * that summarise or review already-read code gain nothing from re-sending
   * the attachments.
   */
  private async shortSdkCall(
    ctx: TaskContext,
    systemPrompt: string,
    prompt: string,
    withImages = false,
    claudeMaxTurns = 1
  ): Promise<string> {
    publishLlmRequest(
      this.deps.bus,
      ctx.taskId,
      buildLlmRequest({
        purpose: "understand",
        provider: "one-shot",
        model: String(ctx.opts.model ?? STAGE_MODEL),
        sections: [{ name: "system prompt", text: systemPrompt }],
        prompt,
      })
    );
    return runOneShot({
      model: ctx.opts.model,
      claudeFallback: STAGE_MODEL,
      system: systemPrompt,
      prompt,
      cwd: this.deps.config.workspaceRoot,
      signal: ctx.abort.signal,
      effort: ctx.opts.effort,
      claudeMaxTurns,
      ...(withImages && ctx.images.length ? { images: ctx.images } : {}),
    });
  }

  /**
   * The working-tree patch, fetched server-side for the review prompt. Best
   * effort: on a non-repo workspace or a git failure the reviewer simply
   * falls back to reading files with its own tools, exactly as before, so a
   * missing diff costs speed rather than correctness.
   */
  private async reviewDiff(ctx: TaskContext): Promise<string> {
    try {
      const result = await this.deps.tools.run<{ diff?: string }>(
        "git",
        { action: "diff" },
        ctx.taskId,
        ctx.abort.signal
      );
      return typeof result?.diff === "string" ? result.diff : "";
    } catch (error) {
      this.deps.log.warn({ err: error }, "review diff unavailable");
      return "";
    }
  }

  /**
   * Swap the stage-4 plan for the one the plan pass just produced. Stage 4
   * still runs and still publishes first — it is the floor, and the only
   * plan there is on a provider without plan mode or on a turn where the
   * model never calls ExitPlanMode. This supersedes it when a real,
   * code-grounded plan arrives, and the UI follows because it renders from
   * plan.created either way. A plan we cannot parse into steps is dropped
   * rather than replacing a usable one with an empty checklist.
   */
  private adoptPlan(ctx: TaskContext, markdown: string): void {
    const plan = planFromMarkdown(ctx.taskId, markdown, ctx.record.planGoal);
    if (!plan) {
      this.deps.log.warn(
        { raw: clip(markdown, 400) },
        "plan text had no parsable steps; keeping stage-4 plan"
      );
      return;
    }
    this.deps.planTracker.setPlan(plan);
    this.deps.bus.publish("plan.created", plan, ctx.taskId);
    ctx.record.planGoal = plan.goal;
    ctx.record.steps = recordSteps(plan.steps);
  }

  /**
   * The main interactive session (stage 6 + validation fix rounds):
   * streams deltas to chat, keeps an in-task SDK session when available, and
   * exposes Atelier tools through the in-process MCP server.
   */
  private async streamSession(
    ctx: TaskContext,
    prompt: string,
    appendContext: AppendContext = "",
    images?: ImageAttachment[],
    purpose: ContextPurpose = "execute",
    opts: {
      resume?: boolean;
      allowedTools?: string[];
      /** Run the internal plan pass before editing — Claude models only. */
      systemPlan?: boolean;
      /** Overrides the purpose's ceiling; only the continuation sets it. */
      maxTurns?: number;
      /** Live evidence checked by Claude's Stop hook before accepting a report. */
      completionGate?: () => string;
      /**
       * Files whose exact current content already rides in the context
       * (previously gathered). Ollama's blind-edit guard accepts them as
       * read; other providers hold the same bytes and need no guard.
       */
      preGrounded?: string[];
    } = {}
  ): Promise<{ text: string }> {
    const resume = opts.resume ?? true;
    const sdkContext: SdkToolContext = {
      taskId: ctx.taskId,
      signal: ctx.abort.signal,
    };
    const mcpServer = createAtelierMcpServer(
      this.deps.tools,
      () => sdkContext,
      (imagePath) => this.deps.attachments.load(imagePath)
    );
    let text = "";
    // Claude streams candidate report text before its Stop hook runs. Keep
    // that text private while a completion gate exists; a blocked Stop drops
    // the candidate, and only an accepted Stop releases the final report.
    let completionAccepted = opts.completionGate === undefined;

    const hasImages = images !== undefined && images.length > 0;
    // A greeting does not need a reasoning pass. Only the turn the user
    // typed is tested — the review and fix rounds carry their own prompts
    // and always run at the picked effort.
    const effort =
      purpose === "execute"
        ? effortFor(prompt, hasImages, ctx.opts.effort)
        : ctx.opts.effort;
    if (effort !== ctx.opts.effort) {
      this.deps.log.info({ effort }, "trivial chat turn — effort lowered");
    }
    // Provider-neutral: the same layout block precedes the rules on every
    // backend, so a Codex or Ollama run knows the folder shape too. It
    // survives direct mode — knowing the real folder names is not knowledge
    // retrieval, and without it the model invents paths.
    const layout = await this.workspaceLayout();
    // Direct mode swaps the whole rule block: SYSTEM_RULES describes a
    // knowledge engine this turn does not have, down to tools it cannot
    // call and hooks that will not fire.
    const direct = isDirectMode(ctx.opts);
    // FAST_RULES, not SYSTEM_RULES. The old block was ~110 lines describing
    // guards this turn no longer arms, and prose the model paid to read on
    // every cache miss. What survived is only what changes what the model
    // DOES: reach for the index first, finish the turn, stay in the
    // workspace, and the two hooks that will stop it and ask the user.
    // The modularity clause went with the guard that enforced it.
    // The user's own rules stay LAST — they are instructions for this
    // workspace, and they are declared to win.
    const rules =
      ATELIER_EXECUTOR_CONTRACT +
      (direct ? DIRECT_RULES : FAST_RULES) +
      (await this.userRules(ctx));
    // Rides AFTER the static rules, never between them: the lock changes
    // per conversation, and splitting the static prefix would invalidate
    // the provider prompt cache on every turn. A direct turn has no lock —
    // the scope store is part of the pipeline, not of a plain agent loop.
    const scoped = direct ? "" : await this.scopeContext(ctx);
    // Byte-identical Atelier context for every interactive provider. Native
    // provider presets and transport protocols still differ, but model
    // selection can no longer add or remove the executor contract itself.
    const providerContext =
      layout +
      rules +
      (ctx.opts.vibe ? VIBE_RULES : "") +
      scoped +
      contextText(appendContext);
    // What is about to be sent, block by block, published BEFORE the call:
    // this is the row the timeline shows as "sent to model", and it has to
    // exist even for a call that never comes back.
    const requestSections: ContextSection[] = [
      { name: "workspace layout", text: layout },
      { name: "rules", text: rules },
      { name: "vibe rules", text: ctx.opts.vibe ? VIBE_RULES : "" },
      { name: "scope lock", text: scoped },
      ...contextSections(appendContext),
    ];
    const modelLabel = String(ctx.opts.model ?? "claude (default)");
    const announceRequest = (
      provider: LlmProvider,
      extra: {
        round?: number;
        transcript?: LlmTranscriptEntry[];
        transcriptChars?: number;
        toolsOffered?: number;
        contextWindow?: number;
        elided?: number;
        promptSuffix?: string;
        resumes?: boolean;
      } = {}
    ): void => {
      const round = extra.round ?? 0;
      publishLlmRequest(
        this.deps.bus,
        ctx.taskId,
        buildLlmRequest({
          purpose,
          provider,
          model: modelLabel,
          round,
          sections: round === 0 ? requestSections : [],
          prompt: round === 0 ? prompt + (extra.promptSuffix ?? "") : "",
          transcript: extra.transcript,
          transcriptChars: extra.transcriptChars,
          toolsOffered: extra.toolsOffered,
          contextWindow: extra.contextWindow,
          elided: extra.elided,
          resumes: extra.resumes,
        })
      );
    };

    if (isOllamaModel(ctx.opts.model)) {
      return {
        text: await runOllamaAgentLoop({
          model: ollamaModelName(ctx.opts.model as string),
          // Routes the turn at the endpoint the picked row came from: the
          // daemon on this machine, or the hosted account.
          target: ollamaTargetOf(ctx.opts.model) ?? "ollama-cloud",
          system: providerContext,
          prompt,
          images,
          // The chat itself, as turns. Ollama has no session to resume, so
          // without these a follow-up ("it's still not fixed") arrives with
          // no idea what this assistant answered a minute ago — the recall
          // block in the system prompt describes that exchange, it is not
          // that exchange. Direct mode drops its own rendered copy rather
          // than send the same turns twice — see runDirect.
          priorTurns: ctx.priorTurns,
          // Resuming, in the only form a stateless endpoint has. A
          // non-resuming call (the independent reviewer) gets no transcript
          // and leaves none behind.
          ...(resume ? { transcript: ctx.ollamaTranscript } : {}),
          tools: this.deps.tools,
          files: this.deps.files,
          toolNames: direct ? DIRECT_TOOLS : undefined,
          preGrounded: opts.preGrounded,
          // Decides the reasoning models' hidden pass; see the loop.
          effort,
          taskId: ctx.taskId,
          signal: ctx.abort.signal,
          // Every round, not just the first: Ollama replays the whole
          // transcript per round, so the round that outgrew the window is
          // the one worth seeing.
          onRequest: (info) =>
            announceRequest("ollama", {
              round: info.round,
              // Round 0 is described by its sections and prompt; only the
              // prior chat turns riding as messages are transcript there,
              // so the system and prompt bytes are taken back out.
              transcript:
                info.round === 0 && info.transcript.length <= 2
                  ? undefined
                  : info.transcript,
              transcriptChars:
                info.round === 0
                  ? Math.max(
                      0,
                      info.transcriptChars -
                        providerContext.length -
                        prompt.length
                    )
                  : info.transcriptChars,
              toolsOffered: info.toolsOffered,
              contextWindow: info.contextWindow,
              elided: info.elided,
            }),
          // Ollama has no SDK Stop event, so its loop applies the same live
          // completion evidence at the no-tool response boundary.
          ...(opts.completionGate
            ? {
                completionGate: opts.completionGate,
                onCompletionBlocked: (reason: string) => {
                  this.deps.bus.publish(
                    "hook.blocked",
                    {
                      hookId: "completion-gate",
                      name: "Completion gate",
                      reason,
                    },
                    ctx.taskId
                  );
                },
              }
            : {}),
          emitText: (delta) => {
            ctx.collectedText += delta;
            this.deps.bus.publish(
              "chat.message.delta",
              {
                conversationId: ctx.conversationId,
                messageId: ctx.messageId,
                delta,
              },
              ctx.taskId
            );
          },
          // Same surface Claude's thinking uses, so a reasoning model's
          // long quiet stretch shows as thought instead of a hang.
          emitThinking: (delta) => {
            this.deps.bus.publish(
              "agent.thinking.delta",
              { conversationId: ctx.conversationId, delta },
              ctx.taskId
            );
          },
        }),
      };
    }

    if (isGrokModel(ctx.opts.model)) {
      announceRequest("grok", {
        toolsOffered: direct ? DIRECT_TOOLS.length : undefined,
      });
      return {
        text: await runGrokAgentLoop({
          model: grokModelName(ctx.opts.model as string),
          system: providerContext,
          prompt,
          images,
          tools: this.deps.tools,
          files: this.deps.files,
          toolNames: direct ? DIRECT_TOOLS : undefined,
          effort,
          taskId: ctx.taskId,
          signal: ctx.abort.signal,
          emitText: (delta) => {
            ctx.collectedText += delta;
            this.deps.bus.publish(
              "chat.message.delta",
              {
                conversationId: ctx.conversationId,
                messageId: ctx.messageId,
                delta,
              },
              ctx.taskId
            );
          },
          emitThinking: (delta) => {
            this.deps.bus.publish(
              "agent.thinking.delta",
              { conversationId: ctx.conversationId, delta },
              ctx.taskId
            );
          },
        }),
      };
    }

    if (isCodexModel(ctx.opts.model)) {
      const toolBridge = await this.deps.codexTools.session(
        ctx.taskId,
        ctx.abort.signal
      );
      announceRequest("codex", { promptSuffix: CODEX_MCP_RULES });
      const text = await runCodexExec({
        cwd: this.deps.config.workspaceRoot,
        model: codexModelName(ctx.opts.model as string),
        // Codex workspace mutations must go through Atelier MCP so hooks,
        // diffs, scope and cancellation stay observable. Its native sandbox
        // remains read-only even for implementation turns.
        sandbox: "read-only",
        effort,
        signal: ctx.abort.signal,
        toolBridge,
        toolNames: direct ? DIRECT_TOOLS : undefined,
        images,
        telemetry: {
          bus: this.deps.bus,
          taskId: ctx.taskId,
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
        },
        prompt:
          providerContext +
          CODEX_MCP_RULES +
          "\n\n" +
          prompt,
      }).finally(() => toolBridge.dispose());
      if (text) ctx.collectedText += text;
      return { text };
    }

    // The INTERNAL plan pass. Distinct from the Plan checkbox
    // (ctx.opts.planMode), which is the interactive mode: there the plan goes
    // to the user, they collaborate on it, and the turn stops at approval.
    // This one never prompts — it captures the plan the model produces and
    // flips the SAME session to execute, so every file the planner read is
    // still in context when the implementer starts. The checkbox wins if
    // both are on, because a user asking to plan wants to be asked.
    const systemPlan = opts.systemPlan === true && !ctx.opts.planMode;
    const planning = systemPlan || ctx.opts.planMode === true;

    // canUseTool closes over the query it belongs to, so the handle is
    // declared first and assigned below; it is only ever read from inside a
    // tool callback, which cannot fire before query() has returned.
    let session: Query | undefined;
    // canUseTool IS the permission layer, so a blanket allow inside it would
    // override plan mode's own read-only gate for Atelier's MCP tools. This
    // flag is what keeps the plan pass honest until ExitPlanMode flips it.
    let planPhase = systemPlan;

    // With images, the Claude turn is a structured multimodal user message.
    // The plan pass also needs streaming input — setPermissionMode is only
    // available in that mode — so plain text is wrapped the same way there.
    // Measured from just before the SDK is asked for a session: everything
    // after this point is process spawn + prefill + the model's own first
    // token — the half of the wait no amount of pipeline work can shorten,
    // and the number to compare a prompt-size change against.
    const spawnedAt = Date.now();
    let firstToken = false;
    announceRequest("claude", {
      resumes: resume && ctx.sdkSessionId !== null,
      toolsOffered:
        opts.allowedTools?.length === 0
          ? 0
          : direct
            ? DIRECT_TOOLS.length
            : undefined,
    });
    /**
     * SDK-builtin tool calls awaiting their result, by tool_use id. Only
     * builtins land here — MCP calls already have their whole lifecycle
     * published by ToolRegistry. Anything still open when the stream ends
     * is closed out below, so a rail row can never be left spinning.
     */
    const builtinToolCalls = new Map<string, { name: string; at: number }>();
    const stream = query({
      prompt: hasImages
        ? imagePrompt(prompt, images)
        : systemPlan
          ? streamedPrompt(prompt)
          : prompt,
      options: {
        cwd: this.deps.config.workspaceRoot,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          // Stable-first ordering for prompt caching: static rule blocks
          // precede the per-task context, and each block is byte-stable.
          append: providerContext,
        },
        permissionMode: planning ? "plan" : "bypassPermissions",
        ...(systemPlan
          ? {
              planModeInstructions: SYSTEM_PLAN_INSTRUCTIONS,
              canUseTool: async (
                name: string,
                input: Record<string, unknown>
              ): Promise<PermissionResult> => {
                if (name === "ExitPlanMode") {
                  const raw = typeof input.plan === "string" ? input.plan : "";
                  if (raw) this.adoptPlan(ctx, raw);
                  // The flip is the whole point: same session, so the reads
                  // that produced the plan are still context for the edits.
                  await session?.setPermissionMode("bypassPermissions");
                  planPhase = false;
                  return { behavior: "allow", updatedInput: input };
                }
                if (planPhase && !READ_ONLY_TOOLS.includes(name)) {
                  return {
                    behavior: "deny",
                    message:
                      "Still planning — that tool writes. Read what you " +
                      "need, then call ExitPlanMode with the plan.",
                  };
                }
                return { behavior: "allow", updatedInput: input };
              },
            }
          : {}),
        // This path is only for Claude models. Ollama selections are handled
        // by runOllamaAgentLoop above because the Claude SDK cannot run them.
        ...(opts.completionGate
          ? {
              hooks: {
                Stop: [
                  {
                    hooks: [
                      async (input) => {
                        const stopHookActive =
                          typeof input === "object" &&
                          input !== null &&
                          (input as { stop_hook_active?: unknown })
                            .stop_hook_active === true;
                        const decision = completionStopHookDecision(
                          opts.completionGate!(),
                          stopHookActive
                        );
                        completionAccepted = decision.decision !== "block";
                        if (decision.decision === "block") {
                          // The report was already generated into our private
                          // buffer, but must never reach chat or a later pass.
                          text = "";
                          this.deps.bus.publish(
                            "hook.blocked",
                            {
                              hookId: "completion-gate",
                              name: "Completion gate",
                              reason: decision.reason,
                            },
                            ctx.taskId
                          );
                        }
                        return decision;
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
        ...(sdkModel(ctx.opts.model)
          ? { model: sdkModel(ctx.opts.model) }
          : {}),
        ...(claudeEffort(effort) ? { effort: claudeEffort(effort) } : {}),
        // A normal Claude Code query is otherwise open-ended. Tool loops and
        // failed repair attempts can keep spending the five-hour quota long
        // after the useful work stopped. Purpose-aware ceilings leave enough
        // room for a grounded coding pass while bounding every SDK session.
        maxTurns: opts.maxTurns ?? claudeTurnBudget(purpose),
        disallowedTools: DISABLED_BUILTINS,
        mcpServers: { [MCP_SERVER_NAME]: mcpServer },
        strictMcpConfig: true,
        // An explicitly empty list is a casual turn: no tools at all, not
        // "the default surface". Everything else gets the fast builtins,
        // which are read-only and so safe on every surface — including the
        // reviewer's and the plan pass's.
        allowedTools:
          opts.allowedTools?.length === 0
            ? []
            : [
                ...(opts.allowedTools ??
                  (direct
                    ? DIRECT_TOOLS.map(
                        (name) => `mcp__${MCP_SERVER_NAME}__${name}`
                      )
                    : [`mcp__${MCP_SERVER_NAME}__*`])),
                ...CLAUDE_FAST_BUILTINS,
              ],
        includePartialMessages: true,
        // Atelier injects selected skills itself so disabled skills cannot
        // leak through Claude's native user/project settings.
        settingSources: [],
        abortController: ctx.abort,
        ...(resume && ctx.sdkSessionId ? { resume: ctx.sdkSessionId } : {}),
      },
    });
    session = stream;

    /**
     * Set when this session ran out of rounds rather than finishing. Two
     * things say so and only one of them is reliable: the `error_max_turns`
     * result message, and — because the CLI then exits non-zero and the SDK
     * rethrows that as an error — the throw that lands right after it.
     */
    let turnLimitHit = false;
    // Iterating the wrapper instead of the query is what keeps the throw
    // from unwinding the whole task; everything else about the loop, the
    // abort break included, behaves exactly as before.
    for await (const message of tolerateTurnLimit(stream, () => {
      turnLimitHit = true;
    })) {
      // A cancel aborts the SDK's own controller, but the teardown it
      // triggers is not instant. Leaving the loop on the signal stops this
      // turn streaming text into a chat the user has already stopped, and
      // closes the iterator (which is what actually ends the subprocess).
      if (ctx.abort.signal.aborted) break;
      const m = message as Record<string, unknown>;
      if (m.type === "system" && m.subtype === "init") {
        // A non-resuming turn (the independent review) runs in a throwaway
        // session: never let its id replace the implementer's, or the fix
        // round after a `fail` would resume the reviewer instead of the
        // agent that actually wrote the code.
        const sid = m.session_id as string | undefined;
        if (resume && sid && sid !== ctx.sdkSessionId) {
          ctx.sdkSessionId = sid;
          ctx.onSdkSessionId(sid);
        }
      }
      // Plan usage moves as the task spends; the status bar follows live.
      if (m.type === "rate_limit_event") {
        this.deps.usage.recordEvent(m.rate_limit_info);
      }
      // The SDK's OWN tools — Grep and Glob (CLAUDE_FAST_BUILTINS) — never
      // touch ToolRegistry, so nothing was publishing tool.* for them. They
      // are also most of what a turn does: it spends its calls looking for
      // things. The rail therefore sat on whichever MCP label happened to be
      // last while the model searched, and a Task fan-out was wholly
      // invisible. These three branches close that hole; the registry stays
      // the source of truth for its own tools, so MCP names are skipped here
      // rather than reported twice.
      if (m.type === "assistant") {
        const toolUses = assistantToolUses(m);
        if (opts.completionGate && toolUses.length > 0) {
          // Text beside a tool call is process narration, not the accepted
          // report. Keep only the final no-tool candidate in the buffer.
          text = "";
        }
        for (const block of toolUses) {
          builtinToolCalls.set(block.id, { name: block.name, at: Date.now() });
          this.deps.bus.publish(
            "tool.started",
            { toolCallId: block.id, name: block.name, input: block.input },
            ctx.taskId
          );
        }
      }
      if (m.type === "user") {
        for (const block of userToolResults(m)) {
          const started = builtinToolCalls.get(block.toolUseId);
          if (!started) continue;
          builtinToolCalls.delete(block.toolUseId);
          const durationMs = Date.now() - started.at;
          if (block.isError) {
            this.deps.bus.publish(
              "tool.failed",
              {
                toolCallId: block.toolUseId,
                name: started.name,
                error: clip(block.text || "tool reported an error", 300),
                durationMs,
              },
              ctx.taskId
            );
          } else {
            this.deps.bus.publish(
              "tool.completed",
              {
                toolCallId: block.toolUseId,
                name: started.name,
                result: { summary: clip(block.text, 200) },
                durationMs,
              },
              ctx.taskId
            );
          }
        }
      }
      if (m.type === "stream_event") {
        const event = m.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (event?.type === "content_block_delta" && event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text) {
            if (!firstToken) {
              firstToken = true;
              trace({
                kind: "first_token",
                taskId: ctx.taskId,
                ms: Date.now() - spawnedAt,
                detail: purpose,
              });
            }
            text += event.delta.text;
            if (!opts.completionGate) {
              ctx.collectedText += event.delta.text;
              this.deps.bus.publish(
                "chat.message.delta",
                {
                  conversationId: ctx.conversationId,
                  messageId: ctx.messageId,
                  delta: event.delta.text,
                },
                ctx.taskId
              );
            }
          } else if (
            event.delta.type === "thinking_delta" &&
            event.delta.thinking
          ) {
            this.deps.bus.publish(
              "agent.thinking.delta",
              {
                conversationId: ctx.conversationId,
                delta: event.delta.thinking,
              },
              ctx.taskId
            );
          }
        }
      }
      if (m.type === "result") {
        if (m.subtype === "error_max_turns") turnLimitHit = true;
        const resultText = m.result as string | undefined;
        if (!text && resultText) text = resultText;
        // Real token accounting: reconcile the assembled-context estimate
        // with what the request actually cost (cache reads broken out).
        const usage = m.usage as SdkUsage | undefined;
        if (usage) {
          this.deps.ledger.attachSdkUsage(
            ctx.taskId,
            ctx.conversationId,
            purpose,
            usage
          );
        }
      }
    }
    const acceptedText = completionReportText(text, completionAccepted);
    if (opts.completionGate && acceptedText) {
      ctx.collectedText += acceptedText;
      this.deps.bus.publish(
        "chat.message.delta",
        {
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          delta: acceptedText,
        },
        ctx.taskId
      );
    }
    if (opts.completionGate) text = acceptedText;
    // A builtin whose result never arrived — the stream ended first, or the
    // turn was cancelled mid-call. Left open, its row spins in the rail for
    // the rest of the session, which reads as a hung tool.
    for (const [toolCallId, started] of builtinToolCalls) {
      this.deps.bus.publish(
        "tool.failed",
        {
          toolCallId,
          name: started.name,
          error: ctx.abort.signal.aborted ? "cancelled" : "no result returned",
          durationMs: Date.now() - started.at,
        },
        ctx.taskId
      );
    }
    builtinToolCalls.clear();
    // Unwind on the spot rather than carrying a half-streamed answer into the
    // next stage, which would only be stopped at the following boundary.
    if (ctx.abort.signal.aborted) throw new AbortError();
    // A turn that ends still in the plan phase never reached ExitPlanMode, so
    // the flip never happened and nothing was ever allowed to change — the
    // user gets an analysis and an offer to implement. Take the plan the
    // model wrote as prose and carry the SAME session into the edits. This
    // is checked before the turn ceiling because it is the better
    // continuation: a plan pass that ran out of rounds still needs to be
    // pushed into implementing, not merely told to wrap up.
    if (planPhase) {
      if (text) this.adoptPlan(ctx, text);
      return { text: text + (await this.nudgeToImplement(ctx, appendContext)) };
    }
    // Out of rounds, not out of work. Carry the session on; if there is
    // nothing left to carry it with, the text and the edits still stand and
    // the user is told the turn stopped early.
    if (turnLimitHit) {
      const rest = await this.continuePastTurnLimit(
        ctx,
        appendContext,
        purpose,
        {
          resume,
          allowedTools: opts.allowedTools,
          completionGate: opts.completionGate,
        }
      );
      return { text: text + rest };
    }
    return { text };
  }

  /**
   * Carries a session that spent its turn ceiling into a bounded wrap-up
   * round, in the SAME session, so every file it read is still context.
   *
   * The ceiling exists to bound what one turn can spend, and it does its
   * job — but the SDK reports reaching it as a thrown error, which used to
   * take the whole task down with it: no answer, no summary, no session
   * memory, just a red banner over work that had already partly happened.
   * A short convergence round is both the honest and the cheaper ending.
   *
   * Returns the continuation's text, or a note when there is no
   * continuation left to spend.
   */
  private async continuePastTurnLimit(
    ctx: TaskContext,
    appendContext: AppendContext,
    purpose: ContextPurpose,
    opts: {
      resume: boolean;
      allowedTools?: string[];
      completionGate?: () => string;
    }
  ): Promise<string> {
    // A non-resuming session (the independent reviewer) has no id of its own
    // on the context — resuming here would continue the IMPLEMENTER instead,
    // which is exactly the confusion the fresh reviewer session exists to
    // avoid. It reports on what it managed to see.
    const resumable = opts.resume && ctx.sdkSessionId !== null;
    // Stalls end the loop, not the count: a task that keeps landing edits
    // may run through many ceilings, and every one that moved the
    // evidence earned the next.
    const spent =
      ctx.turnLimitStalls >= loopHarnessLimits().continuationStallLimit;
    if (!resumable || spent) {
      this.deps.log.warn(
        { taskId: ctx.taskId, purpose, resumable },
        "turn ceiling reached with no continuation left"
      );
      return TURN_LIMIT_NOTE;
    }
    ctx.turnLimitContinuations += 1;
    // A turn that owed an edit and produced none did not run out of room
    // mid-change — it never reached the change. Give it an implementation
    // budget rather than a convergence one, because its earlier rounds all
    // went on reading and none on writing.
    const unstarted =
      ctx.mustEdit &&
      purpose === "execute" &&
      ctx.record.changedFiles.size === 0;
    this.deps.log.warn(
      {
        taskId: ctx.taskId,
        purpose,
        attempt: ctx.turnLimitContinuations,
        unstarted,
      },
      unstarted
        ? "turn ceiling reached with no edits; pushing the session to implement"
        : "turn ceiling reached; continuing the session to finish the work"
    );
    const evidenceBefore = this.completionEvidence(ctx);
    const outstanding = opts.completionGate?.() ?? "";
    const blockers = ctx.blockers?.drain() ?? [];
    const prompt =
      blockers.length > 0
        ? harnessPrompt({
            outstanding:
              outstanding || turnLimitContinuationPrompt("", unstarted),
            changedFiles: [...ctx.record.changedFiles],
            stepsDone: evidenceBefore.stepsDone,
            stepsTotal: this.deps.planTracker.get(ctx.taskId)?.steps.length ?? 0,
            attempt: ctx.turnLimitContinuations,
            stalled: ctx.turnLimitStalls,
            blockers,
          })
        : turnLimitContinuationPrompt(outstanding, unstarted);
    const { text } = await this.streamSession(
      ctx,
      prompt,
      appendContext,
      undefined,
      purpose,
      {
        resume: true,
        allowedTools: opts.allowedTools,
        systemPlan: false,
        maxTurns: claudeContinuationBudget(purpose, unstarted),
        completionGate: opts.completionGate,
      }
    );
    const evidenceAfter = this.completionEvidence(ctx);
    ctx.turnLimitStalls =
      evidenceAfter.edits > evidenceBefore.edits ||
      evidenceAfter.stepsDone > evidenceBefore.stepsDone
        ? 0
        : ctx.turnLimitStalls + 1;
    return text ? `\n\n${text}` : TURN_LIMIT_NOTE;
  }

  /** Live completion evidence, for the progress-driven loops. */
  private completionEvidence(ctx: TaskContext): {
    edits: number;
    stepsDone: number;
  } {
    return {
      edits: ctx.record.changedFiles.size + ctx.record.editCount,
      stepsDone:
        this.deps.planTracker
          .get(ctx.taskId)
          ?.steps.filter((step) => step.status === "done").length ?? 0,
    };
  }

  /**
   * Pushes a stalled run into actually editing — at most once per task.
   *
   * Two shapes end a turn with an analysis instead of a change: the plan
   * pass never calls ExitPlanMode, so nothing was ever permitted to write;
   * or it exits and then asks ("say the word and I'll implement it").
   * Unattended, both are a failed turn — plan mode is the user's checkbox,
   * and with it off, planning is what happens BEFORE editing in the same
   * turn, not instead of it.
   *
   * The continuation resumes the same session, so every file the planner
   * read is still in context. Bounded to one so a run that genuinely has
   * nothing to change cannot be made to loop here.
   */
  private async nudgeToImplement(
    ctx: TaskContext,
    appendContext: AppendContext,
    prompt = PROCEED_PROMPT,
    opts: {
      gateRetry?: boolean;
      maxTurns?: number;
      completionGate?: () => string;
    } = {}
  ): Promise<string> {
    // A generic offer nudge after a turn-limit continuation would spend a
    // fresh full execute budget on top of the ceiling. Completion-gate retries
    // are separate: each carries exact unfinished evidence and uses the
    // smaller continuation budget. Their own cap keeps the loop bounded.
    if (
      !canRunNudge({
        nudges: ctx.nudges,
        gateNudges: ctx.gateNudges,
        turnLimitContinuations: ctx.turnLimitContinuations,
        gateRetry: opts.gateRetry,
        aborted: ctx.abort.signal.aborted,
      })
    ) {
      return "";
    }
    if (opts.gateRetry === true) {
      ctx.gateNudges += 1;
    } else {
      ctx.nudges += 1;
    }
    this.deps.log.warn(
      { taskId: ctx.taskId },
      "turn ended with outstanding work; continuing the same session"
    );
    const { text } = await this.streamSession(
      ctx,
      prompt,
      appendContext,
      undefined,
      "execute",
      {
        systemPlan: false,
        maxTurns: opts.maxTurns,
        completionGate: opts.completionGate,
      }
    );
    return text ? `\n\n${text}` : "";
  }

  private recordTestRun(
    taskId: string,
    kind: ValidationKind,
    result: ValidationResult
  ): void {
    this.deps.db
      .prepare(
        "INSERT INTO test_runs(task_id, kind, ok, findings, ran_at) " +
          "VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        taskId,
        kind,
        result.ok ? 1 : 0,
        JSON.stringify(result.findings),
        Date.now()
      );
  }
}

/**
 * Token cap for the shared memory block. A bare "continue" classifies as
 * chat, which is precisely the turn that needs the thread most — so the light
 * budget stays generous here even though its code budget is small.
 */
/**
 * Cap for the "previously gathered" block. A question or a chat turn gets
 * the list and a little content; a change turn gets enough to carry the
 * two or three files the last turn read, which is what a follow-up edit
 * almost always needs first.
 */
/** Most of an Ollama window the gathered block may take. */
const WORKING_MEMORY_WINDOW_SHARE = 0.15;

/** Diff text handed to the wiki compiler; the page is a summary, not a patch. */
const WIKI_DIFF_CHARS = 14_000;

/** Cap for the feature-wiki block; a page is compact by construction. */
function wikiTokensFor(intentKind: string): number {
  if (intentKind === "question" || intentKind === "chat") return 900;
  if (intentKind === "command") return 500;
  return 1600;
}

function workingMemoryTokensFor(intentKind: string): number {
  if (intentKind === "question" || intentKind === "chat") return 900;
  if (intentKind === "command") return 600;
  if (intentKind === "feature" || intentKind === "refactor") return 3600;
  return 2600;
}

function sessionTokensFor(intentKind: string): number {
  if (intentKind === "feature" || intentKind === "refactor") return 1100;
  return 900;
}

/** What a recalled memory chunk was about, for the console line. */
function chunkLabel(preview: string): string {
  const lines = preview.split("\n");
  const work = lines.find((line) => line.startsWith("Work: "));
  const summary = lines.find((line) => line.startsWith("Summary: "));
  const head = (work ?? summary ?? lines[0] ?? "")
    .replace(/^(Work|Summary):\s*/, "")
    .replace(/^request:\s*/i, "")
    .split(" · ")[0]
    ?.trim();
  if (!head) return "";
  return head.length > 60 ? `${head.slice(0, 57)}…` : head;
}

/**
 * What a chat turn actually carries.
 *
 * This replaced SYSTEM_RULES on the interactive path. The test each clause
 * had to pass was "does the turn come out different without it?" — a rule
 * that only describes good taste is prose the model pays for on every cache
 * miss and then averages away. The clauses below survive because each one
 * changes execution behavior or prevents an observed failure mode:
 *
 * - KNOWLEDGE FIRST, because the index is the thing Atelier has and a stock
 *   CLI does not, and the model will not reach for it unprompted.
 * - IMPACT BEFORE EDITING, because the impact hook DOES block the first
 *   write to an existing source file, and a model that was not told spends
 *   a round-trip discovering that.
 * - TARGETED EDITS, same reason: the rewrite hook refuses a write_file that
 *   is a patch wearing a rewrite's clothes.
 * - AUTONOMOUS EXECUTION, because without it turns end by offering to work.
 * - WORKSPACE CONFINEMENT, because it is the one boundary with no hook.
 * - GIT FLOW and DATABASE, because those hooks DO block, and a model that
 *   was not told loops against them.
 * - REPORTING, because narration is most of the text on a slow turn.
 *
 * A rule stated but not enforced, or enforced but not stated, is worse than
 * neither — so every clause here names the hook standing behind it.
 *
 * Byte-stable — it rides in the static half of the prompt for caching.
 */
export const FAST_RULES =
  "KNOWLEDGE FIRST: call retrieve_knowledge / query_knowledge_graph / " +
  "search_symbols before falling back to search_workspace or reading " +
  "files — the index is live and current. Once you know the exact string " +
  "or filename you want, use your fastest text-search tool (Grep/Glob " +
  "where available, else search_text) and run several searches in ONE " +
  "message rather than one per turn.\n" +
  "TIMELINE EXECUTION CONTRACT (enforced by a blocking completion hook): " +
  "for every change task, call set_plan after you know the shape of the " +
  "work and before editing. Name the files each step touches, execute the " +
  "steps in order, mark the current step in-progress when it starts, and " +
  "mark it done only after its work is complete. Do not render a progress " +
  "or final report until every step is explicitly done; failed, cancelled, " +
  "or skipped steps remain blockers. The timeline is not frozen: if you " +
  "discover additional necessary work, call set_plan again with ONLY the " +
  "new steps and they will be appended. A later set_plan call cannot erase, " +
  "replace, reorder, or complete an existing step.\n" +
  "SIMPLEST FIX WINS: match the solution to the problem. Reuse the " +
  "existing component and layout structure, and prefer the smallest local " +
  "value, CSS, or utility-class change that fully solves the request. Do " +
  "not introduce a new abstraction, service, dependency, or broad refactor " +
  "for a small UI or behavior fix. Scope creep is a defect.\n" +
  "FLEX-FIRST UI LAYOUT (enforced by a blocking hook): when creating or " +
  "changing UI layout, use flexbox by default. Center content with a flex " +
  "container and both-axis alignment (display: flex + align-items: center + " +
  "justify-content: center, or equivalent framework utility classes). Do " +
  "not substitute grid, absolute positioning/transforms, spacer margins, " +
  "or fixed coordinates for basic centering. Preserve a non-flex layout " +
  "only when an explicit requirement or the owning component makes flex " +
  "objectively unsuitable.\n" +
  "GROUND BEFORE EDITING: retrieved chunks and session summaries are leads, " +
  "not proof of the current UI or code path. For a UI bug, locate the exact " +
  "visible trigger, read its owning component, then trace its event handler " +
  "and the state/data passed into the rendered surface. For any code-flow " +
  "bug, trace caller to callee through the divergence point. Do not edit " +
  "until you have searched for the live owner and read every file you will " +
  "change in this turn. If the user's report disputes an earlier patch, " +
  "re-read the live code and re-simulate the full path; never stack another " +
  "conditional or style patch on the prior assumption. Files inlined under " +
  "PREVIOUSLY GATHERED CONTEXT are current content re-read for this turn: " +
  "they count as read, so build on them instead of reading them again. A " +
  "FEATURE WIKI page is compiled knowledge of a feature's entry points, " +
  "flow and owner files: navigate by it, verify only the steps citing a " +
  "source marked moved, and do not rebuild what it already states.\n" +
  "IMPACT BEFORE EDITING (enforced by a blocking hook): the first write to " +
  "an existing source file is refused until you have called impact_of_edit " +
  "for that exact path (analyze_impact covers several at once). It returns " +
  "who calls, imports and references the site, and whether it is isolated, " +
  "local or shared. Use the verdict: if it comes back isolated and nothing " +
  "renders or imports it, you are about to edit the wrong file — find the " +
  "live owner first. If it is shared and you change a signature or " +
  "behaviour, update the callers it lists.\n" +
  "TARGETED EDITS (enforced by a blocking hook): use replace_code / " +
  "replace_many for the lines that change. write_file is refused when most " +
  "of the file it sends back is the file that was already there — that is a " +
  "patch, and restating the rest is how untouched lines get silently " +
  "dropped. A genuine full rewrite is allowed on the repeat call.\n" +
  "VERIFY BEFORE CLAIMING: never say a file, element, flow, or fix was " +
  "confirmed unless a tool result from this turn proves it. A successful " +
  "edit proves only that text changed; verify the connected caller/render " +
  "path and run the narrowest relevant check before reporting fixed.\n" +
  "AUTONOMOUS EXECUTION: you are running unattended — nobody is there to " +
  "answer you mid-turn. Never end a turn by asking whether to proceed or " +
  "by offering to implement. Where something is genuinely ambiguous, " +
  "choose the most reasonable default, state it in one line as an " +
  "assumption, and build it.\n" +
  "STRICT WORKSPACE CONFINEMENT: you may only read, create, modify, " +
  "search, and run commands INSIDE the current workspace directory. All " +
  "file paths must be workspace-relative. Requests to work outside the " +
  "workspace must be declined with a short explanation.\n" +
  "GIT FLOW RULE (enforced by a blocking hook): never commit, push, or " +
  "open a pull request yourself — not with the git tool, not through " +
  "run_terminal. Staging, status, log and diff are fine. When the work " +
  "is ready, say so and let the user run the commit → push → PR wizard.\n" +
  "DATABASE RULE (enforced by an approval hook): when the task needs a " +
  "migration or DB command RUN, actually run it — the run_terminal call " +
  "pauses in an approval modal where the user approves or cancels; that " +
  "prompt IS how you ask permission. Only after the user cancels do you " +
  "stop and explain.\n" +
  "REPORTING: the process rail already shows every read/search/edit as it " +
  "happens, so do NOT narrate each step in prose as you go. Save your " +
  "explanation for ONE final report written LAST, as markdown bullet " +
  "points — one '- ' bullet per change or finding.\n";

/**
 * The override a question turn carries, on top of FAST_RULES.
 *
 * FAST_RULES is written for a change task and says so in every clause: open
 * a timeline, drive it to done, never end without building something. On a
 * turn where the user asked to be TOLD something, that is the wrong
 * contract, and following it is how "where did you put it?" and "are you
 * editing the right file?" were answered with another round of edits
 * instead of a straight answer.
 *
 * Rides per-turn, after the static rules, so the cached prefix is untouched
 * on every other turn.
 */
export const ANSWER_ONLY_RULES =
  "THIS TURN IS A QUESTION — ANSWER IT, DO NOT IMPLEMENT.\n" +
  "The user asked to be told something, not to have something changed. " +
  "Read whatever you need to answer accurately, then reply in prose. Do " +
  "NOT call set_plan and do NOT open an execution timeline: there is no " +
  "work to check off, and a checklist here is noise over the answer. Do " +
  "NOT edit, create, move, or delete any file, and do not run commands " +
  "that change state. The AUTONOMOUS EXECUTION and TIMELINE EXECUTION " +
  "clauses above are suspended for this turn — ending without a change is " +
  "the correct outcome here, not a turn that stopped short.\n" +
  "If the honest answer is that something is wrong or unfinished, say " +
  "exactly what and where (file and line), say what the fix would be, and " +
  "stop. The user's next message decides whether to make it.\n" +
  "If the question is about work you reported earlier, verify against the " +
  "live code before answering — read the file as it is now rather than " +
  "describing what you remember writing.\n";

/**
 * The former interactive rule block, kept for Settings to display and for
 * any caller that wants the full contract back. No longer sent by default —
 * see FAST_RULES.
 */
export const SYSTEM_RULES =
  "AUTONOMOUS EXECUTION: you are running unattended — nobody is there to " +
  "answer you mid-turn. Never end a turn by asking whether to proceed, by " +
  "offering to implement (\"say the word and I'll…\"), or by waiting on a " +
  "decision. Where something is genuinely ambiguous, choose the most " +
  "reasonable default, state it in one line as an assumption, and build " +
  "it. A turn that analyses the work and stops short of doing it has " +
  "failed the request, however good the analysis. The blocking hooks " +
  "(terminal approval, git flow) are the ONLY things that pause for the " +
  "user, and they ask on your behalf. Planning is what you do before " +
  "editing in the same turn, never instead of editing — the user has " +
  "their own Plan checkbox for when they want to be asked first.\n" +
  "SIMPLEST FIX WINS: match the size of the solution to the size of the " +
  "problem. If a one-line change, a CSS rule, or an existing helper solves " +
  "it, do that — do not introduce a new abstraction, config layer, service, " +
  "or dependency for a small bug. Before writing anything, ask whether the " +
  "codebase already does this somewhere and reuse it. Prefer editing an " +
  "existing file over creating new ones, and changing a value over changing " +
  "a structure. Only reach for the bigger design when the simple fix is " +
  "actually wrong — not merely less elegant — and say in one line why. " +
  "Scope creep is a defect: fix what was asked, not what is nearby.\n" +
  "NO OVERSCOPING: work the reported issue and the code retrieval actually " +
  "returned — nothing else. The retrieved chunks and the user's description " +
  "define the boundary of the task. Do not widen it because adjacent code " +
  "looks wrong, could be refactored, or lacks tests; do not rewrite files " +
  "you merely passed through. If you spot a real problem outside the " +
  "boundary, finish the asked-for fix first, then mention it in one line — " +
  "let the user decide. Touching more files than the issue requires is a " +
  "failure, not thoroughness.\n" +
  "STRICT WORKSPACE CONFINEMENT: You may only read, create, modify, " +
  "search, and run commands INSIDE the current workspace directory. All " +
  "file paths must be workspace-relative. Requests to work outside the " +
  "workspace must be declined with a short explanation.\n" +
  "KNOWLEDGE FIRST: call retrieve_knowledge / query_knowledge_graph / " +
  "search_symbols before falling back to search_workspace or reading " +
  "files — the index is live and current.\n" +
  "CHEAPEST CHECK FIRST: when something does not work, run the smallest " +
  "decisive check before theorising about a cause. Is the process alive, " +
  "is the port listening, is the container up, does the file exist, what " +
  "does the command return RIGHT NOW. Only after those come config, env " +
  "and code. A log file, a cached output or an earlier run is HISTORY, " +
  "never proof of the current state — never cite one as evidence that " +
  "something is running. Name a cause only once a check you ran this turn " +
  "confirmed it; otherwise say which check you are running next.\n" +
  "LITERAL SEARCH IS Grep/Glob: once you know the exact string, symbol, or " +
  "filename you are after, use Grep and Glob — they are ripgrep and return " +
  "in milliseconds. Knowledge tools answer 'where does login live?'; Grep " +
  "answers 'which files contain SECRET_KEY?'. Run several searches in ONE " +
  "message rather than one per turn. Keep discovery in this session; do " +
  "not launch subagents for ordinary workspace searches.\n" +
  "VISUAL GROUNDING: when the request includes a screenshot or names " +
  "on-screen text (a label, button, plan name, id), FIRST search for those " +
  "literal visible strings to map the pixels to the real element — never " +
  "infer which element it is by reasoning about layout from code you " +
  "haven't opened. If the literal string returns nothing, the element does " +
  "not exist as described: say so and stop, do not invent a file for it.\n" +
  "VERIFY BEFORE CLAIMING: never state that a file, element, or symbol " +
  "exists — or that you 'confirmed it in code' — unless you actually " +
  "retrieved or opened it this turn. Ground every factual claim in a tool " +
  "result, not a guess.\n" +
  "TIME-BOX SPECULATION: after two inconclusive hypotheses about where " +
  "something lives, stop guessing and ask ONE targeted question (e.g. the " +
  "element's id/class from inspect) rather than generating more theories.\n" +
  "LEARN FROM MISTAKES: when the user confirms a fix that took real " +
  "effort, or you hit a non-obvious gotcha, call save_lesson with a tiny " +
  "distilled insight anchored to the symbols/files involved. Retrieved " +
  "chunks of kind 'lesson' are hard-won knowledge — respect them.\n" +
  "TARGETED EDITS (enforced by a blocking hook): edit existing files with " +
  "replace_code / replace_many, not write_file. Change the lines that are " +
  "wrong and leave the rest alone — restating a file that was mostly " +
  "already correct hides the real change in the diff and risks dropping " +
  "code you never meant to touch. write_file is for new files and for a " +
  "file whose content is genuinely being thrown away. If replace_code " +
  "fails, fix the oldString (check exact whitespace and indentation, or " +
  "add surrounding lines for uniqueness) rather than falling back to a " +
  "whole-file rewrite.\n" +
  "GIT FLOW RULE (enforced by a blocking hook): never commit, push, or " +
  "open a pull request yourself — not with the git tool, not through " +
  "run_terminal. Staging, status, log and diff are fine. When the work " +
  "is ready, say so and let the user run the commit → push → PR wizard.\n" +
  "DATABASE RULE (enforced by an approval hook): when the task needs a " +
  "migration or DB command RUN, actually run it — do NOT skip it and " +
  "leave the user a manual 'run this later' step. The run_terminal call " +
  "pauses in an approval modal where the user approves or cancels; that " +
  "prompt IS how you ask permission, and they can cancel any time. Only " +
  "after the user cancels do you stop and explain. Writing a migration " +
  "file is not finishing the task — apply it (and smoke-test) unless the " +
  "user cancels. Never route around a cancellation with another client, " +
  "script, or ORM call.\n" +
  "CHANGE COMPLETENESS: a fix is not done until it is applied everywhere " +
  "the same pattern occurs. Parallel implementations rarely import each " +
  "other, so use search_symbols / retrieve_knowledge to find the twins of " +
  "any code you change, and check every new branch or message can " +
  "actually be reached by the code that feeds it.\n" +
  "EDIT IMPACT (ENFORCED): the first edit to an existing source file is " +
  "REFUSED until you have called impact_of_edit for that exact path, with " +
  "the line (or symbol) you're about to change — a hook blocks the write, " +
  "so call it as you settle on each target rather than editing twice. It " +
  "tells you who calls/imports it and whether the site is isolated, local, " +
  "or shared. If shared and you change its signature or behavior, update " +
  "every caller it lists; if you can keep the contract stable, isolate the " +
  "change instead. New files and non-source files are not gated.\n" +
  "PLAN PROGRESS: as you complete plan steps, call update_plan_step with " +
  "the step id and its new status.\n" +
  "REPORTING: the process rail already shows every read/search/edit as it " +
  "happens, so do NOT narrate each step in prose as you go — keep any " +
  "interim text to a single short line at most. Save your explanation for " +
  "ONE final report written LAST, after the edits are done — never as a " +
  "preamble before the work. Format that report as markdown bullet points: " +
  "one '- ' bullet per change or finding, each a short standalone line. " +
  "Never chain several sentences into one run-on paragraph.\n";

/**
 * The one-per-file rule, carried ONLY when the guard is actually going to
 * enforce it — see ModularityGuard.inForce.
 *
 * It used to be baked into SYSTEM_RULES unconditionally, which made the
 * prompt lie in two directions: on a workspace the guard stands down for,
 * the model split files to satisfy a rule nobody was checking, and with the
 * hook switched off in the hooks panel the prompt still called it
 * "enforced". A rule the model is told about and a rule the tools enforce
 * have to be the same rule.
 *
 * Byte-stable and appended after the static block, so the two variants each
 * stay cacheable as a prefix.
 */
export const MODULARITY_RULE =
  "MODULARITY RULE (enforced by a blocking hook): ONE file = ONE " +
  "top-level function/component/class. Split helpers into " +
  "one-file-per-function folders with an index.ts barrel. Types, " +
  "interfaces, and constants may share a file.\n";

const CODEX_MCP_RULES =
  "CODEX TOOL ROUTING: use the Atelier MCP tools for workspace actions. " +
  "Prefer search_workspace or search_text over rg/grep, read_many_files " +
  "over repeated reads, read_file over Get-Content/cat, list_dir over " +
  "directory shell commands, git over shell git, and replace_many over " +
  "repeated replace_code/write_file calls. Do not use Codex native " +
  "shell for git, reading, searching, listing, or editing when an Atelier " +
  "MCP tool fits. Use run_terminal only for builds/tests/package commands " +
  "or when no semantic Atelier tool fits.\n";

/**
 * A turn that is nothing but approval: "do it", "fix it", "go ahead", "yes".
 * Anchored at both ends so a sentence that merely CONTAINS "do it" is not
 * mistaken for one.
 */
const GO_AHEAD =
  /^(ok(ay)?|yes|yep|yeah|sure|do it|just do it|go|go on|go ahead|go for it|fix it|fix that|proceed|continue|implement it|apply it|make it so|please do|do that|sounds good|lgtm)\b[\s.!,]*$/i;

/** How much of the approved message to quote back. */
const GO_AHEAD_CHARS = 2_000;

/**
 * Puts the proposal back in front of a turn that only approved it.
 *
 * "fix it" carries no subject. The thing being approved is in the previous
 * assistant message — usually its last paragraph, a deferred suggestion the
 * model itself wrote — and recall clips prior turns from the middle, so the
 * tail holding the actual offer is exactly what got dropped. The model then
 * re-derived something to fix from retrieval and worked on the wrong thing,
 * which is why users end up pasting the whole suggestion back in by hand.
 */
function goAheadBlock(ctx: TaskContext): string {
  if (!GO_AHEAD.test(ctx.prompt.trim())) return "";
  const lastAnswer = [...ctx.priorTurns]
    .reverse()
    .find((turn) => turn.role === "assistant" && turn.text.trim());
  if (!lastAnswer) return "";
  const text = lastAnswer.text.trim();
  const quoted =
    text.length <= GO_AHEAD_CHARS ? text : `…${text.slice(-GO_AHEAD_CHARS)}`;
  return (
    "THIS TURN IS A GO-AHEAD\n" +
    `The user replied "${ctx.prompt.trim()}" — they are approving what you ` +
    "just proposed, not opening a new subject. Your previous message ended " +
    "as follows; whatever you offered or deferred in it is the work to do " +
    "now. Do not substitute a different improvement, and do not ask again.\n" +
    "--- your previous message ---\n" +
    `${quoted}\n` +
    "--- end ---\n" +
    "If it named more than one option, say in one line which you took.\n"
  );
}

/**
 * Names the conversation's images in the turn's context.
 *
 * Deterministic, and a few tokens: a list of paths rather than a picture.
 * Retrieval may also surface these paths out of session memory, but it may
 * not — and "what's on the image?" is the one question that must never
 * depend on an embedding happening to match. The model opens what it needs
 * with view_image and ignores the rest.
 */
function attachmentBlock(ctx: TaskContext): string {
  if (ctx.imagePaths.length === 0) return "";
  const lines = ctx.imagePaths.map((p) => `- ${p}`);
  const shown = ctx.images.length > 0;
  return (
    "IMAGES IN THIS CONVERSATION\n" +
    `${lines.join("\n")}\n` +
    (shown
      ? "The image(s) above are attached to this message and you can see " +
        "them already.\n"
      : "These were attached on an earlier turn and are NOT in front of " +
        "you. If this request refers to what was shown — 'the image', " +
        "'the screenshot', 'the error above' — call view_image on the " +
        "path and look, rather than answering from an earlier " +
        "description of it.\n")
  );
}

/**
 * Rides with every attached image.
 *
 * A screenshot someone drew on is a specification: the box, the arrow, the
 * circle say WHICH part of it the request is about. Without this, a marked
 * screenshot reads as generic context — the model scans the whole picture,
 * finds some other defect, fixes that instead, and reports success on work
 * nobody asked for. A drawn mark is the most explicit thing in the turn and
 * has to be read that way.
 */
const ANNOTATION_NOTE =
  "About the attached image(s): if any carries a drawn annotation — a box, " +
  "an arrow, a circle, a highlight, usually in a bright colour that clashes " +
  "with the UI — that mark IS the subject of this request. Address what is " +
  "marked. An arrow points FROM a thing TO what is wrong with it, or joins " +
  "two things whose relationship is the complaint; a box encloses the " +
  "region at fault. Say in one line what you read the annotation as " +
  "pointing at, so a wrong reading is visible immediately. Do not silently " +
  "switch to some other defect you noticed elsewhere in the picture: if the " +
  "marked area looks correct to you, say so and ask, rather than fixing " +
  "something that was never raised.";

/**
 * A one-shot streaming-input prompt carrying a multimodal user message:
 * the task text plus each attached image as a base64 content block. The
 * generator yields exactly one message and returns, so the SDK runs a
 * single turn over it.
 */
async function* imagePrompt(
  text: string,
  images: ImageAttachment[]
): AsyncGenerator<SDKUserMessage> {
  const content = [
    { type: "text" as const, text },
    ...images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.data,
      },
    })),
    { type: "text" as const, text: ANNOTATION_NOTE },
  ];
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content },
  } as unknown as SDKUserMessage;
}

/**
 * How many repair rounds a change of this size is worth. A one- or two-file
 * edit that fails review twice is not going to pass on the third try — the
 * timeline shows those runs ending `fail,fail,fail` after burning more time
 * than the implementation itself. Wide changes keep the full budget, because
 * there the extra round is usually fixing something real.
 */
export function retryBudget(fileCount: number): number {
  if (fileCount <= 2) return 1;
  if (fileCount <= 6) return 2;
  return 3;
}

/**
 * Streaming-input wrapper for a plain text turn. Same one-shot shape as
 * imagePrompt — the plan pass needs it because setPermissionMode is only
 * available in streaming input mode, not for a plain string prompt.
 */
async function* streamedPrompt(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  } as unknown as SDKUserMessage;
}

/**
 * Turn ExitPlanMode's markdown into Atelier's checklist. Numbered or
 * bulleted lines become steps; the first ordinary line becomes the goal.
 * Paths are pulled out of each line because they are what drives live
 * progress — PlanTracker.noteFileEdited matches an edit to the step that
 * owns the file, so a step with no files never advances on its own.
 */
export function planFromMarkdown(
  taskId: string,
  markdown: string,
  fallbackGoal?: string
): Plan | null {
  const lines = markdown.split("\n").map((line) => line.trim());
  const bullet = /^(?:\d+[.)]|[-*+])\s+/;
  const steps = lines
    .filter((line) => bullet.test(line))
    .map((line) => stripMarkdown(line.replace(bullet, "")))
    .filter((line) => line.length > 0)
    .slice(0, 12)
    .map((line) => ({
      id: newId("step"),
      // Steps read "Title — what changes"; the head is the checklist label
      // and the whole line is the detail the implementer receives.
      title: clip(line.split(/\s[—:-]\s/)[0] ?? line, 120),
      detail: clip(line, 300),
      files: pathsIn(line),
      status: "pending" as const,
    }));
  if (steps.length === 0) return null;
  const goal = lines.find(
    (line) => line.length > 0 && !bullet.test(line) && !line.startsWith("#")
  );
  return {
    id: newId("plan"),
    taskId,
    goal: clip(stripMarkdown(goal ?? fallbackGoal ?? "Implement the plan"), 200),
    steps,
    createdAt: Date.now(),
  };
}

/** Backticked or slash-bearing file paths named in a plan step. */
function pathsIn(line: string): string[] {
  const found = new Set<string>();
  for (const match of line.matchAll(/`([^`]+)`/g)) {
    const token = match[1]!.trim();
    if (token.includes("/") || /^[\w.@-]+\.[a-zA-Z]{1,6}$/.test(token)) {
      found.add(token);
    }
  }
  if (found.size === 0) {
    const bare = /\b[\w.@-]+(?:\/[\w.@-]+)+\.[a-zA-Z]{1,6}\b/g;
    for (const match of line.matchAll(bare)) found.add(match[0]);
  }
  return [...found].slice(0, 6);
}

/** Drop the inline markup a checklist row should not carry. */
function stripMarkdown(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/^#+\s*/, "")
    .trim();
}

function buildSummary(
  intent: Intent,
  changedFiles: string[],
  validation: ValidationResult[],
  plan: Plan,
  reviewVerdict: "pass" | "fail" | null,
  gateStillOpen = false
): string {
  const parts = [intent.summary];
  if (changedFiles.length > 0) {
    parts.push(
      `${changedFiles.length} file(s) changed: ` +
        changedFiles.slice(0, 6).join(", ")
    );
  } else {
    parts.push("no file changes");
  }
  // This line is the durable record: it goes into session memory and comes
  // back as recall on the NEXT turn. Left neutral, "no file changes" reads
  // to that turn as a decision rather than a turn that ran out of room
  // before it started, and the outstanding work quietly disappears.
  if (gateStillOpen) {
    parts.push("INCOMPLETE — completion gate still open");
  }
  if (validation.length > 0) {
    const failed = validation.filter((v) => !v.ok);
    parts.push(
      failed.length === 0
        ? `validation green (${validation.map((v) => v.kind).join(", ")})`
        : `validation FAILING: ${failed.map((v) => v.kind).join(", ")}`
    );
  }
  if (reviewVerdict) {
    parts.push(
      reviewVerdict === "pass" ? "review passed" : "review FAILED"
    );
  }
  const done = plan.steps.filter((s) => s.status === "done").length;
  if (plan.steps.length > 1) {
    parts.push(`plan ${done}/${plan.steps.length} steps done`);
  }
  return parts.join(" · ");
}

/**
 * The concrete files the task intends to edit: the plan's step files, plus
 * any file-shaped intent target. NOT retrieval chunks — those are context
 * (often generic hubs) and computing reach from them is meaningless.
 */
/** Dependents with nothing in them — for turns that skip the graph walk. */
function emptyDeps(): ReturnType<SymbolGraph["dependentsOf"]> {
  return { files: [], symbols: [], lessons: [] };
}

/** A radius with nothing in it — for light tasks or unknown targets. */
/** What retrieval returns on a turn that never needed a code lookup. */
function emptyRetrieval(): RetrievalResult {
  return { strategy: "skipped", chunks: [], graphNodes: [], features: [] };
}

function emptyRadius(targets: string[] = []): ImpactRadius {
  return {
    targets,
    affected: [],
    flows: [],
    testsAtRisk: [],
    companions: [],
    risks: [],
    level: "low",
    summary:
      targets.length > 0
        ? "No indexed reach for the planned files."
        : "No file targets identified yet.",
  };
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Plan steps as the durable record keeps them. `detail` rides along because
 * the note report is the one consumer that shows a step to a human later,
 * and a bare title is not a description of what changed.
 */
function recordSteps(steps: Plan["steps"]): TaskRecord["steps"] {
  return steps.map((step) => ({
    title: step.title,
    detail: step.detail,
    files: step.files,
    status: step.status,
  }));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Parse the reviewer's trailing `VERDICT_JSON:` line. The gate FAILS
 * CLOSED: a missing or malformed verdict is never a pass, because a review
 * that did not report reads exactly like one that found nothing, and only
 * one of those is safe to ship. Prose `ISSUE:` lines are scraped as a
 * fallback so a reviewer that explained itself but botched the JSON still
 * yields actionable findings.
 */
export function extractVerdict(text: string): {
  verdict: "pass" | "fail";
  findings: string[];
} {
  const marker = text.lastIndexOf("VERDICT_JSON");
  const parsed =
    marker === -1
      ? null
      : (extractJson(text.slice(marker)) as {
          verdict?: unknown;
          findings?: unknown;
        } | null);

  if (parsed && parsed.verdict === "pass") {
    return { verdict: "pass", findings: [] };
  }

  const issues = scrapeIssueLines(text);
  if (parsed && parsed.verdict === "fail") {
    const findings = asStringArray(parsed.findings)
      .map((f) => clip(f, 300))
      .slice(0, 6);
    return { verdict: "fail", findings: findings.length > 0 ? findings : issues };
  }
  return { verdict: "fail", findings: issues };
}

/**
 * The reviewer's report without its machine-readable tail. Parse the
 * verdict BEFORE calling this — it removes the line the parser keys on.
 */
export function withoutVerdictLine(text: string): string {
  const marker = text.lastIndexOf("VERDICT_JSON");
  if (marker === -1) return text.trim();
  return text.slice(0, marker).trim();
}

/** `ISSUE: ...` lines from the reviewer's prose, when the JSON is absent. */
function scrapeIssueLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*\s]*\d*[.)]?\s*/, "").trim())
    .filter((line) => /^ISSUE\b/i.test(line))
    .map((line) => clip(line, 300))
    .slice(0, 6);
}

/**
 * Anchor retrieval to the session. A follow-up like "now add a filter" has
 * no subject of its own, so retrieval drifts to unrelated files. Folding a
 * short tail of the recent exchange into the query keeps both the subject
 * and the assistant's proposed next action in view. The current ask leads so
 * its terms win the keyword cap and dominate the mean-pooled query vector;
 * the anchor only nudges — and it matters most when the current turn is terse.
 */
function anchoredQuery(
  base: string,
  priorTurns: TaskContext["priorTurns"]
): string {
  const anchor = priorTurns
    .slice(-2)
    .map(
      (turn) =>
        `${turn.role}: ${clipConversationTurn(turn.text, 320)}`
    )
    .join("\n")
    .trim();
  return anchor ? `${base}\n\ncontext: ${anchor}` : base;
}

/** Recent exchange rendered as a context block for the intent classifier. */
function intentAnchor(priorTurns: TaskContext["priorTurns"]): string {
  const recent = priorTurns
    .slice(-2)
    .map(
      (turn) =>
        `- ${turn.role}: ${clipConversationTurn(turn.text, 600)}`
    );
  if (recent.length === 0) return "";
  return `Recent turns:\n${recent.join("\n")}\n\n`;
}

/**
 * A recommendation is commonly at the end of a long answer. Preserve both
 * ends so an anchor never degenerates into only the answer's preamble.
 */
function clipConversationTurn(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = " … [middle omitted] … ";
  const available = maxChars - marker.length;
  const head = Math.floor(available * 0.4);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

/**
 * Everything the pipeline needs to know about a request, read from the
 * request itself.
 *
 * This replaces two classifier calls. What they returned that mattered was
 * a coarse read-only/editing split, a one-line summary, and the paths the
 * user typed — none of which needs a model. What they returned that did NOT
 * matter (a `kind` from a fixed vocabulary, "constraints" restated back)
 * only ever fed the planner, which is gone.
 *
 * `targets` is deliberately literal: a path in the prompt is a path the
 * user named. Guessing beyond that is what retrieval is for.
 */
export function readIntent(prompt: string): Intent {
  const targets = [...prompt.matchAll(TARGET_PATH)]
    .map((match) => match[0].replace(/^@/, ""))
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 8);
  return {
    kind: looksLikeQuestion(prompt) ? "question" : "work",
    summary: clip(prompt.trim().replace(/\s+/g, " "), 120),
    targets,
    constraints: [],
  };
}

/** A path or "@mention" as typed: `src/app.ts`, `apps/web`, `Composer.tsx`. */
const TARGET_PATH = /@?[\w.-]+(?:[/\\][\w.-]+)+|@?[\w-]+\.[a-z]{1,4}\b/gi;

/** Prefix every Atelier MCP tool carries once the SDK has namespaced it. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

interface BuiltinToolUse {
  id: string;
  name: string;
  input: unknown;
}

/**
 * The `tool_use` blocks in an assistant message, minus Atelier's own.
 *
 * ToolRegistry.run already publishes the full lifecycle for every MCP tool,
 * so reporting them here as well would double every read and edit in the
 * rail. What is left is exactly the surface nothing else observes: the
 * builtins in CLAUDE_FAST_BUILTINS.
 */
function assistantToolUses(message: Record<string, unknown>): BuiltinToolUse[] {
  // Ignore nested SDK activity defensively. `Task` is not offered on the
  // normal Atelier surface anymore, but SDK/provider changes must not make
  // nested tool traffic look like main-session work in the process rail.
  if (message.parent_tool_use_id != null) return [];
  const inner = message.message as { content?: unknown } | undefined;
  if (!Array.isArray(inner?.content)) return [];
  const uses: BuiltinToolUse[] = [];
  for (const raw of inner.content) {
    const block = raw as Record<string, unknown>;
    if (block?.type !== "tool_use") continue;
    const id = typeof block.id === "string" ? block.id : "";
    const name = typeof block.name === "string" ? block.name : "";
    if (!id || !name || name.startsWith(MCP_TOOL_PREFIX)) continue;
    uses.push({ id, name, input: block.input });
  }
  return uses;
}

interface BuiltinToolResult {
  toolUseId: string;
  text: string;
  isError: boolean;
}

/**
 * The `tool_result` blocks in a user message. Content is either a plain
 * string or the block array the API also accepts, so both are flattened to
 * the short text the rail shows beside a finished row.
 */
function userToolResults(
  message: Record<string, unknown>
): BuiltinToolResult[] {
  // Matches the filter on the tool_use side; a result whose call was never
  // published has nothing to close anyway (the id lookup would miss).
  if (message.parent_tool_use_id != null) return [];
  const inner = message.message as { content?: unknown } | undefined;
  if (!Array.isArray(inner?.content)) return [];
  const results: BuiltinToolResult[] = [];
  for (const raw of inner.content) {
    const block = raw as Record<string, unknown>;
    if (block?.type !== "tool_result") continue;
    const toolUseId =
      typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    if (!toolUseId) continue;
    results.push({
      toolUseId,
      text: flattenResultContent(block.content),
      isError: block.is_error === true,
    });
  }
  return results;
}

function flattenResultContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      const part = raw as Record<string, unknown>;
      return part?.type === "text" && typeof part.text === "string"
        ? part.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** True when nothing is expected to change — a question, asked plainly. */
function isReadOnly(intent: Intent): boolean {
  return intent.kind === "question";
}

/**
 * Does the answer end by ASKING to do the work instead of doing it?
 *
 * Only the tail is tested: a turn may reasonably say "I could also add
 * tests" halfway through and then get on with the job. What the nudge is
 * for is the closing line that hands the turn back to a user who is not
 * there — "want me to implement this?", "let me know and I'll proceed".
 */
function endsWithAnOffer(text: string): boolean {
  const tail = text.trimEnd().slice(-400).toLowerCase();
  if (!tail) return false;
  return (
    /\b(?:want|would you like|shall i|should i|do you want)\b[^.?!]*\?/.test(
      tail
    ) ||
    /\b(?:say the word|let me know|just tell me|if you'?d like|if you want|on your go|give me the go[- ]?ahead|happy to (?:implement|proceed|do that|make))\b/.test(
      tail
    ) ||
    /\bi(?:'| wi)?ll (?:go ahead and )?(?:implement|apply|make|write|add) (?:it|them|this|these|that)\b/.test(
      tail
    ) ||
    /\bready to (?:implement|apply|proceed)\b/.test(tail)
  );
}

/**
 * Openers that ask to be TOLD something rather than to have something
 * changed. Kept separate from the interrogatives above because they are
 * imperative in form — "explain the auth flow" parses as a command, and
 * classifying it as work is what made a purely explanatory turn pay for a
 * second full model round-trip when it (correctly) edited nothing.
 *
 * Deliberately not here: "fix", "add", "make", "update", "refactor",
 * "implement", "rename", "remove" — those DO expect the code to move, and
 * a turn that answers one of them with prose really has stopped short.
 */
const EXPLAIN_OPENERS =
  /^(?:please\s+)?(?:explain|describe|summari[sz]e|compare|analy[sz]e|review|audit|investigate|explore|walk\s+me\s+through|tell\s+me|show\s+me|help\s+me\s+understand|look\s+(?:at|into)|find|locate|list|trace|check|inspect|what'?s|where'?s|which)\b/i;

const CHANGE_REQUEST_OPENERS =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+(?:you|we)\s+)?(?:fix|add|implement|refactor|build|create|update|remove|delete|change|rename|move|center|align|style|design|make|put|set|use|replace|adjust|convert)\b/i;

const PASSIVE_CHANGE_REQUEST =
  /^(?:can|could|would|should)\s+(?:the|this|that|these|those|my|our)\b.{0,80}\bbe\s+(?:fixed|added|implemented|updated|removed|deleted|changed|renamed|moved|centered|aligned|styled|designed|made|put|set|replaced|adjusted|converted)\b/i;

const FEATURE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "this",
  "that",
  "these",
  "those",
  "issue",
  "issues",
  "same",
  "apply",
  "fixed",
  "fix",
  "make",
  "update",
  "change",
  "please",
]);

function featureTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.filter((word) => !FEATURE_STOPWORDS.has(word)))].slice(
    0,
    8
  );
}

function looksLikeQuestion(prompt: string): boolean {
  const trimmed = prompt.trim();
  // A question mark is punctuation, not intent. Polite requests such as
  // "can you center the login?" still owe the user a workspace change.
  if (
    CHANGE_REQUEST_OPENERS.test(trimmed) ||
    PASSIVE_CHANGE_REQUEST.test(trimmed)
  ) {
    return false;
  }
  return (
    /^(what|where|when|why|how|who|is|are|can|could|should|does|do|did|was|were)\b/i.test(
      trimmed
    ) || EXPLAIN_OPENERS.test(trimmed)
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
