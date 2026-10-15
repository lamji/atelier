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
