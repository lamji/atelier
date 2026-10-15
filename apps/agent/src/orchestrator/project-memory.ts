import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryEntry, MemoryType } from "@atelier/protocol";

/**
 * The workspace's own memory: one markdown file per fact under
 * .atelier/memory, read into every Claude and Codex session Atelier starts
 * (cli-hooks/session-start.mjs) in place of the CLI's global memory.
 *
 * Per workspace on purpose: a global store let a fact about one project
 * steer a session in another (a note about Atelier's login sent a
 * DigitalFuture2 trace into Atelier's repo). Each file carries its own
 * name, description, and type in frontmatter, so the list is built from
 * the files themselves and there is no index to drift.
 */

export const MEMORY_DIR = ".atelier/memory";

const TYPES: readonly MemoryType[] = [
  "correction",
  "environment",
  "naming",
  "preference",
  "fact",
];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function memoryRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".atelier", "memory");
}

/** A safe kebab-case file stem: no paths, no surprises. */
export function memorySlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug) throw new Error("A memory needs a name");
  return slug;
}

function field(front: string, key: string): string {
  const match = front.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, "im"));
  return (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}

function asType(value: string): MemoryType {
  return (TYPES as readonly string[]).includes(value)
    ? (value as MemoryType)
    : "fact";
}

function parse(stem: string, raw: string, updatedAt: number): MemoryEntry {
  const text = raw.replace(/^﻿/, "");
  const match = text.match(FRONTMATTER_RE);
  const front = match?.[1] ?? "";
  return {
    name: stem,
    description: field(front, "description"),
    type: asType(field(front, "type")),
    body: (match ? text.slice(match[0].length) : text).trim(),
    updatedAt,
  };
}

/** One line, so a description cannot break out of the frontmatter. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function render(entry: Omit<MemoryEntry, "updatedAt">): string {
  return (
    `---\nname: ${entry.name}\n` +
    `description: ${oneLine(entry.description)}\n` +
    `type: ${entry.type}\n---\n\n${entry.body.trim()}\n`
  );
}

export async function listMemory(workspaceRoot: string): Promise<MemoryEntry[]> {
  const dir = memoryRoot(workspaceRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    // No memory yet is the normal empty case.
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const file = path.join(dir, name);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(file, "utf8"),
        fs.stat(file),
      ]);
      entries.push(parse(name.slice(0, -3), raw, stat.mtimeMs));
    } catch {
      // Gone between the listing and the read.
    }
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Write an entry. Saving under a new name renames it: the old file goes,
 * so an edit never leaves a duplicate behind.
 */
export async function saveMemory(
  workspaceRoot: string,
  input: {
    name: string;
    description: string;
    type: MemoryType;
    body: string;
    previousName?: string;
  }
): Promise<MemoryEntry> {
  const name = memorySlug(input.name);
  if (!input.body.trim()) throw new Error("A memory needs some text");
  const dir = memoryRoot(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const previous = input.previousName ? memorySlug(input.previousName) : null;
  if (previous !== name) {
    // A new name must not overwrite another entry.
    const taken = await fs
      .access(path.join(dir, `${name}.md`))
      .then(() => true)
      .catch(() => false);
    if (taken) throw new Error(`A memory named "${name}" already exists`);
  }
  const entry = {
    name,
    description: input.description,
    type: asType(input.type),
    body: input.body,
  };
  const file = path.join(dir, `${name}.md`);
  await fs.writeFile(file, render(entry), "utf8");
  if (previous && previous !== name) {
    await fs.rm(path.join(dir, `${previous}.md`), { force: true });
  }
  const stat = await fs.stat(file);
  return {
    ...entry,
    description: oneLine(entry.description),
    body: entry.body.trim(),
    updatedAt: stat.mtimeMs,
  };
}

export async function deleteMemory(
  workspaceRoot: string,
  name: string
): Promise<void> {
  const file = path.join(memoryRoot(workspaceRoot), `${memorySlug(name)}.md`);
  await fs.rm(file, { force: true });
}

/** Words a memory name leaves out: they say nothing about the subject. */
const NAME_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "this", "that",
  "these", "those", "in", "on", "of", "to", "for", "with", "and", "or",
  "it", "its", "app", "used", "use", "uses", "should", "shold", "all",
  "we", "i", "my", "our", "there", "here", "always", "never", "please",
  "related", "works", "work", "just", "also", "so", "by", "at", "as",
]);

