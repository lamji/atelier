import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  claudeHookSettings,
  cliLaunchFlags,
  sessionHookEnv,
} from "./cli-session-hook.js";

const hookScript = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  "../../cli-hooks/session-start.mjs"
);

/** PowerShell 5.1's argument passing: what reaches the CLI for a 'quoted' arg. */
function powershellSingleQuoted(arg: string): string {
  assert.match(arg, /^'.*'$/s);
  return arg.slice(1, -1).replace(/''/g, "'");
}

test("Windows: Codex gets its hook as arguments PowerShell 5.1 passes intact", () => {
  const flags = cliLaunchFlags({
    platform: "win32",
    root: "C:\\Users\\A B\\Atelier\\cli-skills",
    claudeSettings: "C:\\Users\\A B\\atelier\\cli\\claude-session-hook.json",
  });
  assert.equal(
    flags.claude,
    '--add-dir "C:\\Users\\A B\\Atelier\\cli-skills" ' +
      '--settings "C:\\Users\\A B\\atelier\\cli\\claude-session-hook.json"'
  );
  const [feature, memories, ...hooks] = flags.codex
    .split(" -c ")
    .map((part) => part.replace(/^-c /, ""));
  assert.equal(feature, "features.codex_hooks=true");
  // Codex's global memory is off: the workspace's own memory stands in.
  assert.equal(memories, "features.memories=false");
  const values = hooks.map(powershellSingleQuoted);
  // PowerShell 5.1 re-quotes a native argument that has a space and drops
  // its inner double quotes, so the values may carry neither.
  for (const value of values) assert.doesNotMatch(value, /[\s"]/);
  assert.deepEqual(values, [
    "hooks.SessionStart=[{hooks=[{type='command'," +
      "command='&$env:ATELIER_SESSION_HOOK'}]}]",
    // Before every tool call; the script answers only for apply_patch.
    "hooks.PreToolUse=[{hooks=[{type='command'," +
      "command='&$env:ATELIER_EDIT_HOOK'}]}]",
    // When a turn ends: tells Atelier which terminal it was.
    "hooks.Stop=[{hooks=[{type='command'," +
      "command='&$env:ATELIER_TURN_HOOK'}]}]",
  ]);
});

test("POSIX shells: Codex runs the in-app script with the app's own runtime", () => {
  const flags = cliLaunchFlags({
    platform: "darwin",
    root: "/Applications/Atelier.app/cli-skills",
    claudeSettings: "/Users/a/.local/share/atelier/cli/claude-session-hook.json",
  });
  assert.equal(
    flags.claude,
    '--add-dir "/Applications/Atelier.app/cli-skills" ' +
      '--settings "/Users/a/.local/share/atelier/cli/claude-session-hook.json"'
  );
  assert.equal(
    flags.codex,
    "-c features.codex_hooks=true -c features.memories=false -c " +
      "'hooks.SessionStart=[{hooks=[{type=\"command\",command=" +
      '"ELECTRON_RUN_AS_NODE=1 \\"$ATELIER_HOOK_NODE\\" ' +
      '\\"$ATELIER_HOOK_SCRIPT\\" codex"}]}]\' -c ' +
      "'hooks.PreToolUse=[{hooks=[{type=\"command\",command=" +
      '"ELECTRON_RUN_AS_NODE=1 \\"$ATELIER_HOOK_NODE\\" ' +
      '\\"$ATELIER_IMPACT_SCRIPT\\" codex"}]}]\' -c ' +
      "'hooks.Stop=[{hooks=[{type=\"command\",command=" +
      '"ELECTRON_RUN_AS_NODE=1 \\"$ATELIER_HOOK_NODE\\" ' +
      '\\"$ATELIER_TURN_SCRIPT\\" codex"}]}]\''
  );
});

test("no app skills means nothing to load and no flags", () => {
  const flags = cliLaunchFlags({
    platform: "win32",
    root: null,
    claudeSettings: "C:\\x.json",
  });
  assert.deepEqual(flags, { claude: "", codex: "" });
});

test("Claude's settings: skills at start, impact on edits, turn-end marker", () => {
  const settings = claudeHookSettings({
    node: "C:\\Users\\A B\\Atelier\\Atelier.exe",
    script: "C:\\Users\\A B\\Atelier\\cli-skills\\hooks\\session-start.mjs",
    impact: "C:\\Users\\A B\\Atelier\\cli-skills\\hooks\\edit-impact.mjs",
    turnEnd: "C:\\Users\\A B\\Atelier\\cli-skills\\hooks\\turn-end.mjs",
  });
  assert.deepEqual(settings, {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command:
                'ELECTRON_RUN_AS_NODE=1 "C:/Users/A B/Atelier/Atelier.exe" ' +
                '"C:/Users/A B/Atelier/cli-skills/hooks/session-start.mjs" claude',
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Edit|MultiEdit|Write",
          hooks: [
            {
              type: "command",
              command:
                'ELECTRON_RUN_AS_NODE=1 "C:/Users/A B/Atelier/Atelier.exe" ' +
                '"C:/Users/A B/Atelier/cli-skills/hooks/edit-impact.mjs" claude',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                'ELECTRON_RUN_AS_NODE=1 "C:/Users/A B/Atelier/Atelier.exe" ' +
                '"C:/Users/A B/Atelier/cli-skills/hooks/turn-end.mjs" claude',
            },
          ],
        },
      ],
    },
  });
});

