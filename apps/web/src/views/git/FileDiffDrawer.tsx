import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { FileDiff, FileQuestion, Loader2, Minus, Plus, Undo2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { languageForPath } from "@/lib/diff-view";
import { MonacoDiff } from "@/components/MonacoDiff";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useGitStore } from "@/state/git.store";
import { useThemeStore } from "@/state/theme.store";
import type { GitViewModel } from "@/hooks/useGitViewModel";
import { DiffStat, statOf } from "./DiffStat";

const DIFF_OPTIONS = {
  readOnly: true,
  automaticLayout: true,
  renderSideBySide: false,
  renderOverviewRuler: false,
  minimap: { enabled: false },
  fontSize: 13,
  // Inline mode packs both original and modified line numbers into one
  // gutter column; 3 chars runs them together past line 999.
  lineNumbersMinChars: 6,
  glyphMargin: false,
  folding: false,
  scrollBeyondLastLine: false,
  hideUnchangedRegions: { enabled: true },
} as const;

/**
 * The diff of one changed file, as a panel that slides in over the right
 * of the Changes view. Anchored right rather than centred because the file
 * list stays legible beside it — you pick the next file without closing
 * anything — and the actions that end the file's life (stage, unstage,
 * discard) live in its footer, where the decision is actually made.
 */
export function FileDiffDrawer({ vm }: { vm: GitViewModel }) {
  const diff = vm.gitDiff;
  const loadingPath = useGitStore((s) => s.gitDiffLoading);
  const theme = useThemeStore((s) => s.theme);
  const reduced = useReducedMotion();
  const open = diff !== null || loadingPath !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") vm.closeDiff();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, vm]);

  const file = diff
    ? (vm.status?.files.find((f) => f.path === diff.path) ?? null)
    : null;
  const stat = file ? statOf(file, diff?.staged ? "index" : "work") : undefined;
  const act = (run: () => Promise<void>) => {
    void run().catch(() => undefined);
    vm.closeDiff();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={vm.closeDiff}
            className="absolute inset-0 z-20 bg-black/40"
          />
          <motion.div
            role="dialog"
            aria-label={diff ? `Diff of ${diff.path}` : "Loading diff"}
            initial={reduced ? false : { x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="absolute inset-y-0 right-0 z-30 flex w-[min(64rem,74%)] flex-col bg-card shadow-pop ring-1 ring-white/10"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <FileDiff className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs font-medium">
                  {diff?.path ?? loadingPath}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {diff?.staged ? "staged · HEAD → index" : "working tree · index → disk"}
                </p>
              </div>
              {stat && <DiffStat stat={stat} />}
              <Tooltip content="Close (Esc)">
                <button
                  onClick={vm.closeDiff}
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>

            <div className="min-h-0 flex-1">
              {!diff ? (
                <Centered>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading diff…
                </Centered>
              ) : stat?.binary ? (
                <Centered>
                  <FileQuestion className="h-4 w-4" />
                  Binary file — no text diff to show.
                </Centered>
              ) : diff.before === "" && diff.after === "" ? (
                <Centered>
                  <FileQuestion className="h-4 w-4" />
                  Nothing to compare — the file is empty on both sides.
                </Centered>
              ) : (
                <MonacoDiff
                  original={diff.before}
                  modified={diff.after}
                  language={languageForPath(diff.path)}
                  theme={theme === "dark" ? "atelier-dark" : "atelier-light"}
                  options={DIFF_OPTIONS}
                />
              )}
            </div>

            {diff && (
              <div className="flex items-center gap-1.5 border-t border-white/5 px-3 py-2">
                <span className="text-[10px] text-muted-foreground/70">
                  {diff.staged
                    ? "Staged content — what a commit would record."
                    : "Working-tree content — not staged yet."}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {diff.staged ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => act(() => vm.unstage([diff.path]))}
                    >
                      <Minus className="mr-1.5 h-3.5 w-3.5" />
                      Unstage
                    </Button>
                  ) : (
                    <>
                      <Tooltip content="Tracked files are restored, untracked ones deleted">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive/80 hover:text-destructive"
                          onClick={() => {
                            const ok = window.confirm(
                              `Discard changes in ${diff.path}?\n\n` +
                                "This cannot be undone."
                            );
                            if (ok) act(() => vm.discard([diff.path]));
                          }}
                        >
                          <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                          Discard
                        </Button>
                      </Tooltip>
                      <Button size="sm" onClick={() => act(() => vm.stage([diff.path]))}>
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Stage
                      </Button>
                    </>
                  )}
                </span>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center gap-2",
        "text-xs text-muted-foreground"
      )}
    >
      {children}
    </div>
  );
}