/** The words a fact is about, in order, without the filler. */
function subjectWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word && !NAME_STOPWORDS.has(word));
}

/** A kebab name for a fact: its first few subject words. */
function nameFor(text: string): string {
  return memorySlug(subjectWords(text).slice(0, 5).join(" ") || text);
}

/** Words that put a fact about where and how things run. */
const ENVIRONMENT_WORDS = new RegExp(
  "\\b(local(ly)?|docker|postgres\\w*|redis|\\.env|env|port|localhost|dev|" +
    "prod|staging|database|db|server|installed|running|natively|deployed|" +
    "cloud run)\\b"
);

/**
 * The type a fact most likely is. A plain read of its wording; the user
 * can change it in Settings → Memory.
 */
function typeFor(text: string): MemoryType {
  const t = text.toLowerCase();
  if (/^(no,|not |wrong|actually|that'?s not|it'?s not)/.test(t)) {
    return "correction";
  }
  if (/\b(means|refers to|stands for|is called|is the name)\b/.test(t)) {
    return "naming";
  }
  if (ENVIRONMENT_WORDS.test(t)) return "environment";
  if (/^(always|never|don'?t|do not|prefer|please)\b/.test(t)) {
    return "preference";
  }
  return "fact";
}

/** The fact's first sentence, as its one-line description. */
function descriptionFor(text: string): string {
  const first = oneLine(text).split(/(?<=[.!?])\s/)[0] ?? text;
  const line = first.length > 100 ? `${first.slice(0, 97)}...` : first;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export type RememberResult =
  | { action: "saved" | "updated"; entry: MemoryEntry }
  | { action: "forgot"; name: string }
  | { action: "not-found" | "ambiguous"; candidates: string[] };

/**
 * `$atelier-remember <fact>` (or `forget <what>`), done by Atelier itself.
 *
 * No model runs it. Handed to a CLI as a skill, the agent spent the turn
 * searching its own tool list and MCP resources for a way to write a file;
 * a fact the user states needs no reasoning to be written down. The same
 * subject (same name) is updated in place; anything finer, such as fixing a
 * line another entry contradicts, is left to Settings → Memory and to the
 * agents, which the session hook asks to keep memory consistent.
 */
export async function rememberFact(
  workspaceRoot: string,
  text: string
): Promise<RememberResult> {
  const fact = text.trim();
  if (!fact) throw new Error("Nothing to remember: add the fact after the command");
  const forget = fact.match(/^forget\s+(.+)$/i);
  if (forget) return forgetFact(workspaceRoot, forget[1]!);

  // The same subject: an entry whose every name word is in the new fact
  // ("no-redis-local-environment" for "no Redis locally ... removed in
  // October"). Saying more about a subject updates it, not a second entry.
  const words = new Set(subjectWords(fact));
  const existing = (await listMemory(workspaceRoot)).find((entry) => {
    const parts = entry.name.split("-").filter(Boolean);
    return parts.length >= 2 && parts.every((part) => words.has(part));
  });
  const name = existing?.name ?? nameFor(fact);
  const entry = await saveMemory(workspaceRoot, {
    name,
    previousName: existing ? name : undefined,
    description: descriptionFor(fact),
    type: existing?.type ?? typeFor(fact),
    body: fact,
  });
  return { action: existing ? "updated" : "saved", entry };
}

async function forgetFact(
  workspaceRoot: string,
  what: string
): Promise<RememberResult> {
  const entries = await listMemory(workspaceRoot);
  const exact = entries.find((entry) => entry.name === memorySlug(what));
  if (exact) {
    await deleteMemory(workspaceRoot, exact.name);
    return { action: "forgot", name: exact.name };
  }
  // Otherwise the entry whose name and description share the most words.
  const wanted = new Set(subjectWords(what));
  const scored = entries
    .map((entry) => ({
      name: entry.name,
      score: subjectWords(`${entry.name} ${entry.description}`).filter((w) =>
        wanted.has(w)
      ).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best) return { action: "not-found", candidates: [] };
  if (next && next.score === best.score) {
    return {
      action: "ambiguous",
      candidates: scored.filter((s) => s.score === best.score).map((s) => s.name),
    };
  }
  await deleteMemory(workspaceRoot, best.name);
  return { action: "forgot", name: best.name };
}
