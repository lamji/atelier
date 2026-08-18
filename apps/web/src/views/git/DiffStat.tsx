import type { GitFileStatus, GitLineStat } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";

/** Which side of a file's change a row is showing. */
export type DiffSide = "index" | "work";

/** The stat for one side, or undefined when the agent sent none. */
export function statOf(
  file: GitFileStatus,
  side: DiffSide
): GitLineStat | undefined {
  return side === "index" ? file.indexStat : file.workStat;
}

/** Sum of one side across a list — the totals on a section header. */
export function sumStats(
  files: GitFileStatus[],
  side: DiffSide
): GitLineStat | undefined {
  let added = 0;
  let removed = 0;
  let seen = false;
  for (const file of files) {
    const stat = statOf(file, side);
    if (!stat) continue;
    seen = true;
    added += stat.added;
    removed += stat.removed;
  }
  return seen ? { added, removed } : undefined;
}

/**
 * `+20 −3` for one file (or a whole section). Green for added, red for
 * removed, dimmed at zero so the eye lands on the side that actually
 * moved. Given `onOpen` it is a button that opens the file's diff — the
 * count is the natural thing to click when the question is "what changed".
 */
export function DiffStat({
  stat,
  onOpen,
  disabled,
  title,
}: {
  stat: GitLineStat | undefined;
  onOpen?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  if (!stat) return null;

  const body = stat.binary ? (
    <span className="text-muted-foreground/70">binary</span>
  ) : (
    <>
      <span className={stat.added > 0 ? "text-success" : "text-success/35"}>
        +{stat.added}
      </span>
      <span
        className={stat.removed > 0 ? "text-destructive" : "text-destructive/35"}
      >
        −{stat.removed}
      </span>
    </>
  );

  const className = cn(
    "flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5",
    "font-mono text-[10px] font-semibold tabular-nums",
    onOpen && "hover:bg-accent/60"
  );

  const label =
    title ??
    (stat.binary
      ? "Binary file — open it"
      : `${stat.added} added, ${stat.removed} removed${onOpen ? " — open diff" : ""}`);

  if (!onOpen) {
    return (
      <Tooltip content={label}>
        <span className={className}>{body}</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={label}>
      <button onClick={onOpen} disabled={disabled} className={className}>
        {body}
      </button>
    </Tooltip>
  );
}
