// Throwaway check of the CLI session-history reader: builds fake ~/.codex
// and ~/.claude transcript trees, points the reader's home at them, and
// asserts what comes back. Covers the rollout shapes Codex has written, the
// Claude Code transcript, the cwd filter and the ordering.
// Run: node scratch/cli-history-check.mjs
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const HOME = path.resolve("scratch/.cli-home");
const OUT = path.resolve("scratch/.cli-history.mjs");
const WORKSPACE = path.resolve(".");
const OTHER = path.resolve("..", "somewhere-else");

fs.rmSync(HOME, { recursive: true, force: true });

// Transpile the reader (types stripped, no bundling — its only import is
// type-only) so plain node can run it.
const esbuild = createRequire(path.resolve("apps/agent/package.json"))("esbuild");
const source = fs.readFileSync("apps/agent/src/terminal/cli-history.ts", "utf8");
fs.writeFileSync(
  OUT,
  (await esbuild.transform(source, { loader: "ts", format: "esm" })).code
);

// libuv reads these for os.homedir().
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const write = (file, lines, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
};

const codexDir = path.join(HOME, ".codex", "sessions", "2026", "08", "08");
const claudeDir = path.join(
  HOME,
  ".claude",
  "projects",
  WORKSPACE.replace(/[^a-zA-Z0-9]/g, "-")
);
const LARGE_CODEX_GUIDANCE =
  "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n" +
  "Stay inside the requested scope.\n".repeat(3_000) +
  "</INSTRUCTIONS>";

// 1. Current rollout shape: guidance larger than the old 64 KiB head,
// followed by the environment preamble and then the real prompt.
write(
  path.join(codexDir, "rollout-2026-08-08T10-00-00-11111111-1111-1111-1111-111111111111.jsonl"),
  [
    {
      timestamp: "2026-08-08T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "sess-current", timestamp: "2026-08-08T10:00:00.000Z", cwd: WORKSPACE },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: LARGE_CODEX_GUIDANCE }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>cwd=…</environment_context>" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "cli mode should retain\n all sessions" }],
      },
    },
  ],
  Date.now() - 16_000
);

// 2. Legacy shape: bare header line, un-enveloped items.
write(
  path.join(codexDir, "rollout-2026-08-07T09-00-00-22222222-2222-2222-2222-222222222222.jsonl"),
  [
    { id: "sess-legacy", timestamp: "2026-08-07T09:00:00.000Z", cwd: WORKSPACE },
    { type: "message", role: "user", content: [{ type: "input_text", text: "build this app" }] },
  ],
  Date.now() - 60 * 60 * 1000
);

// 3. event_msg shape, and a header with no id — the filename carries it.
write(
  path.join(codexDir, "rollout-2026-08-06T08-00-00-33333333-3333-3333-3333-333333333333.jsonl"),
  [
    { type: "session_meta", payload: { timestamp: "2026-08-06T08:00:00.000Z", cwd: WORKSPACE } },
    { type: "event_msg", payload: { type: "user_message", message: "## My request for Codex:\n\nrun the dev" } },
  ],
  Date.now() - 2 * 24 * 60 * 60 * 1000
);

// 4. Another project's session — must not be listed here.
write(
  path.join(codexDir, "rollout-2026-08-05T08-00-00-44444444-4444-4444-4444-444444444444.jsonl"),
  [
    { type: "session_meta", payload: { id: "sess-elsewhere", timestamp: "2026-08-05T08:00:00.000Z", cwd: OTHER } },
    { type: "event_msg", payload: { type: "user_message", message: "not ours" } },
  ],
  Date.now() - 3 * 24 * 60 * 60 * 1000
);

// 5. Claude Code transcript: caveat + meta lines skipped, sessionId wins.
write(
  path.join(claudeDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
  [
    { type: "user", isMeta: true, sessionId: "sess-claude", timestamp: "2026-08-08T09:00:00.000Z", cwd: WORKSPACE, message: { role: "user", content: "<command-name>/init</command-name>" } },
    { type: "user", isSidechain: true, message: { role: "user", content: "subagent instructions" } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "explain the share session flow" }] } },
  ],
  Date.now() - 30 * 60 * 1000
);

// 6. Truncated last line must not lose the rest of the file.
write(
  path.join(claudeDir, "ffffffff-0000-0000-0000-000000000000.jsonl"),
  [
    { type: "user", sessionId: "sess-truncated", timestamp: "2026-08-08T08:00:00.000Z", message: { role: "user", content: "what is this" } },
  ],
  Date.now() - 45 * 60 * 1000
);
fs.appendFileSync(path.join(claudeDir, "ffffffff-0000-0000-0000-000000000000.jsonl"), '{"type":"assis');

const { listCliHistory } = await import(`file://${OUT}`);
const entries = await listCliHistory(WORKSPACE);
const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

const cases = [
  ["current rollout is listed", byId["sess-current"]?.title === "cli mode should retain all sessions"],
  ["large AGENTS guidance is not a title", !entries.some((e) => e.title.startsWith("# AGENTS.md instructions"))],
  ["environment preamble is not a title", !entries.some((e) => e.title.startsWith("<"))],
  ["legacy rollout is listed", byId["sess-legacy"]?.title === "build this app"],
  ["id falls back to the filename", byId["33333333-3333-3333-3333-333333333333"]?.title === "run the dev"],
  ["another project's session is excluded", !byId["sess-elsewhere"]],
  ["claude transcript is listed", byId["sess-claude"]?.title === "explain the share session flow"],
  ["truncated tail still yields its session", byId["sess-truncated"]?.title === "what is this"],
  ["newest first", entries.map((e) => e.updatedAt).every((v, i, a) => i === 0 || a[i - 1] >= v)],
  ["startedAt is the session's own timestamp", byId["sess-legacy"]?.startedAt === Date.parse("2026-08-07T09:00:00.000Z")],
  ["providers are tagged", byId["sess-current"]?.providerId === "codex" && byId["sess-claude"]?.providerId === "claude"],
  ["limit applies per provider", (await listCliHistory(WORKSPACE, "codex", 1)).length === 1],
  ["unknown provider is empty, not an error", (await listCliHistory(WORKSPACE, "nope")).length === 0],
];

let failed = 0;
for (const [name, ok] of cases) {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
if (failed) console.log(JSON.stringify(entries, null, 2));

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(OUT, { force: true });
process.exit(failed ? 1 : 0);
