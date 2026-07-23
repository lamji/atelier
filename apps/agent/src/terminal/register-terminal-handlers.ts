import type { Router } from "../bridge/router.js";
import type { TerminalManager } from "./terminal-manager.js";

export function registerTerminalHandlers(
  router: Router,
  terminals: TerminalManager
): void {
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

  router.register("terminal.list", () => ({ sessions: terminals.list() }));

  router.register("terminal.getHistory", (params) => ({
    data: terminals.getHistory(params.termId),
  }));
}
