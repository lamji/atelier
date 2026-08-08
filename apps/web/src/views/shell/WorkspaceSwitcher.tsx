import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, FolderGit2, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { useProjectsStore } from "@/state/projects.store";
import { useSessionsStore } from "@/state/sessions.store";
import { addProject, openWorkspace } from "@/services/project-switch";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Header workspace switcher — the only place projects are switched or
 * added, since the app opens straight into a workspace. Every open
 * workspace keeps its agent working in the background; the menu shows
 * which ones are busy.
 */
export function WorkspaceSwitcher() {
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const switching = useProjectsStore((s) => s.switching);
  // The active project's activity comes from live session state; background
  // ones from the desktop's per-agent status pushes.
  const activeWorking = useSessionsStore((s) =>
    Object.values(s.sessions).some((session) => session.status === "working")
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  const active = projects.find((p) => p.id === activeId);

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

  /** Pick a folder, register it, and open it as a workspace. */
  const addNew = async () => {
    setOpen(false);
    const path = await window.atelierDesktop?.pickFolder();
    if (!path) return;
    try {
      const project = await addProject(path);
      await openWorkspace(project.id);
    } catch {
      // The status bar reports a failed attach; the current workspace stays.
    }
  };

  const isWorking = (project: AtelierProjectInfo): boolean =>
    project.id === activeId ? activeWorking : project.working;

  const ordered = [...projects].sort((a, b) => {
    const working = Number(isWorking(b)) - Number(isWorking(a));
    return working !== 0
      ? working
      : (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
  });
  const othersWorking = projects.filter(
    (p) => p.id !== activeId && isWorking(p)
  ).length;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={switching}
        title={active?.path}
        className={cn(
          "flex h-7 max-w-[min(15rem,32vw)] items-center gap-1.5 rounded-md",
          "px-2 text-xs font-medium outline-none transition-colors",
          "hover:bg-accent",
          "disabled:opacity-60",
          open ? "bg-accent" : "bg-accent/50"
        )}
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{active?.name ?? "Workspace"}</span>
        {othersWorking > 0 && (
          <Tooltip
            content={`${othersWorking} other workspace${
              othersWorking > 1 ? "s have agents" : " has an agent"
            } working right now`}
          >
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full bg-primary/15",
                "px-1.5 text-[10px] font-semibold tabular-nums text-primary"
              )}
            >
              <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
              {othersWorking}
            </span>
          </Tooltip>
        )}
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 opacity-60 transition-transform",
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
              "absolute left-0 top-full z-50 mt-1",
              "w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg",
              "border border-border bg-card shadow-xl"
            )}
          >
            <ul className="max-h-[min(60vh,20rem)] overflow-y-auto p-1">
              {ordered.map((project) => (
                <li key={project.id}>
                  <WorkspaceRow
                    project={project}
                    selected={project.id === activeId}
                    working={isWorking(project)}
                    onSelect={() => {
                      setOpen(false);
                      if (project.id !== activeId) {
                        void openWorkspace(project.id).catch(() => undefined);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
            <div className="border-t border-border p-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => void addNew()}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5",
                  "text-left text-xs font-medium text-primary",
                  "outline-none transition-colors hover:bg-accent/60"
                )}
              >
                <Plus className="h-3.5 w-3.5" />
                New project…
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function WorkspaceRow(props: {
  project: AtelierProjectInfo;
  selected: boolean;
  working: boolean;
  onSelect: () => void;
}) {
  const { project, selected, working } = props;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onSelect}
      title={project.path}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5",
        "text-left outline-none transition-colors",
        selected ? "bg-primary/10" : "hover:bg-accent/60"
      )}
    >
      {working ? (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            project.status === "error"
              ? "bg-destructive"
              : "bg-muted-foreground/30"
          )}
        />
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-xs font-medium",
            selected ? "text-primary" : "text-foreground"
          )}
        >
          {project.name}
        </span>
        {/* Tail-truncated: the deep end of a path identifies it. */}
        <span className="block truncate text-[10px] leading-snug text-muted-foreground/70 [direction:rtl] [text-align:left]">
          {project.path}
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 text-[10px]",
          working ? "font-medium text-primary" : "text-muted-foreground/60"
        )}
      >
        {working ? "working" : project.status === "error" ? "error" : ""}
      </span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
    </button>
  );
}
