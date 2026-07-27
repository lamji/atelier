import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
import type { ValidationRunners } from "../validation/runners.js";
import type { SettingsRepo } from "../storage/repositories/settings.js";
import type { PlanTracker } from "./plan-tracker.js";
import type { TaskOptions } from "./orchestrator.js";
import {
  createAtelierMcpServer,
  MCP_SERVER_NAME,
  type SdkToolContext,
} from "./sdk-tools.js";
import { buildReviewFixPrompt, buildReviewPrompt } from "./review-prompt.js";
import { VIBE_RULES } from "./vibe-rules.js";
import type { UsageMonitor } from "./usage-monitor.js";
import type { SdkUsage, TokenLedger } from "../context/ledger/index.js";
import type { PromptAssembler } from "../context/assemble/index.js";
import type { RetrieverLike } from "../context/cache/index.js";
import {
  buildTaskSummary,
  type TaskSummaryStore,
} from "../context/summaries/index.js";
import { rankCandidates } from "../context/rank/index.js";

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
 * Read-only tool surface for the independent-review turn. Everything that
 * can mutate the workspace — write_file, replace_code, run_terminal — is
 * withheld so the reviewer can only judge the change, never quietly repair
 * what it is supposed to be reporting. `git` is present for the diff
 * action; the git-flow hook still blocks commit/push.
 */
const REVIEW_TOOLS = [
  "read_file",
  "list_dir",
  "search_workspace",
  "search_symbols",
  "retrieve_knowledge",
  "query_knowledge_graph",
  "impact_of_edit",
  "analyze_impact",
  "git",
].map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);

/** Small, fast model for the structured understand/plan calls. */
const STAGE_MODEL = "claude-haiku-4-5";

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
  validators: ValidationRunners;
  planTracker: PlanTracker;
  settings: SettingsRepo;
  usage: UsageMonitor;
  ledger: TokenLedger;
  assembler: PromptAssembler;
  summaries: TaskSummaryStore;
  log: Logger;
}

export interface TaskContext {
  taskId: string;
  conversationId: string;
  prompt: string;
  /** Recent prior user turns (oldest→newest), for anchoring retrieval. */
  priorPrompts: string[];
  messageId: string;
  opts: TaskOptions;
  abort: AbortController;
  sdkSessionId: string | null;
  onSdkSessionId: (sessionId: string) => void;
  /** Streamed assistant text so far — survives cancellation. */
  collectedText: string;
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
  constructor(private deps: PipelineDeps) {}

