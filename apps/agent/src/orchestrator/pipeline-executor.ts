import {
  query,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import { newId } from "@atelier/shared";
import type {
  ContextPurpose,
  ImageAttachment,
  ImpactRadius,
  Plan,
  PipelineStage,
  RetrievalResult,
  ValidationKind,
  ValidationResult,
} from "@atelier/protocol";
import type { AgentConfig } from "../config/agent-config.js";
import type { Db } from "../storage/db.js";
import type { EventBus } from "../events/event-bus.js";
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
  isOllamaModel,
  ollamaModelName,
  ollamaTargetOf,
  sdkModel,
} from "../providers/model-routing.js";
import { runOllamaAgentLoop } from "../providers/ollama/agent-loop.js";
import { runCodexExec } from "../providers/codex/client.js";
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
  type SessionScope,
  type SessionScopeStore,
} from "../workspace/scope/index.js";
import type { WorkspaceIgnore } from "../workspace/ignore.js";
import type { GitService } from "../git/git-service.js";
import type { ScopeGuard } from "../tools/scope-guard.js";
import { touchesCode } from "./change-scale/index.js";
import type { SkillLoader } from "./skill-loader.js";

/** Built-in SDK tools stay disabled: everything flows through Atelier. */
const DISABLED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
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

/** Small, fast model for the structured understand/plan calls. */
const STAGE_MODEL = "claude-haiku-4-5";

/**
 * Body of the plan-mode system reminder for the INTERNAL plan pass. The CLI
 * wraps this with its own read-only preamble and ExitPlanMode protocol
 * footer, so it only has to say what a good Atelier plan looks like. The
 * scope rules mirror the stage-4 planner's — a plan that widens the job is
 * the failure mode either way.
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

/** Intent kinds that skip heavyweight planning and validation. */
const LIGHT_KINDS = new Set(["question", "chat", "command"]);

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
  retriever: RetrieverLike;
  graph: SymbolGraph;
  clones: CloneScanner;
  impact: ImpactAnalyzer;
  indexer: IncrementalIndexer;
  hooks: HooksEngine;
  /** Tasks running with system knowledge off, for the code guards to skip. */
  directTasks: DirectTaskRegistry;
  validators: ValidationRunners;
  planTracker: PlanTracker;
  settings: SettingsRepo;
  usage: UsageMonitor;
  ledger: TokenLedger;
  assembler: PromptAssembler;
  summaries: TaskSummaryStore;
  sharedSessions: SharedSessionContextBuilder;
  codexTools: CodexToolBridge;
  skillLoader: SkillLoader;
  /** Per-conversation working-set lock, seeded by "@folder" mentions. */
  scope: SessionScopeStore;
  /** Shared ignore rules, so the scoped directory map skips build output. */
  ignore: WorkspaceIgnore;
  /** Routes git at the checkout the scope points to. */
  git: GitService;
  /** Enforces the lock at the tool boundary, where prose cannot. */
  scopeGuard: ScopeGuard;
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
    summarized: false,
  };
}

export interface TaskContext {
  taskId: string;
  conversationId: string;
  prompt: string;
  /** Prior conversation turns (oldest→newest), including assistant answers. */
  priorTurns: Array<{
    role: "user" | "assistant";
    text: string;
  }>;
  messageId: string;
  opts: TaskOptions;
  abort: AbortController;
  sdkSessionId: string | null;
  onSdkSessionId: (sessionId: string) => void;
  /** Streamed assistant text so far — survives cancellation. */
  collectedText: string;
  /** How many times this run has been pushed to stop planning and edit. */
  nudges: number;
  /** Progressive record of the work, for summaries and interrupted saves. */
  record: TaskRecord;
  /** The working-set lock in force for this turn. Resolved before stage 1. */
  scope: SessionScope;
}

export interface PipelineOutcome {
  assistantText: string;
  sdkSessionId: string | null;
}

