import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, FolderGit2, FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import { isDesktop, pickFolder } from "@/lib/desktop";
import { useProjectsStore } from "@/state/projects.store";
import { addProject, switchProject } from "@/services/project-switch";

/**
 * Header project chip, upgraded to a menu. Switching drives the existing
 * projects.start flow; "Open Folder…" is desktop-only and feeds the native
 * picker's path into the same projects.add RPC that `?open=` uses.
 */
export function ProjectSwitcher() {
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const switching = useProjectsStore((s) => s.switching);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  const active = projects.find((p) => p.id === activeId);
  const desktop = isDesktop();

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

  if (!active && projects.length === 0 && !desktop) return null;

  const onOpenFolder = async () => {
    setOpen(false);
    const path = await pickFolder();
    if (!path) return;
    try {
      const project = await addProject(path);
      await switchProject(project.id);
    } catch {
      // The connection gate surfaces start failures; nothing to do here.
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={switching}
        className={cn(
          "flex h-8 items-center gap-2 rounded-lg bg-accent/60 px-2.5",
          "text-xs font-medium outline-none transition-colors",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/50",
          open && "bg-accent"
        )}
      >
        <FolderGit2 className="h-4 w-4 text-muted-foreground" />
        <span className="max-w-[160px] truncate">
          {active?.name ?? "Open a project"}
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "absolute left-0 top-full z-50 mt-1 w-64",
              "max-h-[min(60vh,22rem)] overflow-y-auto rounded-lg",
              "border border-border bg-card p-1 shadow-xl"
            )}
          >
            {projects.map((project) => {
              const selected = project.id === activeId;
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    if (!selected) void switchProject(project.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5",
                    "text-left text-xs outline-none transition-colors",
                    selected
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent/60"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {project.name}
                    </span>
                    <span
                      className={cn(
                        "block truncate text-[10px]",
                        selected ? "opacity-70" : "text-muted-foreground"
                      )}
                    >
                      {project.path}
                    </span>
                  </span>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })}

            {desktop && (
              <>
                {projects.length > 0 && (
                  <div className="mx-1 my-1 border-t border-border" />
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void onOpenFolder()}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5",
                    "text-left text-xs font-medium outline-none",
                    "text-foreground transition-colors hover:bg-accent/60"
                  )}
                >
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  Open Folder…
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
