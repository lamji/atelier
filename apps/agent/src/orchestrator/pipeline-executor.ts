import {
  query,
  type HookCallbackMatcher,
  type HookEvent,
  type HookInput,
  type HookJSONOutput,
  type PermissionResult,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { TurnRunner } from "./turn-runner.js";
import { assertCommandConfined } from "../tools/terminal-tools.js";
import type { Logger } from "pino";
import {
  approxTokens,
  clipToTokens,
  newId,
  stripHiddenContext,
} from "@atelier/shared";
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
import type { SearchGroundingGuard } from "../hooks/search-grounding-guard.js";
import type { RepeatCallGuard } from "../hooks/repeat-call-guard.js";
import type { DebugProtocolGuard } from "../hooks/debug-protocol-guard.js";
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
  LIGHT_APPEND_CHARS,
  LIGHT_CONTEXT_MAX_CHARS,
  LIGHT_LAYOUT_CHARS,
  LIGHT_USER_RULE_CHARS,
  LIGHT_VIBE_CHARS,
  clipLightContext,
  isDirectMode,
  renderExecutionCheckpoint,
  renderPriorTurns,
} from "./direct-mode.js";
import { trace } from "./trace.js";
import {
  BlockerLedger,
  harnessPrompt,
  loopHarnessLimits,
  reportsHardBlocker,
  reportsNoChangeNeeded,
  streamStallLimits,
} from "./loop-harness.js";
import {
  buildLlmRequest,
  contextSections,
  contextText,
  promptWithRelevantPreview,
  publishLlmRequest,
  type AppendContext,
  type ContextSection,
} from "./llm-request.js";
import { effortFor, isTrivialChat } from "./trivial-chat.js";
import {
  focusedLiterals,
  previewVisibleText,
} from "../context/preview/preview-evidence.js";
import type { PreviewBaselines } from "../context/preview/preview-baselines.js";
import {
  clipKeepingRefs,
  extractRefs,
} from "../context/session/clip-keeping-refs.js";
import {
  EMPTY_NAMED_TARGETS,
  describeNamedTargets,
  namedTargets,
  type NamedTargets,
} from "./named-targets.js";
import { turnStance, type TurnStance } from "./turn-stance.js";
import type { NamedTargetGuard } from "../hooks/named-target-guard.js";
import {
  ATELIER_AGENTS,
  CLAUDE_FAST_BUILTINS,
  CLAUDE_NATIVE_TOOLS,
  CLAUDE_TURN_LIMIT_CONTINUATIONS,
  claudeContinuationBudget,
  claudeEffort,
  claudeTurnBudget,
  tolerateTurnLimit,
} from "./claude-budget.js";
import { userRulesPrompt } from "./user-rules.js";
import { VIBE_RULES } from "./vibe-rules.js";
import type { UsageMonitor } from "./usage-monitor.js";
import type {
  SdkUsage,
  TaskTokenUsage,
  TokenLedger,
} from "../context/ledger/index.js";
import type { PromptAssembler } from "../context/assemble/index.js";
import type { RetrieverLike } from "../context/cache/index.js";
import {
  buildTaskSummary,
  type TaskSummaryStore,
} from "../context/summaries/index.js";
import {
  isGlobalSessionCommand,
  parseGeneratedGlobalAlias,
  type GlobalSessionStore,
} from "../context/global-session/index.js";
import {
  DEBUG_REPORT_PROMPT,
  DEBUG_REPORT_TEMPLATE,
  parseDebugReport,
  parseFeatureContextCommand,
  parseFeatureContextDebugCommand,
  parseFeatureContextUpdateCommand,
  parseEntryPointCommand,
  parseImpactRadiusCommand,
  readScreenEvidence,
  screenTerms,
  renderEntryPointReport,
  renderImpactRadiusReport,
  renderDebugTask,
  renderFeatureContextActivationReport,
  renderFeatureContextRefreshReport,
  type FeatureContextStore,
  type SessionFeatureContext,
} from "../context/feature-context/index.js";
import { rankCandidates } from "../context/rank/index.js";
import {
  detectWorkspaceProfile,
  renderProjectTree,
  UNSCOPED_MAX_CHARS,
  UNSCOPED_MAX_DEPTH,
  renderWorkspaceProfile,
} from "../workspace/profile/index.js";
import type { WorkspaceProfile } from "../workspace/profile/index.js";
import {
  EMPTY_SCOPE,
  inScope,
  renderScope,
  featureFocusFiles,
  scopeGlob,
  workingSet,
  type SessionScope,
  type SessionScopeStore,
} from "../workspace/scope/index.js";
import type { WorkspaceIgnore } from "../workspace/ignore.js";
import type { GitService } from "../git/git-service.js";
import type { ScopeGuard } from "../tools/scope-guard.js";
import {
  MOCK_API_USAGE,
  parseMockApiCommand,
  renderMockApiReport,
  type MockApiCommand,
} from "../preview/mock-api-command.js";
import { runMockApi } from "../preview/mock-api.js";
import type { PreviewSessionStore } from "../preview/preview-session-store.js";
import {
  classifyChange,
  testOnlyPaths,
  touchesCode,
  type ChangeScale,
} from "./change-scale/index.js";
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
 * How many files the blast radius is computed for. The analyzer caps its
 * own output at 60 affected nodes; this caps the input, so a turn with a
 * forty-file working set reports the reach of the handful it is about.
 */
const IMPACT_TARGETS = 6;

/**
 * Body of the plan-mode system reminder for the plan pass the user asks for
 * with the Plan checkbox. The CLI wraps this with its own read-only preamble
 * and ExitPlanMode protocol footer, so it only has to say what a good
 * Atelier plan looks like.
 */
const SYSTEM_PLAN_INSTRUCTIONS =
  "Use current code already carried in the assembled context before " +
  "planning. Read only a concrete missing range or a source marked changed " +
  "or stale; do not reopen code the prompt already provides. Then call " +
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
/**
 * Whether a call to the `git` tool changed anything.
 *
 * status/log/diff/branches only look; the rest move refs, the index, or
 * HEAD. A read is not effect and must not check a step off.
 */
export function mutatesGit(input: unknown): boolean {
  const action = (input as { action?: unknown } | null)?.action;
  if (typeof action !== "string") return false;
  return !["status", "log", "diff", "branches"].includes(action);
}

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
      "- Not one file was changed, on a turn that asked for a change, and the tool budget is spent. Make the edits now from what you have already read. If the turn genuinely calls for no workspace change — the user stated a fact, pasted output, corrected you, or the code already is what was asked for — end with a line starting `NO CHANGE NEEDED:` and the reason; that closes this gate, and nothing else does."
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
  _outstanding: string,
  _stopHookActive: boolean,
  _report = ""
):
  | { decision: "block"; reason: string }
  | { decision?: undefined; reason?: undefined } {
  // ADVISORY, never blocking. Blocking the Stop erased the model's report
  // (`text = ""`), forced it on until the round ceiling, restarted it from
  // a checkpoint, erased that report too, and the user got two rounds of
  // ~450k tokens and an empty "task is incomplete" panel. The report is
  // the output; what is still open is SAID under it (completionGateResultText),
  // and the user decides whether to carry on.
  return {};
}

/**
 * The two reports the harness itself tells the model will end the turn:
 * a named hard blocker, and "this turn needs no change".
 *
 * The hook has to read them, because a blocked Stop ERASES the report it
 * blocked (`text = ""`). So the model would write the exact sentence the
 * loop below looks for, the hook would delete it, the loop would see an
 * empty round and spend another one — and both declared exits were
 * unreachable in practice. The turn could then only end by running the
 * stall budget dry, which is what put "the completion gate is still open"
 * under turns that had nothing left to do.
 */
