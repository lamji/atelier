import { useMemo, useState } from "react";
import { Check, Copy, GitBranch, Search, Tag, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { GitCommit } from "@atelier/protocol";

export interface HistoryPanelProps {
  commits: GitCommit[];
}

/**
 * The commit log, on its own now that it no longer shares a scroller with
 * the working tree. Two lines per commit was the panel's biggest space
 * spender, so a row is one line: the rail carries the graph, the message
 * takes the width, and the relative age sits on the right. Hash and author
 * are in the row's tooltip and on the copy button, which is where they are
 * wanted — occasionally, and one at a time.
 *
 * Commits are grouped by day. A sticky day heading says "when" once for a
 * run of commits instead of repeating a date on each of them.
 */
export function HistoryPanel({ commits }: HistoryPanelProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter(
      (c) =>
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.hash.toLowerCase().startsWith(q)
    );
  }, [commits, query]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  if (commits.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-[11px] text-muted-foreground/60">
        No commits yet.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-1 pb-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-black/20 px-2">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter commits…"
            className={cn(
              "h-6 min-w-0 flex-1 bg-transparent text-[11px]",
              "placeholder:text-muted-foreground/60 focus-visible:outline-none"
            )}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear filter"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          {filtered.length}
        </span>
      </div>

      <ActivitySpark commits={commits} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground/60">
            No commit matches “{query.trim()}”.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 px-1 py-1 backdrop-blur">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  {group.label}
                </span>
                <span className="h-px flex-1 bg-white/5" />
                <span className="text-[10px] tabular-nums text-muted-foreground/50">
                  {group.commits.length}
                </span>
              </div>
              {group.commits.map((c) => (
                <CommitRow
                  key={c.hash}
                  commit={c}
                  head={c.hash === commits[0]?.hash}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * One commit. The rail on the left is drawn with a dot and a line that runs
 * the full height of the row, so a column of rows reads as a single strand
 * without any per-row bookkeeping about what comes next.
 */
function CommitRow(props: { commit: GitCommit; head: boolean }) {
  const { commit } = props;
  const [copied, setCopied] = useState(false);
  const refs = parseRefs(commit.refs);

  const copy = () => {
    void navigator.clipboard
      .writeText(commit.hash)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div className="group flex items-stretch gap-1.5 rounded-md pr-1 hover:bg-accent/60">
      <span
        aria-hidden
        className="relative flex w-3 shrink-0 justify-center py-1"
      >
        <span className="absolute inset-y-0 w-px bg-white/10" />
        <span
          className={cn(
            "relative mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
            props.head
              ? "bg-primary ring-2 ring-primary/25"
              : "bg-muted-foreground/50"
          )}
        />
      </span>

      <Tooltip
        content={`${commit.hash.slice(0, 12)} · ${commit.author} · ${fullDate(commit.date)}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
          <span
            aria-hidden
            className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
              "text-[8px] font-bold uppercase leading-none",
              authorTone(commit.author)
            )}
          >
            {initials(commit.author)}
          </span>
          <span className="truncate text-xs leading-tight">
            {firstLine(commit.message)}
          </span>
          {refs.map((ref) => (
            <span
              key={ref.label}
              className={cn(
                "flex shrink-0 items-center gap-0.5 rounded-full px-1.5",
                "text-[9px] font-medium leading-[15px]",
                ref.kind === "tag"
                  ? "bg-warning/15 text-warning"
                  : "bg-primary/15 text-primary"
              )}
            >
              {ref.kind === "tag" ? (
                <Tag className="h-2.5 w-2.5" />
              ) : (
                <GitBranch className="h-2.5 w-2.5" />
              )}
              {ref.label}
            </span>
          ))}
        </div>
      </Tooltip>

      <span className="flex shrink-0 items-center gap-1 py-1">
        <Tooltip content={`Copy ${commit.hash.slice(0, 7)}`}>
          <button
            onClick={copy}
            aria-label={`Copy the full hash of ${commit.hash.slice(0, 7)}`}
            className={cn(
              "rounded p-0.5 text-muted-foreground opacity-0",
              "group-hover:opacity-100 hover:text-foreground",
              copied && "opacity-100 text-success"
            )}
          >
            {copied ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </Tooltip>
        <span className="w-7 text-right text-[10px] tabular-nums text-muted-foreground/60">
          {relativeAge(commit.date)}
        </span>
      </span>
    </div>
  );
}

/**
 * Two weeks of commit counts as a bar strip. The log is a list of names and
 * dates; this is the one place the panel says something the rows can't —
 * whether the work is steady, bursty, or stopped.
 */
function ActivitySpark({ commits }: { commits: GitCommit[] }) {
  const bars = useMemo(() => {
    const buckets = new Array<number>(SPARK_DAYS).fill(0);
    for (const c of commits) {
      const d = new Date(c.date);
      if (Number.isNaN(d.getTime())) continue;
      const idx = SPARK_DAYS - 1 - daysAgo(d);
      if (idx >= 0 && idx < SPARK_DAYS) buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    return buckets;
  }, [commits]);

  const total = bars.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const max = Math.max(...bars);

  return (
    <div className="flex shrink-0 items-center gap-2 px-1 pb-1.5">
      <span className="flex h-5 min-w-0 flex-1 items-stretch gap-[2px]">
        {bars.map((n, i) => {
          const age = SPARK_DAYS - 1 - i;
          return (
            <Tooltip
              key={i}
              content={`${n} commit${n === 1 ? "" : "s"} · ${
                age === 0 ? "today" : age === 1 ? "yesterday" : `${age}d ago`
              }`}
            >
              <span className="flex min-w-0 flex-1 items-end">
                <span
                  className={cn(
                    "w-full rounded-sm",
                    n > 0 ? "bg-primary/60" : "bg-white/5"
                  )}
                  style={{ height: `${Math.max(12, (n / max) * 100)}%` }}
                />
              </span>
            </Tooltip>
          );
        })}
      </span>
      <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/60">
        {SPARK_DAYS}d · {total}
      </span>
    </div>
  );
}

/** How many days of history the sparkline covers. */
const SPARK_DAYS = 14;

/** Chip palette for authors — picked by name so a person keeps one colour. */
const AUTHOR_TONES = [
  "bg-primary/20 text-primary",
  "bg-cyan/20 text-cyan",
  "bg-success/20 text-success",
  "bg-warning/20 text-warning",
];

function authorTone(author: string): string {
  let hash = 0;
  for (let i = 0; i < author.length; i += 1) {
    hash = (hash * 31 + author.charCodeAt(i)) >>> 0;
  }
  return AUTHOR_TONES[hash % AUTHOR_TONES.length] ?? AUTHOR_TONES[0]!;
}

/** One or two letters from the author name, for the row chip. */
function initials(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2);
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`;
}

interface CommitGroup {
  label: string;
  commits: GitCommit[];
}

/** Commits in log order, cut into runs that fall on the same calendar day. */
function groupByDay(commits: GitCommit[]): CommitGroup[] {
  const groups: CommitGroup[] = [];
  for (const commit of commits) {
    const label = dayLabel(commit.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.commits.push(commit);
    else groups.push({ label, commits: [commit] });
  }
  return groups;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = daysAgo(d);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

/** Whole calendar days between a date and today, ignoring the time of day. */
function daysAgo(d: Date): number {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - start.getTime()) / 86_400_000);
}

/** "4h", "3d", "2w", "5mo" — the age in the widest unit that still fits. */
function relativeAge(iso: string): string {
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

function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).trim();
}

interface ParsedRef {
  label: string;
  kind: "branch" | "tag";
}

/**
 * git's decoration string ("HEAD -> electron, origin/electron, tag: v1.0.2")
 * as chips. Remote-tracking copies of a branch already shown are dropped:
 * on a pushed branch every commit would otherwise carry the same name twice.
 */
function parseRefs(refs: string | undefined): ParsedRef[] {
  if (!refs) return [];
  const out: ParsedRef[] = [];
  const seen = new Set<string>();
  for (const raw of refs.split(",")) {
    const name = raw.trim().replace(/^HEAD ->\s*/, "");
    if (!name || name === "HEAD") continue;
    const tag = name.startsWith("tag:");
    const label = tag ? name.slice(4).trim() : name;
    const key = label.replace(/^[^/]+\//, "");
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, kind: tag ? "tag" : "branch" });
  }
  return out.slice(0, 3);
}
