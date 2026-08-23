import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ListSearchProps {
  value: string;
  onChange: (next: string) => void;
  /** How many items exist before filtering — drives the placeholder. */
  total: number;
  /** How many survive the current query — shown as `shown/total`. */
  shown: number;
  placeholder: string;
  className?: string;
}

/**
 * Filter box shared by the sidebar lists (notes, agent sessions). Past a
 * couple of screens' worth of rows, scrolling stops being the fastest way
 * to find one — and the rows already carry everything worth matching on,
 * so callers match the whole row, not just its title.
 */
export function ListSearch({
  value,
  onChange,
  total,
  shown,
  placeholder,
  className,
}: ListSearchProps) {
  const filtering = value.trim().length > 0;
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears the filter instead of reaching the global
          // shortcut layer, which would close the panel out from under it.
          if (e.key === "Escape" && filtering) {
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={placeholder}
        className={cn(
          "h-8 w-full rounded-lg border border-border/40 bg-muted/25 pl-8 pr-16",
          "text-xs outline-none placeholder:text-muted-foreground/50",
          "focus:border-border/70 focus:bg-muted/40"
        )}
      />
      {filtering && (
        <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {shown}/{total}
          </span>
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="rounded-md p-0.5 text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * Shown in place of the list when a query matches nothing. Keeps the
 * "clear search" escape hatch next to the thing that caused the emptiness.
 */
export function ListSearchEmpty({
  query,
  label,
  onClear,
}: {
  query: string;
  /** Singular noun for the row type, e.g. "note", "session". */
  label: string;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-2xl bg-muted/50 text-muted-foreground/40">
        <Search className="h-4 w-4" />
      </span>
      <p className="text-xs font-medium text-foreground/60">
        No {label} matches “{query.trim()}”
      </p>
      <button
        type="button"
        onClick={onClear}
        className="text-[11px] text-primary/80 hover:text-primary hover:underline"
      >
        Clear search
      </button>
    </div>
  );
}
