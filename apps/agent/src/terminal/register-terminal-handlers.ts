import { atelierDataRoot, freePort, hasCommand } from "@atelier/shared/node";
import type { Router } from "../bridge/router.js";
import type { CliSessionDiffRepo } from "../storage/repositories/cli-session-diffs.js";
import type { CliSessionHistoryRepo } from "../storage/repositories/cli-session-history.js";
import { scanCliHistoryPage, suggestCliSessionTitle } from "./cli-history.js";
import { listCliDocs } from "./cli-docs.js";
import { cliSkillPaths } from "./cli-skills.js";
import { cliTurnDir, prepareSessionHook } from "./cli-session-hook.js";
import { linkCodexSkills } from "./codex-skill-links.js";
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

  router.register("terminal.prewarm", () => {
    terminals.prewarm();
    return {};
  });

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

  // Ready before any CLI starts: the hook's location is in the env every
  // pty inherits, and Claude's settings file is on disk.
  const cliSkills = cliSkillPaths();
  // In Codex's `$` menu like its own skills, by links into the app. A
  // linked skill is run in Codex by its `$name`, with no path to the app.
  const codexNative = linkCodexSkills(cliSkills.skills);
  const offeredSkills = {
    ...cliSkills,
    skills: cliSkills.skills.map((skill) => ({
      ...skill,
      codexNative: codexNative.has(skill.name),
    })),
  };
  let launch = { claude: "", codex: "" };
  try {
    launch = prepareSessionHook({
      root: cliSkills.root,
      dataRoot: atelierDataRoot(),
    });
  } catch {
    // No hook, but the skills still load where the CLI can load them.
    if (cliSkills.root) launch.claude = `--add-dir "${cliSkills.root}"`;
  }
  // The turn-end hook's markers say when a CLI turn ended; without the hook
  // (no app skills) nothing is written and the UI reads the screen instead.
  terminals.watchTurnEnds(cliTurnDir(atelierDataRoot()));
  router.register("cli.skills", () => ({ ...offeredSkills, launch }));

  router.register("cli.docs.list", async () => ({
    docs: await listCliDocs(workspaceRoot),
  }));

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
    sessionDiffs.save(
      params.providerId,
      params.sessionId,
      params.changes,
      params.dirtyPaths
    );
    return { ok: true };
  });
}
