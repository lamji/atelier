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
      className={cn("app-no-drag pill-field w-full text-left")}
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Search files or commands</span>
      <kbd
        className={cn(
          "ml-auto hidden shrink-0 rounded-md bg-muted px-1.5 py-0.5",
          "text-[10px] font-medium tabular-nums text-muted-foreground sm:block"
        )}
      >
        {mod}+P
      </kbd>
    </button>
  );
}
