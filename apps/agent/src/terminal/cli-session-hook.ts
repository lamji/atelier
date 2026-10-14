import fs from "node:fs";
import path from "node:path";

/**
 * The hooks Claude and Codex sessions started from the app run: at
 * SessionStart, the app skills and the session's reports; before each file
 * edit (PreToolUse), a tree-sitter impact check of what the edit can break
 * (the impact-check skill). Neither ever blocks anything.
 *
 * Nothing goes into ~/.claude or ~/.codex: each CLI is handed the hook on
 * its own command line. Claude reads it from a settings file passed with
 * `--settings`; Codex from `-c` overrides. The hook itself is a script that
 * ships inside the app (`cli-hooks/session-start.mjs`) and runs on the
 * app's own runtime - Electron as Node - so it needs nothing installed.
 *
 * Measured against the installed CLIs: Claude runs the hook when the
 * session starts, in Git Bash on Windows; Codex 0.162 runs it with the
 * session's first turn, in Windows PowerShell.
 */

type Platform = NodeJS.Platform;

export interface CliLaunchFlags {
  /** Appended to `claude`: the skills folder and the hook settings. */
  claude: string;
  /** Appended to `codex`: the hook, as config overrides. */
  codex: string;
}

/** The hook scripts and the Windows wrappers Codex calls, in the app. */
function hookFiles(root: string, platform: Platform) {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return {
    script: join(root, "hooks", "session-start.mjs"),
    codexCmd: join(root, "hooks", "codex-session-start.cmd"),
    impact: join(root, "hooks", "edit-impact.mjs"),
    codexImpactCmd: join(root, "hooks", "codex-edit-impact.cmd"),
  };
}

/**
 * Codex's hook, as the `-c` value its config parser reads.
 *
 * Windows: the CLI is launched from Windows PowerShell 5.1, which wraps a
 * native argument containing a space in quotes and drops the double quotes
 * inside it. So the value has neither: TOML literal strings, and a command
 * that calls a wrapper whose path comes from the environment.
 */
function codexHookValue(
  platform: Platform,
  event: "SessionStart" | "PreToolUse" | "PostToolUse",
  vars: { windows: string; script: string }
): string {
  if (platform === "win32") {
    return (
      `hooks.${event}=[{hooks=[{type='command',` +
      `command='&$env:${vars.windows}'}]}]`
    );
  }
  const command =
    'ELECTRON_RUN_AS_NODE=1 \\"$ATELIER_HOOK_NODE\\" ' +
    `\\"$${vars.script}\\" codex`;
  return `hooks.${event}=[{hooks=[{type="command",command="${command}"}]}]`;
}

/** `value` quoted for the shell a CLI pty runs: PowerShell or POSIX. */
function shellQuote(value: string, platform: Platform): string {
  if (platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What to add to each CLI's launch command, typed into the pty's shell.
 * With no app skills there is nothing to load, so nothing is added.
 */
export function cliLaunchFlags(args: {
  platform: Platform;
  root: string | null;
  claudeSettings: string;
}): CliLaunchFlags {
  const { platform, root, claudeSettings } = args;
  if (!root) return { claude: "", codex: "" };
  const sessionStart = codexHookValue(platform, "SessionStart", {
    windows: "ATELIER_SESSION_HOOK",
    script: "ATELIER_HOOK_SCRIPT",
  });
  // No matcher: Codex's patch tool is told apart by its input, in the script,
  // which also reads from the event whether the edit is about to happen or
  // has just happened.
  const impact = { windows: "ATELIER_EDIT_HOOK", script: "ATELIER_IMPACT_SCRIPT" };
  const preToolUse = codexHookValue(platform, "PreToolUse", impact);
  const postToolUse = codexHookValue(platform, "PostToolUse", impact);
  const hooks = [sessionStart, preToolUse, postToolUse]
    .map((value) => `-c ${shellQuote(value, platform)}`)
    .join(" ");
  return {
    claude: `--add-dir "${root}" --settings "${claudeSettings}"`,
    codex: `-c features.codex_hooks=true ${hooks}`,
  };
}

/** Forward slashes: Git Bash keeps them, and has no use for the others. */
function bashPath(file: string): string {
  return file.replace(/\\/g, "/");
}

/** Claude's tools that write a file, which the impact check runs before. */
const CLAUDE_EDIT_TOOLS = "Edit|MultiEdit|Write";

/** The settings Claude is launched with: the SessionStart and edit hooks. */
export function claudeHookSettings(args: {
  node: string;
  script: string;
  impact: string;
}) {
  const run = (script: string) =>
    `ELECTRON_RUN_AS_NODE=1 "${bashPath(args.node)}" ` +
    `"${bashPath(script)}" claude`;
  // Before an edit: what it can break. After it: the code just written.
  const impact = [
    {
      matcher: CLAUDE_EDIT_TOOLS,
      hooks: [{ type: "command", command: run(args.impact) }],
    },
  ];
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: run(args.script) }] }],
      PreToolUse: impact,
      PostToolUse: impact,
    },
  };
}

/**
 * Where the hook lives, for the environment of every pty. Codex's hook
 * command names only these variables, which is what keeps its launch
 * arguments free of paths.
 */
export function sessionHookEnv(args: {
  platform: Platform;
  node: string;
  root: string | null;
}): Record<string, string> {
  if (!args.root) return {};
  const files = hookFiles(args.root, args.platform);
  const env: Record<string, string> = {
    ATELIER_HOOK_NODE: args.node,
    ATELIER_HOOK_SCRIPT: files.script,
  };
  if (args.platform === "win32") env.ATELIER_SESSION_HOOK = files.codexCmd;
  // Also how the impact-check skill runs its --diff check by hand.
  env.ATELIER_IMPACT_SCRIPT = files.impact;
  if (args.platform === "win32") env.ATELIER_EDIT_HOOK = files.codexImpactCmd;
  return env;
}

/**
 * Get both CLIs ready to load the hook: write Claude's settings file into
 * the app's data folder, and put the hook's location in this process's
 * environment, which every pty inherits. Returns the launch flags.
 */
export function prepareSessionHook(args: {
  root: string | null;
  dataRoot: string;
  node?: string;
  platform?: Platform;
}): CliLaunchFlags {
  const platform = args.platform ?? process.platform;
  const node = args.node ?? process.execPath;
  const claudeSettings = path.join(args.dataRoot, "cli", "claude-session-hook.json");
  if (!args.root || !fs.existsSync(hookFiles(args.root, platform).script)) {
    return { claude: args.root ? `--add-dir "${args.root}"` : "", codex: "" };
  }
  const { script, impact } = hookFiles(args.root, platform);
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify(claudeHookSettings({ node, script, impact }), null, 2)
  );
  Object.assign(process.env, sessionHookEnv({ platform, node, root: args.root }));
  return cliLaunchFlags({ platform, root: args.root, claudeSettings });
}
