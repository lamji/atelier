import { FolderOpen, Loader2 } from "lucide-react";
import { useProjectsStore } from "@/state/projects.store";
import { addProject, openWorkspace } from "@/services/project-switch";
import { BareTitleBar } from "@/views/shell/WindowControls";
import { cn } from "@/lib/cn";

/**
 * The gap between "a workspace exists" and "the workspace is on screen":
 * the agent is forking, or the last attempt failed. Both used to render an
 * empty div, which reads as a hung app — a black window with no way out.
 */
export function OpeningScreen() {
  const projects = useProjectsStore((s) => s.projects);
  const switching = useProjectsStore((s) => s.switching);
  const error = useProjectsStore((s) => s.openError);

  const ordered = [...projects].sort(
    (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)
  );

  const addNew = async () => {
    const path = await window.atelierDesktop?.pickFolder();
    if (!path) return;
    const project = await addProject(path);
    await openWorkspace(project.id).catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <BareTitleBar />
      <main className="flex min-h-0 flex-1 items-center justify-center px-6 pb-10">
        <div className="w-full max-w-md">
          {switching ? (
            <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Opening workspace…
            </div>
          ) : (
            <>
              <p
                className="font-mono text-[10px] uppercase tracking-[0.18em]
                  text-muted-foreground/60"
              >
                {error ? "Could not open" : "Open a workspace"}
              </p>
              <h1 className="mt-2.5 text-[22px] font-bold leading-tight tracking-tight">
                {error ?? "Pick a workspace to open."}
              </h1>

              <ul className="mt-6 space-y-1">
                {ordered.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() =>
                        void openWorkspace(project.id).catch(() => undefined)
                      }
                      className={cn(
                        "flex w-full flex-col items-start rounded-lg px-3 py-2",
                        "text-left outline-none transition-colors",
                        "hover:bg-accent/60"
                      )}
                    >
                      <span className="text-[13px] font-medium">
                        {project.name}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {project.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => void addNew()}
                className={cn(
                  "mt-5 flex h-9 items-center gap-2 rounded-xl px-4",
                  "bg-primary text-xs font-semibold text-primary-foreground",
                  "outline-none transition-opacity hover:opacity-90"
                )}
              >
                <FolderOpen className="h-4 w-4" />
                Add another folder…
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
