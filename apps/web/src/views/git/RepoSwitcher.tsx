import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, FolderGit2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GitRepo } from "@atelier/protocol";

export interface RepoSwitcherProps {
  repos: GitRepo[];
  active: string | null;
  onSelect: (repo: string) => void;
}

/**
 * Project switcher for a workspace that holds several checkouts.
 *
 * A tab strip was the first attempt and it failed the only constraint
 * that mattered: this panel is a narrow sidebar, so four projects already
 * pushed the rest off the edge — the control hid the very thing it
 * existed to show. A single row states the current project and yields
 * the full width to it.
 *
 * The menu carries each project's uncommitted count. That answers a
 * question nothing else in the app does — "where did I leave work?" —
 * across every project in the folder, which is the reason to open it.
 */
export function RepoSwitcher({ repos, active, onSelect }: RepoSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const current = repos.find((repo) => repo.path === active);

  // Matches the app's Select: click-outside and Escape both dismiss.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (repos.length === 0) return null;

  const label = current?.name ?? "Select a project";
  const detail = current
    ? [current.branch ?? "no branch", changeLabel(current.changedFiles)]
        .filter(Boolean)
        .join(" · ")
    : `${repos.length} projects in this folder`;

  return (
    <div
      ref={rootRef}
      className="relative shrink-0 border-b border-border/60 px-1.5 py-1.5"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
          "outline-none transition-colors hover:bg-accent/60",
          "focus-visible:ring-2 focus-visible:ring-primary/50",
          open && "bg-accent/60"
        )}
      >
        <FolderGit2 className="h-4 w-4 shrink-0 text-primary/70" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-tight">
            {label}
          </span>
          <span className="mt-0.5 block truncate text-[10px] leading-tight text-muted-foreground">
            {detail}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "absolute left-1.5 right-1.5 top-full z-50 mt-0.5",
              "max-h-[min(60vh,22rem)] overflow-y-auto rounded-lg",
              "border border-white/10 bg-card p-1 shadow-xl"
            )}
          >
            {repos.map((repo) => {
              const selected = repo.path === active;
              return (
                <li key={repo.path} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (!selected) onSelect(repo.path);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5",
                      "text-left outline-none transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-primary/50",
                      selected
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-accent/60"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium leading-tight">
                        {repo.name}
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 block truncate text-[10px] leading-tight",
                          selected ? "opacity-70" : "text-muted-foreground"
                        )}
                      >
                        {repo.branch ?? "no branch"}
                      </span>
                    </span>
                    {repo.changedFiles > 0 && (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-1.5 py-0.5",
                          "text-[10px] tabular-nums",
                          selected
                            ? "bg-primary/20"
                            : "bg-muted-foreground/15 text-muted-foreground"
                        )}
                      >
                        {repo.changedFiles}
                      </span>
                    )}
                    {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

/** "3 changed" / "1 changed" / nothing at all when the tree is clean. */
function changeLabel(count: number): string {
  return count > 0 ? `${count} changed` : "";
}
