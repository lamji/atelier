import { freePort, hasCommand } from "@atelier/shared/node";
import type { Router } from "../bridge/router.js";
import type { CliSessionDiffRepo } from "../storage/repositories/cli-session-diffs.js";
import type { CliSessionHistoryRepo } from "../storage/repositories/cli-session-history.js";
import { scanCliHistoryPage, suggestCliSessionTitle } from "./cli-history.js";
import type { TerminalManager } from "./terminal-manager.js";

export function registerTerminalHandlers(
  router: Router,
  terminals: TerminalManager,
  workspaceRoot: string,
  sessionDiffs: CliSessionDiffRepo,
  sessionHistory: CliSessionHistoryRepo
): void {
  router.register("terminal.freePort", async (params) => ({
    port: await freePort(
      params.start,
      params.span,
      new Set(params.exclude ?? [])
    ),
  }));

  router.register("terminal.hasCommand", async (params) => {
    const available: Record<string, boolean> = {};
    await Promise.all(
      [...new Set(params.commands)].map(async (name) => {
        available[name] = await hasCommand(name);
      })
    );
    return { available };
  });

  router.register("terminal.create", (params) => ({
    session: terminals.create(params),
  }));

  router.register("terminal.write", (params) => {
    terminals.write(params.termId, params.data);
    return {};
  });

  router.register("terminal.resize", (params) => {
    terminals.resize(params.termId, params.cols, params.rows);
    return {};
  });

  router.register("terminal.kill", (params) => {
    terminals.kill(params.termId);
    return {};
  });

  router.register("terminal.interrupt", async (params) => ({
    killed: await terminals.interrupt(params.termId),
  }));

  router.register("terminal.list", () => ({ sessions: terminals.list() }));

  router.register("terminal.getHistory", (params) => ({
    data: terminals.getHistory(params.termId),
  }));

  // Not a pty at all: the CLI providers' own past sessions, so CLI mode can
  // list every session for this project and not just the ones it started.
  router.register("cli.history", async (params) => {
    const offset = Math.max(params?.offset ?? 0, 0);
    const limit = Math.min(Math.max(params?.limit ?? 30, 1), 50);
    const scan = await scanCliHistoryPage(workspaceRoot, params?.providerId, offset, limit);
    sessionHistory.save(scan.entries, workspaceRoot);
    const visible = offset + limit;
    return {
      entries: sessionHistory.list(workspaceRoot, params?.providerId, visible),
      hasMore: scan.hasMore || sessionHistory.count(workspaceRoot, params?.providerId) > visible,
    };
  });

  router.register("cli.title.autoRename", async ({ providerId, sessionId }) => {
    const title = await suggestCliSessionTitle(workspaceRoot, providerId, sessionId);
    if (!title) throw new Error("No conversation context is available yet. Send a request, then try /rename again.");
    sessionHistory.setCustomTitle(providerId, sessionId, workspaceRoot, title);
    return { title };
  });

  router.register("cli.diff.get", (params) => ({
    changes: sessionDiffs.get(params.providerId, params.sessionId),
  }));

  router.register("cli.diff.save", (params) => {
    sessionDiffs.save(params.providerId, params.sessionId, params.changes);
    return { ok: true };
  });
}