  async run(ctx: TaskContext): Promise<PipelineOutcome> {
    const changedFiles = new Set<string>();
    const unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.topic === "edit.applied" && event.taskId === ctx.taskId) {
        const path = (event.payload as { path: string }).path;
        changedFiles.add(path);
        // Advance the plan checklist live from real edits, so it moves even
        // when the model doesn't call update_plan_step itself.
        this.deps.planTracker.noteFileEdited(ctx.taskId, path);
      }
    });

    try {
      const intent = await this.stage(ctx, "understand", async () => {
        const result = await this.understand(ctx);
        return {
          value: result,
          detail: `${result.kind}: ${clip(result.summary, 80)}`,
        };
      });

      const retrieval = await this.stage(ctx, "retrieve", async () => {
        const base =
          [intent.summary, ...intent.targets].join(" ").trim() || ctx.prompt;
        const queryText = anchoredQuery(base, ctx.priorPrompts);
        // Over-fetch, then re-rank with signals retrieval cannot see
        // (target proximity, recency, lesson priority) and keep the top.
        const raw = await this.deps.retriever.retrieve(queryText, 24);
        const result = {
          ...raw,
          chunks: rankCandidates({
            chunks: raw.chunks,
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
        const result = light
          ? this.trivialPlan(ctx, intent)
          : await this.buildPlan(ctx, intent, retrieval, impact);
        this.deps.planTracker.setPlan(result);
        this.deps.bus.publish("plan.created", result, ctx.taskId);
        return { value: result, detail: `${result.steps.length} steps` };
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
        // Attached images ride only on this first turn.
        const result = await this.streamSession(
          ctx,
          ctx.prompt,
          context,
          ctx.opts.images
        );
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
          changedFiles
        );
        assistantText += text;
        reviewVerdict = passed ? "pass" : "fail";
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
        // instead of replayed history.
        this.deps.summaries.save(
          buildTaskSummary({
            taskId: ctx.taskId,
            conversationId: ctx.conversationId,
            intentSummary: intent.summary,
            changedFiles: [...changedFiles],
            validation,
            planGoal: plan.goal,
          })
        );
        return { value: undefined, detail: clip(text, 100) };
      });

      return { assistantText, sdkSessionId: ctx.sdkSessionId };
    } finally {
      unsubscribe();
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
    const anchor = intentAnchor(ctx.priorPrompts);
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
          'explicit scope limits ("only", "just", "revert", "do not ...").\n' +
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

  private async buildPlan(
    ctx: TaskContext,
    intent: Intent,
    retrieval: RetrievalResult,
    impact: { deps: { files: string[] }; riskNotes: string[] }
  ): Promise<Plan> {
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
      const contextLines = [
        `Request: ${clip(ctx.prompt, 1200)}`,
        `Intent: ${intent.kind} — ${intent.summary}`,
        intent.constraints.length > 0
          ? "Explicit scope limits from the user (honor exactly): " +
            intent.constraints.join(" | ")
          : "",
        riskFiles.length > 0
          ? "Regression-risk files (DO NOT edit unless the request requires " +
            "it, listed only so you avoid breaking them): " +
            riskFiles.join(", ")
          : "",
        impact.riskNotes.length > 0
          ? `Risk notes from past lessons: ${impact.riskNotes.join(" | ")}`
          : "",
      ].filter(Boolean);
      const raw = await this.shortSdkCall(
        ctx,
        "You are a senior engineer writing a MINIMAL implementation plan. " +
          "Plan ONLY what the explicit request requires. Do NOT add " +
          "follow-up, refactor, or verify steps for files the user did not " +
          "name; the regression-risk files are context to avoid breaking, " +
          "NOT tasks. Honor any explicit scope limits exactly. Reply with " +
          "ONLY valid JSON, no prose.",
        `${contextLines.join("\n")}\n\n` +
          'JSON shape: {"goal":"one line","steps":[{"title":"...",' +
          '"detail":"optional","files":["paths"]}]} — use as few steps as ' +
          "the request needs, no filler."
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
        return fallback;
      }
      return {
        id: newId("plan"),
        taskId: ctx.taskId,
        goal: clip(parsed.goal ?? intent.summary, 200),
        steps: parsed.steps.slice(0, 6).map((step) => ({
          id: newId("step"),
          title: clip(step.title ?? "Step", 120),
          detail: step.detail ? clip(step.detail, 300) : undefined,
          files: asStringArray(step.files).slice(0, 6),
          status: "pending" as const,
        })),
        createdAt: Date.now(),
      };
    } catch (error) {
      if (ctx.abort.signal.aborted) throw error;
      this.deps.log.warn({ err: error }, "plan call failed; using fallback");
      return fallback;
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
    changed: Set<string>
  ): Promise<{ text: string; detail: string; passed: boolean }> {
    const maxAttempts = 1 + this.deps.settings.get().maxReviewRetries;
    let text = "";
    let verdict: "pass" | "fail" = "fail";
    let findings: string[] = [];
    let attempt = 0;
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
        similar = await this.deps.clones
          .siblingsOf(changedFiles)
          .catch((error: unknown) => {
            this.deps.log.warn({ err: error }, "clone scan failed");
            return [];
          });
        companionFiles = companionFilesFor(
          this.deps.config.workspaceRoot,
          changedFiles
        );
      }
      const result = await this.streamSession(
        ctx,
        buildReviewPrompt({ changedFiles, similar, companionFiles }),
        "",
        undefined,
        "review",
        { resume: false, allowedTools: REVIEW_TOOLS }
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
        "",
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
            `${findings.length} finding(s)`,
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
      const fix = await this.streamSession(ctx, feedback, "", undefined, "fix");
      extraText += fix.text;
    }
    return { results, extraText };
  }

  // ----------------------------------------------------------- SDK calls

  /** One-shot structured call on the small model: no tools, one turn. */
  private async shortSdkCall(
    ctx: TaskContext,
    systemPrompt: string,
    prompt: string
  ): Promise<string> {
    const stream = query({
      prompt,
      options: {
        cwd: this.deps.config.workspaceRoot,
        systemPrompt,
        model: STAGE_MODEL,
        maxTurns: 1,
        disallowedTools: DISABLED_BUILTINS,
        strictMcpConfig: true,
        settingSources: [],
        abortController: ctx.abort,
      },
    });
    let text = "";
    for await (const message of stream) {
      const m = message as Record<string, unknown>;
      if (m.type === "result" && typeof m.result === "string") {
        text = m.result;
      }
    }
    return text;
  }

  /**
   * The main interactive session (stage 6 + validation fix rounds):
   * streams deltas to chat, resumes the conversation's SDK session, and
   * exposes Atelier tools through the in-process MCP server.
   */
  private async streamSession(
    ctx: TaskContext,
    prompt: string,
    appendContext = "",
    images?: ImageAttachment[],
    purpose: ContextPurpose = "execute",
    opts: { resume?: boolean; allowedTools?: string[] } = {}
  ): Promise<{ text: string }> {
    const resume = opts.resume ?? true;
    const sdkContext: SdkToolContext = {
      taskId: ctx.taskId,
      signal: ctx.abort.signal,
    };
    const mcpServer = createAtelierMcpServer(this.deps.tools, () => sdkContext);
    let text = "";

    // With images, the turn is a structured multimodal user message; plain
    // text stays a plain string prompt (the common path).
    const promptInput =
      images && images.length > 0 ? imagePrompt(prompt, images) : prompt;

    const stream = query({
      prompt: promptInput,
      options: {
        cwd: this.deps.config.workspaceRoot,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          // Stable-first ordering for prompt caching: static rule blocks
          // precede the per-task context, and each block is byte-stable.
          append:
            SYSTEM_RULES +
            (ctx.opts.vibe ? VIBE_RULES : "") +
            appendContext,
        },
        permissionMode: ctx.opts.planMode ? "plan" : "bypassPermissions",
        ...(ctx.opts.model ? { model: ctx.opts.model } : {}),
        ...(ctx.opts.effort ? { effort: ctx.opts.effort } : {}),
        disallowedTools: DISABLED_BUILTINS,
        mcpServers: { [MCP_SERVER_NAME]: mcpServer },
        strictMcpConfig: true,
        allowedTools: opts.allowedTools ?? [`mcp__${MCP_SERVER_NAME}__*`],
        includePartialMessages: true,
        // user+project so .claude/commands and skills stay executable.
        settingSources: ["user", "project"],
        abortController: ctx.abort,
        ...(resume && ctx.sdkSessionId ? { resume: ctx.sdkSessionId } : {}),
      },
    });

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
    return { text };
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

const SYSTEM_RULES =
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
 * short tail of recent user turns into the query keeps the subject ("site
 * map") in view. The current ask leads so its terms win the keyword cap and
 * dominate the mean-pooled query vector; the anchor only nudges — and it
 * matters most exactly when the current turn is terse.
 */
function anchoredQuery(base: string, priorPrompts: string[]): string {
  const anchor = priorPrompts
    .slice(-2)
    .map((p) => clip(p, 160))
    .join(" ")
    .trim();
  return anchor ? `${base}\n\ncontext: ${anchor}` : base;
}

/** Recent user turns rendered as a context block for the intent classifier. */
function intentAnchor(priorPrompts: string[]): string {
  const recent = priorPrompts.slice(-2).map((p) => clip(p, 200));
  if (recent.length === 0) return "";
  return `Recent turns:\n${recent.map((p) => `- ${p}`).join("\n")}\n\n`;
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
