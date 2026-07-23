import pino from "pino";
import { loadConfig } from "./config/agent-config.js";
import { createBridgeInfo, bridgeInfoPath } from "./config/token.js";
import { EventBus } from "./events/event-bus.js";
import { TimelineStore } from "./events/timeline-store.js";
import { openDb } from "./storage/db.js";
import { ConversationRepo } from "./storage/repositories/conversations.js";
import { SettingsRepo } from "./storage/repositories/settings.js";
import { Router } from "./bridge/router.js";
import { EventHub } from "./bridge/event-hub.js";
import { BridgeServer } from "./bridge/server.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
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
import { WorkspaceIgnore } from "./workspace/ignore.js";
import { FileService } from "./workspace/file-service.js";
import { registerFsHandlers } from "./workspace/register-fs-handlers.js";
import { WorkspaceWatcher } from "./workspace/watcher.js";
import { HooksEngine } from "./hooks/hooks-engine.js";
import { KnowledgeQuery } from "./knowledge/query/knowledge-query.js";

const log = pino({
  transport: process.stdout.isTTY ? { target: "pino-pretty" } : undefined,
  level: process.env.LOG_LEVEL ?? "info",
});

function main(): void {
  const config = loadConfig();
  log.info({ workspaceRoot: config.workspaceRoot }, "starting atelier agent");

  const db = openDb(config.dataDir);
  const bus = new EventBus();
  const timeline = new TimelineStore(db, bus);
  const conversations = new ConversationRepo(db);
  const settings = new SettingsRepo(db, {
    workspaceRoot: config.workspaceRoot,
    ignoreGlobs: [],
    maxValidationRetries: 2,
  });

  const guard = new PathGuard(config.workspaceRoot);
  const ig = new WorkspaceIgnore(config.workspaceRoot, settings.get().ignoreGlobs);
  const files = new FileService(guard, ig, bus);
  const tools = new ToolRegistry(bus);
  const git = new GitService(config.workspaceRoot, bus);
  registerFsTools(tools, files);
  registerGitTools(tools, git);
  registerTerminalTools(tools, guard, config.workspaceRoot);
  const terminals = new TerminalManager(db, bus, config.workspaceRoot);
  const hooks = new HooksEngine(db, bus);
  const knowledge = new KnowledgeQuery(db);
  const watcher = new WorkspaceWatcher(bus, guard, ig, config.workspaceRoot);
  files.onAgentWrite((relPath) => watcher.markAgentWrite(relPath));
  watcher.onChange(() => git.scheduleRefresh());
  const orchestrator = new Orchestrator(config, bus, conversations, tools, log);

  const router = new Router();
  registerSessionHandlers(router, config, conversations, orchestrator, timeline);
  registerFsHandlers(router, files);
  registerGitHandlers(router, git);
  registerTerminalHandlers(router, terminals);
  registerMiscHandlers(router, hooks, knowledge, settings);

  const info = createBridgeInfo(config);
  const hub = new EventHub(bus, timeline);
  const server = new BridgeServer(config, info, router, hub, log);
  server.start();
  watcher.start();
  // Seed the snapshot and emit the initial git.state.changed.
  void git.start().then(() => git.refresh());

  const auth = probeAuth();
  bus.publish("agent.status", { status: auth.status, detail: auth.detail });
  if (auth.status === "waiting-auth") {
    log.warn(auth.detail);
  }
  log.info(`bridge info written to ${bridgeInfoPath(config)}`);

  const shutdown = (): void => {
    log.info("shutting down");
    watcher.stop();
    git.stop();
    terminals.shutdown();
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