export function declaresHonestExit(report: string): boolean {
  return reportsHardBlocker(report) || reportsNoChangeNeeded(report);
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

/**
 * A bounded retry budget resets only when live completion evidence advances.
 *
 * A completed STEP is not that evidence, and used to be. A checkmark is the
 * model's own assertion — so a model that spent each round checking one more
 * step off an untouched workspace reset the stall counter every round, and
 * the loop had no bound left at all. That is the turn that runs twenty-three
 * rounds and finishes nothing. An applied edit and an observed verification
 * are the two things Atelier watched happen, so they are the two that count.
 */
export function completionGateMadeProgress(
  before: CompletionGateProgress,
  after: CompletionGateProgress
): boolean {
  return (
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
/**
 * The report is the output. Nothing is appended under it: the italic
 * "completion gate is still open" verdict read, to the person receiving
 * it, as the agent announcing its own failure after every long turn, and
 * it said nothing they could not see from the plan rail. The gate state
 * still reaches the timeline (stage detail) and the task summary.
 */
export function completionGateResultText(
  text: string,
  _gateStillOpen: boolean
): string {
  return text.trim();
}

/**
 * Watches a provider stream for going silent, and ends the turn if it stays
 * that way.
 *
 * A turn that hangs here used to hang forever: the UI kept saying "Working",
 * no event was published, no timeout existed anywhere on this path, and the
 * only way out was killing the app. That is indistinguishable, to the user,
 * from a turn that is merely slow — so a real hang could never be reported,
 * reproduced, or told apart from a long build.
 *
 * `beat()` on every message; the timer is re-armed from the last beat, so a
 * chatty stream never trips it. Warning first, abort second: the warning is
 * what makes a stall visible while a legitimately quiet tool run finishes.
 */
export class StreamStallWatch {
  private timer: NodeJS.Timeout | undefined;
  private quietSince = Date.now();
  private warned = false;
  /** True once the stream was cut for silence rather than ending itself. */
  abandoned = false;

  constructor(
    private report: (detail: string) => void,
    private abort: () => void,
    private limits = streamStallLimits()
  ) {
    this.arm();
  }

  beat(): void {
    this.quietSince = Date.now();
    if (this.warned) {
      this.warned = false;
      this.report("working");
    }
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** What the turn says when its stream was abandoned mid-flight. */
  note(): string {
    return (
      "_The provider stream stopped responding for " +
      `${minutes(this.limits.abortMs)} and Atelier ended the turn. Anything ` +
      "above this line is partial. Send the next message to carry on._"
    );
  }

  private arm(): void {
    this.stop();
    const next = this.warned ? this.limits.abortMs : this.limits.warnMs;
    if (!Number.isFinite(next)) return;
    const due = this.quietSince + next - Date.now();
    this.timer = setTimeout(() => this.fire(), Math.max(due, 0));
    // A watchdog must never be the reason a finished process stays alive.
    this.timer.unref?.();
  }

  private fire(): void {
    if (!this.warned) {
      this.warned = true;
      this.report(
        `no provider output for ${minutes(this.limits.warnMs)} — still waiting`
      );
      this.arm();
      return;
    }
    this.abandoned = true;
    this.stop();
    // Said before the abort, because aborting may end the turn down the
    // cancel path — where this detail is the only thing that separates
    // "the user stopped it" from "it stopped answering".
    this.report(
      `stream abandoned after ${minutes(this.limits.abortMs)} of silence`
    );
    this.abort();
  }
}

function minutes(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return mins >= 1 ? `${mins}m` : `${Math.round(ms / 1000)}s`;
}

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
  /**
   * Holds what each turn has seen, so a search for an invented identifier
   * can be told apart from a search for a real one. Optional: the smokes
   * build a bare deps object, and an unseeded guard stands down.
   */
  searchGrounding?: SearchGroundingGuard;
  /**
   * Armed when a turn reports a failure; holds edit tools until the failure
   * has been observed in this turn, and holds "Fixed" until the fix has been
   * re-observed. Optional so the smokes' bare deps object keeps working.
   */
  debugProtocol?: DebugProtocolGuard;
  /**
   * Holds what each turn has already LOOKED UP, so an identical rerun can
   * be answered from the ledger instead of the filesystem. Optional for
   * the same reason as the guard above: an unfed ledger stands down.
   */
  repeatCalls?: RepeatCallGuard;
  /**
   * Holds set_plan and the edit tools until the file or text the user
   * named has been looked at. Optional so the smokes' bare deps object
   * keeps working; an unarmed guard stands down.
   */
  namedTargets?: NamedTargetGuard;
  /** What the previewed page showed at send time, for preview_test. */
  previewBaselines?: PreviewBaselines;
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
  globalSessions: GlobalSessionStore;
  /** Tree-sitter feature maps explicitly pinned with /context <feature>. */
  featureContexts: FeatureContextStore;
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
  /** Live Page preview session, for /context_mock_api. */
  previewSessions: PreviewSessionStore;
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
    /** The model's own note on the step. */
    note?: string;
    /** Harness-observed verification (a green test run), when any. */
    verification?: string;
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
  /** The prompt as the composer built it — hidden preview block included. */
  prompt: string;
  /**
   * The user's words alone, every hidden block stripped. This is what the
   * intent, retrieval, grounding and memory read; `prompt` is only what the
   * model is sent. The page dump riding inside `prompt` was once read as
   * the request by all of them, and it drowned the request.
   */
  humanPrompt: string;
  /** Visible strings of the previewed page at send time, one per line. */
  previewText: string;
  /** Files and strings the user named this turn. */
  named: NamedTargets;
  /** How this turn relates to the last one: continue, correct, or fresh. */
  stance: TurnStance;
  /** Size of the diff so far, from its content; null until the first edit. */
  changeScale: ChangeScale | null;
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
  /** Explicit /context feature pinned to this conversation, if any. */
  featureContext: SessionFeatureContext | null;
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

/** The text a native Read returned, whatever shape the SDK wrapped it in. */
function readToolContent(response: unknown): string | null {
  if (typeof response === "string") return response;
  const file = (response as { file?: { content?: unknown } } | null)?.file;
  if (file && typeof file.content === "string") return file.content;
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Render every provider request accounted for by the task, then its rollup. */
export function renderTaskTokenReport(usage: TaskTokenUsage): string {
  if (usage.turns.length === 0) return "";
  const turns = usage.turns.map(
    (turn, index) =>
      `- Model turn ${index + 1} (${turn.purpose}): ` +
      `${formatTokenCount(turn.totalTokens)} total tokens ` +
      `(input ${formatTokenCount(turn.inputTokens)}, ` +
      `cache read ${formatTokenCount(turn.cacheReadTokens)}, ` +
      `cache write ${formatTokenCount(turn.cacheCreationTokens)}, ` +
      `output ${formatTokenCount(turn.outputTokens)})`
  );
  turns.push(
    `- Final token total: ${formatTokenCount(usage.totalTokens)} tokens`
  );
  return turns.join("\n");
}

function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString("en-US");
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
 * is not a stage either: the blast radius is one local graph walk over the
 * turn's targets, run inside `retrieve` and shipped as context.
 */
export class PipelineExecutor {
  /**
   * Detected once per process and reused verbatim. It must stay
   * byte-stable: it rides in the static half of the system prompt, so a
   * value that changed mid-session would invalidate the provider prompt
   * cache on every turn.
   */
  private workspaceBlock?: Promise<string>;

  private turnRunner?: TurnRunner;
  /** The agent flow — see turn-runner.ts. */
  private get turns(): TurnRunner {
    this.turnRunner ??= new TurnRunner({
      bus: this.deps.bus,
      log: this.deps.log,
      files: this.deps.files,
      summaries: this.deps.summaries,
      workingMemory: this.deps.workingMemory,
      skillLoader: this.deps.skillLoader,
    });
    return this.turnRunner;
  }

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
    // An unlocked turn used to get NO map at all — the one case where the
    // model has least idea where anything is. It gets the workspace root
    // instead, on a smaller budget: breadth over depth until a lock says
    // which project matters.
    if (scope.roots.length === 0 && scope.anchors.length === 0) {
      return this.projectTree("", UNSCOPED_MAX_CHARS, UNSCOPED_MAX_DEPTH);
    }

    const boundary = renderScope(scope, ctx.workingSet);
    // Once retrieval has produced concrete files, the boundary plus that
    // working set is the useful scope. Re-sending every directory under each
    // locked project can cost thousands of tokens without helping the model
    // choose a target; it can retrieve or list an exact missing path on
    // demand. Keep the deep map only for turns that have no concrete files.
    if (ctx.workingSet.length > 0) return boundary;

    const trees = await Promise.all(
      scope.roots.map((root) => this.projectTree(root))
    );
    // ctx.workingSet is empty on the warm-up call above, which only exists to
    // prime the tree cache and whose text is discarded.
    return [boundary, ...trees].filter(Boolean).join("\n");
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
    // A workspace-wide feature table can match a project this conversation
    // has nothing to do with. Focus only on what this session may actually
    // be narrowed to; an ambiguous match leaves the scope exactly as it is.
    const focusable = featureFocusFiles(files, profile, ctx.scope);
    if (focusable.length === 0) return;

    const focused = this.deps.scope.focusFiles(
      ctx.conversationId,
      focusable,
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

  /**
   * Loads the explicit /context binding before retrieval. A stale map is
   * rebuilt from the current tree-sitter rows; otherwise this is one small
   * SQLite read. Typed/explicit scope still wins for the current turn.
   */
  private async applyPinnedFeatureContext(ctx: TaskContext): Promise<void> {
    let pinned = this.deps.featureContexts.get(ctx.conversationId);
    if (!pinned) return;

    if (pinned.status === "stale") {
      try {
        await this.deps.indexer.drainFor([]);
        pinned = this.deps.featureContexts.activate(
          ctx.conversationId,
          pinned.name
        ).context;
      } catch (error) {
        // The last compiled map remains useful as a lead even when a large
        // refactor temporarily leaves the index without a matching seed.
        this.deps.log.warn(
          { error, feature: pinned.name },
          "pinned feature context refresh failed"
        );
      }
    }
    ctx.featureContext = pinned;

    if (
      pinned.files.length === 0 ||
      ctx.scope.source === "mention" ||
      ctx.scope.source === "explicit"
    ) {
      return;
    }

    const profile = await this.workspaceProfile();
    // Explicit: the user named this context, so unlike an automatic feature
    // match it may relock the conversation and is persisted as a lock.
    const focused = this.deps.scope.focusFiles(
      ctx.conversationId,
      pinned.files,
      profile,
      { explicit: true }
    );
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
        source: "feature",
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

  /**
   * The scripted investigation hand-off for this turn.
   *
   * A file named in the current prompt is the concrete entry point. A vague
   * follow-up inherits the session's named scope, and only an unanchored turn
   * falls back to the highest-ranked files retrieval re-earned. The local graph
   * walk then runs before the provider starts, so both change tasks and
   * read-only investigations begin from the returned callers, flows, tests and
   * risks instead of spending model tool rounds rebuilding a radius.
   */
  private investigationRadius(ctx: TaskContext, intent: Intent): ImpactRadius {
    const targets = investigationTargets(
      intent.targets,
      ctx.scope.named,
      ctx.workingSet
    );
    if (targets.length === 0) return emptyRadius([]);
    try {
      const radius = this.deps.impact.analyze(targets);
      this.deps.bus.publish("impact.radius", radius, ctx.taskId);
      return radius;
    } catch (error) {
      // A radius we cannot compute is missing context, never a failed turn.
      this.deps.log.warn({ error, targets }, "impact radius failed");
      return emptyRadius(targets);
    }
  }

  private projectTree(
    root: string,
    maxChars?: number,
    maxDepth?: number
  ): Promise<string> {
    let block = this.treeBlocks.get(root);
    if (!block) {
      block = renderProjectTree(
        this.deps.config.workspaceRoot,
        root,
        this.deps.ignore,
        maxChars,
        maxDepth
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

  /**
   * `/context_update` — recompiles the pinned map in place. Same build path
   * as /context, except the feature name comes from the existing pin, so a
   * long debugging session can re-sync after edits without retyping it.
   */
  /**
   * `/entry_point` — which symbol renders the screen the user marked.
   *
   * Answered from the tree-sitter index and the preview evidence the
   * composer already attaches, with no model call at all: that is what
   * makes it behave the same on Codex, Claude and a local provider. The
   * screenshot still rides in the conversation for later turns to look at;
   * it simply is not what the mapping depends on.
   */
  private async runEntryPoint(
    ctx: TaskContext,
    hint: string
  ): Promise<PipelineOutcome> {
    try {
      await this.deps.indexer.drainFor([]);
      const evidence = readScreenEvidence(ctx.prompt);
      const terms = screenTerms(evidence, hint);
      const matches = this.deps.featureContexts.entryPoints(
        terms,
        evidence.routeTerms
      );
      this.deps.featureContexts.rememberEntryPoints(
        ctx.conversationId,
        matches.slice(0, 3).map((match) => match.id)
      );
      return {
        assistantText: renderEntryPointReport({ matches, evidence, hint }),
        sdkSessionId: null,
      };
    } catch (error) {
      return {
        assistantText: String((error as { message?: string })?.message ?? error),
        sdkSessionId: null,
      };
    }
  }

  /**
   * `/impact_radius` — everything reachable from that entry point.
   *
   * Takes its own screenshot when one rides along, so it can be used on its
   * own; otherwise it walks from whatever `/entry_point` last pinned in this
   * conversation.
   */
  /**
   * `/context_mock_api` — replays one API call as the signed-in user.
   *
   * The call goes out from the agent with the in-app browser's own
   * Authorization header and cookies, so the answer is the one the app
   * gets rather than the 401 an anonymous caller gets. Nothing is written;
   * the report is the whole result, and it stays in the conversation as
   * context for the turns that follow.
   */
  private async runMockApiCommand(
    command: MockApiCommand
  ): Promise<PipelineOutcome> {
    if (!command.request) {
      const problem = command.problem ? `${command.problem}\n\n` : "";
      return { assistantText: problem + MOCK_API_USAGE, sdkSessionId: null };
    }
    try {
      const result = await runMockApi(
        command.request,
        this.deps.previewSessions
      );
      return { assistantText: renderMockApiReport(result), sdkSessionId: null };
    } catch (error) {
      return {
        assistantText:
          String((error as { message?: string })?.message ?? error) +
          "\n\n" +
          MOCK_API_USAGE,
        sdkSessionId: null,
      };
    }
  }

  private async runImpactRadius(
    ctx: TaskContext,
    hint: string
  ): Promise<PipelineOutcome> {
    try {
      await this.deps.indexer.drainFor([]);
      const evidence = readScreenEvidence(ctx.prompt);
      const terms = screenTerms(evidence, hint);
      // Fresh evidence wins: the user marked a screen with THIS send, so
      // that screen is the subject even if another was pinned earlier.
      let entries =
        terms.length > 0
          ? this.deps.featureContexts.entryPoints(terms, evidence.routeTerms)
          : [];
      if (entries.length === 0) {
        const remembered = this.deps.featureContexts.lastEntryPoints(
          ctx.conversationId
        );
        if (remembered.length === 0) {
          return {
            assistantText:
              "Nothing to walk from yet. Mark the screen in Page preview " +
              "and send `/entry_point` first, or attach a screenshot to " +
              "`/impact_radius` so it can find the entry point itself.",
            sdkSessionId: null,
          };
        }
        entries = this.deps.featureContexts.entryPointsByIds(remembered);
      }
      const chosen = entries.slice(0, 3);
      const radius = this.deps.featureContexts.impactRadius(
        chosen.map((entry) => entry.id)
      );
      this.deps.featureContexts.rememberEntryPoints(
        ctx.conversationId,
        chosen.map((entry) => entry.id)
      );
      return {
        assistantText: renderImpactRadiusReport({
          entries: chosen,
          radius,
          evidence,
        }),
        sdkSessionId: null,
      };
    } catch (error) {
      return {
        assistantText: String((error as { message?: string })?.message ?? error),
        sdkSessionId: null,
      };
    }
  }

  private async runFeatureContextUpdate(
    ctx: TaskContext,
    requestedFeature: string
  ): Promise<PipelineOutcome> {
    try {
      // Explicit command: wait on the whole queue rather than the pinned
      // files. The point of a refresh is to pick up callers and imports
      // that did not exist when the map was first compiled.
      await this.deps.indexer.drainFor([]);
      const result = this.deps.featureContexts.refresh(
        ctx.conversationId,
        requestedFeature || undefined
      );
      return {
        assistantText: renderFeatureContextRefreshReport(result),
        sdkSessionId: null,
      };
    } catch (error) {
      return {
        assistantText: String((error as { message?: string })?.message ?? error),
        sdkSessionId: null,
      };
    }
  }

  /**
   * `/context_debug` — hands back the report to fill in. Fenced, so the
   * markdown survives being rendered as an assistant message and can be
   * copied or loaded straight into an editor rather than read as prose.
   */
  private debugReportForm(retry: boolean): PipelineOutcome {
    return {
      assistantText:
        (retry
          ? "That report still has an empty \"Steps to replicate\" or " +
            "\"Expected result\" — I cannot reproduce a defect from either " +
            "one alone. Here is the form again.\n\n"
          : "") +
        DEBUG_REPORT_PROMPT +
        "\n\n```markdown\n" +
        DEBUG_REPORT_TEMPLATE +
        "```\n",
      sdkSessionId: null,
    };
  }

  async run(ctx: TaskContext): Promise<PipelineOutcome> {
    // Slash commands belong to the text the user typed. Page-preview and
    // screenshot evidence is intentionally appended as hidden context for a
    // model turn, but must not make an anchored command parser miss and fall
    // through into implementation.
    const commandPrompt = stripHiddenContext(ctx.prompt);
    // The page's visible strings are read off the FULL block, before the
    // markup is dropped below: the text nodes of the page are where an
    // on-screen label the user is looking at is found.
    ctx.previewText = previewVisibleText(ctx.prompt);
    this.deps.previewBaselines?.set(ctx.taskId, ctx.previewText);
    // Keep the compact label/focus/console evidence on every preview turn.
    // Raw markup rides into the pipeline only when the visible request asks
    // about HTML, CSS, the DOM or styling source.
    ctx.prompt = promptWithRelevantPreview(ctx.prompt);
    ctx.humanPrompt = humanText(commandPrompt);
    const debugBody = parseFeatureContextDebugCommand(commandPrompt);
    if (debugBody !== undefined) {
      const report = debugBody ? parseDebugReport(debugBody) : null;
      if (!report) return this.debugReportForm(debugBody.length > 0);
      // A filled report is not a command, it is the turn's task. Rewriting
      // the prompt rather than answering here is what lets the rest of the
      // pipeline run on it: the pinned feature map, retrieval, the
      // debugging skill, and any screenshots attached to the same send.
      ctx.prompt = renderDebugTask(report, ctx.opts.images?.length ?? 0);
      ctx.humanPrompt = humanText(stripHiddenContext(ctx.prompt));
    }
    // The screen commands read the prompt the COMPOSER built, not the
    // stripped command line: the route and the captured DOM ride in it,
    // and they are the whole input. See screen-commands.ts.
    const entryPointHint = parseEntryPointCommand(ctx.prompt);
    if (entryPointHint !== undefined) {
      return this.runEntryPoint(ctx, entryPointHint);
    }
    const radiusHint = parseImpactRadiusCommand(ctx.prompt);
    if (radiusHint !== undefined) {
      return this.runImpactRadius(ctx, radiusHint);
    }
    const mockApi = parseMockApiCommand(commandPrompt);
    if (mockApi !== undefined) {
      return this.runMockApiCommand(mockApi);
    }
    const updatedFeature = parseFeatureContextUpdateCommand(commandPrompt);
    if (updatedFeature !== undefined) {
      return this.runFeatureContextUpdate(ctx, updatedFeature);
    }
    const requestedFeature = parseFeatureContextCommand(commandPrompt);
    if (requestedFeature !== undefined) {
      if (!requestedFeature) {
        return {
          assistantText:
            "Usage: /context <feature> — for example, /context login.",
          sdkSessionId: null,
        };
      }
      try {
        // The command snapshots the local tree-sitter index, not provider
        // output. Waiting here ensures a just-opened workspace is mapped
        // before the feature is bound to the conversation.
        await this.deps.indexer.drainFor([]);
        const result = this.deps.featureContexts.activate(
          ctx.conversationId,
          requestedFeature
        );
        return {
          assistantText: renderFeatureContextActivationReport(result),
          sdkSessionId: null,
        };
      } catch (error) {
        return {
          assistantText: String(
            (error as { message?: string })?.message ?? error
          ),
          sdkSessionId: null,
        };
      }
    }
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
    // Agent turns always use the CLI-style loop; legacy knowledge flags do not opt in.
    if (isDirectMode(ctx.opts)) {
      try {
        return await this.runDirect(ctx);
      } finally {
        this.deps.previewBaselines?.release(ctx.taskId);
      }
    }
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
    /**
     * Effect this turn had on the workspace that left no file diff: a git
     * ref moved, a command that changes something ran clean. The gate reads
     * "0 files changed" as "nothing was implemented", which is true of a
     * turn that only talked and false of a turn that reset a branch — and
     * the second kind could never close its timeline.
     */
    let stateChanged = false;
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
        const failedInput = toolInputs.get(payload.toolCallId)?.input;
        toolInputs.delete(payload.toolCallId);
        blockers.note(`tool ${payload.name ?? ""}`, payload.error ?? "");
        if (payload.name) {
          this.deps.debugProtocol?.noteFailed(
            ctx.taskId,
            payload.name,
            failedInput,
            payload.error ?? ""
          );
        }
      }
      if (event.topic === "edit.applied") {
        const path = (event.payload as { path: string }).path;
        changedFiles.add(path);
        appliedEdits += 1;
        ctx.record.editCount += 1;
        verificationObserved = false;
        this.deps.debugProtocol?.noteEdit(ctx.taskId, path);
        // The diff decides how much verification the change deserves; it
        // is re-read after every edit so the guard and the tail stages see
        // the change as it is now.
        this.refreshChangeScale(ctx);
        // The workspace moved, so every lookup taken before it answered a
        // question about a file that no longer reads that way. Re-running
        // one now is new information, not a repeat.
        this.deps.repeatCalls?.invalidate(ctx.taskId);
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
        // What this turn looked at, remembered for the next one. Failures
        // are swallowed: memory is a side effect of the turn, never a way
        // to fail it.
        const started = payload.toolCallId
          ? toolInputs.get(payload.toolCallId)
          : undefined;
        if (
          payload.name === "run_terminal" &&
          payload.result?.exitCode === 0 &&
          payload.result.timedOut !== true
        ) {
          verificationObserved = true;
          // …and effect, not just proof. A command that ran clean inside a
          // started step is the only evidence a git-ref or infrastructure
          // step ever produces; without this it could never be checked off.
          stateChanged = true;
          this.deps.planTracker.noteWorkObserved(ctx.taskId);
          // A green test/typecheck run is attached to the step it verifies,
          // so a "done" the model asserts and a "done" the harness saw are
          // told apart in the plan rail and in memory.
          const command = commandOf(started?.input);
          if (VERIFYING_COMMAND.test(command)) {
            this.deps.planTracker.noteVerified?.(
              ctx.taskId,
              `${clip(command, 80)} → exit 0`
            );
          }
        }
        // A preview assertion only verifies a change if what it asserts
        // was not already on the page when the turn was sent.
        if (payload.name === "preview_test") {
          const outcome = payload.result as
            | { status?: string; tautological?: boolean; title?: string }
            | undefined;
          if (outcome?.status === "passed" && outcome.tautological !== true) {
            this.deps.planTracker.noteVerified?.(
              ctx.taskId,
              `preview_test "${clip(outcome.title ?? "", 60)}" passed`
            );
          }
        }
        // Did the model look at what the user named? The guard that holds
        // planning and editing until it has is fed from here.
        if (payload.name) {
          this.deps.namedTargets?.note(
            ctx.taskId,
            payload.name,
            started?.input,
            payload.result
          );
        }
        if (payload.name === "git" && mutatesGit(started?.input)) {
          stateChanged = true;
          this.deps.planTracker.noteWorkObserved(ctx.taskId);
        }
        if (payload.toolCallId) toolInputs.delete(payload.toolCallId);
        if (started && payload.name) {
          // A runtime observation? The debugging gate reads the result to
          // decide whether the failure has been seen and, after a fix,
          // re-seen coming back clean.
          this.deps.debugProtocol?.note(
            ctx.taskId,
            payload.name,
            started.input,
            payload.result
          );
          // Everything a tool returns is now something this turn has read,
          // so the next search may be grounded in it.
          this.deps.searchGrounding?.note(
            ctx.taskId,
            typeof payload.result === "string"
              ? payload.result
              : JSON.stringify(payload.result ?? "")
          );
          // ...and something this turn no longer needs to look up. Same
          // event, because a lookup's identity is only worth recording
          // once it has actually returned something to reuse.
          this.deps.repeatCalls?.note(
            ctx.taskId,
            payload.name,
            started.input,
            payload.result
          );
        }
      }
    });
    // What this turn reads, searches, runs and edits, remembered for the
    // next one. One recorder for both modes — see rememberActions.
    const forget = this.turns.remember(ctx);

    // NOT marked as a direct task. That mark exists for one thing: a turn
    // running with system knowledge OFF has no knowledge engine behind it,
    // so the code guards that enforce one would block edits the run has no
    // way to unblock. A pipeline turn keeps them armed, and every rule they
    // enforce is stated in FAST_RULES — stated and enforced, which is the
    // only pairing that works.

    try {
      await this.applyScope(ctx);
      await this.applyPinnedFeatureContext(ctx);
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
      // The previous turn's answer, when this turn implements it. Read in
      // the understand stage so its file references steer retrieval and
      // the impact walk; rendered in the execute stage as "plan handoff".
      let handoffAnswer = "";
      const intent = await this.stage(ctx, "understand", async () => {
        // The user's words only. The hidden page dump used to be read here
        // too, and its URLs and utility classes came out as `targets`.
        const result = readIntent(ctx.humanPrompt);
        // What the user pointed at — a typed path, quoted text, an i18n
        // key, a phrase that is on the previewed page, a highlighted
        // region — and how this message relates to the last turn.
        ctx.named = namedTargets({
          humanPrompt: ctx.humanPrompt,
          previewText: ctx.previewText,
          focused: focusedLiterals(ctx.prompt),
        });
        const previous = this.deps.summaries.previous(
          ctx.conversationId,
          ctx.taskId
        );
        const stance = turnStance({
          humanPrompt: ctx.humanPrompt,
          previousStatus: previous?.status ?? null,
          named: ctx.named,
        });
        ctx.stance = stance.stance;
        handoffAnswer = handoffAnswerFor(ctx, result, previous);
        const handoffRefs = extractRefs(handoffAnswer, 8).map((ref) =>
          ref.replace(/:\d+(?:-\d+)?$/, "")
        );
        // A named file is the subject; retrieval and the impact walk start
        // from it — and from the files the plan being implemented names —
        // rather than from whatever the earlier turns touched.
        result.targets = [
          ...new Set([...ctx.named.paths, ...handoffRefs, ...result.targets]),
        ].slice(0, 8);
        ctx.record.intentKind = result.kind;
        ctx.record.intentSummary = result.summary;
        this.deps.bus.publish("intent.resolved", result, ctx.taskId);
        this.deps.bus.publish(
          "turn.stance",
          {
            stance: ctx.stance,
            reasons: stance.reasons,
            namedPaths: ctx.named.paths,
            namedLiterals: ctx.named.literals,
            previousTaskId: previous?.taskId ?? null,
            previousStatus: previous?.status ?? null,
          },
          ctx.taskId
        );
        // The guard that holds set_plan and the edit tools until the named
        // thing has been read or searched: what the wrong-file turns never
        // did before editing somewhere else.
        this.deps.namedTargets?.arm(ctx.taskId, ctx.named);
        return {
          value: result,
          detail:
            `${result.kind} · ${ctx.stance}: ${clip(result.summary, 80)}` +
            (ctx.named.paths.length + ctx.named.literals.length > 0
              ? ` · names ${describeNamedTargets(ctx.named)}`
              : ""),
        };
      });

      // "Where did you put it?", "are you editing the right file?", "what
      // does this hook do?" — the user asked to be TOLD something. Such a
      // turn owed an answer and got an implementation instead, because
      // every clause pointing at the timeline and at autonomous execution
      // rode on it regardless of intent. An answer-only turn publishes no
      // execution contract, so no plan-before-edit gate and no checklist:
      // the model reads what it needs and replies.
      // Ask mode is the user overruling the classifier, so it only ever
      // adds an answer-only turn — never cancels one. A prompt that reads
      // as a question is still answered in Code mode; what Code does not
      // do is promise an edit the classifier never saw a reason for.
      const answerOnly = ctx.opts.turnMode === "ask" || isReadOnly(intent);
      if (answerOnly) this.deps.planTracker.markAnswerOnly(ctx.taskId);
      else this.deps.planTracker.requirePlan(ctx.taskId);
      // "Study this and create a plan" is a work turn whose deliverable is
      // the plan. Its steps are study and design steps, and the plan gates
      // built for change turns turned it into a dead end: set_plan was
      // refused until every request bullet had a step "delivering" it, and
      // then no step could ever be checked because none had an edit — the
      // user watched a finished study with every bullet still unchecked.
      const planOnly =
        answerOnly ||
        ctx.opts.planMode === true ||
        asksForPlanOnly(ctx.humanPrompt);
      if (planOnly) this.deps.planTracker.markPlanOnly(ctx.taskId);

      // A change turn that reports a failure enters the debugging protocol:
      // its edits wait until the failure has been observed in this turn.
      // Only the human half of the prompt is read (the hidden preview blob
      // says "errors are present" on every send), and the conversation
      // carries the symptom so a "then?" after a failed fix stays gated.
      // A change turn that reports a failure enters `fix` mode (edits wait on
      // the observation). A question that asks to diagnose one enters
      // `diagnose` mode: it makes no edits, but a confident root-cause verdict
      // still has to be reproduced or hedged — the jump-to-conclusions guard.
      if (!isTrivialChat(ctx.humanPrompt, ctx.images.length > 0)) {
        this.deps.debugProtocol?.arm(
          ctx.taskId,
          ctx.conversationId,
          ctx.prompt,
          {
            mode: answerOnly ? "diagnose" : "fix",
            hasImages: ctx.images.length > 0,
            // "I can still see <label>" beside a page that shows that label
            // is a copy complaint, not a runtime failure to observe.
            previewText: ctx.previewText,
          }
        );
      }

      const retrieval = await this.stage(ctx, "retrieve", async () => {
        // Small talk is the one turn with nothing to look up, and the test
        // for it is a regex, not a model.
        if (isTrivialChat(ctx.humanPrompt, ctx.images.length > 0)) {
          return { value: emptyRetrieval(), detail: "skipped — small talk" };
        }
        // The user's words, the files they named, and the strings they
        // expect to find — never the page dump, which once made a 37KB DOM
        // the retrieval query for a five-word request.
        const base =
          [ctx.humanPrompt, ...intent.targets, ...ctx.named.literals]
            .join(" ")
            .trim() || ctx.humanPrompt;
        const anchored = anchoredQuery(base, ctx.priorTurns);
        const queryText = [
          anchored,
          ctx.featureContext
            ? "Pinned feature: " + ctx.featureContext.queryHint
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        // An explicit /context binding is stronger than the automatic
        // plain-language feature matcher and must not be re-locked elsewhere.
        if (!ctx.featureContext) await this.applyFeatureScope(ctx, base);
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
        const pinnedChunks = ctx.featureContext
          ? this.deps.featureContexts
              .retrievalChunks(ctx.featureContext.featureId, 6)
              .filter((chunk) => inScope(ctx.scope, chunk.path))
          : [];
        const seenChunks = new Set<number>();
        const candidateChunks = [...pinnedChunks, ...scoped].filter((chunk) => {
          if (seenChunks.has(chunk.id)) return false;
          seenChunks.add(chunk.id);
          return true;
        });
        // Anchors boost the ranking ONLY on a turn that names nothing of
        // its own. When the user does name a file, a route, or a component,
        // that is the subject — letting forty previously-touched files
        // compete with it is how a single wrong edit kept winning every
        // later turn's ranking for the rest of the session.
        const anchorTargets =
          ctx.scope.named.length === 0 && intent.targets.length === 0
            ? ctx.scope.anchors.slice(0, RANK_ANCHOR_TARGETS)
            : [];
        const ranked = rankCandidates({
          chunks: candidateChunks,
          targets: [
            ...intent.targets,
            ...ctx.scope.named,
            ...anchorTargets,
            ...(ctx.featureContext?.files.slice(0, 12) ?? []),
            ...raw.features.flatMap((feature) => feature.files).slice(0, 12),
          ],
          graph: this.deps.graph,
          db: this.deps.db,
          k: 12,
        });
        // The feature-owned chunks lead even when the current prompt is a
        // vague follow-up such as "debug it"; ordinary retrieval fills the
        // remainder with evidence specific to this turn.
        const pinnedIds = new Set(pinnedChunks.map((chunk) => chunk.id));
        const result = {
          ...raw,
          chunks: [
            ...pinnedChunks,
            ...ranked.filter((chunk) => !pinnedIds.has(chunk.id)),
          ].slice(0, 12),
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
      const skills = this.deps.skillLoader.load(ctx.humanPrompt);
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

      // The blast radius, computed HERE and handed over as context.
      //
      // It used to be a hook that refused the first write to every existing
      // source file until the model called impact_of_edit for that exact
      // path. That bought one graph query — a local SQLite walk, single-digit
      // milliseconds — at the price of a blocked tool call and a round-trip
      // PER FILE, and the model spent that budget discovering a fact the
      // server already knew. Worse, the block below was fed an empty radius
      // in the meantime, so the prompt said nothing about callers at all: the
      // turn paid the tax and got none of the information.
      //
      // Now the walk runs once over what this turn is actually about, and its
      // callers, flows, tests and past lessons ride into the prompt before
      // the model picks a target. impact_of_edit stays available for a
      // symbol- or line-precise question the map does not answer.
      const radius = this.investigationRadius(ctx, intent);

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
        const conversation = isOllamaModel(ctx.opts.model) ? "" : renderPriorTurns(ctx.priorTurns);
        // What earlier turns already READ, on top of what they said. This
        // is the block that lets "now also handle X" start from the three
        // files the last turn gathered instead of reading them again.
        const gathered = await this.recallWorkingMemory(
          ctx,
          intent.kind,
          new Set(retrieval.chunks.map((chunk) => chunk.path))
        );
        // Named, not joined: the provider gets the same bytes either way,
        // and the names are what the timeline's "sent to model" row shows
        // beside each block's size, so a heavy turn can be read at a glance.
        // Whether this conversation has been investigated yet. The recall
        // block is the evidence: if nothing came back, nobody has looked.
        const carriedWiki = this.renderWiki(ctx, intent.kind);
        // The answer the previous turn gave, quoted whole when this turn is
        // the "implement it" that follows a plan. A go-ahead block already
        // covers the bare approval; this covers the typo'd, wordy one.
        const handoff = planHandoffBlock(ctx, intent, handoffAnswer);
        const built = buildExecuteContext({
          inlinedPaths: gathered.inlinedPaths,
          pinnedFeature: ctx.featureContext
            ? this.deps.featureContexts.pinnedName(ctx.conversationId)
            : null,
          stance: ctx.stance,
          named: ctx.named,
          sections: [
          { name: "answer-only rules", text: answerOnly ? ANSWER_ONLY_RULES : "" },
          { name: "plan handoff", text: handoff },
          { name: "conversation", text: conversation },
          {
            name: "session feature",
            text: ctx.featureContext
              ? this.deps.featureContexts.render(
                  ctx.featureContext,
                  ctx.workingSet
                )
              : "",
          },
          { name: "feature wiki", text: carriedWiki },
          { name: "previously gathered", text: gathered.text },
          { name: "attachments", text: attachmentBlock(ctx) },
          { name: "go-ahead", text: handoff ? "" : goAheadBlock(ctx) },
          {
            name: "asked-about",
            text: followUpBlock(ctx.humanPrompt, ctx.priorTurns, intent),
          },
          { name: "recovery plan", text: ctx.recoveryPlan },
          { name: "skills", text: skills.context },
          { name: "knowledge context", text: context },
          ],
        });
        // Small talk gets no investigation rules; it looks nothing up.
        const appendContext = isTrivialChat(ctx.humanPrompt, ctx.images.length > 0)
          ? built.sections.filter(
              (section) => section.name !== "investigation rules"
            )
          : built.sections;
        // Seeded from the SAME fact the rule was written from: only refuse
        // to re-gather findings that actually reached the model. Seeding on
        // findings that were clipped away would refuse the turn the lookups
        // it has no carried answer for — a deadlock, not a saving.
        // …and not at all on a correction turn: the user just said the
        // last attempt looked in the wrong place, so re-looking is the
        // point, not the failure.
        if (built.carriedInvestigation && ctx.stance !== "correct") {
          this.deps.repeatCalls?.seedEarlier(ctx.taskId, {
            searches:
              this.deps.workingMemory?.searchesBefore(
                ctx.conversationId,
                ctx.taskId
              ) ?? [],
            inlinedPaths: gathered.inlinedPaths,
          });
        }
        // Whether this turn owes the user an EDIT, decided before the model
        // is called rather than after — the turn-ceiling path runs inside
        // streamSession, so by the time control returns here it has already
        // chosen how to wrap the session up. It needs to know this.
        //
        // Trivial chat is excluded outright: a greeting classifies as
        // `work` (it is imperative in form), and a reply that happens to
        // end "what would you like to do?" reads as an offer — so without
        // this guard, saying hello could cost a second full model turn.
        //
        // A turn that only TELLS Atelier something is excluded for the same
        // reason: it owes no edit, so requiring one only bought a gate that
        // could never close.
        // `answerOnly`, not the classifier it came from. Ask mode can make
        // a turn answer-only that the classifier read as work — "how create
        // contract works here?" carries a verb and an object and scans as a
        // request to build one — and arming the gate on such a turn is a
        // contradiction with only one way out. The gate exists to force an
        // edit; the answer-only guard refuses every edit tool; so the model
        // cannot satisfy it by working and can only satisfy it by emitting
        // the escape sentinel. That sentinel then IS the reply, and the
        // user gets "NO CHANGE NEEDED: …" where their answer should be.
        // A plan-only turn is not actionable either: it must not be
        // nudged to implement, and it owes no edit.
        const actionable =
          !answerOnly &&
          !this.deps.planTracker.isPlanOnly(ctx.taskId) &&
          !isTrivialChat(ctx.humanPrompt, ctx.images.length > 0) &&
          !looksInformational(ctx.humanPrompt);
        ctx.mustEdit = actionable;
        // An armed diagnose turn runs the completion gate too, even though it
        // is answer-only: its whole purpose is to refuse a confident verdict
        // the turn never reproduced.
        const debugArmed = this.deps.debugProtocol?.isArmed(ctx.taskId) === true;
        const guardCompletion =
          completionGateRequired({
            actionable,
            planMode: ctx.opts.planMode === true,
            model: ctx.opts.model,
          }) || (debugArmed && ctx.opts.planMode !== true);
        // Read at completion time, not when the query starts: edits and plan
        // updates happen inside the stream, and every provider hook must judge
        // the checklist as it exists when the model tries to finish. `report`
        // is the answer the model is trying to end with, so the jump-to-
        // conclusions block can read it.
        const gateOutstanding = (report?: string): string => {
          const debug = this.deps.debugProtocol?.status(ctx.taskId, report);
          const debugLines = debug?.lines ?? [];
          // A diagnose turn owes no plan and no edit — only, at most, the
          // reproduction behind a confident conclusion.
          if (!actionable) {
            if (debugLines.length === 0) return "";
            return (
              "The debugging gate is still open:\n" +
              debugLines.map((line) => `- ${line}`).join("\n")
            );
          }
          const base = completionGatePrompt(
            this.deps.planTracker.unfinishedSteps(ctx.taskId),
            touchesCode([...changedFiles]) &&
              !verificationObserved &&
              ctx.opts.autoValidate !== true,
            // This closure exists only on actionable change turns. Ollama
            // has no Claude turn-limit continuation counter, so delaying the
            // no-edit verdict until that counter moves lets a model check its
            // plan done and finish with 0 edits forever.
            //
            // `stateChanged` is the exception that had to exist: a turn whose
            // whole job was a git ref or a command changes no files and is
            // not "nothing implemented".
            changedFiles.size === 0 && !stateChanged,
            this.deps.planTracker.get(ctx.taskId) === undefined
          );
          // The debugging gate is independent of the plan checklist: a bug
          // turn can have every step checked off and still owe an observation
          // of the failure it claims to have fixed — or a confident conclusion
          // it never reproduced.
          if (debugLines.length === 0) return base;
          const debugBlock =
            "The observe-before-fix gate is still open:\n" +
            debugLines.map((line) => `- ${line}`).join("\n");
          return base ? `${base}\n\n${debugBlock}` : debugBlock;
        };
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
          // The gate REPORTS, it no longer retries. The retry loop re-ran
          // the model up to six times whenever a plan step was still open,
          // each round on a fresh ~450k-token session; the user watched a
          // spinner and then read that the task was incomplete. The model's
          // report now stands as written, with one line under it saying
          // what is still open — and the next message carries on, in the
          // same session, if the user wants it carried on.
          const outstanding = reportsNoChangeNeeded(result.text)
            ? ""
            : gateOutstanding(result.text);
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
        // The scale is refreshed after every edit; make sure the last
        // refresh has landed before it decides how much to run.
        const scale = await this.changeScaleOf(ctx.taskId);
        const { results, extraText } = await this.validateWithFixLoop(
          ctx,
          [...changedFiles],
          // A copy change cannot fail a test it did not touch; the
          // typecheck is the one validator that can still catch a broken
          // string, so it is the one that runs.
          scale === "copy" ? ["typecheck"] : undefined
        );
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

      assistantText = this.appendNotDelivered(ctx, assistantText);
      assistantText = this.appendTaskTokenReport(ctx, assistantText);

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
          gateStillOpen,
          this.deps.planTracker.notCoveredFor(ctx.taskId)
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
            // The user's words, not the page dump that rode with them.
            originalPrompt: ctx.humanPrompt,
            attachmentPaths: ctx.imagePaths,
            assistantText,
            changedFiles: [...changedFiles],
            validation,
            planGoal: this.deps.planTracker.get(ctx.taskId)?.goal ?? plan.goal,
            // Live statuses from the tracker reflect only model updates and
            // edit evidence; summary never manufactures completion.
            steps: ctx.record.steps,
            reviewVerdict,
            status: "completed",
            // A question, an ask-mode or a plan-mode turn: its answer is
            // the deliverable the next message says "implement" to.
            answerTurn: answerOnly || ctx.opts.planMode === true,
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
      forget();
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
  /**
   * Every task runs here. The flow itself lives in turn-runner.ts; this
   * method only owns what the executor has that the runner does not — the
   * transport to the providers, the token report, and the per-task state
   * the remaining hooks read.
   */
  private async runDirect(ctx: TaskContext): Promise<PipelineOutcome> {
    const changedFiles = ctx.record.changedFiles;
    // Guards that only made sense beside the knowledge stages stand down.
    this.deps.directTasks.mark(ctx.taskId);
    // A question turn answers; the MCP edit tools refuse it too (answer-only
    // hook), matching the native read-only mode set in streamSession.
    if (ctx.opts.turnMode === "ask") this.deps.planTracker.markAnswerOnly(ctx.taskId);
    const unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.topic === "tool.completed" && event.taskId === ctx.taskId) {
        const result = (event.payload as { result?: unknown }).result;
        this.deps.searchGrounding?.note(ctx.taskId,
          typeof result === "string" ? result : JSON.stringify(result ?? ""));
      }
      if (event.topic === "edit.applied" && event.taskId === ctx.taskId) {
        changedFiles.add((event.payload as { path: string }).path);
      }
    });
    try {
      // The user's own preTask hooks still run; nothing else stands between
      // the message and the model.
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
        const result = await this.turns.run(ctx, (c, prompt, context, images) =>
          this.streamSession(c, prompt, context, images, "execute", {})
        );
        return {
          value: result,
          detail: `${changedFiles.size} file(s) changed`,
        };
      });
      return {
        assistantText: this.appendTaskTokenReport(ctx, exec.text),
        sdkSessionId: ctx.sdkSessionId,
      };
    } finally {
      unsubscribe();
      this.deps.directTasks.release(ctx.taskId);
      this.deps.searchGrounding?.release(ctx.taskId);
      this.deps.repeatCalls?.release(ctx.taskId);
      this.deps.debugProtocol?.release(ctx.taskId);
      this.deps.namedTargets?.release(ctx.taskId);
      this.deps.previewBaselines?.release(ctx.taskId);
      this.changeScales.delete(ctx.taskId);
    }
  }

  /**
   * Claude's native tools — Read, Edit, MultiEdit, Write, Bash — are on the
   * surface: they are the tools the model is trained on, and driving the
   * MCP equivalents cost a simple task sixty calls. These two hooks are the
   * ONLY gates left, and they are the user's own: a shell command goes
   * through the same preTool hooks run_terminal does (git-flow
   * confirmation, DB/npm approval, dev-server), an edit through the same
   * as write_file, and both stay inside the workspace. PostToolUse feeds
   * the timeline and working memory, so native edits and reads are
   * remembered exactly like MCP ones.
   */
  private nativeToolHooks(
    ctx: TaskContext
  ): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const root = path.resolve(this.deps.config.workspaceRoot);
    const relative = (file: unknown): string | null => {
      if (typeof file !== "string" || !file) return null;
      const abs = path.resolve(root, file);
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      return rel.split(path.sep).join("/");
    };
    const deny = (reason: string): HookJSONOutput => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
    const pre = async (raw: HookInput): Promise<HookJSONOutput> => {
      const input = raw as PreToolUseHookInput;
      const args = (input.tool_input ?? {}) as Record<string, unknown>;
      if (input.tool_name === "Grep") {
        const decision = await this.deps.hooks.evaluateToolUse(
          "search_text", { query: args.pattern, regex: true }, ctx.taskId, ctx.abort.signal
        );
        return decision.allowed ? {} : deny(decision.reason ?? "Search needs an observed term");
      }
      if (input.tool_name === "Bash") {
        const command = typeof args.command === "string" ? args.command : "";
        try {
          assertCommandConfined(command, root);
        } catch (error) {
          return deny(error instanceof Error ? error.message : String(error));
        }
        const decision = await this.deps.hooks.evaluateToolUse(
          "run_terminal",
          { command },
          ctx.taskId,
          ctx.abort.signal
        );
        return decision.allowed ? {} : deny(decision.reason ?? "blocked by hook");
      }
      const target = args.file_path ?? args.notebook_path;
      const rel = relative(target);
      if (!rel) {
        return deny(`Edits stay inside the workspace: ${String(target ?? "?")}`);
      }
      const decision = await this.deps.hooks.evaluateToolUse(
        input.tool_name === "Write" ? "write_file" : "replace_code",
        { path: rel },
        ctx.taskId,
        ctx.abort.signal
      );
      return decision.allowed ? {} : deny(decision.reason ?? "blocked by hook");
    };
    const post = async (raw: HookInput): Promise<HookJSONOutput> => {
      const input = raw as PostToolUseHookInput;
      const args = (input.tool_input ?? {}) as Record<string, unknown>;
      try {
        this.deps.searchGrounding?.note(ctx.taskId,
          typeof input.tool_response === "string" ? input.tool_response : JSON.stringify(input.tool_response ?? ""));
        if (input.tool_name === "Read") {
          const rel = relative(args.file_path);
          const content = readToolContent(input.tool_response);
          if (rel && content !== null) {
            this.deps.workingMemory?.noteRead({
              conversationId: ctx.conversationId,
              taskId: ctx.taskId,
              path: rel,
              offset: finiteNumber(args.offset),
              limit: finiteNumber(args.limit),
              content,
            });
          }
        } else if (input.tool_name === "Bash") {
          const response = (input.tool_response ?? {}) as {
            stdout?: unknown;
            stderr?: unknown;
            interrupted?: unknown;
          };
          this.deps.workingMemory?.noteCommand({
            conversationId: ctx.conversationId,
            taskId: ctx.taskId,
            command: typeof args.command === "string" ? args.command : "",
            exitCode: null,
            output: [response.stdout, response.stderr]
              .filter((part): part is string => typeof part === "string")
              .join("\n"),
            timedOut: response.interrupted === true,
          });
        } else if (!["Grep", "Glob"].includes(input.tool_name)) {
          const rel = relative(args.file_path ?? args.notebook_path);
          if (rel) {
            this.deps.bus.publish(
              "edit.applied",
              { path: rel, diffId: `native:${input.tool_use_id}` },
              ctx.taskId
            );
          }
        }
      } catch (error) {
        this.deps.log.warn({ err: error }, "native tool hook failed");
      }
      return {};
    };
    return {
      PreToolUse: [
        {
          matcher: "Grep|Bash|Edit|MultiEdit|Write|NotebookEdit",
          hooks: [pre],
          // The DB/npm approval modal waits for the user; the default hook
          // timeout would auto-deny it after a minute.
          timeout: 3600,
        },
      ],
      PostToolUse: [
        { matcher: "Read|Grep|Glob|Edit|MultiEdit|Write|NotebookEdit|Bash", hooks: [post] },
      ],
    };
  }

  /**
   * Per-task diff scale, kept current from the edit stream. The guard that
   * refuses a build on a copy change reads it through `changeScaleOf`, and
   * awaits the refresh in flight so it never judges a stale diff.
   */
  private changeScales = new Map<
    string,
    { scale: ChangeScale | null; pending: Promise<void> }
  >();

  private refreshChangeScale(ctx: TaskContext): void {
    const entry = this.changeScales.get(ctx.taskId) ?? {
      scale: null,
      pending: Promise.resolve(),
    };
    entry.pending = entry.pending.then(async () => {
      const diffs: Array<{ path: string; diff: string }> = [];
      for (const file of [...ctx.record.changedFiles].slice(0, 12)) {
        try {
          const { diff } = await this.deps.git.diff(file);
          diffs.push({ path: file, diff: diff ?? "" });
        } catch {
          // An untracked or unreadable file: its size is unknown, and an
          // unknown change is code — classifyChange's default.
          diffs.push({ path: file, diff: "" });
        }
      }
      const scale = diffs.length > 0 ? classifyChange(diffs) : null;
      entry.scale = scale;
      ctx.changeScale = scale;
    });
    this.changeScales.set(ctx.taskId, entry);
  }

  /** The current diff scale of a task, after any refresh in flight. */
  async changeScaleOf(taskId: string): Promise<ChangeScale | null> {
    const entry = this.changeScales.get(taskId);
    if (!entry) return null;
    await entry.pending.catch(() => undefined);
    return entry.scale;
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
    // A copy-only diff (string literals, visible text) is read as inert
    // here: a reviewer asked to judge a label has nothing in its rubric to
    // judge and reaches for the repo around it instead.
    const deep = touchesCode([...changed]) && ctx.changeScale !== "copy";
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
    changedFiles: string[],
    /** Restrict to these validators (a copy change runs only the typecheck). */
    only?: ValidationKind[]
  ): Promise<{ results: ValidationResult[]; extraText: string }> {
    const detected = this.deps.validators.detect();
    const kinds = only ? detected.filter((kind) => only.includes(kind)) : detected;
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
      // The working set, not the raw anchors: anchors are every file any
      // earlier turn ever edited, wrong attempts included, and two of them
      // were enough to pull in a page about a different feature.
      const matched = store.match({
        terms: featureTerms(ctx.humanPrompt),
        namedFiles: [...ctx.scope.named, ...intent.targets],
        files: [...ctx.workingSet.slice(0, 8), ...retrievedPaths],
      });
      ctx.wiki = matched.map(({ page }) => ({ page, moved: store.moved(page) }));
      if (ctx.wiki.length === 0) return;
      // Why each page matched rides on the event: a page pulled in by
      // touched files alone is the signal to look for when the wrong page
      // steers a turn.
      const matchedBy = new Map(
        matched.map(({ page, matchedBy: by }) => [page.slug, by])
      );
      this.deps.bus.publish(
        "wiki.recalled",
        {
          pages: ctx.wiki.map(({ page, moved }) => ({
            slug: page.slug,
            title: page.title,
            status: moved.length > 0 ? "stale" : page.status,
            moved,
            matchedBy: matchedBy.get(page.slug),
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
    intentKind: string,
    excludePaths: Set<string>
  ): Promise<RecalledWorkingMemory> {
    const store = this.deps.workingMemory;
    if (!store) return EMPTY_RECALL;
    // Small talk looks nothing up and should not pay to carry old reads.
    if (isTrivialChat(ctx.humanPrompt, ctx.images.length > 0)) return EMPTY_RECALL;
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
      // Tasks the user stopped: what they read is listed, never inlined as
      // "the files you hold". Three stopped attempts in a row once filled
      // the inline slots with the wrong files and the rule then told the
      // next turn not to look anywhere else.
      const demoteTaskIds = new Set(
        this.deps.summaries
          .recent(ctx.conversationId, 8)
          .filter((summary) => summary.status && summary.status !== "completed")
          .map((summary) => summary.taskId)
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
        // Current retrieval already carries these files. Keep their earlier
        // read ranges as cheap path references instead of paying to inline
        // the same source again under "previously gathered".
        excludePaths,
        demoteTaskIds,
        // What the user named this turn rides in first, and the files that
        // earlier searches for the same string located ride in as content
        // rather than as a one-line "→ path" the model never opened.
        preferPaths: ctx.named.paths,
        literals: ctx.named.literals,
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
            demoted: gathered.demoted,
            located: gathered.located,
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
    return [renderPriorTurns(ctx.priorTurns), current].filter(Boolean).join("\n");
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
    if (ctx.record.summarized) return;
    // A stopped direct turn is remembered the way a finished one is: as a
    // STOPPED record, built locally, so the next turn knows the attempt was
    // rejected rather than meeting it as if it never happened.
    if (isDirectMode(ctx.opts)) {
      this.turns.saveSummary(ctx, ctx.collectedText, status);
      return;
    }
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
        intentSummary: record.intentSummary || clip(ctx.humanPrompt, 120),
        originalPrompt: ctx.humanPrompt,
        attachmentPaths: ctx.imagePaths,
        // What the model said before the stop is the only record of what
        // it found — a plan turn stopped after its answer still answered.
        assistantText: ctx.collectedText,
        changedFiles: [...record.changedFiles],
        validation: record.validation,
        planGoal: this.deps.planTracker.get(ctx.taskId)?.goal ?? record.planGoal,
        steps: record.steps,
        reviewVerdict: record.reviewVerdict,
        status,
        partialText: ctx.collectedText,
        answerTurn:
          record.intentKind === "question" || ctx.opts.planMode === true,
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
      completionGate?: (report?: string) => string;
      /**
       * Files whose exact current content already rides in the context
       * (previously gathered). Ollama's blind-edit guard accepts them as
       * read; other providers hold the same bytes and need no guard.
       */
      preGrounded?: string[];
    } = {}
  ): Promise<{ text: string }> {
    const resume = opts.resume ?? true;
    const direct = isDirectMode(ctx.opts);
    const toolNames = direct
      ? DIRECT_TOOLS.filter((name) => !opts.allowedTools || opts.allowedTools.includes(name))
      : opts.allowedTools;
    const sdkContext: SdkToolContext = {
      taskId: ctx.taskId,
      signal: ctx.abort.signal,
    };
    const mcpServer = createAtelierMcpServer(
      this.deps.tools,
      () => sdkContext,
      (imagePath) => this.deps.attachments.load(imagePath),
      toolNames
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
        ? effortFor(ctx.humanPrompt || prompt, hasImages, ctx.opts.effort)
        : ctx.opts.effort;
    if (effort !== ctx.opts.effort) {
      this.deps.log.info({ effort }, "trivial chat turn — effort lowered");
    }
    // FULL keeps the exact provider payload it had before. LIGHT clips each
    // locally available block and never asks a second model to summarize it.
    const fullLayout = await this.workspaceLayout();
    const layout = direct
      ? clipLightContext(fullLayout, LIGHT_LAYOUT_CHARS)
      : fullLayout;
    const fullUserRules = await this.userRules(ctx);
    const userRules = direct
      ? clipLightContext(fullUserRules, LIGHT_USER_RULE_CHARS)
      : fullUserRules;
    const rules = direct
      ? DIRECT_RULES + userRules
      : ATELIER_EXECUTOR_CONTRACT + FAST_RULES + userRules;
    // The scope store is part of the full pipeline. LIGHT remains confined by
    // ToolRegistry's active task scope and carries only the compact boundary.
    const scoped = direct ? "" : await this.scopeContext(ctx);
    const vibeRules = ctx.opts.vibe
      ? direct
        ? clipLightContext(VIBE_RULES, LIGHT_VIBE_CHARS)
        : VIBE_RULES
      : "";
    const appended = direct
      ? clipLightContext(contextText(appendContext), LIGHT_APPEND_CHARS)
      : contextText(appendContext);
    // The outer cap is a hard guarantee even if a future static rule grows.
    // FULL deliberately bypasses it and remains byte-for-byte on its old path.
    const providerContext = direct
      ? clipLightContext(
          layout + rules + vibeRules + scoped + appended,
          LIGHT_CONTEXT_MAX_CHARS
        )
      : layout + rules + vibeRules + scoped + appended;
    // The turn's vocabulary: what the user asked, what the page SHOWS, and
    // every block the model is about to be given. A search term outside
    // this and outside anything the tools return is one the model made up.
    // The page's markup and classes are deliberately not vocabulary: a
    // grounded `max-w-[180px]` once outranked the label the user named.
    this.deps.searchGrounding?.seed(ctx.taskId, [
      stripHiddenContext(prompt),
      ctx.previewText,
      providerContext,
    ]);
    // What is about to be sent, block by block, published BEFORE the call:
    // this is the row the timeline shows as "sent to model", and it has to
    // exist even for a call that never comes back.
    const requestSections: ContextSection[] = [
      { name: "workspace layout", text: layout },
      { name: "rules", text: rules },
      { name: "vibe rules", text: vibeRules },
      { name: "scope lock", text: scoped },
      ...(direct
        ? [{ name: "light carried context", text: appended }]
        : contextSections(appendContext)),
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
          toolNames,
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
        toolsOffered: undefined,
      });
      return {
        text: await runGrokAgentLoop({
          model: grokModelName(ctx.opts.model as string),
          system: providerContext,
          prompt,
          images,
          tools: this.deps.tools,
          files: this.deps.files,
          toolNames,
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
        toolNames,
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
    // Ask mode is read-only natively: the SDK's plan permission mode denies
    // every writing tool, so a question turn cannot edit on any surface.
    const planning =
      systemPlan || ctx.opts.planMode === true || ctx.opts.turnMode === "ask";

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
      toolsOffered: opts.allowedTools?.length === 0 ? 0 : undefined,
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
        hooks: this.nativeToolHooks(ctx),
        ...(sdkModel(ctx.opts.model)
          ? { model: sdkModel(ctx.opts.model) }
          : {}),
        ...(claudeEffort(effort) ? { effort: claudeEffort(effort) } : {}),
        // Omit the SDK ceiling for agent turns; completion or user Stop ends them.
        ...(!direct ? { maxTurns: opts.maxTurns ?? claudeTurnBudget(purpose) } : {}),
        disallowedTools: direct
          ? DISABLED_BUILTINS.filter((name) => !CLAUDE_NATIVE_TOOLS.some((native) => native === name))
          : DISABLED_BUILTINS,
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
                ...(opts.allowedTools ?? [
                  `mcp__${MCP_SERVER_NAME}__*`,
                  ...CLAUDE_NATIVE_TOOLS,
                ]),
                ...CLAUDE_FAST_BUILTINS,
              ],
        includePartialMessages: true,
        // Subagents the turn can delegate to — see ATELIER_AGENTS.
        agents: ATELIER_AGENTS as unknown as NonNullable<
          Parameters<typeof query>[0]["options"]
        >["agents"],
        // The project's CLAUDE.md (and .claude/ project settings) load the
        // way the CLI loads them: the project's own instructions are the
        // highest-leverage context there is, and Atelier was the one
        // surface that dropped them. User-level settings stay out so a
        // machine's personal hooks and permissions never steer a shared
        // workspace.
        settingSources: ["project"],
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
    // Silence is the one failure nothing else here can see: every other
    // bound needs a message to arrive. Watched from outside the loop,
    // because a stream that says nothing never runs the loop body.
    const stall = new StreamStallWatch(
      (detail) =>
        this.deps.bus.publish(
          "agent.status",
          { status: "working", detail },
          ctx.taskId
        ),
      () => ctx.abort.abort()
    );
    try {
      for await (const message of tolerateTurnLimit(stream, () => {
        turnLimitHit = true;
      })) {
        stall.beat();
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
    } finally {
      stall.stop();
    }
    if (stall.abandoned) {
      // The stream was cut, not finished. Say so where the report goes,
      // rather than returning whatever partial text had accumulated as if
      // the model had chosen to stop there.
      text = `${text}\n\n${stall.note()}`.trim();
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
   * round from a compact execution checkpoint.
   *
   * The ceiling exists to bound what one turn can spend, and it does its
   * job — but resuming the provider's complete native transcript on every
   * round makes each continuation repay every prior tool call. A fresh
   * session receives the same bounded evidence plus the live plan, changed
   * files, and exact outstanding work, preserving execution quality without
   * unbounded transcript growth.
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
      completionGate?: (report?: string) => string;
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
      // Nothing is appended: the answer and the edits stand on their own,
      // and the open gate (full mode) already says the work is unfinished.
      return "";
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
    const checkpoint = this.executionCheckpoint(ctx, prompt);
    const { text } = await this.streamSession(
      ctx,
      checkpoint,
      appendContext,
      undefined,
      purpose,
      {
        resume: false,
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
    return text ? `\n\n${text}` : "";
  }

  /** Compact live state for a fresh continuation request. */
  private executionCheckpoint(
    ctx: TaskContext,
    outstanding: string
  ): string {
    const plan = this.deps.planTracker.get(ctx.taskId);
    return renderExecutionCheckpoint({
      request: ctx.prompt,
      outstanding,
      goal: plan?.goal ?? ctx.record.planGoal,
      steps: (plan?.steps ?? ctx.record.steps).map((step) => ({
        title: step.title,
        status: step.status,
        files: step.files,
      })),
      changedFiles: [...ctx.record.changedFiles],
    });
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
   * The first plan-to-edit transition keeps the same session so its source
   * reads remain available. Repeated completion-gate retries switch to the
   * compact execution checkpoint so they do not repay a growing transcript.
   */
  private async nudgeToImplement(
    ctx: TaskContext,
    appendContext: AppendContext,
    prompt = PROCEED_PROMPT,
    opts: {
      gateRetry?: boolean;
      maxTurns?: number;
      completionGate?: (report?: string) => string;
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
    const checkpointed = opts.gateRetry === true;
    const continuationPrompt = checkpointed
      ? this.executionCheckpoint(ctx, prompt)
      : prompt;
    this.deps.log.warn(
      { taskId: ctx.taskId, checkpointed },
      checkpointed
        ? "turn ended with outstanding work; continuing from compact state"
        : "turn ended with outstanding work; continuing the same session"
    );
    const { text } = await this.streamSession(
      ctx,
      continuationPrompt,
      appendContext,
      undefined,
      "execute",
      {
        resume: !checkpointed,
        systemPlan: false,
        maxTurns: opts.maxTurns,
        completionGate: opts.completionGate,
      }
    );
    return text ? `\n\n${text}` : "";
  }

  /** Add real per-request usage after the task's last model call. */
  /**
   * The harness's own line under the report: what the plan declared it
   * would not deliver. The model wrote the report and may have glossed
   * over the narrowing; this line comes from the set_plan declaration, so
   * the user sees the gap in the same message as the claim.
   */
  private appendNotDelivered(ctx: TaskContext, text: string): string {
    const items = this.deps.planTracker.notCoveredFor(ctx.taskId);
    if (items.length === 0) return text;
    const block =
      "Not delivered this turn (declared at planning):\n" +
      items.map((item) => `- ${item}`).join("\n");
    return this.appendReportText(ctx, text, block);
  }

  private appendTaskTokenReport(ctx: TaskContext, text: string): string {
    const report = renderTaskTokenReport(this.deps.ledger.taskUsage(ctx.taskId));
    if (!report) return text;
    return this.appendReportText(ctx, text, report);
  }

  /** Streams a harness-written block onto the end of the answer. */
  private appendReportText(
    ctx: TaskContext,
    text: string,
    report: string
  ): string {
    const delta = `${text.trim() ? "\n\n" : ""}${report}`;
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
    return text + delta;
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
 * Recall budgets stay deliberately smaller than current retrieval. Earlier
 * turns are continuity hints; exact evidence can be demand-loaded again when
 * the compact block does not settle a needed detail.
 */
/** Most of an Ollama window the gathered block may take. */
const WORKING_MEMORY_WINDOW_SHARE = 0.15;

/**
 * Dynamic context ceiling for the first execute request. Static rules, the
 * workspace boundary, and the user's prompt sit outside this allowance.
 * Sections are packed by value so exact current evidence wins over older
 * summaries when the turn has more relevant context than the model needs.
 */
/**
 * Raised from 3000, because 3000 was set before a turn carried this much.
 *
 * A follow-up turn now ships four evidence blocks that have to coexist:
 * the gathered reads (~1.4k), the feature Flow (~750), session memory
 * (~320) and current retrieval (~1.1k). That is 3.6k of evidence against a
 * 3k budget, so one of them was always going to be zeroed — and the greedy
 * packer zeroed whichever sat last, silently.
 *
 * Paying ~1.2k more per turn is the cheap side of this trade by an order of
 * magnitude: the turn that went without its carried findings re-investigated
 * instead, and that cost five continuation rounds at ~6.3k each.
 */
const EXECUTE_CONTEXT_TOKENS = 4200;

/**
 * Room held back for the investigation rules, which are written AFTER the
 * rest is packed — see buildExecuteContext. They are short and they decide
 * how the model reads everything else, so they are never in the auction.
 */
const INVESTIGATION_RULES_RESERVE = 320;

/**
 * Packing order, and it is an order of DEPENDENCE, not of interest.
 *
 * "previously gathered" used to sit second-from-last, which on a normal
 * follow-up turn meant it got whatever survived the blocks above it —
 * observed live at TWO tokens, out of the 1447 the recall had produced.
 * The turn was then told, at the top of its own prompt, that the findings
 * it must not re-derive were in a block that had been clipped to nothing.
 * It re-investigated, the repeat guard refused the searches, and the turn
 * burned five identical continuation rounds getting nowhere.
 *
 * So the carried investigation now outranks current retrieval. Retrieval
 * can be re-derived from the index at any time; the gathered block is the
 * only record that earlier turns of THIS conversation ever read anything,
 * and it is what every no-re-investigation rule points at.
 */
const EXECUTE_CONTEXT_PRIORITY = [
  "answer-only rules",
  "recovery plan",
  // Small, and supplied by the USER rather than gathered on their behalf.
  // Cheap enough that ranking them first costs the blocks below almost
  // nothing, and losing one of them is never the right saving.
  "attachments",
  "go-ahead",
  "asked-about",
  // The plan the previous turn proposed, on the turn that implements it.
  // As user-supplied as a go-ahead: the user read it and said "do it".
  "plan handoff",
  // The map the USER pinned with /context, and the reason they pinned it:
  // every later turn is supposed to run against this feature rather than
  // rediscover it. It was last in this list, which meant the one block the
  // whole workflow depends on was the first one a busy turn dropped. It is
  // bounded by construction — 12 files, 12 symbols — so ranking it here
  // costs the blocks below it very little.
  "session feature",
  // The evidence the investigation rules depend on, before anything the
  // model could reconstruct for itself.
  "previously gathered",
  "feature wiki",
  "session memory",
  // Re-derivable from the index on demand, so it yields first when the
  // budget is tight — unlike the carried blocks, which exist nowhere else.
  "knowledge context",
  "skills",
] as const;

/**
 * Packs the turn's context, then writes the investigation rules to match
 * what SURVIVED the packing.
 *
 * The two have to be decided in this order. A rule that says "the findings
 * are above, do not gather them again" is only true if the findings are
 * still above after the budget has had its way with them — and when it is
 * false it is worse than absent, because the repeat guard is seeded from
 * the same belief and will refuse the model the very lookups it now has no
 * carried answer for. Rule, evidence, and guard are one decision here, so
 * they are made in one place from one fact: what actually shipped.
 */
export function buildExecuteContext(input: {
  sections: ContextSection[];
  inlinedPaths: string[];
  /** Name the user pinned with /context, if this conversation has one. */
  pinnedFeature?: string | null;
  /** How this turn relates to the last; `correct` softens the carried rule. */
  stance?: TurnStance;
  /** What the user named this turn, for the correction variant to point at. */
  named?: NamedTargets;
}): { sections: ContextSection[]; carriedInvestigation: boolean } {
  const packed = compactExecuteContext(
    input.sections,
    EXECUTE_CONTEXT_TOKENS - INVESTIGATION_RULES_RESERVE
  );
  const survived = (name: string): boolean =>
    (packed.find((section) => section.name === name)?.text ?? "").trim()
      .length > 0;
  const gathered = survived("previously gathered");
  const hasFlow = survived("feature wiki");
  // Only an anchor the model can actually see is an anchor.
  const pinned =
    input.pinnedFeature && survived("session feature")
      ? input.pinnedFeature
      : undefined;
  const carriedInvestigation = gathered || hasFlow || Boolean(pinned);
  const rules = investigationRules({
    first: !carriedInvestigation,
    // Only claim files the model can actually see the text of.
    inlined: gathered ? input.inlinedPaths : [],
    hasFlow,
    pinnedFeature: pinned,
    stance: input.stance,
    named: input.named,
  });
  return {
    sections: [{ name: "investigation rules", text: rules }, ...packed],
    carriedInvestigation,
  };
}

export function compactExecuteContext(
  sections: ContextSection[],
  budget = EXECUTE_CONTEXT_TOKENS
): ContextSection[] {
  const byName = new Map(sections.map((section) => [section.name, section]));
  const packed = new Map<string, string>();
  let remaining = budget;

  for (const name of EXECUTE_CONTEXT_PRIORITY) {
    const section = byName.get(name);
    if (!section?.text || remaining <= 0) continue;
    const text =
      approxTokens(section.text) <= remaining
        ? section.text
        : clipToTokens(section.text, remaining);
    if (!text) continue;
    packed.set(name, text);
    remaining -= approxTokens(text);
  }

  return sections
    .map((section) => ({ ...section, text: packed.get(section.name) ?? "" }))
    .filter((section) => section.text.length > 0);
}

/** Diff text handed to the wiki compiler; the page is a summary, not a patch. */
const WIKI_DIFF_CHARS = 14_000;

/** Cap for the feature-wiki block; a page is compact by construction. */
function wikiTokensFor(intentKind: string): number {
  if (intentKind === "question" || intentKind === "chat") return 400;
  if (intentKind === "command") return 300;
  return 700;
}

function workingMemoryTokensFor(intentKind: string): number {
  if (intentKind === "question" || intentKind === "chat") return 350;
  if (intentKind === "command") return 300;
  if (intentKind === "feature" || intentKind === "refactor") return 1000;
  return 800;
}


/**
 * What a chat turn actually carries.
 *
 * The test every clause has to pass is "does the turn come out different
 * without it?" — a rule that only describes good taste is prose the model
 * pays for on every cache miss and then averages away. This block was 5.4 KB
 * of it, and the turns it produced were measurably worse than the same task
 * run with system knowledge OFF, which carries a fifth of the text and none
 * of the ceremony. What survives is the enforced half plus the four
 * behaviours that stop a turn ending wrong:
 *
 * - REUSE FIRST / KNOWLEDGE GAPS, because assembled evidence should remove
 *   investigation rounds, while the live index fills only what is missing.
 * - PLAN, because a blocking completion hook reads the plan's steps.
 * - TARGETED EDITS / LAYOUT / MODULARITY, because those hooks DO block, and
 *   a model that was not told loops against them.
 * - AUTONOMOUS EXECUTION, because without it turns end by offering to work.
 * - WORKSPACE CONFINEMENT, because it is the one boundary with no hook.
 * - GIT FLOW and DATABASE, because those hooks stop and ask the user.
 * - REPORTING, because narration is most of the text on a slow turn.
 *
 * What went, and why it was not free: SIMPLEST FIX, GROUND BEFORE EDITING,
 * VERIFY BEFORE CLAIMING and the timeline contract's paragraph of procedure
 * were advice about how to think, competing for attention with the task and
 * with each other. The impact clause went with the hook it described — the
 * radius is computed server-side now and arrives as context, so there is
 * nothing for the model to do about it.
 *
 * A rule stated but not enforced, or enforced but not stated, is worse than
 * neither — so every clause naming a hook still has one standing behind it.
 *
 * Byte-stable — it rides in the static half of the prompt for caching.
 */
export const FAST_RULES =
  "REUSE PROVIDED EVIDENCE FIRST: start from FEATURE WIKI, PREVIOUSLY " +
  "GATHERED CONTEXT, TASK CONTEXT, and IMPACT RADIUS already in this " +
  "prompt. Inlined current source and verified flow descriptions count as " +
  "work already completed. Do not retrieve, search, list, or read again " +
  "for a fact or exact range they provide; this also satisfies a selected " +
  "skill's read/study step for that evidence. Use tools only for a concrete " +
  "missing detail, a source marked changed or stale, lines not included, " +
  "or post-edit verification.\n" +
  "KNOWLEDGE GAPS: when supplied evidence does not settle a needed detail, " +
  "call retrieve_knowledge / query_knowledge_graph / search_symbols before " +
  "falling back to search_workspace or reading files — the index is live " +
  "and current. Once you know the exact string or filename you want, use " +
  "your fastest text-search tool (Grep/Glob where available, else " +
  "search_text) and run several searches in ONE message rather than one " +
  "per turn. The DIRECTORY MAP above lists real paths and file names: read " +
  "from it instead of guessing a path or listing folders one by one.\n" +
  "PLAN: for a multi-step change, call set_plan once you know the shape of " +
  "the work, naming the files each step touches, and mark steps done as " +
  "their work completes — the plan rail shows the user your progress. It " +
  "never blocks an edit; a one-line fix needs no plan. Call set_plan again " +
  "with ONLY new steps to append; it cannot erase, reorder or complete " +
  "existing ones.\n" +
  "GROUNDED SEARCH: search for words the user used, a name from the " +
  "DIRECTORY MAP, or a string you have actually read. Do not invent an " +
  "identifier you expect this codebase to contain and then grep for it — on " +
  "a large repo that is a full scan that finds nothing. Start from the " +
  "thing the user named.\n" +
  "IMPACT RADIUS: when the prompt carries one, it already lists who calls " +
  "and imports your targets, which flows ride on them, and which tests " +
  "cover them — keep those aligned with your change instead of " +
  "rediscovering them. impact_of_edit answers a symbol- or line-precise " +
  "question the block does not.\n" +
  "TARGETED EDITS: use replace_code / replace_many for the lines that " +
  "change; keep write_file for new files and genuine rewrites — restating " +
  "a whole file to change three lines is how untouched lines get silently " +
  "dropped.\n" +
  "FLEX-FIRST UI LAYOUT: center and align UI " +
  "with a flex container (display: flex + align-items + justify-content, or " +
  "the framework's utility classes), not grid, absolute positioning, " +
  "transforms, or spacer margins. Keep a non-flex layout only where the " +
  "owning component makes flex unsuitable.\n" +
  "AUTONOMOUS EXECUTION: you are running unattended — nobody is there to " +
  "answer you mid-turn. Never end a turn by asking whether to proceed or " +
  "by offering to implement. Where something is genuinely ambiguous, " +
  "choose the most reasonable default, state it in one line as an " +
  "assumption, and build it.\n" +
  "WORKSPACE BOUNDARY: use workspace-relative paths for project work. " +
  "Installed skills are runtime instructions, not project files: read " +
  "their SKILL.md and any referenced resources from their registered " +
  "external paths without treating them as part of the workspace or its " +
  "project/folder lock. A path the user explicitly named outside the " +
  "workspace is likewise an authorized read-only reference: read it " +
  "directly without asking the user to widen the workspace. Do not search " +
  "other external locations, and do not create, modify, delete, or run " +
  "commands outside the workspace.\n" +
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
/**
 * The no-re-investigation rule, in the two forms a conversation needs.
 *
 * Atelier already carries the investigation forward — working memory, the
 * feature wiki's Flow, session memory — and each of those blocks asks the
 * model, politely and in passing, to reuse what it holds. Politely and in
 * passing loses to a model's reflex to go and look, so turn four re-greps
 * what turn one already established and pays full price for an answer it
 * was handed at the top of its own prompt.
 *
 * So it is stated once, first, and as a rule. The FIRST turn investigates
 * and owes an end-to-end flow for its trouble — the artifact that makes
 * every later turn's investigation unnecessary. Every turn after it reads
 * only what it is about to change. The rule is enforced, not advised: the
 * repeat guard is seeded with those earlier findings, so a rerun of one is
 * refused at the tool boundary with the answer attached.
 *
 * Rides per-turn, so the cached static prefix is untouched.
 */
export function investigationRules(input: {
  /** Nothing carried in: this turn is the one that gets to look around. */
  first: boolean;
  /** Files whose current bytes are already inlined in this turn's context. */
  inlined: string[];
  /** Whether a compiled feature Flow rode along. */
  hasFlow: boolean;
  /** Feature the user pinned with /context, when its map shipped this turn. */
  pinnedFeature?: string;
  /** `correct`: the last attempt was stopped or called wrong. */
  stance?: TurnStance;
  /** What the user named this turn. */
  named?: NamedTargets;
}): string {
  // A stopped or corrected attempt inverts the rule below. Everything the
  // carried blocks hold was gathered by a turn the user has just rejected:
  // it is a record of what was TRIED, and telling the next turn to "treat
  // it as the answer" is how the same wrong file was edited three turns in
  // a row. The target is re-derived from the user's own words, and the
  // one thing that stays refused is silently starting over.
  // (Only once something HAS been carried: a first turn that opens with
  // "wait, this is wrong" still owes the end-to-end flow below.)
  if (input.stance === "correct" && !input.first) {
    const named = input.named ? describeNamedTargets(input.named) : "";
    return (
      "THE LAST ATTEMPT WAS STOPPED OR CALLED WRONG — RE-ANCHOR BEFORE " +
      "YOU ACT.\n" +
      "The user stopped the previous attempt or says its result is wrong. " +
      "Everything carried below (files it read or edited, its plan, its " +
      "\"changed\"/\"touched\" lists) is evidence of what was TRIED, not of " +
      "what is right: do not resume it, and do not treat any file it " +
      "touched as the target because it was touched.\n" +
      "The target is what the user named" +
      (named ? `: ${named}. ` : " in the latest message. ") +
      "Look at exactly that FIRST — read_file the named file, search_text " +
      "the quoted text. Only then plan. Do not narrate what you take the " +
      "request to mean; if, having looked, the right place is elsewhere, " +
      "say so briefly in the final report.\n" +
      "Earlier searches and their hits are listed under PREVIOUSLY GATHERED " +
      "CONTEXT: use those results rather than re-running the searches. " +
      "Reading the files they point at IS allowed on this turn.\n" +
      VERIFICATION_SCALE_RULE
    );
  }
  // A pinned feature IS the end-to-end map, gathered on purpose by a
  // command the user ran for exactly this reason. A turn that has one is
  // never a first turn, whatever else did or did not survive packing.
  if (input.pinnedFeature) {
    return (
      `ANCHORED TO THE PINNED FEATURE "${input.pinnedFeature}".\n` +
      "The user ran /context for this feature, so its end-to-end map is " +
      "already in this prompt under SESSION FEATURE CONTEXT: the files, the " +
      "symbols, and the roles they play. That map is this conversation's " +
      "frame. Work inside it.\n" +
      "DO NOT RE-INVESTIGATE. Do not text-search to rediscover the shape of " +
      "this feature, do not re-derive its file list, and do not re-read a " +
      "file to confirm something the map already states. Re-running a " +
      "search an earlier turn already ran is REFUSED at the tool boundary.\n" +
      (input.inlined.length > 0
        ? "You already hold the CURRENT text of: " +
          `${input.inlined.slice(0, 12).join(", ")}` +
          (input.inlined.length > 12 ? ", …" : "") +
          ". Do not read these again.\n"
        : "") +
      "What you may still do: read the exact file you are about to edit at " +
      "the range you are about to change, follow ONE named hop the map " +
      "omits, and run verification. If the map is genuinely missing " +
      "something this turn needs, name it in one line, gather only that, " +
      "and say so — the user can run /context_update to fix the map " +
      "properly. Silently starting over is the failure this rule stops.\n" +
      VERIFICATION_SCALE_RULE
    );
  }
  if (input.first) {
    return (
      "INVESTIGATE ONCE — THIS IS THAT TURN.\n" +
      "Nothing has been gathered for this conversation yet, so this is the " +
      "only turn that may look around broadly. Spend it well, and finish " +
      "the investigation with an END-TO-END FLOW of the feature you were " +
      "asked about: every hop from the user-facing entry point to the data " +
      "and back — UI component, handler, route, service, store, schema — " +
      "each named as `path:line`. Include the hops you did NOT change.\n" +
      "State it in your report under a line beginning `FLOW:`. It is " +
      "compiled into the feature wiki and shipped to every later turn, " +
      "which is what lets them start from it instead of repeating this. " +
      "A flow with a hop you never traced is worse than a short one — say " +
      "`unverified` next to any step you inferred rather than read.\n" +
      VERIFICATION_SCALE_RULE
    );
  }
  const held =
    input.inlined.length > 0
      ? "You already hold the CURRENT text of: " +
        `${input.inlined.slice(0, 12).join(", ")}` +
        (input.inlined.length > 12 ? ", …" : "") +
        ". Do not read these again.\n"
      : "";
  return (
    "DO NOT RE-INVESTIGATE.\n" +
    "This conversation has already been investigated and the findings are " +
    "in this prompt: " +
    (input.hasFlow ? "the FEATURE WIKI Flow, " : "") +
    "PREVIOUSLY GATHERED CONTEXT, and session memory. Treat them as the " +
    "answer, not as a hint about where to look. Re-running a search an " +
    "earlier turn already ran is REFUSED at the tool boundary, and the " +
    "refusal will hand you back the result you already had.\n" +
    held +
    "What you may still do: read the exact file you are about to edit, at " +
    "the range you are about to change, and run verification. What you may " +
    "not do: re-derive the shape of the feature, re-grep for identifiers " +
    "the carried context already located, or re-read a file to confirm " +
    "something the flow already states.\n" +
    "If the carried flow is genuinely missing a hop this turn needs, name " +
    "the missing hop in one line, gather ONLY that hop, and continue. " +
    "Silently starting over is the failure this rule exists to stop.\n" +
    VERIFICATION_SCALE_RULE
  );
}

/**
 * Rides with every variant above. A one-line label change once got nine
 * test rewrites, eleven test runs and a production build — none of which
 * can tell a right label from a wrong one. Stated once, and enforced at
 * the tool boundary for copy-only diffs by the change-scale guard.
 */
const VERIFICATION_SCALE_RULE =
  "VERIFICATION SCALES WITH THE CHANGE. A copy/label/string change is " +
  "verified by the typecheck plus ONE existing test that covers the file, " +
  "or a preview_test asserting the NEW text — never a new test file, never " +
  "a build. A preview assertion on text that was already on the page " +
  "before your edit verifies nothing. Reserve suites and builds for changes " +
  "that move logic.\n";

export const ANSWER_ONLY_RULES =
  "THIS TURN IS A QUESTION — ANSWER IT, DO NOT IMPLEMENT.\n" +
  "The user asked to be told something, not to have something changed. " +
  "Read whatever you need to answer accurately, then reply in prose. Do " +
  "NOT call set_plan and do NOT open an execution timeline: there is no " +
  "work to check off, and a checklist here is noise over the answer. Do " +
  "NOT edit, create, move, or delete any file, and do not run commands " +
  "that change state.\n" +
  "READ-ONLY COMMANDS ARE ALLOWED AND OFTEN THE FASTEST ANSWER. " +
  "`git show`, `git log`, `git diff`, `git status`, and the like change " +
  "nothing and are not covered by the sentence above. When the question " +
  "is about history, a branch, or what is actually committed, run the one " +
  "command that settles it instead of inferring the answer from the " +
  "working tree — grepping files cannot tell you what a commit contains, " +
  "and repeating the grep will not make it. Never end a turn saying you " +
  "could have run a read-only check: run it.\n" +
  "The AUTONOMOUS EXECUTION and TIMELINE EXECUTION " +
  "clauses above are suspended for this turn — ending without a change is " +
  "the correct outcome here, not a turn that stopped short.\n" +
  "If the honest answer is that something is wrong or unfinished, say " +
  "exactly what and where (file and line), say what the fix would be, and " +
  "stop. The user's next message decides whether to make it.\n" +
  "If the question is about work you reported earlier, verify against the " +
  "live code before answering — read the file as it is now rather than " +
  "describing what you remember writing.\n";

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
  "MODULARITY RULE: ONE file = ONE " +
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
  /^(ok(ay)?|yes|yep|yeah|sure|do it|just do it|go|go on|go ahead|go for it|fix it|fix that|proceed|continue|implement(?: it| this| that| the plan)?|apply it|make it so|please do|do that|sounds good|lgtm)\b[\s.!,]*$/i;

/**
 * An approval that keeps talking: "implement, i'm expecting the fixed
 * version", "go ahead and do the plan". The opener is the approval; the
 * rest is commentary. Bounded in length so a genuinely new request that
 * happens to start with "implement" is not read as one.
 */
const GO_AHEAD_OPENER =
  /^(?:ok(?:ay)?[,.]?\s+)?(?:yes[,.]?\s+)?(?:please\s+)?(?:implement|go ahead|proceed|do it|make it so)\b/i;
const GO_AHEAD_MAX_WORDS = 14;

/**
 * `answer` is the previous assistant turn: an opener-only approval
 * ("implement the login page") is a go-ahead only when it is about that
 * answer — shares a subject word with it — or names no subject at all.
 */
export function isGoAhead(human: string, answer = ""): boolean {
  const text = human.trim();
  if (GO_AHEAD.test(text)) return true;
  const words = text.match(/\S+/g)?.length ?? 0;
  if (!GO_AHEAD_OPENER.test(text) || words > GO_AHEAD_MAX_WORDS) return false;
  return !answer || sharesSubject(text, answer);
}

const SUBJECT_STOPWORDS = new Set([
  "implement", "please", "that", "this", "with", "from", "then", "also", "just",
  "what", "your", "plan", "version", "fixed", "expecting", "expect", "said",
  "clear", "because", "have", "already", "now", "again", "same", "into",
]);

/** Whether a message and an earlier answer name at least one thing in common. */
export function sharesSubject(human: string, answer: string): boolean {
  const words = new Set(
    (human.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []).filter(
      (word) => !SUBJECT_STOPWORDS.has(word)
    )
  );
  if (words.size === 0) return true;
  const haystack = answer.toLowerCase();
  for (const word of words) {
    if (haystack.includes(word)) return true;
  }
  return false;
}

/** How much of the approved message to quote back. */
const GO_AHEAD_CHARS = 2_000;

/**
 * A question that points AT the previous answer rather than opening a new
 * subject: "what do you mean by this?", "explain that", "why did you say
 * the residual is harmless?", "sample scenario?".
 *
 * Demonstratives alone are the test, deliberately loose, because the
 * block they gate is only ever added to a turn already classified as a
 * question — a change request never reaches it.
 */
const BACK_REFERENCE =
  /\b(this|that|these|those|it|its|it'?s|above|there|your\s+(?:last|previous|earlier)\s+\w+|you\s+(?:said|mean|meant|wrote|claimed|mentioned|reported|found|did))\b/i;

/** How much of the referenced answer to quote back. */
const ASKED_ABOUT_CHARS = 4_000;

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
  const lastAnswer = [...ctx.priorTurns]
    .reverse()
    .find((turn) => turn.role === "assistant" && turn.text.trim());
  if (!lastAnswer) return "";
  if (!isGoAhead(ctx.humanPrompt, lastAnswer.text)) return "";
  const text = lastAnswer.text.trim();
  const quoted =
    text.length <= GO_AHEAD_CHARS ? text : `…${text.slice(-GO_AHEAD_CHARS)}`;
  return (
    "THIS TURN IS A GO-AHEAD\n" +
    `The user replied "${clip(ctx.humanPrompt.trim(), 200)}" — they are approving what you ` +
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
 * The previous turn's answer, when THIS turn is the one that implements it.
 *
 * A plan turn answered with the two right lines; the next message was a
 * wordy, typo'd "Implmenet and i am expecting the ixed version…" — not a
 * bare go-ahead, so nothing quoted the plan back, and session memory had
 * clipped its middle. The implement turn built the wrong thing from the
 * surviving tail. The signal is structural, not lexical: the last task
 * was an ANSWER (question, ask mode, plan mode) and this one is work.
 */
function handoffAnswerFor(
  ctx: TaskContext,
  intent: Intent,
  previous: { kind?: "answer" | "change"; status?: string } | null
): string {
  if (intent.kind !== "work") return "";
  if (!previous || previous.kind !== "answer") return "";
  if (ctx.opts.turnMode === "ask") return "";
  const last = [...ctx.priorTurns]
    .reverse()
    .find((turn) => turn.role === "assistant" && turn.text.trim());
  const answer = last?.text.trim() ?? "";
  if (!answer) return "";
  // Only an answer that PROPOSED something is a plan: it names files or
  // lays out steps. A one-line factual reply is not handed off.
  const proposes =
    extractRefs(answer, 1).length > 0 || /^\s*(?:[-*]|\d+[.)])\s+\S/m.test(answer);
  if (!proposes) return "";
  // …and only when this message is about it: a go-ahead (spelled however
  // — "Implmenet and i am expecting the ixed version" is one), a
  // correction, or a request that shares its subject. "add a footer" after
  // a plan for the login page is a new request, not its implementation.
  if (
    !isGoAhead(ctx.humanPrompt, answer) &&
    !hasApprovalVerb(ctx.humanPrompt) &&
    ctx.stance !== "correct" &&
    !sharesSubject(ctx.humanPrompt, answer)
  ) {
    return "";
  }
  return answer;
}

const APPROVAL_VERBS = ["implement", "proceed", "continue", "go ahead", "do it"];

/**
 * An approval verb anywhere in the message, misspellings included: the
 * hand-off that failed in the field was lost to "Implmenet". Words of 6+
 * letters match within an edit distance of 2 (3 for 10+).
 */
export function hasApprovalVerb(human: string): boolean {
  const lower = human.toLowerCase();
  if (/\b(?:go ahead|do it)\b/.test(lower)) return true;
  const words = lower.match(/[a-z]{5,}/g) ?? [];
  return words.some((word) =>
    APPROVAL_VERBS.some(
      (verb) =>
        !verb.includes(" ") &&
        editDistance(word, verb) <= (verb.length >= 10 ? 3 : 2)
    )
  );
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = temp;
    }
  }
  return prev[b.length]!;
}

/** How much of the handed-off answer to quote. */
const HANDOFF_CHARS = 4_000;

function planHandoffBlock(
  ctx: TaskContext,
  intent: Intent,
  answer: string
): string {
  if (!answer) return "";
  const correction = ctx.stance === "correct";
  return (
    "THE PLAN YOU PROPOSED LAST TURN\n" +
    (correction
      ? "The user's message is a CORRECTION to it — read their words for " +
        "what to change; the parts they did not object to stand.\n"
      : "The user's message is the go-ahead for it. Start from the files " +
        "and lines it names; do not re-derive the target, and do not " +
        "substitute a different improvement.\n") +
    "--- your previous answer ---\n" +
    `${quoteEnds(answer, HANDOFF_CHARS)}\n` +
    "--- end ---\n" +
    (intent.targets.length > 0
      ? `Files it names: ${intent.targets.join(", ")}.\n`
      : "")
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
  const focused = focusedLiterals(ctx.prompt);
  return (
    "IMAGES IN THIS CONVERSATION\n" +
    `${lines.join("\n")}\n` +
    (shown
      ? "The image(s) above are attached to this message and you can see " +
        "them already.\n" +
        SCREENSHOT_SUBJECT_NOTE +
        (focused.length > 0
          ? "The user highlighted region(s) of the screenshot; the text " +
            "inside them is: " +
            focused.map((text) => `"${text}"`).join(", ") +
            ". That text is the subject. search_text for it before " +
            "anything else.\n"
          : "")
      : "These were attached on an earlier turn and are NOT in front of " +
        "you. If this request refers to what was shown — 'the image', " +
        "'the screenshot', 'the error above' — call view_image on the " +
        "path and look, rather than answering from an earlier " +
        "description of it.\n")
  );
}

/**
 * Rides with every screenshot, on every provider. Only the Claude path
 * used to carry the annotation note, inside the image message itself;
 * Codex and Ollama got the picture with no word about how to read it and
 * grounded "this" on the page dump instead.
 */
const SCREENSHOT_SUBJECT_NOTE =
  "The screenshot and the user's words define the SUBJECT of this request. " +
  "The hidden page-preview block is supporting evidence: use its quoted " +
  "labels to locate code, never its selectors, classes or console URLs. " +
  "When the request says 'this', 'here' or 'the label' beside a picture, " +
  "search_text the exact on-screen text it points at before planning — " +
  "do not narrate what you take it to mean. If any image " +
  "carries a drawn box, arrow or circle, the marked part IS the subject.\n";

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
  gateStillOpen = false,
  notDelivered: string[] = []
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
  // Carried into the next turn's memory: what this one left undone is
  // the first thing a "continue" should pick up, not something it has to
  // rediscover from the user's complaint.
  if (notDelivered.length > 0) {
    parts.push(`NOT DELIVERED: ${notDelivered.slice(0, 6).join("; ")}`);
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

/** A working-set entry that is a file, not a folder anchor. */
function isFilePath(value: string): boolean {
  return /\.[a-z0-9]{1,6}$/i.test(value);
}

/** A radius with nothing in it — for light tasks or unknown targets. */
/** What retrieval returns on a turn that never needed a code lookup. */
function emptyRetrieval(): RetrievalResult {
  return { strategy: "skipped", chunks: [], graphNodes: [], features: [] };
}

export function investigationTargets(
  currentTargets: string[],
  scopedTargets: string[],
  retrievedFiles: string[]
): string[] {
  const currentFiles = currentTargets.filter(isFilePath);
  const scopedFiles = scopedTargets.filter(isFilePath);
  const entryPoints =
    currentFiles.length > 0
      ? currentFiles
      : scopedFiles.length > 0
        ? scopedFiles
        : retrievedFiles;
  return [...new Set(entryPoints.filter(isFilePath))].slice(0, IMPACT_TARGETS);
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
  return steps.map((step) => {
    const extra = step as { note?: string; verification?: string };
    return {
      title: step.title,
      detail: step.detail,
      files: step.files,
      status: step.status,
      ...(extra.note ? { note: extra.note } : {}),
      ...(extra.verification ? { verification: extra.verification } : {}),
    };
  });
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
  return clipKeepingRefs(text, maxChars);
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
/**
 * The composer's trailer on a screenshot send — "Screenshot context:\n-
 * Current page preview URL: …" — is machine text that older renderers put
 * OUTSIDE the hidden markers. It is not the user's words either.
 */
const SCREENSHOT_TRAILER =
  /\n*Screenshot context:\n(?:- [^\n]*\n?)+/g;

function humanText(visible: string): string {
  return visible.replace(SCREENSHOT_TRAILER, "\n").trim();
}

/** A shell command that verifies code: tests, a typecheck, a linter. */
const VERIFYING_COMMAND =
  /\b(?:vitest|jest|mocha|ava|pytest|phpunit|rspec|go test|cargo test|dotnet test|tsc\b|typecheck|type-check|eslint|lint|npm test|pnpm test|yarn test|bun test|npm run test|pnpm run test)\b/i;

function commandOf(input: unknown): string {
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" ? command : "";
}

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
  /^(?:please\s+)?(?:explain|describe|summari[sz]e|compare|analy[sz]e|review|audit|investigate|explore|walk\s+me\s+through|tell\s+me|show\s+me|help\s+me\s+understand|look\s+(?:at|into)|find|locate|list|trace|check|inspect|answer|confirm|clarify|what'?s|where'?s|which)\b/i;

const CHANGE_REQUEST_OPENERS =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+(?:you|we)\s+)?(?:fix|add|implement|refactor|build|create|update|remove|delete|change|rename|move|center|align|style|design|redesign|make|put|set|use|replace|adjust|convert)\b/i;

const PASSIVE_CHANGE_REQUEST =
  /^(?:can|could|would|should)\s+(?:the|this|that|these|those|my|our)\b.{0,80}\bbe\s+(?:fixed|added|implemented|updated|removed|deleted|changed|renamed|moved|centered|aligned|styled|designed|redesigned|made|put|set|replaced|adjusted|converted)\b/i;

/**
 * "Find" normally asks for information, but "find a way to support X" is
 * a request to make X possible. This exact distinction matters because the
 * answer-only hook enforces the classifier at the edit boundary: reading the
 * latter as a question makes autonomous implementation physically impossible.
 * The optional `o` preserves the real-world "supprt" spelling from the
 * regression without turning ordinary "find the file" prompts into work.
 */
const FIND_IMPLEMENTATION_REQUEST =
  /^(?:please\s+)?find\s+(?:a\s+)?(?:way|solution|approach)\s+to\s+(?:supp(?:o)?rt|implement|build|create|add|fix|enable|integrate|make)\b/i;

/**
 * An imperative change may follow a question or an analysis clause:
 * "is there a better layout? redesign it" and "review this, then fix it"
 * still owe the user an implementation. Keep the boundary requirement so
 * explanatory questions such as "how should I fix it?" remain read-only.
 */
const EXPLICIT_CHANGE_CLAUSE =
  /(?:^|[.!?]\s+|[,;:]\s*|\b(?:and|then|also|after\s+that)\s+)(?:please\s+)?(?:go\s+ahead\s+(?:and\s+)?|do\s+(?:anything|something|whatever)(?:\s+you\s+need)?\s+to\s+)?(?:fix|add|implement|refactor|build|create|update|remove|delete|change|rename|move|center|align|style|design|redesign|make|put|set|use|replace|adjust|convert)\b/i;

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

/**
 * Conversational filler a follow-up opens with: "so its the same?",
 * "ok and this one?". It carries no intent, but it does hide the word the
 * openers below are anchored on, so it comes off before they are tested.
 */
const LEADING_FILLER = /^(?:so|ok(?:ay)?|and|but|well|hmm+|wait|also)\b[\s,]*/i;

/**
 * A change verb ANYWHERE, not just at the front — the guard on the short
 * trailing-"?" rule below. "the login is broken, can you center it?" opens
 * with none of the change openers, and only this keeps it work.
 */
const CHANGE_VERB_ANYWHERE =
  /\b(fix|add|implement|refactor|build|create|update|remove|delete|change|rename|move|center|align|style|design|redesign|replace|adjust|convert)\b/i;

/** Longest trailing-"?" prompt still read as a bare question. */
const SHORT_QUESTION_WORDS = 12;

/**
 * Opens by REPORTING something — a fact, a result, a correction — rather
 * than asking for anything: "i will prove you wrong …", "that was the dev",
 * "here's what the API returns", "fyi the token already expired".
 */
const STATEMENT_OPENERS =
  /^(?:i(?:'m| am|'ll)\s|i\s(?:will|just|already|think|thought|tried|ran|did|was|have|see|saw|found|got|meant)\b|that(?:'s|s|\swas|\sis|\swere)\b|this\s(?:was|is)\b|it\s(?:was|is|works|worked|returns|returned|failed)\b|here(?:'s|\sis|\sare)\b|fyi\b|note:|see\s(?:this|the|below)\b|look\sat\s(?:this|the)\b)/i;

/**
 * A turn that hands Atelier information and asks for nothing to move.
 *
 * Such a turn is neither a question (no question mark, no interrogative
 * opener) nor trivial chat, so it used to classify as `work` — which made
 * it owe an edit it was never going to produce, and the completion gate
 * then held it open for the whole stall budget. It stays fully tool-capable
 * on purpose: unlike a question it is not marked answer-only, so if the
 * information genuinely does imply an obvious change the model may still
 * make one. What it no longer does is REQUIRE one.
 *
 * Any change verb anywhere in the prompt disqualifies it — "i just tried it
 * and the login is broken, fix the redirect" is work, whatever it opens on.
 */
export function looksInformational(prompt: string): boolean {
  const trimmed = prompt.trim().replace(LEADING_FILLER, "");
  if (
    CHANGE_REQUEST_OPENERS.test(trimmed) ||
    PASSIVE_CHANGE_REQUEST.test(trimmed) ||
    CHANGE_VERB_ANYWHERE.test(trimmed)
  ) {
    return false;
  }
  return STATEMENT_OPENERS.test(trimmed);
}

/**
 * "plan" as a THING to build ("create a plan page") is a change request;
 * only a bare plan, or one qualified as a plan, is a request for one.
 */
const PLAN_AS_ARTIFACT =
  /\bplan\s+(?:page|screen|component|view|form|card|table|model|entity|schema|type|route|endpoint|module|class|object|record|tier|feature|picker|selector|editor|builder)s?\b/i;

const PLAN_REQUEST =
  /\b(?:create|make|write|draft|prepare|propose|produce|give|build|come\s+up\s+with)\s+(?:me\s+)?(?:a|an|the)?\s*(?:\w+\s+){0,3}?plan\b/i;

const PLAN_QUALIFIER =
  /\bplan\s+(?:only|first)\b|\bplanning[- ]only\b|\b(?:do\s+not|don'?t|without|no)\s+(?:implement|code|coding|change|modify|edit|touch)/i;

/**
 * A turn that asks for a PLAN — to study something and say how it would be
 * done — and not for the change itself.
 *
 * The turn this exists for: "Understand and study this and create a plan
 * …", six study steps, zero edits by design. It classified as work, so the
 * plan owed a step per request bullet and every step owed an edit; the
 * study finished with the timeline wedged and nothing checked. A plan-only
 * turn keeps every tool — the model may still edit if asked to in the same
 * breath — it only stops OWING a change.
 */
export function asksForPlanOnly(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (PLAN_QUALIFIER.test(text)) return true;
  if (PLAN_AS_ARTIFACT.test(text)) return false;
  const match = PLAN_REQUEST.exec(text);
  if (!match) return false;
  // "create a plan and implement it" asks for both; the change wins.
  const after = text.slice(match.index + match[0].length);
  return !/\b(?:and|then)\s+(?:implement|apply|execute|build|do)\b/i.test(after);
}

function looksLikeQuestion(prompt: string): boolean {
  const trimmed = prompt.trim().replace(LEADING_FILLER, "");
  // A question mark is punctuation, not intent. Polite requests such as
  // "can you center the login?" still owe the user a workspace change.
  if (
    CHANGE_REQUEST_OPENERS.test(trimmed) ||
    PASSIVE_CHANGE_REQUEST.test(trimmed) ||
    FIND_IMPLEMENTATION_REQUEST.test(trimmed) ||
    EXPLICIT_CHANGE_CLAUSE.test(trimmed)
  ) {
    return false;
  }
  if (
    /^(what|where|when|why|how|who|is|are|can|could|should|does|do|did|was|were)\b/i.test(
      trimmed
    ) ||
    EXPLAIN_OPENERS.test(trimmed)
  ) {
    return true;
  }
  // The tail the openers miss: a SHORT prompt that ends in a question mark
  // and asks for nothing to move. "so its the same?" opens on none of the
  // words above, and classifying it as work made a two-word confirmation
  // owe an edit — the completion gate then held the turn open until the
  // continuation budget was spent.
  const words = trimmed.match(/\S+/g)?.length ?? 0;
  return (
    trimmed.endsWith("?") &&
    words <= SHORT_QUESTION_WORDS &&
    !CHANGE_VERB_ANYWHERE.test(trimmed)
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Puts the previous answer back in front of a question ABOUT it.
 *
 * Every Atelier turn runs in a fresh provider session by design, so the
 * only trace of the last answer is the recall block — which budgets all
 * prior turns into a few hundred tokens and clips each from the middle.
 * Ask "what do you mean by this?" about a long report and the model
 * receives a fifth of its own words with the substance cut out; it then
 * does the responsible thing and re-derives the answer by searching the
 * repo again. The user sees the app forget what it said a minute ago and
 * ends up pasting the report back in by hand.
 *
 * So this quotes the referenced message whole (or its two ends), and ONLY
 * here: a question, carrying a back-reference, with a previous answer to
 * carry. Anything else — new work, a fresh subject, a go-ahead — keeps
 * the ordinary flow and pays nothing.
 */
export function followUpBlock(
  prompt: string,
  priorTurns: TaskContext["priorTurns"],
  intent: Intent
): string {
  if (intent.kind !== "question") return "";
  const asked = prompt.trim();
  // A go-ahead already gets its own, differently-worded block.
  if (GO_AHEAD.test(asked) || !BACK_REFERENCE.test(asked)) return "";
  const previous = [...priorTurns]
    .reverse()
    .find((turn) => turn.role === "assistant" && turn.text.trim());
  if (!previous) return "";

  return (
    "THE USER IS ASKING ABOUT YOUR PREVIOUS ANSWER\n" +
    "This turn is a follow-up question about what you said last, quoted " +
    "below in full. It is your own message: treat its claims as yours to " +
    "explain, not as something to re-verify from scratch. Answer from it " +
    "first — expand it, give the example asked for, say plainly if it was " +
    "wrong — and read or search only for what the quote genuinely does " +
    "not settle.\n" +
    "--- your previous message ---\n" +
    `${quoteEnds(previous.text.trim(), ASKED_ABOUT_CHARS)}\n` +
    "--- end ---\n"
  );
}

/**
 * The whole text when it fits, otherwise its head and tail. The head
 * carries what the report was about and the tail the caveats and open
 * questions — which is what a follow-up almost always points at.
 */
function quoteEnds(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n… [middle omitted] …\n";
  const room = max - marker.length;
  const head = Math.floor(room * 0.35);
  return `${text.slice(0, head)}${marker}${text.slice(-(room - head))}`;
}
