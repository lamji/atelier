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

/**
 * Skills that run as hooks, never as a command: the impact check is added
 * before each file edit by itself, so it is not offered at session start.
 */
const HOOK_ONLY = new Set(["atelier-impact-check"]);

/** Reports re-loaded after a compact: the newest few, each cut to size. */
const RELOAD_MAX = 3;
const RELOAD_CHARS = 12000;

function readReport(cwd, id) {
  try {
    const file = path.join(cwd, ...REPORTS_DIR.split("/"), `${id}.md`);
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    if (text.length <= RELOAD_CHARS) return text;
    return `${text.slice(0, RELOAD_CHARS)}\n[... cut; read the file for the rest]`;
  } catch {
    return null;
  }
}

/**
 * After a compact, this session's own reports go straight back into its
 * context, which is what the atelier-re-init-feature skill would do by
 * hand. Only then: any other start has nothing of its own to restore.
 */
function reloadedReports(cwd, source, mine) {
  if (source !== "compact" || mine.length === 0) return [];
  const lines = [
    "",
    "The conversation was just compacted. This session's own flow reports,",
    "re-loaded so their findings are not lost (check what they cite before",
    "relying on a line that may have changed):",
  ];
  for (const doc of mine.slice(0, RELOAD_MAX)) {
    const text = readReport(cwd, doc.id);
    if (text) lines.push("", `=== ${REPORTS_DIR}/${doc.id}.md ===`, text);
  }
  return lines;
}

