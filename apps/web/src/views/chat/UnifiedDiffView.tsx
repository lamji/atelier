import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { buildUnifiedDiff, type DiffRow } from "@/lib/unified-diff";

export interface UnifiedDiffViewProps {
  before: string;
  after: string;
}

/**
 * One file's change as a unified diff: line number, marker, line.
 *
 * Hand-rendered rather than handed to Monaco. An editor widget in a 420px
 * rail spends its width on chrome — two line-number columns, decoration
 * margin, folding gutter — and wraps what is left, so a changed line and the
 * tail of the line above it look alike. Rows cost nothing, scroll sideways
 * instead of wrapping, and give the reader the one number per row they are
 * actually looking for.
 */
export function UnifiedDiffView(props: UnifiedDiffViewProps) {
  const { rows, truncated } = useMemo(
    () => buildUnifiedDiff(props.before, props.after),
    [props.before, props.after]
  );

  // Size the gutter to the widest number present, so a 40-line file does not
  // pay for the four columns a 4,000-line file needs.
  const gutter = useMemo(() => {
    let digits = 1;
    for (const row of rows) {
      if (row.kind !== "gap") {
        digits = Math.max(digits, String(row.num).length);
      }
    }
    return `${digits}ch`;
  }, [rows]);

  return (
    <div className="h-full overflow-auto font-mono text-[12px] leading-[1.7]">
      {/* w-max so rows are as wide as the widest line, min-w-full so their
          background still spans the pane when every line is short. */}
      <div className="w-max min-w-full py-1">
        {rows.map((row, i) => (
          <Row key={i} row={row} gutter={gutter} />
        ))}
        {truncated > 0 && (
          <p className="sticky left-0 px-3 py-2 text-[11px] text-muted-foreground/70">
            {truncated} more rows not shown — open the file to read the rest.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ row, gutter }: { row: DiffRow; gutter: string }) {
  if (row.kind === "gap") {
    return (
      // sticky: the marker stays put when the diff is scrolled sideways, so
      // you never lose your place in a wide file.
      <p className="sticky left-0 px-3 py-1 text-[10px] text-muted-foreground/50">
        ⋯ {row.hidden} unchanged {row.hidden === 1 ? "line" : "lines"}
      </p>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-full gap-2 px-3",
        row.kind === "add" && "bg-success/10 text-success",
        row.kind === "del" && "bg-destructive/10 text-destructive",
        row.kind === "eq" && "text-foreground/70"
      )}
    >
      {/* select-none on the chrome: copying a hunk gives you the code, not
          the code with a line number welded to the front of every line. */}
      <span
        style={{ width: gutter }}
        className="shrink-0 select-none text-right tabular-nums text-muted-foreground/40"
      >
        {row.num}
      </span>
      <span className="w-[1ch] shrink-0 select-none opacity-70">
        {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
      </span>
      <span className="whitespace-pre">{row.text}</span>
    </div>
  );
}
