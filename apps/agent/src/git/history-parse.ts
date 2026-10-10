import type { GitBlameLine, GitCommit, GitCommitFile } from "@atelier/protocol";

/**
 * Parsers for the History view's git output: the graph log, a commit's
 * file list, and porcelain blame. Kept apart from GitService so they can
 * be exercised on captured output without a repository.
 */

/** git's well-known empty tree — the "parent" of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * hash, parents, author, email, ISO date, decorations, subject, body.
 * Unit/record separators rather than newlines, because a body is free
 * text and may contain anything printable.
 */
export const LOG_FORMAT = [
  "%H", "%P", "%an", "%ae", "%aI", "%D", "%s", "%b",
].join("%x1f") + "%x1e";

/**
 * A revision the UI hands back to git. Only hashes and plain ref names
 * pass, so nothing that starts with "-" can be read as an option.
 */
export function assertRev(rev: string): string {
  if (!/^[\w./~^@{}-]+$/.test(rev) || rev.startsWith("-")) {
    throw new Error(`Not a revision: ${rev}`);
  }
  return rev;
}

export function parseLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split(RECORD)) {
    const trimmed = record.replace(/^\s+/, "");
    if (!trimmed) continue;
    const [hash, parents, author, email, date, refs, subject, body] =
      trimmed.split(FIELD);
    if (!hash) continue;
    commits.push({
      hash,
      message: subject ?? "",
      // An empty body is dropped so the UI can test presence, not whitespace.
      body: body?.trim() || undefined,
      author: author ?? "",
      email: email || undefined,
      date: date ?? "",
      refs: refs || undefined,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
    });
  }
  return commits;
}

/**
 * Joins `diff --name-status -z` with `diff --numstat -z` into one row per
 * file. Both list files in the same order, which is what pairs them.
 */
export function parseCommitFiles(
  nameStatus: string,
  numStat: string
): GitCommitFile[] {
  const files: GitCommitFile[] = [];
  const names = nameStatus.split("\0");
  for (let i = 0; i < names.length; ) {
    const code = names[i++];
    if (!code) continue;
    const letter = code[0]!;
    if (letter === "R" || letter === "C") {
      const oldPath = names[i++] ?? "";
      const path = names[i++] ?? "";
      files.push({ path, oldPath, status: letter, added: 0, removed: 0 });
    } else {
      const path = names[i++] ?? "";
      files.push({ path, status: letter, added: 0, removed: 0 });
    }
  }

  const nums = numStat.split("\0");
  let row = 0;
  for (let i = 0; i < nums.length && row < files.length; ) {
    const entry = nums[i++];
    if (!entry) continue;
    const [added, removed, inlinePath] = entry.split("\t");
    // A rename's numstat carries an empty path, then old and new.
    if (inlinePath === "") i += 2;
    const file = files[row++]!;
    if (added === "-" || removed === "-") {
      file.binary = true;
    } else {
      file.added = Number(added) || 0;
      file.removed = Number(removed) || 0;
    }
  }
  return files;
}

interface BlameCommitInfo {
  author: string;
  email?: string;
  date: string;
  summary: string;
}

/** `git blame --porcelain` into one entry per line of the file. */
export function parseBlame(raw: string): GitBlameLine[] {
  const lines: GitBlameLine[] = [];
  const info = new Map<string, BlameCommitInfo>();
  let current: { hash: string; line: number } | null = null;

  for (const text of raw.split("\n")) {
    if (text.startsWith("\t")) {
      if (!current) continue;
      const meta = info.get(current.hash);
      lines.push({
        line: current.line,
        hash: current.hash,
        author: meta?.author ?? "",
        email: meta?.email,
        date: meta?.date ?? "",
        summary: meta?.summary ?? "",
        content: text.slice(1),
      });
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(text);
    if (header) {
      current = { hash: header[1]!, line: Number(header[2]) };
      if (!info.has(current.hash)) {
        info.set(current.hash, { author: "", date: "", summary: "" });
      }
      continue;
    }
    if (!current) continue;
    const meta = info.get(current.hash)!;
    const space = text.indexOf(" ");
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? "" : text.slice(space + 1);
    if (key === "author") meta.author = value;
    else if (key === "author-mail") meta.email = value.replace(/^<|>$/g, "");
    else if (key === "author-time") {
      meta.date = new Date(Number(value) * 1000).toISOString();
    } else if (key === "summary") meta.summary = value;
  }
  return lines;
}
