import { freePort } from "@atelier/shared/node";
import type { Router } from "../bridge/router.js";
import type { CliSessionDiffRepo } from "../storage/repositories/cli-session-diffs.js";
import { listCliHistory } from "./cli-history.js";
import type { TerminalManager } from "./terminal-manager.js";

export function registerTerminalHandlers(
  router: Router,
  terminals: TerminalManager,
  workspaceRoot: string,
  sessionDiffs: CliSessionDiffRepo
): void {
  router.register("terminal.freePort", async (params) => ({
    port: await freePort(
      params.start,
      params.span,
      new Set(params.exclude ?? [])
    ),
  }));

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
  router.register("cli.history", async (params) => ({
    entries: await listCliHistory(
      workspaceRoot,
      params?.providerId,
      params?.limit
    ),
  }));

  router.register("cli.diff.get", (params) => ({
    changes: sessionDiffs.get(params.providerId, params.sessionId),
  }));

  router.register("cli.diff.save", (params) => {
    sessionDiffs.save(params.providerId, params.sessionId, params.changes);
    return { ok: true };
  });
}