test("the CLI ptys carry where the hook lives", () => {
  assert.deepEqual(
    sessionHookEnv({
      platform: "win32",
      node: "C:\\A\\Atelier.exe",
      root: "C:\\A\\cli-skills",
      turnDir: "C:\\data\\cli\\turns",
    }),
    {
      ATELIER_HOOK_NODE: "C:\\A\\Atelier.exe",
      ATELIER_HOOK_SCRIPT: "C:\\A\\cli-skills\\hooks\\session-start.mjs",
      ATELIER_SESSION_HOOK: "C:\\A\\cli-skills\\hooks\\codex-session-start.cmd",
      ATELIER_IMPACT_SCRIPT: "C:\\A\\cli-skills\\hooks\\edit-impact.mjs",
      ATELIER_EDIT_HOOK: "C:\\A\\cli-skills\\hooks\\codex-edit-impact.cmd",
      ATELIER_TURN_SCRIPT: "C:\\A\\cli-skills\\hooks\\turn-end.mjs",
      ATELIER_TURN_DIR: "C:\\data\\cli\\turns",
      ATELIER_TURN_HOOK: "C:\\A\\cli-skills\\hooks\\codex-turn-end.cmd",
    }
  );
  assert.deepEqual(
    sessionHookEnv({
      platform: "linux",
      node: "/x/node",
      root: null,
      turnDir: "/data/cli/turns",
    }),
    {}
  );
});

