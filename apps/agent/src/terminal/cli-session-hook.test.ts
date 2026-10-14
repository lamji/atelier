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
  const [feature, ...hooks] = flags.codex.split(" -c ").map((part) =>
    part.replace(/^-c /, "")
  );
  assert.equal(feature, "features.codex_hooks=true");
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
    // After every tool call: the impact of the code just written.
    "hooks.PostToolUse=[{hooks=[{type='command'," +
      "command='&$env:ATELIER_EDIT_HOOK'}]}]",
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
    "-c features.codex_hooks=true -c " +
      "'hooks.SessionStart=[{hooks=[{type=\"command\",command=" +
      '"ELECTRON_RUN_AS_NODE=1 \\"$ATELIER_HOOK_NODE\\" ' +
      '\\"$ATELIER_HOOK_SCRIPT\\" codex"}]}]\' -c ' +
      "'hooks.PreToolUse=[{hooks=[{type=\"command\",command=" +
      '"ELECTRON_RUN_AS_NODE=1 \\"$ATELIER_HOOK_NODE\\" ' +
      '\\"$ATELIER_IMPACT_SCRIPT\\" codex"}]}]\' -c ' +
      "'hooks.PostToolUse=[{hooks=[{type=\"command\",command=" +
      '"ELECTRON_RUN_AS_NODE=1 \\"$ATELIER_HOOK_NODE\\" ' +
      '\\"$ATELIER_IMPACT_SCRIPT\\" codex"}]}]\''
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

test("Claude's settings: skills at session start, impact before each edit", () => {
  const settings = claudeHookSettings({
    node: "C:\\Users\\A B\\Atelier\\Atelier.exe",
    script: "C:\\Users\\A B\\Atelier\\cli-skills\\hooks\\session-start.mjs",
    impact: "C:\\Users\\A B\\Atelier\\cli-skills\\hooks\\edit-impact.mjs",
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
      PostToolUse: [
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
    },
  });
});

test("the CLI ptys carry where the hook lives", () => {
  assert.deepEqual(
    sessionHookEnv({
      platform: "win32",
      node: "C:\\A\\Atelier.exe",
      root: "C:\\A\\cli-skills",
    }),
    {
      ATELIER_HOOK_NODE: "C:\\A\\Atelier.exe",
      ATELIER_HOOK_SCRIPT: "C:\\A\\cli-skills\\hooks\\session-start.mjs",
      ATELIER_SESSION_HOOK: "C:\\A\\cli-skills\\hooks\\codex-session-start.cmd",
      ATELIER_IMPACT_SCRIPT: "C:\\A\\cli-skills\\hooks\\edit-impact.mjs",
      ATELIER_EDIT_HOOK: "C:\\A\\cli-skills\\hooks\\codex-edit-impact.cmd",
    }
  );
  assert.deepEqual(
    sessionHookEnv({ platform: "linux", node: "/x/node", root: null }),
    {}
  );
});

/** A workspace with the app skills and the reports a session left. */
function fixture(): { cwd: string; skills: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-hook-"));
  const skills = path.join(base, "cli-skills", ".claude", "skills");
  const shipped: Array<[string, string]> = [
    ["document", "Trace a code flow and save the report."],
    ["reference-doc", "Read saved reports back into context."],
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
  assert.match(context, /document: Trace a code flow/);
  assert.match(context, /reference-doc: Read saved reports/);
  assert.match(context, /document[\\/]SKILL\.md/);
  assert.match(context, /\.atelier\/doc-agent/);
  // After a compact, this session's own report is named for reading back.
  assert.match(context, /20261014-1-login-flow/);
  assert.match(context, /Atelier skills loaded: document, reference-doc/);
  assert.match(result.systemMessage, /document, reference-doc/);
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
  assert.deepEqual(record.skills, ["document", "reference-doc"]);
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
  assert.match(
    result.hookSpecificOutput.additionalContext,
    /Atelier skills loaded: document, reference-doc/
  );
  const log = fs.readFileSync(
    path.join(cwd, ".atelier", "session-start.log"),
    "utf8"
  );
  assert.match(log, /"provider":"codex"/);
});
