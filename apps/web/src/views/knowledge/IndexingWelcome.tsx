import { motion } from "framer-motion";
import { Braces, Database, EyeOff, FileCode2, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import type { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";

export interface IndexingWelcomeProps {
  vm: ReturnType<typeof useKnowledgeViewModel>;
  workspaceRoot: string | null;
}

const PHASE_LABEL: Record<string, string> = {
  scan: "Scanning files",
  parse: "Parsing symbols",
  resolve: "Resolving imports",
  embed: "Embedding for search",
  features: "Modeling features",
};

/**
 * Launch welcome page: the knowledge engine building itself, live. Shown
 * over the workspace while the first index pass runs; the Hide button
 * dismisses it to the status-bar indicator so you can start working
 * immediately.
 */
export function IndexingWelcome({ vm, workspaceRoot }: IndexingWelcomeProps) {
  const stats = vm.stats;
  const progress = vm.indexing;
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;
  const project = workspaceRoot?.split(/[\\/]/).filter(Boolean).pop() ?? "workspace";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/75 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg px-6">
        <motion.div
          initial={{ scale: 0.96, y: 10 }}
          animate={{ scale: 1, y: 0 }}
          className="overflow-hidden rounded-lg border border-border-subtle bg-card shadow-pop"
        >
          <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Database className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Building knowledge</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {project}
              </p>
            </div>
            <button
              onClick={vm.dismissWelcome}
              className="ml-auto flex h-8 items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <EyeOff className="h-3.5 w-3.5" />
              Hide
            </button>
          </div>

          <div className="px-5 py-4">
            <div className="mb-1.5 flex items-center justify-between text-[11px]">
              <span className="font-medium text-foreground/80">
                {progress ? (PHASE_LABEL[progress.phase] ?? "Indexing") : "Indexing"}
              </span>
              {progress && (
                <span className="tabular-nums text-muted-foreground">
                  {progress.done}/{progress.total}
                </span>
              )}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full rounded-full bg-primary"
                animate={{ width: pct !== null ? `${pct}%` : "40%" }}
                transition={{ duration: 0.3 }}
                style={pct === null ? { opacity: 0.5 } : undefined}
              />
            </div>
            {progress?.currentPath && (
              <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground/70">
                {progress.currentPath}
              </p>
            )}

            <div className="mt-4 grid grid-cols-3 gap-2">
              <Stat icon={FileCode2} label="Files" value={stats?.files} />
              <Stat icon={Braces} label="Symbols" value={stats?.symbols} />
              <Stat icon={Sparkles} label="Embedded" value={stats?.embedded} />
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function Stat(props: {
  icon: typeof Database;
  label: string;
  value: number | undefined;
}) {
  return (
    <div className={cn("rounded-lg bg-muted/45 px-2.5 py-2 text-center")}>
      <props.icon className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
      <p className="mt-1 text-sm font-semibold tabular-nums">
        {props.value ?? "—"}
      </p>
      <p className="text-[10px] text-muted-foreground">{props.label}</p>
    </div>
  );
}
