import type pino from "pino";
import type { AgentConfig } from "./config/agent-config.js";
import { EventBus } from "./events/event-bus.js";
import { TimelineStore } from "./events/timeline-store.js";
import { openDb } from "./storage/db.js";
import { ConversationRepo } from "./storage/repositories/conversations.js";
import { SettingsRepo } from "./storage/repositories/settings.js";
import { CliSessionDiffRepo } from "./storage/repositories/cli-session-diffs.js";
import { Router } from "./bridge/router.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { UsageMonitor } from "./orchestrator/usage-monitor.js";
import {
  createUserRule,
  deleteUserRule,
  listUserRules,
  setUserRuleEnabled,
} from "./orchestrator/user-rules.js";
import { pickerRoster } from "./providers/roster.js";
import { CodexToolBridge } from "./providers/codex/tool-bridge.js";
import { registerProviderHandlers } from "./providers/register-provider-handlers.js";
import { probeAuth } from "./orchestrator/auth-status.js";
import { registerSessionHandlers } from "./sessions/session-manager.js";
import { registerMiscHandlers } from "./register-handlers.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerFsTools } from "./tools/fs-tools.js";
import { registerGitTools } from "./tools/git-tools.js";
import { registerTerminalTools } from "./tools/terminal-tools.js";
import { GitService } from "./git/git-service.js";
import { registerGitHandlers } from "./git/register-git-handlers.js";
import { TerminalManager } from "./terminal/terminal-manager.js";
import { registerTerminalHandlers } from "./terminal/register-terminal-handlers.js";
import { PathGuard } from "./workspace/path-guard.js";
import {
  ensureAtelierGitignored,
  WorkspaceIgnore,
} from "./workspace/ignore.js";
import { SessionScopeStore } from "./workspace/scope/index.js";
import { ScopeGuard } from "./tools/scope-guard.js";
import { FileService } from "./workspace/file-service.js";
import { AttachmentStore } from "./context/attachments/attachment-store.js";
import { NoteJournal } from "./notes/note-journal.js";
import { registerFsHandlers } from "./workspace/register-fs-handlers.js";
import { WorkspaceWatcher } from "./workspace/watcher.js";
import { HooksEngine } from "./hooks/hooks-engine.js";
import { DirectTaskRegistry } from "./hooks/direct-tasks.js";
import {
  ModularityGuard,
  MODULARITY_HOOK_ID,
  MODULARITY_HOOK_NAME,
} from "./hooks/modularity-guard.js";
import { followsOneSymbolPerFile } from "./hooks/modularity-convention.js";
import {
  ImpactFirstGuard,
  IMPACT_HOOK_ID,
  IMPACT_HOOK_NAME,
} from "./hooks/impact-guard.js";
import {
  TargetedEditGuard,
  REWRITE_HOOK_ID,
  REWRITE_HOOK_NAME,
} from "./hooks/rewrite-guard.js";
import {
  GitFlowGuard,
  GIT_FLOW_HOOK_ID,
  GIT_FLOW_HOOK_NAME,
} from "./hooks/git-flow-guard.js";
import {
  DbApprovalGuard,
  DB_APPROVAL_HOOK_ID,
  DB_APPROVAL_HOOK_NAME,
  NPM_APPROVAL_HOOK_ID,
  NPM_APPROVAL_HOOK_NAME,
} from "./hooks/db-approval-guard.js";
import {
  DevServerGuard,
  DEV_SERVER_HOOK_ID,
  DEV_SERVER_HOOK_NAME,
} from "./hooks/dev-server-guard.js";
import { registerHookHandlers } from "./hooks/register-hook-handlers.js";
import { KnowledgeQuery } from "./knowledge/query/knowledge-query.js";
import { IncrementalIndexer } from "./knowledge/indexer/incremental-indexer.js";
import { SymbolGraph } from "./knowledge/graph/symbol-graph.js";
import { CloneScanner } from "./knowledge/impact/clone-scan.js";
import { ImpactAnalyzer } from "./knowledge/impact/impact-analyzer.js";
import { SymbolImpactAnalyzer } from "./knowledge/impact/symbol-impact.js";
import { FeatureModelService } from "./knowledge/features/feature-model.js";
import { RouteFeatureScanner } from "./knowledge/features/route-feature-scanner.js";
import { Embedder, EMBEDDING_DIMS } from "./knowledge/embeddings/embedder.js";
import { VectorStore } from "./knowledge/embeddings/vector-store.js";
import { LessonStore } from "./knowledge/lessons/lesson-store.js";
import { registerKnowledgeTools } from "./tools/knowledge-tools.js";
import { GlobalSessionStore } from "./context/global-session/index.js";
import { registerPlanTools } from "./tools/plan-tools.js";
import { PlanTracker } from "./orchestrator/plan-tracker.js";
import { ValidationRunners } from "./validation/runners.js";
import { Retriever } from "./rag/retriever.js";
import { TokenLedger } from "./context/ledger/index.js";
import { PromptAssembler } from "./context/assemble/index.js";
import { CachedRetriever, IndexGeneration } from "./context/cache/index.js";
import { SentChunkStore } from "./context/dedup/index.js";
import { TaskSummaryStore } from "./context/summaries/index.js";
import { SharedSessionContextBuilder } from "./context/session/index.js";
import { SkillLoader } from "./orchestrator/skill-loader.js";