/** A workspace with the app skills and the reports a session left. */
function fixture(): { cwd: string; skills: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-hook-"));
  const skills = path.join(base, "cli-skills", ".claude", "skills");
  const shipped: Array<[string, string]> = [
    ["atelier-impact-check", "Prevent regressions when changing code."],
    ["atelier-init-feature", "Trace a code flow and save the report."],
    ["atelier-re-init-feature", "Read saved reports back into context."],
  ];
  for (const [name, description] of shipped) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(
      path.join(skills, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`
    );
  }
  const cwd = path.join(base, "ws");
  const docs = path.join(cwd, ".atelier", "doc-agent");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(
    path.join(docs, "20261014-1-login-flow.md"),
    "---\nid: 20261014-1-login-flow\nsession: sess-1\ntitle: Login Flow\n---\n"
  );
  fs.writeFileSync(
    path.join(docs, "20261014-2-checkout.md"),
    "---\nid: 20261014-2-checkout\nsession: other\ntitle: Checkout — café\n---\n"
  );
  return { cwd, skills };
}

function runHook(
  provider: string,
  stdin: string | null,
  env: Record<string, string>
): Promise<{ out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript, provider], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve({ out, ms: Date.now() - started }));
    // null: stdin is left open and never written, as a shell may leave it.
    if (stdin !== null) child.stdin.end(stdin);
  });
}

test("the hook hands the agent the skills and this session's reports", async () => {
  const { cwd, skills } = fixture();
  const input = JSON.stringify({
    session_id: "sess-1",
    source: "compact",
    cwd,
    hook_event_name: "SessionStart",
  });
  const { out } = await runHook("claude", input, {
    ATELIER_HOOK_SKILLS: skills,
  });
  // Codex reads it through Windows PowerShell, which re-encodes non-ASCII.
  assert.doesNotMatch(out, /[^\x00-\x7f]/);
  const result = JSON.parse(out);
  assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  const context: string = result.hookSpecificOutput.additionalContext;
  assert.match(context, /\/atelier-init-feature: Trace a code flow/);
  assert.match(context, /\/atelier-re-init-feature: Read saved reports/);
  // No path into the app: an agent took the app's folder for the project.
  assert.doesNotMatch(context, /SKILL\.md/);
  assert.match(context, /not part of this\s+project/);
  assert.match(context, /\.atelier\/doc-agent/);
  // After a compact, this session's own report is re-loaded in full, by
  // itself; another session's report is not.
  assert.match(context, /just compacted/);
  assert.match(context, /=== \.atelier\/doc-agent\/20261014-1-login-flow\.md ===/);
  assert.match(context, /title: Login Flow/);
  assert.doesNotMatch(context, /title: Checkout/);
  assert.match(result.systemMessage, /re-loaded 1 report\(s\) after the compact/);
  // Background, not a line the agent has to open its reply with.
  assert.doesNotMatch(context, /begin your next reply/i);
  // The status line names the skills offered, not the before-edit hook.
  assert.match(
    result.systemMessage,
    new RegExp(
      "loaded app skills: atelier-init-feature, atelier-re-init-feature; " +
        "workspace memory: empty;"
    )
  );
  // The reports are the evidence: a cause is named from a trace, never a guess.
  assert.match(context, /Evidence rule/);
  assert.match(context, /before naming a cause/i);
  assert.match(context, /unverified/i);
  assert.match(context, /environment/i);

  // The report that it happened, per session start.
  const log = path.join(cwd, ".atelier", "session-start.log");
  const [record] = fs.readFileSync(log, "utf8").trim().split("\n").map((line) =>
    JSON.parse(line)
  );
  assert.equal(record.provider, "claude");
  assert.equal(record.session, "sess-1");
  assert.equal(record.source, "compact");
  assert.deepEqual(record.skills, [
    "atelier-impact-check",
    "atelier-init-feature",
    "atelier-re-init-feature",
  ]);
  assert.deepEqual(record.reports, ["20261014-1-login-flow"]);
});

test("the hook does not wait forever on a stdin nobody closes", async () => {
  const { cwd, skills } = fixture();
  const { out, ms } = await runHook("codex", null, {
    ATELIER_HOOK_SKILLS: skills,
    ATELIER_HOOK_CWD: cwd,
  });
  assert.ok(ms < 5000, `took ${ms} ms`);
  const result = JSON.parse(out);
  const context: string = result.hookSpecificOutput.additionalContext;
  assert.match(context, /\$atelier-init-feature: Trace a code flow/);
  // A new session has no reports to read back.
  assert.doesNotMatch(context, /just compacted/);
  assert.doesNotMatch(context, /=== \.atelier/);
  // The impact check is a hook before each edit, not a skill to offer.
  assert.doesNotMatch(context, /atelier-impact-check/);
  const log = fs.readFileSync(
    path.join(cwd, ".atelier", "session-start.log"),
    "utf8"
  );
  assert.match(log, /"provider":"codex"/);
});

test("the hook reads the workspace's own memory into the session", async () => {
  const { cwd, skills } = fixture();
  const memory = path.join(cwd, ".atelier", "memory");
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(
    path.join(memory, "no-redis-locally.md"),
    "---\nname: no-redis-locally\ndescription: Local runs have no Redis\n" +
      "type: correction\n---\n\nLocal serves KPIs from snapshot + live only.\n"
  );
  const { out } = await runHook("codex", null, {
    ATELIER_HOOK_SKILLS: skills,
    ATELIER_HOOK_CWD: cwd,
  });
  const result = JSON.parse(out);
  const context: string = result.hookSpecificOutput.additionalContext;
  // Memory is context, not a file read, so the status line shows it.
  assert.match(result.systemMessage, /workspace memory: 1 entry checked$/);
  assert.match(context, /Project memory/);
  assert.match(context, /\[correction\] no-redis-locally: Local runs have no Redis/);
  assert.match(context, /snapshot \+ live only/);
  // Memory guides where to look; it never stands in for a trace.
  assert.match(context, /never\s+evidence for a cause/);
  assert.match(context, /Never save task progress/);
});

test("memory is checked against the workspace before the session starts", async () => {
  const { cwd, skills } = fixture();
  const memory = path.join(cwd, ".atelier", "memory");
  fs.mkdirSync(memory, { recursive: true });
  fs.mkdirSync(path.join(cwd, "api", "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "api", "src", "app.ts"), "");
  fs.writeFileSync(
    path.join(cwd, "api", ".env"),
    "PORT=5055\nREDIS_URL=rediss://default:hunter2-secret@127.0.0.1:6378\n" +
      "API_KEY=abc\nPORT=5056\n"
  );
  fs.writeFileSync(
    path.join(memory, "redis-local.md"),
    "---\nname: redis-local\ndescription: Redis runs locally\ntype: environment\n" +
      "---\n\nEntry is `src/app.ts`; old code was `api/src/gone.ts`.\n" +
      "Port is `PORT`. Slug `org/repo` and command `\ir` are not paths.\n"
  );
  const { out } = await runHook("claude", null, {
    ATELIER_HOOK_SKILLS: skills,
    ATELIER_HOOK_CWD: cwd,
  });
  const result = JSON.parse(out);
  const context: string = result.hookSpecificOutput.additionalContext;
  const checked = context
    .split("\n")
    .filter((line) => line.includes("checked now:"))
    .join("\n");
  // Paths are looked up in the workspace and its repos.
  assert.match(checked, /1 named path\(s\) exist/);
  assert.match(checked, /may be stale: api\/src\/gone\.ts/);
  assert.doesNotMatch(checked, /org\/repo|\ir/);
  // Settings come from the .env files; the last definition wins.
  assert.match(checked, /PORT=5056/);
  assert.doesNotMatch(checked, /PORT=5055/);
  // The topic (`redis-...`) finds REDIS_* even unnamed, with no password.
  assert.match(checked, /REDIS_URL=rediss:\/\/\*\*\*@127\.0\.0\.1:6378/);
  assert.doesNotMatch(context, /hunter2/);
  assert.doesNotMatch(context, /API_KEY/);
  assert.match(result.systemMessage, /1 entry checked, 1 may be stale/);
});
