import fs from "node:fs/promises";
import path from "node:path";
import type { CliDoc } from "@atelier/protocol";

/** Where the `document` skill saves its reports, under the workspace root. */
export const CLI_DOCS_DIR = ".atelier/doc-agent";

/** Enough of a report to hold its frontmatter and first heading. */
const HEAD_BYTES = 2048;
/** A report is a page or two; past this its citations are not followed. */
const REPORT_BYTES = 512 * 1024;
/** `src/auth/login.ts:12` - a path with an extension, then a line number. */
const CITATION = /([\w@.()[\]\/\\-]+\.\w+):\d+/g;
/** A doc id is its file name without `.md`; nothing that could leave the dir. */
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function docsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ...CLI_DOCS_DIR.split("/"));
}

/** Top-level `key: value` pairs of a leading `---` block, if there is one. */
function frontmatter(head: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!head.startsWith("---")) return fields;
  const end = head.indexOf("\n---", 3);
  if (end === -1) return fields;
  for (const line of head.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

function firstHeading(head: string): string | null {
  return head.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

/** A session id the skill could not fill in is the same as none. */
function sessionOf(raw: string | undefined): string | null {
  if (!raw || raw === "unknown" || raw.includes("${")) return null;
  return raw;
}

async function readReport(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(REPORT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, REPORT_BYTES, 0);
    // PowerShell writes files with a byte-order mark, which is how Codex
    // saves a report on Windows; left in, the frontmatter is never found.
    return buffer.toString("utf8", 0, bytesRead).replace(/^﻿/, "");
  } finally {
    await handle.close();
  }
}

/**
 * The workspace files a report cites, as forward-slash relative paths.
 *
 * A citation that leaves the workspace is dropped, and so is one into the
 * reports folder: a report rewritten later must not make its neighbours
 * look out of date.
 */
function citedFiles(workspaceRoot: string, body: string): string[] {
  const files = new Set<string>();
  for (const match of body.matchAll(CITATION)) {
    const cited = match[1]!.replace(/\\/g, "/");
    const absolute = path.resolve(workspaceRoot, cited);
    const relative = path.relative(workspaceRoot, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const rel = relative.split(path.sep).join("/");
    if (rel.startsWith(`${CLI_DOCS_DIR}/`)) continue;
    files.add(rel);
  }
  return [...files];
}

/**
 * Which cited files were written after the report, and when the last was.
 * A citation that names no file (deleted, or never a path) is not a change.
 */
async function changesSince(
  workspaceRoot: string,
  body: string,
  writtenAt: number
): Promise<Pick<CliDoc, "changedFiles" | "changedAt">> {
  const stats = await Promise.all(
    citedFiles(workspaceRoot, body).map(async (rel) => {
      try {
        const stat = await fs.stat(path.join(workspaceRoot, rel));
        return stat.isFile() ? { rel, at: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
  );
  const changed = stats.flatMap((item) =>
    item && item.at > writtenAt ? [item] : []
  );
  return {
    changedFiles: changed.map((item) => item.rel),
    changedAt: Math.max(0, ...changed.map((item) => item.at)),
  };
}

/**
 * The reports the `document` skill has saved in this workspace, newest first.
 *
 * A report's id is its file name, so it is stable and needs no index; the
 * `session` in its frontmatter is what ties it back to the CLI session that
 * wrote it. `changedFiles` is what lets Atelier ask that session to bring the
 * report up to date. Best-effort: an unreadable file is skipped, a missing folder is
 * simply no reports.
 */
export async function listCliDocs(workspaceRoot: string): Promise<CliDoc[]> {
  const root = docsRoot(workspaceRoot);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const docs = await Promise.all(
    names
      .filter((name) => name.endsWith(".md") && DOC_ID.test(name.slice(0, -3)))
      .map(async (name): Promise<CliDoc | null> => {
        const file = path.join(root, name);
        try {
          const [stat, body] = await Promise.all([
            fs.stat(file),
            readReport(file),
          ]);
          const head = body.slice(0, HEAD_BYTES);
          const fields = frontmatter(head);
          const id = name.slice(0, -3);
          return {
            id,
            session: sessionOf(fields.session),
            title: fields.title || firstHeading(head) || id,
            createdAt: stat.mtimeMs,
            path: `${CLI_DOCS_DIR}/${name}`,
            ...(await changesSince(workspaceRoot, body, stat.mtimeMs)),
          };
        } catch {
          return null;
        }
      })
  );
  return docs
    .filter((doc): doc is CliDoc => doc !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}