export interface AgentRuntime {
  router: Router;
  bus: EventBus;
  timeline: TimelineStore;
  orchestrator: Orchestrator;
  /** Graceful teardown of every service; does NOT exit the process. */
  shutdown: () => void;
}

/**
 * Wires the full agent service graph for one workspace and returns the
 * transport-agnostic pieces (router + bus) for whichever server hosts it.
 * Extracted verbatim from the old WS main() — behavior unchanged.
 */
export function createAgentRuntime(
  config: AgentConfig,
  log: pino.Logger
): AgentRuntime {
  try {
    if (ensureAtelierGitignored(config.workspaceRoot)) {
      log.info(
        { workspaceRoot: config.workspaceRoot },
        "added .atelier/ to project .gitignore"
      );
    }
  } catch (error) {
    log.warn(
      { err: error, workspaceRoot: config.workspaceRoot },
      "could not add .atelier/ to project .gitignore"
    );
  }

  const db = openDb(config.dataDir);
  const bus = new EventBus();
  const timeline = new TimelineStore(db, bus);
  const conversations = new ConversationRepo(db);
  const cliSessionDiffs = new CliSessionDiffRepo(db);
  const settings = new SettingsRepo(db, {
    workspaceRoot: config.workspaceRoot,
    ignoreGlobs: [],
    disabledSkills: [],
    globalSessionKnowledge: false,
    // No auto-repair rounds. Each retry re-runs the WHOLE validator set and
    // spends another full model turn, and measured across real tasks the
    // retry count — not the validators — was the dominant cost. The findings
    // still reach the user; the agent just does not go round again by itself.
    maxValidationRetries: 0,
    maxReviewRetries: 2,
  });

  const guard = new PathGuard(config.workspaceRoot);
  const ig = new WorkspaceIgnore(config.workspaceRoot, settings.get().ignoreGlobs);
  const files = new FileService(guard, ig, bus);
  const tools = new ToolRegistry(bus);
  const git = new GitService(config.workspaceRoot, bus);
  registerFsTools(tools, files);
  registerGitTools(tools, git);
  registerTerminalTools(tools, guard, config.workspaceRoot, log);
  const codexTools = new CodexToolBridge(tools);
  const terminals = new TerminalManager(db, bus, config.workspaceRoot);
  const hooks = new HooksEngine(db, bus, config.workspaceRoot);
  // Tasks the user asked to run without system knowledge. The code guards
  // below enforce the knowledge engine, so they step aside for those runs;
  // the consent guards (git flow, DB, dev server) never do.
  const directTasks = new DirectTaskRegistry();
  // Built-in modularity hook: one file = one function/component/class.
  // Visible in hooks.list, can be disabled there; enforced on every write.
  hooks.ensureBuiltin({
    id: MODULARITY_HOOK_ID,
    name: MODULARITY_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "write_file|replace_code|replace_many",
    action: "block",
    argument: "One file = one function/component/class",
  });
  const modularity = new ModularityGuard();
  /**
   * The one answer to "is the modularity rule live right now" — the user's
   * toggle AND this workspace actually keeping to the convention. Both the
   * write guard below and the system prompt read it, so the model is never
   * told about a rule that will not be enforced, or left unwarned about one
   * that will.
   */
  const modularityInForce = (): boolean =>
    hooks.isEnabled(MODULARITY_HOOK_ID) && followsOneSymbolPerFile(db);
  // The structural check runs in the write guard below, which sees the
  // content. Without a hook guard the engine would apply the stored "block"
  // action to every write_file/replace_code/replace_many call, so pass here
  // and let the write guard decide.
  hooks.registerGuard(MODULARITY_HOOK_ID, async () => undefined);
  files.setWriteGuard(async (relPath, nextContent, prevContent, taskId) => {
    if (!modularityInForce()) return;
    if (directTasks.has(taskId)) return;
    const verdict = await modularity.check(relPath, nextContent, prevContent);
    if (!verdict.ok) {
      bus.publish(
        "hook.blocked",
        {
          hookId: MODULARITY_HOOK_ID,
          name: MODULARITY_HOOK_NAME,
          reason: verdict.reason,
        },
        taskId
      );
      throw new Error(`Write blocked by modularity hook: ${verdict.reason}`);
    }
  });
  // Built-in git-flow hook: the agent may never commit, push, or open a
  // PR on its own — the guard blocks the attempt and the UI opens the
  // commit → push → PR wizard for the user to confirm.
  hooks.ensureBuiltin({
    id: GIT_FLOW_HOOK_ID,
    name: GIT_FLOW_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "git|run_terminal",
    action: "block",
    argument: "Git flow (commit / push / PR) must be confirmed by the user",
  });
  const gitFlowGuard = new GitFlowGuard(bus);
  hooks.registerGuard(GIT_FLOW_HOOK_ID, (ctx) => gitFlowGuard.check(ctx));
  // Built-in database hook: DB commands (migrations, clients, dumps, raw
  // DDL/DML) are parked until the user approves them in the modal.
  hooks.ensureBuiltin({
    id: DB_APPROVAL_HOOK_ID,
    name: DB_APPROVAL_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "run_terminal",
    action: "block",
    argument: "Database operations need the user's approval",
  });
  const dbApprovalGuard = new DbApprovalGuard(bus);
  hooks.registerGuard(DB_APPROVAL_HOOK_ID, (ctx) => dbApprovalGuard.check(ctx));
  // Built-in npm-family hook: every package command pauses for an explicit
  // run-or-skip choice before the agent can spend time or change files.
  hooks.ensureBuiltin({
    id: NPM_APPROVAL_HOOK_ID,
    name: NPM_APPROVAL_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "run_terminal",
    action: "block",
    argument: "Package commands need the user's approval",
  });
  hooks.registerGuard(NPM_APPROVAL_HOOK_ID, (ctx) => dbApprovalGuard.check(ctx));
  // A refusal only stands for the task it was given in; drop it when the
  // task ends so the next run asks again.
  bus.subscribe((event) => {
    const ended =
      event.topic === "task.completed" || event.topic === "task.cancelled";
    if (ended && event.taskId) dbApprovalGuard.forgetTask(event.taskId);
  });
  // Built-in dev-server hook: starting `npm run dev` / `pnpm start` a second
  // time leaves two servers up and the UI pointed at the stale one. The guard
  // refuses only when an instance is already there (port already listening,
  // or this session started it), so first-time starts are untouched.
  hooks.ensureBuiltin({
    id: DEV_SERVER_HOOK_ID,
    name: DEV_SERVER_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "run_terminal",
    action: "block",
    argument: "A dev server is already running for this project",
  });
  const devServerGuard = new DevServerGuard(bus, config.workspaceRoot);
  hooks.registerGuard(DEV_SERVER_HOOK_ID, (ctx) => devServerGuard.check(ctx));
  // Built-in impact hook: the blast radius must be checked at the edit site.
  // The pipeline's radius is computed from plan targets, before the model
  // knows the line it will touch; this refuses the first write to an
  // existing source file until impact_of_edit has been called for it.
  hooks.ensureBuiltin({
    id: IMPACT_HOOK_ID,
    name: IMPACT_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "write_file|replace_code|replace_many|impact_of_edit|analyze_impact",
    action: "block",
    argument: "Check who uses this code before editing it",
  });
  const impactGuard = new ImpactFirstGuard(
    (relPath) =>
      files
        .stat(relPath)
        .then(() => true)
        .catch(() => false),
    bus
  );
  // Direct tasks are not offered impact_of_edit at all, so gating their
  // edits on it would be a wall with no door.
  hooks.registerGuard(IMPACT_HOOK_ID, (ctx) =>
    directTasks.has(ctx.taskId)
      ? Promise.resolve(undefined)
      : impactGuard.check(ctx)
  );
  // Built-in targeted-edit hook: write_file may not restate a file that
  // was mostly already correct. Refused once per file per task, so a
  // genuine full rewrite costs one extra tool call and never the task.
  hooks.ensureBuiltin({
    id: REWRITE_HOOK_ID,
    name: REWRITE_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "write_file",
    action: "block",
    argument: "Patch with replace_code instead of rewriting the whole file",
  });
  const rewriteGuard = new TargetedEditGuard(
    (relPath) =>
      files
        .readFile(relPath)
        .then(({ content }) => content)
        .catch(() => null),
    bus
  );
  hooks.registerGuard(REWRITE_HOOK_ID, (ctx) =>
    directTasks.has(ctx.taskId)
      ? Promise.resolve(undefined)
      : rewriteGuard.check(ctx)
  );
  const knowledge = new KnowledgeQuery(db);
  const embedder = new Embedder(config.dataDir);
  const vectors = new VectorStore(db, EMBEDDING_DIMS);
  const indexer = new IncrementalIndexer(
    db,
    bus,
    guard,
    ig,
    config.workspaceRoot,
    embedder,
    vectors,
    log
  );
  const graph = new SymbolGraph(db);
  // Similarity sweep over changed code: finds parallel implementations
  // the import graph cannot reach (the "fixed here, not there" class).
  const clones = new CloneScanner(db, embedder, vectors);
  // Pre-edit blast radius: transitive callers, downstream flows, tests.
  const impactAnalyzer = new ImpactAnalyzer(db, graph, config.workspaceRoot);
  const features = new FeatureModelService(db, bus);
  features.attach(embedder, vectors);
  // Route-anchored features: scan pages/endpoints, describe each statically
  // from its reachable code (no LLM), embed into the knowledge engine.
  const routeFeatures = new RouteFeatureScanner(db, bus, files, embedder, vectors);
  const lessons = new LessonStore(db, bus, embedder, vectors);
  // The retriever caches its has-embeddings probe once it turns true; no
  // reset wiring is needed, because embeddings only ever vanish at boot
  // (the embedder-version wipe) — a fresh process with an empty cache.
  const retriever = new Retriever(db, embedder, vectors, knowledge, lessons);
  // Semantic retrieval cache: identical queries against an unchanged
  // index skip the re-embed and all retrieval arms entirely.
  const generation = new IndexGeneration(bus);
  const cachedRetriever = new CachedRetriever(retriever, generation);
  // Textual fallback for the symbol-impact analyzer: word-boundary search
  // catches dynamic/string-keyed uses the graph never resolved.
  const symbolImpact = new SymbolImpactAnalyzer(db, async (identifier) => {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = await files.search(`\\b${escaped}\\b`, undefined, 200, true);
    return matches.map((m) => ({ path: m.path, row: m.row }));
  });
  registerKnowledgeTools(
    tools,
    cachedRetriever,
    graph,
    knowledge,
    lessons,
    symbolImpact,
    bus,
    settings
  );
  const planTracker = new PlanTracker(bus);
  registerPlanTools(tools, planTracker);
  const validators = new ValidationRunners(config.workspaceRoot);
  // Every tool call — model- or UI-invoked — is gated by user hooks.
  tools.setGate(hooks);
  const watcher = new WorkspaceWatcher(bus, guard, ig, config.workspaceRoot);
  files.onAgentWrite((relPath) => watcher.markAgentWrite(relPath));
  watcher.onChange(() => git.scheduleRefresh());
  // Every file change — user or agent — flows into the knowledge engine.
  watcher.onChange((relPath) => indexer.enqueueFile(relPath));
  // Live plan usage: SDK rate-limit events during tasks + an idle probe
  // that also catches spend from other machines.
  const usage = new UsageMonitor(bus, config.workspaceRoot);
  // Context-engineering accounting: estimated assembly cost + SDK actuals.
  const ledger = new TokenLedger(db, bus);
  // Token-budgeted context assembly through the compression ladder, with
  // cross-turn dedup and compressed conversation memory.
  const sentChunks = new SentChunkStore(db);
  // Saving a session memory changes what retrieval can return, so it has to
  // invalidate the retrieval cache the same way re-indexing a file does.
  const taskSummaries = new TaskSummaryStore(db, embedder, vectors, () =>
    generation.bump()
  );
  const globalSessions = new GlobalSessionStore(
    db,
    conversations,
    embedder,
    vectors,
    () => generation.bump()
  );
  const sharedSessions = new SharedSessionContextBuilder({
    conversations,
    summaries: taskSummaries,
  });
  const assembler = new PromptAssembler({ db, ledger, sent: sentChunks });
  const skillLoader = new SkillLoader(config.workspaceRoot, settings);
  // Keeps a markdown note picked in the composer in step with its task:
  // in-progress on start, review plus an appended report on finish.
  const notes = new NoteJournal({
    files,
    workspaceRoot: config.workspaceRoot,
    log,
  });
  // Attached images outlive the turn that carried them: the bytes go to
  // disk and the path rides in context and session memory, so a follow-up
  // ("what's on the image?") opens the picture instead of guessing.
  const attachments = new AttachmentStore(config.dataDir, log);
  // The working-set lock: "@folder" in a prompt narrows retrieval, the
  // prompt's directory map, and git routing for the whole conversation.
  const scope = new SessionScopeStore(db, config.workspaceRoot, guard);
  const scopeGuard = new ScopeGuard();
  tools.setScopeGuard(scopeGuard);
  const orchestrator = new Orchestrator({
    config,
    db,
    bus,
    tools,
    files,
    scope,
    scopeGuard,
    ignore: ig,
    git,
    retriever: cachedRetriever,
    graph,
    clones,
    impact: impactAnalyzer,
    indexer,
    hooks,
    directTasks,
    modularityInForce,
    validators,
    planTracker,
    settings,
    usage,
    ledger,
    assembler,
    summaries: taskSummaries,
    sharedSessions,
    globalSessions,
    codexTools,
    skillLoader,
    conversations,
    notes,
    attachments,
    log,
  });

  const router = new Router();
  registerSessionHandlers(
    router,
    config,
    conversations,
    orchestrator,
    timeline,
    settings
  );
  registerFsHandlers(router, files);
  // The user's model choice, read fresh each time so background work picks
  // up a switch without a restart. An "ollama/" id routes eligible model
  // calls, including the main tool loop, through Ollama.
  const selectedModel = () => settings.get().model;
  registerGitHandlers(router, git, selectedModel);
  registerProviderHandlers(router, settings, config.workspaceRoot);
  registerTerminalHandlers(
    router,
    terminals,
    config.workspaceRoot,
    cliSessionDiffs
  );
  registerHookHandlers(router, hooks, dbApprovalGuard);
  router.register("usage.get", async (params) => ({
    usage: params?.refresh ? await usage.refresh() : usage.current,
  }));
  router.register("context.stats", async (params) =>
    ledger.query(params?.conversationId, params?.limit ?? 50)
  );
  // Live model roster for the composer's picker: whatever the providers
  // switched on in Settings currently offer. Assembled in one place so the
  // toggles there and the picker here can never disagree — see roster.ts
  // for the caching and filtering rules.
  router.register("models.list", async () => ({
    models: await pickerRoster(config.workspaceRoot),
  }));
  // The user's own standing rules — markdown files under .atelier/rules
  // that ride along with every run. Registered here rather than with the
  // misc handlers because they are workspace files, not agent settings.
  router.register("rules.list", async () => ({
    rules: await listUserRules(config.workspaceRoot),
  }));
  router.register("rules.create", async (params) => ({
    rule: await createUserRule(config.workspaceRoot, params.name),
  }));
  router.register("rules.setEnabled", async (params) => ({
    rule: await setUserRuleEnabled(
      config.workspaceRoot,
      params.path,
      params.enabled
    ),
  }));
  router.register("rules.delete", async (params) => {
    await deleteUserRule(config.workspaceRoot, params.path);
    return { ok: true };
  });
  registerMiscHandlers(
    router,
    knowledge,
    indexer,
    cachedRetriever,
    graph,
    features,
    routeFeatures,
    lessons,
    validators,
    bus,
    settings
  );

  watcher.start();
  // Seed the snapshot and emit the initial git.state.changed.
  void git.start().then(() => git.refresh());
  // The knowledge engine catches up in the background: recover the job
  // queue, scan for drift, then keep learning from watcher events.
  void indexer.start().catch((error) => {
    log.error({ err: error }, "knowledge indexer failed to start");
  });
  // Feature models: background seeding + stale refresh, paused while any
  // interactive task runs so it never competes with the user's session.
  features.setBusyProbe(() => orchestrator.listRunningTaskIds().length > 0);
  features.setModelSelector(selectedModel);
  features.start();
  usage.setBusyProbe(() => orchestrator.listRunningTaskIds().length > 0);
  usage.start();

  const auth = probeAuth();
  bus.publish("agent.status", { status: auth.status, detail: auth.detail });
  if (auth.status === "waiting-auth") {
    log.warn(auth.detail);
  }

  const shutdown = (): void => {
    log.info("shutting down agent runtime");
    usage.stop();
    features.stop();
    indexer.stop();
    codexTools.stop();
    watcher.stop();
    git.stop();
    terminals.shutdown();
    db.close();
  };

  return { router, bus, timeline, orchestrator, shutdown };
}
