/** Small formatting helpers shared by the History view's parts. */

/** "4h", "3d", "2w", "5mo" — the age in the widest unit that still fits. */
export function relativeAge(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}

/** "Sep 24, 1:24 PM" — the date column; the year only when it differs. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fullDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** One or two letters from the author name, for avatars. */
export function initials(author: string): string {
  const parts = author.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  const first = parts[0]![0] ?? "";
  const last = parts[parts.length - 1]![0] ?? "";
  return `${first}${last}`.toUpperCase();
}

/** A stable hue per author, so one person keeps one avatar colour. */
export function authorHue(author: string): number {
  let hash = 0;
  for (let i = 0; i < author.length; i += 1) {
    hash = (hash * 31 + author.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export interface ParsedRef {
  /** Branch or tag name without the remote prefix. */
  name: string;
  kind: "branch" | "tag";
  /** Checked out here (the "HEAD ->" decoration). */
  head: boolean;
  local: boolean;
  /** Remote names that carry this branch at this commit. */
  remotes: string[];
}

/** Remote prefixes recognised in decorations when no list is to hand. */
const KNOWN_REMOTES = ["origin", "upstream"];

/**
 * git's decoration string ("HEAD -> fix/x, origin/fix/x, tag: v1") as one
 * entry per branch, with its local and remote copies folded together the
 * way GitKraken shows them: one pill, a laptop and a cloud.
 */
export function parseRefs(refs: string | undefined): ParsedRef[] {
  if (!refs) return [];
  const out = new Map<string, ParsedRef>();
  const get = (name: string, kind: ParsedRef["kind"]) => {
    const key = `${kind}:${name}`;
    let ref = out.get(key);
    if (!ref) {
      ref = { name, kind, head: false, local: false, remotes: [] };
      out.set(key, ref);
    }
    return ref;
  };

  for (const raw of refs.split(",")) {
    let name = raw.trim();
    if (!name || name === "HEAD") continue;
    if (name.startsWith("tag:")) {
      get(name.slice(4).trim(), "tag").local = true;
      continue;
    }
    const head = name.startsWith("HEAD ->");
    if (head) name = name.slice(7).trim();
    const slash = name.indexOf("/");
    const prefix = slash > 0 ? name.slice(0, slash) : "";
    if (KNOWN_REMOTES.includes(prefix)) {
      const branch = name.slice(slash + 1);
      if (branch === "HEAD") continue;
      get(branch, "branch").remotes.push(prefix);
      continue;
    }
    const ref = get(name, "branch");
    ref.local = true;
    ref.head = ref.head || head;
  }
  // Checked-out branch first, then local branches, then remote-only, tags.
  const rank = (r: ParsedRef) =>
    r.head ? 0 : r.kind === "tag" ? 3 : r.local ? 1 : 2;
  return [...out.values()].sort((a, b) => rank(a) - rank(b));
}

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { dir: "", name: path };
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}
