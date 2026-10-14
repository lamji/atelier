// SessionStart hook for the Claude and Codex CLIs started from Atelier.
//
//   <runtime> session-start.mjs <claude|codex>     (JSON event on stdin)
//
// Tells the agent which app skills this session has and which saved flow
// reports belong to it, asks it to confirm it read that, and records the
// session start in <cwd>/.atelier/session-start.log. Plain Node, no
// dependencies: it runs on the app's own runtime (Electron as Node).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The app skills ship beside this folder, as `--add-dir` expects them. */
const SKILLS_DIR =
  process.env.ATELIER_HOOK_SKILLS ?? path.join(here, "..", ".claude", "skills");
/** A shell may hand over a stdin it never closes; the event is optional. */
const STDIN_WAIT_MS = 1500;
const REPORTS_DIR = ".atelier/doc-agent";
/** Reports named when none is this session's own. */
const NEWEST_SHOWN = 5;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, STDIN_WAIT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function parseEvent(text) {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

/** Top-level `key: value` pairs of a leading `---` block. */
function frontmatter(text) {
  const fields = {};
  const body = text.replace(/^﻿/, "");
  if (!body.startsWith("---")) return fields;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return fields;
  for (const line of body.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readHead(file) {
  try {
    return fs.readFileSync(file, "utf8").slice(0, 4096);
  } catch {
    return "";
  }
}

function listSkills() {
  return readDir(SKILLS_DIR)
    .map((name) => {
      const file = path.join(SKILLS_DIR, name, "SKILL.md");
      const fields = frontmatter(readHead(file));
      if (!fields.name && !fs.existsSync(file)) return null;
      return {
        name: fields.name || name,
        description: fields.description || "",
        file,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listReports(cwd) {
  const dir = path.join(cwd, ...REPORTS_DIR.split("/"));
  return readDir(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const file = path.join(dir, name);
      const fields = frontmatter(readHead(file));
      let at = 0;
      try {
        at = fs.statSync(file).mtimeMs;
      } catch {
        // listed a moment ago; gone now
      }
      return {
        id: name.slice(0, -3),
        session: fields.session || null,
        title: fields.title || name.slice(0, -3),
        at,
      };
    })
    .sort((a, b) => b.at - a.at);
}

const COMMAND = { claude: "/", codex: "$" };

function buildContext({ provider, source, skills, mine, others }) {
  const sigil = COMMAND[provider] ?? "/";
  const names = skills.map((skill) => skill.name).join(", ");
  const lines = [
    `Atelier session start (${provider}, ${source}).`,
    "",
    "This session has these Atelier app skills. When a request matches one,",
    "read its file and follow it exactly:",
    ...skills.map(
      (skill) =>
        `- ${skill.name}: ${skill.description} ` +
        `(${sigil}${skill.name}; file: ${skill.file})`
    ),
    "",
    `Flow reports are saved under ${REPORTS_DIR}/ in this workspace.`,
  ];
  if (mine.length > 0) {
    lines.push(
      "This session's own reports:",
      ...mine.map((doc) => `- ${doc.id}: ${doc.title}`),
      "Read them (the reference-doc skill) before relying on findings from",
      "earlier in this session; a compact or resume drops their detail."
    );
  } else if (others.length > 0) {
    lines.push(
      "No report belongs to this session yet. Newest in the workspace:",
      ...others.slice(0, NEWEST_SHOWN).map((doc) => `- ${doc.id}: ${doc.title}`),
      "Read one only when the request needs it."
    );
  } else {
    lines.push("No reports have been saved in this workspace yet.");
  }
  lines.push(
    "",
    "Evidence rule: the reports are what you answer from, not memory or a",
    "likely story. Before naming a cause, explaining why a value is wrong, or",
    "telling the user to change data or settings:",
    "- read the report that covers that flow, or trace it with the document",
    "  skill first when none does;",
    "- check which branches this environment actually takes (env files,",
    "  config, feature flags) before blaming a cache, service, or fallback",
    "  that may not even run here;",
    "- state only what the trace confirms, with file:line. Say anything else",
    "  is unverified and what would verify it; never offer it as the cause,",
    "  and never ask the user to act on it.",
    "",
    "Confirm you read this: begin your next reply with this line, exactly:",
    `Atelier skills loaded: ${names}.`
  );
  return lines.join("\n");
}

/** JSON with every non-ASCII character escaped. */
function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function record(cwd, entry) {
  try {
    const dir = path.join(cwd, ".atelier");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "session-start.log"),
      `${asciiJson(entry)}\n`
    );
  } catch {
    // The report is a record, not a gate: the session starts regardless.
  }
}

const provider = process.argv[2] || "claude";
const event = parseEvent(await readStdin());
const cwd = event.cwd || process.env.ATELIER_HOOK_CWD || process.cwd();
const session = event.session_id || event.sessionId || null;
const source = event.source || "startup";
const skills = listSkills();
const reports = listReports(cwd);
const mine = session ? reports.filter((doc) => doc.session === session) : [];
const context = buildContext({ provider, source, skills, mine, others: reports });

record(cwd, {
  at: new Date().toISOString(),
  provider,
  source,
  session,
  skills: skills.map((skill) => skill.name),
  reports: mine.map((doc) => doc.id),
  contextChars: context.length,
});

const loaded = skills.map((skill) => skill.name).join(", ") || "none";
const extra = mine.length > 0 ? `; ${mine.length} report(s) of this session` : "";
process.stdout.write(
  asciiJson({
    systemMessage: `Atelier loaded app skills: ${loaded}${extra}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  })
);
