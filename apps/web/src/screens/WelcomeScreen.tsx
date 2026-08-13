import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { FolderOpen } from "lucide-react";
import { addProject, openWorkspace } from "@/services/project-switch";
import { BareTitleBar } from "@/views/shell/WindowControls";
import { BrandMark } from "@/components/BrandMark";
import { cn } from "@/lib/cn";

/**
 * First run: no workspaces exist yet, so the only thing to do is point
 * Atelier at a folder. The native picker opens on arrival — this screen is
 * what stands behind it, and what you land on if you cancel.
 *
 * A folder can also be dropped onto the window, which is the one place
 * this screen spends its boldness.
 */
export function WelcomeScreen() {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoOpened = useRef(false);
  const reduceMotion = useReducedMotion();

  const open = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const project = await addProject(path);
      await openWorkspace(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that folder");
      setBusy(false);
    }
  };

  const choose = async () => {
    if (busy) return;
    const path = await window.atelierDesktop?.pickFolder();
    if (path) await open(path);
  };

  // Straight to the picker on arrival: with nothing to list, a screen whose
  // only button opens a dialog may as well open it.
  useEffect(() => {
    if (autoOpened.current) return;
    autoOpened.current = true;
    void choose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = window.atelierDesktop?.pathForFile(file) ?? null;
    if (!path) {
      setError("Could not read that folder's location");
      return;
    }
    await open(path);
  };

  return (
    <div
      className="flex h-full flex-col bg-background"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Only clear when the pointer actually left the window, not when it
        // crosses between children.
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(event) => void onDrop(event)}
    >
      <BareTitleBar />

      <main className="flex min-h-0 flex-1 items-center justify-center px-6 pb-10">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="w-full max-w-md"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
            New workspace
          </p>
          <h1 className="mt-2.5 text-[26px] font-bold leading-tight tracking-tight">
            Point Atelier at a folder.
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            It maps the code, indexes what matters, and gets to work. One
            folder per workspace — open as many as you like.
          </p>

          {/* The signature: a real drop target, not decoration. */}
          <div
            className={cn(
              "mt-7 flex flex-col items-center rounded-2xl border border-dashed",
              "px-6 py-9 text-center transition-colors duration-150",
              dragging
                ? "border-primary/70 bg-primary/[0.07]"
                : "border-border bg-card/40"
            )}
          >
            <motion.div
              animate={
                reduceMotion
                  ? undefined
                  : { scale: dragging ? 1.12 : 1, rotate: dragging ? 8 : 0 }
              }
              transition={{ type: "spring", stiffness: 260, damping: 18 }}
            >
              <BrandMark className="h-10 w-10" />
            </motion.div>
            <p className="mt-4 text-[13px] font-medium">
              {dragging ? "Drop to open it" : "Drop a folder here"}
            </p>
            <button
              type="button"
              onClick={() => void choose()}
              disabled={busy}
              className={cn(
                "mt-4 flex h-9 items-center gap-2 rounded-xl px-4",
                "bg-primary text-xs font-semibold text-primary-foreground",
                "outline-none transition-opacity hover:opacity-90",
                "disabled:opacity-60"
              )}
            >
              <FolderOpen className="h-4 w-4" />
              {busy ? "Opening…" : "Choose a folder…"}
            </button>
          </div>

          {error && (
            <p
              className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-xs
                leading-relaxed text-destructive"
            >
              {error}
            </p>
          )}

        </motion.div>
      </main>
    </div>
  );
}
