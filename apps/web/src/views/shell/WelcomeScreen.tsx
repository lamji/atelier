import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FolderGit2, FolderOpen, Loader2 } from "lucide-react";
import type { ProjectInfo } from "@atelier/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isDesktop, pickFolder } from "@/lib/desktop";
import { useProjectsStore } from "@/state/projects.store";
import { addProject, switchProject } from "@/services/project-switch";

/**
 * Desktop-only landing view. The desktop build never auto-opens a workspace
 * and never shows a boot spinner: this screen is up instantly, the user
 * clicks a recent project or picks a folder with the native dialog, and the
 * shell appears the moment the workspace is selected. The browser build
 * keeps its `atelier run` flow and never renders this.
 */
export function WelcomeScreen() {
  const activeId = useProjectsStore((s) => s.activeId);
  const projects = useProjectsStore((s) => s.projects);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isDesktop()) return null;

  const recents = [...projects].sort(
    (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)
  );

  const openProject = async (id: string) => {
    setError(null);
    setOpeningId(id);
    try {
      await switchProject(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open project");
    } finally {
      setOpeningId(null);
    }
  };

  const openFolder = async () => {
    setError(null);
    const path = await pickFolder();
    if (!path) return;
    setPicking(true);
    try {
      const project = await addProject(path);
      await switchProject(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open folder");
    } finally {
      setPicking(false);
    }
  };

  return (
    <AnimatePresence>
      {activeId === null && (
        <motion.div
          initial={false}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-x-0 bottom-0 top-[var(--titlebar-h)] z-[90]
            flex items-center justify-center bg-background p-6"
        >
          <div className="w-full max-w-lg">
            <div className="flex items-center gap-3">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center
                  rounded-2xl bg-primary/12 text-primary"
              >
                <FolderGit2 className="h-5 w-5" />
              </span>
              <div>
                <h1 className="text-base font-bold tracking-tight">
                  Open a project
                </h1>
                <p className="text-xs text-muted-foreground">
                  Pick a recent workspace or import a folder from your machine.
                </p>
              </div>
            </div>

            {error && (
              <p
                className="mt-4 rounded-xl bg-destructive/10 px-3 py-2
                  text-xs leading-relaxed text-destructive"
              >
                {error}
              </p>
            )}

            {recents.length > 0 && (
              <>
                <p
                  className="mt-6 text-[10px] font-semibold uppercase
                    tracking-wider text-muted-foreground/70"
                >
                  Recent
                </p>
                <ul
                  className="mt-1.5 max-h-[min(45vh,18rem)] space-y-1
                    overflow-y-auto"
                >
                  {recents.map((project) => (
                    <li key={project.id}>
                      <RecentRow
                        project={project}
                        opening={openingId === project.id}
                        disabled={openingId !== null || picking}
                        onOpen={() => void openProject(project.id)}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}

            <Button
              className="mt-6 w-full"
              onClick={() => void openFolder()}
              disabled={picking || openingId !== null}
            >
              {picking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderOpen className="h-4 w-4" />
              )}
              Open Folder…
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function RecentRow(props: {
  project: ProjectInfo;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { project, opening, disabled } = props;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      disabled={disabled}
      title={project.path}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left",
        "outline-none ring-1 ring-border/60 transition-colors",
        "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-primary/50",
        "disabled:opacity-60",
        opening && "bg-accent/60"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          {project.name}
        </span>
        {/* Tail-truncated: the deep end of a path identifies it. */}
        <span
          className="block truncate text-[10px] leading-snug
            text-muted-foreground/70 [direction:rtl] [text-align:left]"
        >
          {project.path}
        </span>
      </span>
      {opening && (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      )}
    </button>
  );
}
