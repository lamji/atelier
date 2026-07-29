import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  ChevronDown,
  FolderGit2,
  FolderOpen,
  Loader2,
} from "lucide-react";
import type { ProjectInfo, ProjectStatus } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { isDesktop, pickFolder } from "@/lib/desktop";
import { useProjectsStore } from "@/state/projects.store";
import { useSessionsStore } from "@/state/sessions.store";
import { useWorkspaceActivityStore } from "@/state/workspace-activity.store";
import { addProject, switchProject } from "@/services/project-switch";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Workspace switcher. Each project is an isolated workspace with its own
 * agent process, so the menu states which ones are live: a project keeps
 * running (and keeps working) while you are looking at another one.
 *
 * Switching drives the existing projects.start flow; "Open Folder…" is
 * desktop-only and feeds the native picker's path into the same
 * projects.add RPC that the `?open=` bootstrap uses.
 */
export function ProjectSwitcher() {
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const switching = useProjectsStore((s) => s.switching);
  const activity = useWorkspaceActivityStore((s) => s.byProject);
  // The active project is not monitored (the main bridge already sees it).
  const activeWorking = useSessionsStore((s) =>
    Object.values(s.sessions).some((session) => session.status === "working")
  );
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

  const isWorking = (project: ProjectInfo): boolean =>
    project.id === activeId
      ? activeWorking
      : (activity[project.id]?.working ?? false);

  // Projects with an agent actually working come first — that is the thing
  // worth surfacing — then most recently opened.
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
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/50",
          "disabled:opacity-60",
          open ? "bg-accent" : "bg-accent/50"
        )}
      >
        {switching ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{active?.name ?? "Open a project"}</span>
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
            <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Workspaces
            </p>
            <ul className="max-h-[min(60vh,20rem)] overflow-y-auto p-1 pt-0">
              {ordered.map((project) => (
                <li key={project.id}>
                  <ProjectRow
                    project={project}
                    selected={project.id === activeId}
                    working={isWorking(project)}
                    onSelect={() => {
                      setOpen(false);
                      if (project.id !== activeId) {
                        void switchProject(project.id);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>

            {desktop && (
              <div className="border-t border-border p-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void onOpenFolder()}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5",
                    "text-left text-xs font-medium text-foreground",
                    "outline-none transition-colors hover:bg-accent/60"
                  )}
                >
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  Open Folder…
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ProjectRow(props: {
  project: ProjectInfo;
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
      <StatusDot status={project.status} working={working} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-xs font-medium",
            selected ? "text-primary" : "text-foreground"
          )}
        >
          {project.name}
        </span>
        {/* Tail-truncated: the deep end of a path identifies it, the
            "C:\Users\..." head never does. */}
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
        {rowLabel(project.status, working)}
      </span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
    </button>
  );
}

/**
 * Only real work earns a label. A warm-but-idle agent says nothing: every
 * project you have opened this session keeps its process alive, so calling
 * that "live" would light up the whole list and mean nothing.
 */
function rowLabel(status: ProjectStatus, working: boolean): string {
  if (working) return "working";
  if (status === "starting") return "starting";
  if (status === "error") return "error";
  return "";
}

function StatusDot({
  status,
  working,
}: {
  status: ProjectStatus;
  working: boolean;
}) {
  if (working) {
    return (
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        status === "starting" && "animate-pulse bg-amber-500",
        status === "error" && "bg-destructive",
        // Warm and idle reads the same as cold: neither is doing anything.
        (status === "running" || status === "stopped") &&
          "bg-muted-foreground/30"
      )}
    />
  );
}