function buildContext({ cwd, provider, source, skills, mine, others }) {
  const sigil = COMMAND[provider] ?? "/";
  const offered = skills.filter((skill) => !HOOK_ONLY.has(skill.name));
  const lines = [
    `Atelier session start (${provider}, ${source}).`,
    "",
    "This session has these Atelier app skills; run one with its command",
    "when a request matches it:",
    ...offered.map(
      (skill) => `- ${sigil}${skill.name}: ${skill.description}`
    ),
    "Their files ship inside the Atelier app and are not part of this",
    "project: never search or read the folder they live in. The project is",
    "the directory this session was started in.",
    "",
    `Flow reports are saved under ${REPORTS_DIR}/ in this workspace.`,
  ];
  // A session's own reports matter once it has some: after a compact they
  // are re-loaded in full (below); a resumed session still has them in its
  // conversation, so they are only named. A new session starts clean.
  if (mine.length > 0 && source !== "startup") {
    lines.push(
      "This session's own reports:",
      ...mine.map((doc) => `- ${doc.id}: ${doc.title}`)
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
    "- read the report that covers that flow, or trace it first with",
    `  ${sigil}atelier-init-feature when none does;`,
    "- check which branches this environment actually takes (env files,",
    "  config, feature flags) before blaming a cache, service, or fallback",
    "  that may not even run here;",
    "- state only what the trace confirms, with file:line. Say anything else",
    "  is unverified and what would verify it; never offer it as the cause,",
    "  and never ask the user to act on it.",
    "",
    ...memorySection(cwd, provider),
    "",
    "This is background for the session: do not mention it, list the",
    "skills, or acknowledge it in a reply.",
    ...reloadedReports(cwd, source, mine)
  );
  return lines.join("\n");
}

const MEMORY_DIR = ".atelier/memory";
/** Filled while the memory section is built; read for the status line. */
const memoryStats = { stale: 0 };
/** Entries are short facts; past this the rest are named, not inlined. */
const MEMORY_CHARS = 16000;
/**
 * Which entries go in first when the limit is reached: corrections and
 * naming are what keep a session off the wrong path (a misread name once
 * sent a trace into another repo), so they are never the part cut.
 */
const MEMORY_ORDER = ["correction", "naming", "environment", "preference", "fact"];

function memoryRank(type) {
  const rank = MEMORY_ORDER.indexOf(type);
  return rank === -1 ? MEMORY_ORDER.length : rank;
}

function listMemory(cwd) {
  const dir = path.join(cwd, ...MEMORY_DIR.split("/"));
  return readDir(dir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => {
      const file = path.join(dir, name);
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
      } catch {
        return null;
      }
      const fields = frontmatter(text);
      const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
      const body = end === -1 ? text : text.slice(end + 4).trim();
      return {
        name: name.slice(0, -3),
        type: fields.type || "fact",
        description: fields.description || "",
        body,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        memoryRank(a.type) - memoryRank(b.type) || a.name.localeCompare(b.name)
    );
}

/** Folders a memory path may be relative to: the workspace and its repos. */
function searchRoots(cwd) {
  const roots = [cwd];
  for (const name of readDir(cwd)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const dir = path.join(cwd, name);
    try {
      if (fs.statSync(dir).isDirectory()) roots.push(dir);
    } catch {
      // gone
    }
    if (roots.length > 40) break;
  }
  return roots;
}

/** `code` spans of an entry: where its paths and setting names are. */
function codeSpans(text) {
  return [...text.matchAll(/`([^`\n]{2,200})`/g)].map((m) => m[1].trim());
}

/**
 * A span is checked as a path only when it is clearly one: it names a file
 * (has an extension), or it starts with a folder that exists here. A repo
 * slug like `org/repo` or a psql command is not a path.
 */
function looksLikePath(span, roots) {
  if (/\s/.test(span) || /^https?:/i.test(span)) return false;
  if (span.includes("*") || span.includes("<")) return false;
  // Only a drive or POSIX root is absolute: on Windows `\ir` would count.
  if (/^[A-Za-z]:[\\/]|^\/[^/]/.test(span)) return true;
  const parts = span
    .replace(/:\d+(-\d+)?$/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts.length < 2) return false;
  if (/\.[A-Za-z0-9]{1,6}$/.test(parts[parts.length - 1])) return true;
  return roots.some((root) => {
    try {
      return fs.statSync(path.join(root, parts[0])).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Words of an entry name that can stand for a setting (`redis`, `huawei`). */
const GENERIC_WORDS = new Set([
  "and", "the", "not", "with", "means", "local", "locally", "cache",
  "repo", "frontend", "backend", "environment", "only", "never", "work",
  "flags", "strict", "true", "false", "base", "ports", "port", "layout",
]);

function topicWords(name) {
  return name
    .split("-")
    .filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word))
    .map((word) => word.toUpperCase());
}

/**
 * A value safe to put in a session's context, cut to a readable length.
 * Credentials hide in values whose names look harmless (a REDIS_URL with
 * `user:password@`), so the value itself is cleaned, not only the name.
 */
function short(value) {
  const safe = value
    .replace(/^(["']?)([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/i, "$1$2***@")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "***");
  return safe.length > 80 ? `${safe.slice(0, 77)}...` : safe;
}

/** Where `span` exists, relative to the workspace or one of its repos. */
function findPath(span, roots) {
  const clean = span.replace(/:\d+(-\d+)?$/, "");
  if (path.isAbsolute(clean)) {
    return fs.existsSync(clean) ? clean : null;
  }
  for (const root of roots) {
    if (fs.existsSync(path.join(root, clean))) {
      return path.relative(roots[0], path.join(root, clean)) || ".";
    }
  }
  return null;
}

/** Setting names an entry mentions: `NAME` or `NAME=value`. */
function settingName(span) {
  const match = span.match(/^([A-Z][A-Z0-9_]{2,})(=.*)?$/);
  return match ? match[1] : null;
}

/** Values that must never be copied into a session's context. */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASS|CREDENTIAL|PRIVATE|AUTH/i;

/** `NAME=value` lines from the workspace's own .env files, read once. */
function readEnvFiles(roots) {
  const found = [];
  for (const root of roots) {
    for (const name of readDir(root)) {
      if (!/^\.env(\.[\w.-]+)?$/.test(name) || name.endsWith(".example")) continue;
      let text = "";
      try {
        text = fs.readFileSync(path.join(root, name), "utf8");
      } catch {
        continue;
      }
      const file = path.relative(roots[0], path.join(root, name));
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        // A file that sets one name twice: the last wins, as in dotenv.
        const index = found.findIndex(
          (item) => item.file === file && item.name === match[1]
        );
        if (index !== -1) found.splice(index, 1);
        found.push({ file, name: match[1], value: match[2].trim() });
      }
    }
  }
  return found;
}

/**
 * What the workspace says about an entry right now: whether the paths it
 * names still exist, and what the .env files set for the settings it names.
 * Done here, before the session starts, so the agent begins from memory
 * that has been checked, not only read. Secret-looking settings are never
 * read out.
 */
function checkEntry(entry, roots, env) {
  const notes = [];
  const missing = [];
  let present = 0;
  const seen = new Set();
  const named = new Set();
  for (const span of codeSpans(entry.body)) {
    if (seen.has(span)) continue;
    seen.add(span);
    if (looksLikePath(span, roots)) {
      if (findPath(span, roots)) present += 1;
      else missing.push(span);
      continue;
    }
    const name = settingName(span);
    if (name && !SECRET_NAME.test(name)) named.add(name);
  }
  // Settings the entry is about without naming them: `redis-...` checks
  // every REDIS_* the workspace sets.
  for (const word of topicWords(entry.name)) {
    for (const item of env) {
      if (item.name.includes(word) && !SECRET_NAME.test(item.name)) {
        named.add(item.name);
      }
    }
  }
  for (const name of [...named].slice(0, 8)) {
    const values = env.filter((item) => item.name === name);
    notes.push(
      values.length === 0
        ? `${name} is not set in any .env here`
        : values
            .map((item) => `${item.file}: ${name}=${short(item.value)}`)
            .join("; ")
    );
  }
  if (present > 0) notes.unshift(`${present} named path(s) exist`);
  if (missing.length > 0) {
    notes.push(`not found, may be stale: ${missing.slice(0, 4).join(", ")}`);
  }
  return { notes, stale: missing.length > 0 };
}

/**
 * The workspace's own memory, and how to keep it. It stands in for the
 * CLI's global memory, which Atelier switches off for its sessions: a
 * global store let one project's facts steer a session in another.
 */
function memorySection(cwd, provider) {
  const entries = listMemory(cwd);
  const roots = searchRoots(cwd);
  const env = readEnvFiles(roots);
  const lines = [
    `Project memory: this workspace keeps its own memory in ${MEMORY_DIR}/,`,
    "one fact per file. It is the only memory for this project; there is",
    "no other memory store to read.",
  ];
  if (entries.length === 0) {
    lines.push("It is empty so far.");
  } else {
    lines.push(
      "Current entries. Each was checked against the workspace just now;",
      "`checked now:` lines are that result, newer than the entry itself:"
    );
    let used = 0;
    for (const entry of entries) {
      const head = `- [${entry.type}] ${entry.name}: ${entry.description}`;
      const { notes, stale } = checkEntry(entry, roots, env);
      if (stale) memoryStats.stale += 1;
      const checked = notes.length > 0 ? [`  checked now: ${notes.join("; ")}`] : [];
      used += head.length + entry.body.length;
      if (used > MEMORY_CHARS) {
        lines.push(head, ...checked, `  (read ${MEMORY_DIR}/${entry.name}.md)`);
      } else {
        lines.push(
          head,
          ...entry.body.split("\n").map((l) => `  ${l}`),
          ...checked
        );
      }
    }
  }
  lines.push(
    "How to use it:",
    "- Memory says where to look and what is not true here. It is never",
    "  evidence for a cause; a cause still comes from a trace.",
    "- An entry that names a file, function, or setting may be stale: check",
    "  it still exists before relying on it.",
    "How to keep it, without being asked and without mentioning it:",
    "- Save an entry when the user corrects you, or states a lasting fact",
    "  about this project: the environment (what runs locally), which repo",
    "  or app a name means, or how they want work done.",
    "- Never save task progress, guesses, or descriptions of code (traces",
    "  belong in the flow reports).",
    "- Update the entry that covers a fact instead of adding a second one;",
    "  delete an entry that turns out to be wrong.",
    `- Format: ${MEMORY_DIR}/<kebab-name>.md, starting with`,
    "    ---",
    "    name: <kebab-name>",
    "    description: <one line>",
    "    type: correction | environment | naming | preference | fact",
    "    ---",
    "  then the fact in a few lines, with why it holds when that matters.",
    provider === "codex"
      ? "  Write it with apply_patch (every added line starts with +). Do not"
      : "  Write it with the Write or Edit tool, not Bash. Do not",
    "  look for other tools, MCP resources, or connectors to store memory."
  );
  return lines;
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
const memoryCount = listMemory(cwd).length;
const context = buildContext({
  cwd,
  provider,
  source,
  skills,
  mine,
  others: reports,
});

record(cwd, {
  at: new Date().toISOString(),
  provider,
  source,
  session,
  skills: skills.map((skill) => skill.name),
  reports: mine.map((doc) => doc.id),
  memory: memoryCount,
  memoryStale: memoryStats.stale,
  contextChars: context.length,
});

const loaded =
  skills
    .filter((skill) => !HOOK_ONLY.has(skill.name))
    .map((skill) => skill.name)
    .join(", ") || "none";
const reloaded = source === "compact" ? Math.min(mine.length, RELOAD_MAX) : 0;
const extra =
  reloaded > 0 ? `; re-loaded ${reloaded} report(s) after the compact` : "";
// Memory goes in as context, not as a file the agent reads, so this line
// is the only sign on screen that it was loaded.
const staleNote =
  memoryStats.stale > 0 ? `, ${memoryStats.stale} may be stale` : "";
const memoryNote =
  memoryCount === 0
    ? "workspace memory: empty"
    : `workspace memory: ${memoryCount} ${memoryCount === 1 ? "entry" : "entries"}` +
      ` checked${staleNote}`;
process.stdout.write(
  asciiJson({
    systemMessage: `Atelier loaded app skills: ${loaded}; ${memoryNote}${extra}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  })
);