/**
 * The mandatory 9-stage pipeline. Every task runs understand -> retrieve
 * -> impact -> plan -> hooks -> execute -> validate -> knowledge ->
 * summary, in order, with stage events published around each — the SDK is
 * only ever invoked inside stages, never free-running.
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
    return [renderScope(scope), ...trees].filter(Boolean).join("\n");
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

    let repo: string | null = null;
    const first = scope.roots[0];
    if (first) {
      try {
        await this.deps.git.focus(first);
        repo = this.deps.git.activeRepo;
      } catch (error) {
        this.deps.log.warn({ error, root: first }, "git focus failed");
      }
    }
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

  async run(ctx: TaskContext): Promise<PipelineOutcome> {
    // The user unticked "System knowledge": nothing below this line runs.
    if (isDirectMode(ctx.opts)) return this.runDirect(ctx);
    // Lives on the context, not this frame: the orchestrator needs it to
    // write a summary if the task is cancelled or crashes before stage 9.
    const changedFiles = ctx.record.changedFiles;
    const unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.topic === "edit.applied" && event.taskId === ctx.taskId) {
        const path = (event.payload as { path: string }).path;
        changedFiles.add(path);
        // Advance the plan checklist live from real edits, so it moves even
        // when the model doesn't call update_plan_step itself.
        this.deps.planTracker.noteFileEdited(ctx.taskId, path);
        // An edited file becomes an anchor: the next turn is usually "now
        // make it do X" with no path named at all.
        this.deps.scope.noteTouched(ctx.conversationId, path);
      }
    });

    try {
      await this.applyScope(ctx);
      const intent = await this.stage(ctx, "understand", async () => {
        const result = await this.understand(ctx);
        ctx.record.intentKind = result.kind;
        ctx.record.intentSummary = result.summary;
        return {
          value: result,
          detail: `${result.kind}: ${clip(result.summary, 80)}`,
        };
      });

      const retrieval = await this.stage(ctx, "retrieve", async () => {
        const base =
          [intent.summary, ...intent.targets].join(" ").trim() || ctx.prompt;
        const queryText = anchoredQuery(base, ctx.priorTurns);
        // Over-fetch, then re-rank with signals retrieval cannot see
        // (target proximity, recency, lesson priority) and keep the top.
        // The lock is a filter here, not a ranking hint: three checkouts
        // holding a near-identical badge.tsx score the same on similarity,
        // so nothing but a hard glob keeps the other two out.
        const raw = await this.deps.retriever.retrieve(queryText, 24, {
          conversationId: ctx.conversationId,
          pathGlob: scopeGlob(ctx.scope),
        });
        // The glob prunes at the source for a single-root lock; this is
        // what makes a two-folder lock exact, and it also catches chunk
        // kinds the glob arm does not reach.
        const scoped = raw.chunks.filter(
          (chunk) =>
            chunk.kind === "session-memory" || inScope(ctx.scope, chunk.path)
        );
        const result = {
          ...raw,
          chunks: rankCandidates({
            chunks: scoped,
            targets: intent.targets,
            graph: this.deps.graph,
            db: this.deps.db,
            k: 12,
          }),
        };
        this.deps.bus.publish("knowledge.retrieved", result, ctx.taskId);
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

      const light = LIGHT_KINDS.has(intent.kind);

      // Impact analysis exists to protect an EDIT: its only consumer is the
      // plan prompt, and its only point is knowing what breaks when the
      // targets change. A question/chat turn edits nothing, so the graph
      // walk is skipped and no impact event is published — reach numbers on
      // a read-only answer are noise that reads like a pending change.
      const impact = await this.stage(ctx, "impact", async () => {
        if (light) {
          return {
            value: { paths: [], deps: emptyDeps(), riskNotes: [] },
            detail: "skipped — read-only turn, no edit planned",
          };
        }
        const paths = impactPaths(intent, retrieval);
        const deps = this.deps.graph.dependentsOf(paths);
        const riskNotes = deps.lessons.map((l) => `${l.title}: ${l.body}`);
        this.deps.bus.publish(
          "impact.analyzed",
          {
            affectedFiles: deps.files.slice(0, 50),
            affectedSymbols: deps.symbols.slice(0, 50),
            riskNotes,
            companionFiles: [],
          },
          ctx.taskId
        );
        return {
          value: { paths, deps, riskNotes },
          detail: `${deps.files.length} dependent files (context)`,
        };
      });

      const plan = await this.stage(ctx, "plan", async () => {
        const built = light
          ? { plan: this.trivialPlan(ctx, intent), degraded: false }
          : await this.buildPlan(ctx, intent, retrieval, impact, skills.context);
        const result = built.plan;
        this.deps.planTracker.setPlan(result);
        this.deps.bus.publish("plan.created", result, ctx.taskId);
        ctx.record.planGoal = result.goal;
        ctx.record.steps = recordSteps(result.steps);
        return {
          value: result,
          // A blind fallback is a FAILED plan stage, not a two-step plan.
          ok: !built.degraded,
          detail: built.degraded
            ? "planner returned no usable JSON — generic fallback plan"
            : `${result.steps.length} steps`,
        };
      });

      // Blast radius is computed from the PLAN's concrete target files, not
      // from retrieval — retrieval pulls in generic hubs (Button, Modal)
      // that the task never edits, which produced wildly wrong reach.
      //
      // It is a PRE-EDIT check, so it runs only when there is an edit to
      // protect: an editing intent with concrete target files. Otherwise the
      // radius stays empty AND unpublished — a question that touches nothing
      // must not surface a radius line in the transcript at all.
      const targets = planTargets(plan, intent);
      const analyzeRadius = !light && targets.length > 0;
      const radius = analyzeRadius
        ? this.deps.impact.analyze(targets)
        : emptyRadius(targets);
      if (analyzeRadius) {
        this.deps.bus.publish("impact.radius", radius, ctx.taskId);
      }

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
        const appendContext = [recalled.text, skills.context, context]
          .filter(Boolean)
          .join("\n");
        // Attached images ride only on this first turn.
        //
        // The plan pass runs on editing turns only: a question or a chat
        // reply has nothing to plan, and the Plan checkbox already owns the
        // interactive version. Non-Claude providers ignore the flag — they
        // return from their own branches before it is read.
        const result = await this.streamSession(
          ctx,
          ctx.prompt,
          appendContext,
          ctx.opts.images,
          "execute",
          { systemPlan: !light }
        );
        // An editing turn that changed nothing has, in practice, ended by
        // offering to implement rather than implementing. Push it once —
        // no-ops if the plan pass already had to do the same.
        if (!light && changedFiles.size === 0) {
          result.text += await this.nudgeToImplement(ctx, appendContext);
        }
        return {
          value: result,
          detail: `${changedFiles.size} file(s) changed`,
        };
      });
      let assistantText = exec.text;

      const validation = await this.stage(ctx, "validate", async () => {
        if (light || changedFiles.size === 0) {
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
        const { results, extraText } = await this.validateWithFixLoop(ctx);
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

      await this.stage(ctx, "knowledge", async () => {
        await this.deps.indexer.drainFor([...changedFiles]);
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
        if (light || changedFiles.size === 0) {
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
        // Work finished: any step still open (model never marked it) is done.
        this.deps.planTracker.completeAll(ctx.taskId);
        const text = buildSummary(
          intent,
          [...changedFiles],
          validation,
          plan,
          reviewVerdict
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
        await this.deps.summaries.save(
          buildTaskSummary({
            taskId: ctx.taskId,
            conversationId: ctx.conversationId,
            intentSummary: intent.summary,
            originalPrompt: ctx.prompt,
            assistantText,
            changedFiles: [...changedFiles],
            validation,
            planGoal: plan.goal,
            // Live statuses from the tracker: completeAll just ran, and the
            // record was refreshed from it above, so this reflects what
            // actually got done rather than the plan as first drafted.
            steps: ctx.record.steps,
            reviewVerdict,
            status: "completed",
          })
        );
        return { value: undefined, detail: clip(text, 100) };
      });

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
          renderPriorTurns(ctx.priorTurns),
          ctx.opts.images,
          "execute"
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
      this.deps.bus.publish(
        "pipeline.stage.completed",
        { stage, ok, detail, durationMs: Date.now() - startedAt },
        ctx.taskId
      );
      return value;
    } catch (error) {
      this.deps.bus.publish(
        "pipeline.stage.completed",
        {
          stage,
          ok: false,
          detail: clip(String(error), 200),
          durationMs: Date.now() - startedAt,
        },
        ctx.taskId
      );
      throw error;
    }
  }

  private async understand(ctx: TaskContext): Promise<Intent> {
    const fallback: Intent = {
      kind: looksLikeQuestion(ctx.prompt) ? "question" : "chat",
      summary: clip(ctx.prompt, 120),
      targets: [],
      constraints: [],
    };
    // Same session anchor as retrieval: a follow-up ("now add a filter")
    // resolves against the recent turns, so its summary/targets carry the
    // subject instead of classifying a subjectless line in isolation.
    const anchor = intentAnchor(ctx.priorTurns);
    try {
      const raw = await this.shortSdkCall(
        ctx,
        "You are an intent classifier for a coding agent. Reply with ONLY " +
          "valid JSON, no prose.",
        `Classify the LATEST request${
          anchor ? " (recent turns are context only)" : ""
        }:\n${anchor}Latest:\n"""${clip(ctx.prompt, 2000)}"""\n\n` +
          "targets = ONLY files/symbols named in the LATEST request; never " +
          "copy paths from the recent-turn context, and never list something " +
          "the latest request says is already done/reverted. constraints = " +
          'explicit scope limits ("only", "just", "revert", "do not ..."), ' +
          "AND any wording that pins the fix down rather than opening it " +
          'up — "direct fix", "quick fix", "simplest", "for now", or the ' +
          "user naming the exact file and the exact edit to make in it. " +
          "Capture that instruction verbatim as a constraint: it is what " +
          "stops later stages widening the job.\n" +
          'JSON shape: {"kind":"question|chat|command|edit|fix|feature|refactor",' +
          '"summary":"one line","targets":["file paths or symbol names ' +
          'mentioned"],"constraints":["explicit constraints"]}'
      );
      const parsed = extractJson(raw) as Partial<Intent> | null;
      if (!parsed || typeof parsed.summary !== "string") {
        this.deps.bus.publish("intent.resolved", fallback, ctx.taskId);
        return fallback;
      }
      const intent: Intent = {
        kind: typeof parsed.kind === "string" ? parsed.kind : fallback.kind,
        summary: clip(parsed.summary, 200),
        targets: asStringArray(parsed.targets).slice(0, 8),
        constraints: asStringArray(parsed.constraints).slice(0, 8),
      };
      this.deps.bus.publish("intent.resolved", intent, ctx.taskId);
      return intent;
    } catch (error) {
      if (ctx.abort.signal.aborted) throw error;
      this.deps.log.warn({ err: error }, "intent call failed; using fallback");
      this.deps.bus.publish("intent.resolved", fallback, ctx.taskId);
      return fallback;
    }
  }

  private trivialPlan(ctx: TaskContext, intent: Intent): Plan {
    return {
      id: newId("plan"),
      taskId: ctx.taskId,
      goal: intent.summary,
      steps: [
        {
          id: newId("step"),
          title:
            intent.kind === "question" ? "Answer from knowledge" : "Respond",
          files: [],
          status: "pending",
        },
      ],
      createdAt: Date.now(),
    };
  }

  /**
   * Stage 4. Returns the plan plus whether it is the blind fallback, so the
   * stage can report a planning failure instead of passing a generic
   * two-step checklist off as a real plan.
   */
  private async buildPlan(
    ctx: TaskContext,
    intent: Intent,
    retrieval: RetrievalResult,
    impact: { deps: { files: string[] }; riskNotes: string[] },
    skillContext = ""
  ): Promise<{ plan: Plan; degraded: boolean }> {
    const fallback: Plan = {
      id: newId("plan"),
      taskId: ctx.taskId,
      goal: intent.summary,
      steps: [
        {
          id: newId("step"),
          title: "Implement the request",
          files: intent.targets,
          status: "pending",
        },
        {
          id: newId("step"),
          title: "Verify the change",
          files: [],
          status: "pending",
        },
      ],
      createdAt: Date.now(),
    };
    try {
      // Retrieval hubs + dependents are regression-risk CONTEXT (what might
      // break), never a to-do list — the model used to turn them into steps.
      const riskFiles = [
        ...new Set([
          ...retrieval.chunks
            .filter((c) => c.kind !== "lesson")
            .slice(0, 6)
            .map((c) => c.path),
          ...impact.deps.files.slice(0, 8),
        ]),
      ];
      // The planner used to see the LATEST turn only. A terse follow-up
      // ("implement", "continue") carries no subject, so it planned a single
      // word — which is exactly what a generic "Implement the request"
      // checklist is. Anchor it the way understand() and retrieve already are.
      const task = planTask(ctx, retrieval);
      const maxSteps = stepBudget(intent, task.full);
      const evidence = codeEvidence(retrieval);
      const contextLines = [
        `Request (latest turn): ${clip(ctx.prompt, 1200)}`,
        task.anchor
          ? "Conversation so far — the latest turn continues THIS work, so " +
            `plan the work described here:\n${task.anchor}`
          : "",
        `Intent: ${intent.kind} — ${intent.summary}`,
        intent.targets.length > 0
          ? `Files/symbols the user named: ${intent.targets.join(", ")}`
          : "",
        intent.constraints.length > 0
          ? "Explicit scope limits from the user (honor exactly): " +
            intent.constraints.join(" | ")
          : "",
        evidence
          ? "Code from the repo — ground every step in what these actually " +
            "show, and never name a path that appears in neither these " +
            `excerpts nor the workspace layout:\n${evidence}`
          : "",
        // These overlap the excerpts above by design: reading a file is how
        // a step gets concrete, but being readable was never permission to
        // change it — that conflation is what turned retrieval into a to-do
        // list before.
        riskFiles.length > 0
          ? "Regression-risk files (DO NOT edit unless the request requires " +
            "it, listed only so you avoid breaking them — several are quoted " +
            "above, and being quoted is context, not a task): " +
            riskFiles.join(", ")
          : "",
        impact.riskNotes.length > 0
          ? `Risk notes from past lessons: ${impact.riskNotes.join(" | ")}`
          : "",
        skillContext
          ? `Skills the user invoked (follow these constraints):\n${skillContext}`
          : "",
      ].filter(Boolean);
      // The planner names concrete file paths, so it needs the folder
      // shape as much as the implementer does.
      const raw = await this.shortSdkCall(
        ctx,
        (await this.workspaceLayout()) +
          (await this.scopeContext(ctx)) +
          "You are a senior engineer writing an implementation plan that " +
          "another engineer will execute step by step, in order. Two rules " +
          "pull against each other and BOTH bind you. Scope: plan ONLY what " +
          "the request requires — no follow-up, refactor or cleanup steps " +
          "for files the user did not ask about, and the regression-risk " +
          "files are context to avoid breaking, NOT tasks. Depth: inside " +
          "that scope be CONCRETE — each step names the real files it " +
          "touches and its detail says what changes in them and why, in " +
          "terms of the code you were shown. A step a stranger could not " +
          "act on without re-reading the whole repo is not a step. Never " +
          'restate the request as a step ("implement the request") or add a ' +
          "bare verify step. Honor any explicit scope limits exactly. Reply " +
          "with ONLY valid JSON, no prose.",
        `${contextLines.join("\n")}\n\n` +
          'JSON shape: {"goal":"one line","steps":[{"title":"imperative, ' +
          '<=10 words","detail":"what changes in these files and why, 1-2 ' +
          'sentences","files":["real repo paths"]}]}\n' +
          `Use as many steps as the work genuinely has, up to ${maxSteps}. ` +
          "detail and files are required on every step. Order the steps so " +
          "each one is executable when its turn comes."
      );
      const parsed = extractJson(raw) as {
        goal?: string;
        steps?: Array<{ title?: string; detail?: string; files?: unknown }>;
      } | null;
      if (
        !parsed ||
        !Array.isArray(parsed.steps) ||
        parsed.steps.length === 0
      ) {
        // Used to return the fallback silently, which reads downstream
        // exactly like a task that genuinely needed two steps.
        this.deps.log.warn(
          { raw: clip(raw, 400) },
          "plan JSON unusable; using fallback"
        );
        return { plan: fallback, degraded: true };
      }
      return {
        plan: {
          id: newId("plan"),
          taskId: ctx.taskId,
          goal: clip(parsed.goal ?? intent.summary, 200),
          steps: parsed.steps.slice(0, maxSteps).map((step) => ({
            id: newId("step"),
            title: clip(step.title ?? "Step", 120),
            detail: step.detail ? clip(step.detail, 300) : undefined,
            files: asStringArray(step.files).slice(0, 6),
            status: "pending" as const,
          })),
          createdAt: Date.now(),
        },
        degraded: false,
      };
    } catch (error) {
      if (ctx.abort.signal.aborted) throw error;
      this.deps.log.warn({ err: error }, "plan call failed; using fallback");
      return { plan: fallback, degraded: true };
    }
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
    ctx: TaskContext
  ): Promise<{ results: ValidationResult[]; extraText: string }> {
    const kinds = this.deps.validators.detect();
    if (kinds.length === 0) return { results: [], extraText: "" };
    const maxRetries = this.deps.settings.get().maxValidationRetries;
    let extraText = "";
    let results: ValidationResult[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      results = [];
      for (const kind of kinds) {
        if (ctx.abort.signal.aborted) throw new AbortError();
        this.deps.bus.publish("validation.started", { kind }, ctx.taskId);
        const result = await this.deps.validators.run(kind, ctx.abort.signal);
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
  async saveInterruptedSummary(
    ctx: TaskContext,
    status: "cancelled" | "error"
  ): Promise<void> {
    // A direct turn writes no memory when it succeeds, so it must not write
    // any when it is cancelled either — that record would come back as a
    // retrievable chunk in the next pipeline run.
    if (isDirectMode(ctx.opts) || ctx.record.summarized) return;
    const record = ctx.record;
    // Live statuses while the tracker entry still exists — the task finishes
    // right after this and clears it. Without the refresh, a step that
    // genuinely got done is reported as work the run never reached.
    const live = this.deps.planTracker.get(ctx.taskId)?.steps;
    if (live) record.steps = recordSteps(live);
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
  private async shortSdkCall(
    ctx: TaskContext,
    systemPrompt: string,
    prompt: string
  ): Promise<string> {
    return runOneShot({
      model: ctx.opts.model,
      claudeFallback: STAGE_MODEL,
      system: systemPrompt,
      prompt,
      cwd: this.deps.config.workspaceRoot,
      signal: ctx.abort.signal,
      effort: ctx.opts.effort,
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
    appendContext = "",
    images?: ImageAttachment[],
    purpose: ContextPurpose = "execute",
    opts: {
      resume?: boolean;
      allowedTools?: string[];
      /** Run the internal plan pass before editing — Claude models only. */
      systemPlan?: boolean;
    } = {}
  ): Promise<{ text: string }> {
    const resume = opts.resume ?? true;
    const sdkContext: SdkToolContext = {
      taskId: ctx.taskId,
      signal: ctx.abort.signal,
    };
    const mcpServer = createAtelierMcpServer(this.deps.tools, () => sdkContext);
    let text = "";

    const hasImages = images !== undefined && images.length > 0;
    // Provider-neutral: the same layout block precedes the rules on every
    // backend, so a Codex or Ollama run knows the folder shape too. It
    // survives direct mode — knowing the real folder names is not knowledge
    // retrieval, and without it the model invents paths.
    const layout = await this.workspaceLayout();
    // Direct mode swaps the whole rule block: SYSTEM_RULES describes a
    // knowledge engine this turn does not have, down to tools it cannot
    // call and hooks that will not fire.
    const direct = isDirectMode(ctx.opts);
    const rules = direct ? DIRECT_RULES : SYSTEM_RULES;
    // Rides AFTER the static rules, never between them: the lock changes
    // per conversation, and splitting the static prefix would invalidate
    // the provider prompt cache on every turn. A direct turn has no lock —
    // the scope store is part of the pipeline, not of a plain agent loop.
    const scoped = direct ? "" : await this.scopeContext(ctx);

    if (isOllamaModel(ctx.opts.model)) {
      return {
        text: await runOllamaAgentLoop({
          model: ollamaModelName(ctx.opts.model as string),
          // Routes the turn at the endpoint the picked row came from: the
          // daemon on this machine, or the hosted account.
          target: ollamaTargetOf(ctx.opts.model) ?? "ollama-cloud",
          system:
            layout +
            rules +
            (ctx.opts.vibe ? VIBE_RULES : "") +
            scoped +
            appendContext,
          prompt,
          images,
          tools: this.deps.tools,
          toolNames: direct ? DIRECT_TOOLS : undefined,
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
        }),
      };
    }

    if (isCodexModel(ctx.opts.model)) {
      const toolBridge = await this.deps.codexTools.session(
        ctx.taskId,
        ctx.abort.signal
      );
      const text = await runCodexExec({
        cwd: this.deps.config.workspaceRoot,
        model: codexModelName(ctx.opts.model as string),
        sandbox: ctx.opts.planMode ? "read-only" : "workspace-write",
        effort: ctx.opts.effort,
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
          layout +
          rules +
          CODEX_MCP_RULES +
          (ctx.opts.vibe ? VIBE_RULES : "") +
          scoped +
          appendContext +
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
          append:
            layout +
            rules +
            (ctx.opts.vibe ? VIBE_RULES : "") +
            scoped +
            appendContext,
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
        ...(sdkModel(ctx.opts.model)
          ? { model: sdkModel(ctx.opts.model) }
          : {}),
        ...(sdkEffort(ctx.opts.effort)
          ? { effort: sdkEffort(ctx.opts.effort) }
          : {}),
        disallowedTools: DISABLED_BUILTINS,
        mcpServers: { [MCP_SERVER_NAME]: mcpServer },
        strictMcpConfig: true,
        allowedTools:
          opts.allowedTools ??
          (direct
            ? DIRECT_TOOLS.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`)
            : [`mcp__${MCP_SERVER_NAME}__*`]),
        includePartialMessages: true,
        // Atelier injects selected skills itself so disabled skills cannot
        // leak through Claude's native user/project settings.
        settingSources: [],
        abortController: ctx.abort,
        ...(resume && ctx.sdkSessionId ? { resume: ctx.sdkSessionId } : {}),
      },
    });
    session = stream;

    for await (const message of stream) {
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
      if (m.type === "stream_event") {
        const event = m.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (event?.type === "content_block_delta" && event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text) {
            text += event.delta.text;
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
    // A turn that ends still in the plan phase never reached ExitPlanMode, so
    // the flip never happened and nothing was ever allowed to change — the
    // user gets an analysis and an offer to implement. Take the plan the
    // model wrote as prose and carry the SAME session into the edits.
    if (planPhase) {
      if (text) this.adoptPlan(ctx, text);
      return { text: text + (await this.nudgeToImplement(ctx, appendContext)) };
    }
    return { text };
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
    appendContext: string
  ): Promise<string> {
    if (ctx.nudges > 0 || ctx.abort.signal.aborted) return "";
    ctx.nudges += 1;
    this.deps.log.warn(
      { taskId: ctx.taskId },
      "turn ended without edits; continuing the session into implementation"
    );
    const { text } = await this.streamSession(
      ctx,
      PROCEED_PROMPT,
      appendContext,
      undefined,
      "execute",
      { systemPlan: false }
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

function sdkEffort(
  effort: TaskOptions["effort"]
): Exclude<TaskOptions["effort"], "ultra"> | undefined {
  return effort === "ultra" ? undefined : effort;
}

/**
 * Token cap for the shared memory block. A bare "continue" classifies as
 * chat, which is precisely the turn that needs the thread most — so the light
 * budget stays generous here even though its code budget is small.
 */
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

/** Exported so Settings can display exactly what the agent is told. */
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
  "MODULARITY RULE (enforced by a blocking hook): ONE file = ONE " +
  "top-level function/component/class. Split helpers into " +
  "one-file-per-function folders with an index.ts barrel. Types, " +
  "interfaces, and constants may share a file.\n" +
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
  reviewVerdict: "pass" | "fail" | null
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
function planTargets(plan: Plan, intent: Intent): string[] {
  const targets = new Set<string>();
  for (const step of plan.steps) {
    for (const file of step.files) {
      if (file.includes("/") || file.includes(".")) targets.add(file.trim());
    }
  }
  for (const target of intent.targets) {
    if (target.includes("/") || target.includes(".")) targets.add(target.trim());
  }
  return [...targets].filter(Boolean).slice(0, 12);
}

/** Dependents with nothing in them — for turns that skip the graph walk. */
function emptyDeps(): ReturnType<SymbolGraph["dependentsOf"]> {
  return { files: [], symbols: [], lessons: [] };
}

/** A radius with nothing in it — for light tasks or unknown targets. */
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

function impactPaths(intent: Intent, retrieval: RetrievalResult): string[] {
  const paths = new Set<string>();
  for (const target of intent.targets) {
    if (target.includes("/") || target.includes(".")) paths.add(target);
  }
  for (const chunk of retrieval.chunks) {
    if (chunk.kind !== "lesson") paths.add(chunk.path);
  }
  return [...paths].slice(0, 8);
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
 * What the plan stage is actually being asked to build. The latest turn is
 * often a single word — "implement", "continue" — and the subject then lives
 * in the recent exchange and in the session-memory chunks retrieval recalled
 * (which carry the original request verbatim). Folding both in is what stops
 * the planner from planning a word. Deeper than the intent anchor on purpose:
 * classifying one line needs less history than planning the whole job.
 */
function planTask(
  ctx: TaskContext,
  retrieval: RetrievalResult
): { anchor: string; full: string } {
  const turns = ctx.priorTurns
    .slice(-4)
    .map((turn) => `- ${turn.role}: ${clipConversationTurn(turn.text, 500)}`);
  const recalled = retrieval.chunks
    .filter((chunk) => chunk.kind === "session-memory")
    .slice(0, 2)
    .map((chunk) => `- recalled: ${clip(chunk.preview, 400)}`);
  const anchor = [...turns, ...recalled].join("\n");
  return { anchor, full: `${ctx.prompt}\n${anchor}` };
}

/**
 * How many steps the plan may spend. Plan cost has to track the size of the
 * job in both directions: a one-line fix still gets a short checklist, while
 * a multi-file feature is allowed the steps it genuinely has instead of
 * being clipped to six and losing the tail of the work.
 */
function stepBudget(intent: Intent, taskText: string): number {
  const broad = intent.kind === "feature" || intent.kind === "refactor";
  const score =
    (broad ? 1 : 0) +
    (taskText.length > 1200 ? 1 : 0) +
    (intent.targets.length >= 3 ? 1 : 0);
  if (score >= 2) return 12;
  return score === 1 ? 8 : 5;
}

/**
 * Excerpts of the code the plan will touch. The plan stage used to receive
 * file PATHS only, so its steps could not say what changes inside them —
 * "based on code understanding" was structurally impossible. Bounded on
 * purpose: a handful of chunks grounds the steps without turning a cheap
 * stage call into a second context assembly. Lessons and session memory are
 * excluded — they are handled elsewhere and are not code to plan against.
 */
function codeEvidence(retrieval: RetrievalResult): string {
  return retrieval.chunks
    .filter(
      (chunk) =>
        chunk.kind === "code" ||
        chunk.kind === "doc" ||
        chunk.kind === "feature-summary"
    )
    .slice(0, 5)
    .map((chunk) => {
      const rows =
        chunk.startRow !== undefined
          ? `:${chunk.startRow}-${chunk.endRow ?? chunk.startRow}`
          : "";
      return `--- ${chunk.path}${rows}\n${clip(chunk.preview, 500)}`;
    })
    .join("\n");
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

function looksLikeQuestion(prompt: string): boolean {
  return (
    /\?\s*$/.test(prompt.trim()) ||
    /^(what|where|when|why|how|who|is|are|can|does|do|did)\b/i.test(
      prompt.trim()
    )
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
