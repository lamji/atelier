import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { desktopPlatform } from "@/lib/desktop";

export interface CommandCenterProps {
  /** Opens the palette; the query seeds the mode (">" = commands). */
  onOpen: (initialQuery: string) => void;
}

/**
 * The title bar's command center: a quiet field that opens the palette. It is
 * a button, not an input — the real input lives in the palette, and two focus
 * targets for one search would be a trap for keyboard users.
 */
export function CommandCenter(props: CommandCenterProps) {
  const mod = desktopPlatform() === "darwin" ? "⌘" : "Ctrl";

  return (
    <button
      type="button"
      onClick={() => props.onOpen("")}
      aria-label="Search files and commands"
      aria-keyshortcuts="Control+P Control+Shift+P"
      title={`Search files (${mod}+P) · Commands (${mod}+Shift+P)`}
      className={cn(
        "app-no-drag flex h-[22px] w-full items-center gap-1.5 rounded",
        "border border-border bg-editor/60 px-2 text-[11px]",
        "text-muted-foreground transition-colors",
        "hover:border-primary/50 hover:text-foreground"
      )}
    >
      <Search className="h-3 w-3 shrink-0" />
      <span className="truncate">Search files or run a command</span>
      <kbd
        className={cn(
          "ml-auto hidden shrink-0 rounded border border-border px-1",
          "text-[9px] font-medium tabular-nums sm:block"
        )}
      >
        {mod}+P
      </kbd>
    </button>
  );
}
