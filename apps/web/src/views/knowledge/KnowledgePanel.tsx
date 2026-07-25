import { useState } from "react";
import {
  Braces,
  Database,
  FileCode2,
  GraduationCap,
  Loader2,
  Network,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";

export interface KnowledgePanelProps {
  vm: ReturnType<typeof useKnowledgeViewModel>;
  onOpenRag: () => void;
}

/**
 * Left-column Knowledge view: live index stats, indexing progress, the
 * re-index action, recent knowledge updates, and shortcuts into the Graph
 * and RAG Inspector panes.
 */
export function KnowledgePanel({ vm, onOpenRag }: KnowledgePanelProps) {
  const [reindexing, setReindexing] = useState(false);
  const { stats, indexing } = vm;

  const runReindex = async (force: boolean) => {
    setReindexing(true);
    try {
      await vm.reindex(force);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-primary/80" />
        <h2 className="text-sm font-semibold">Knowledge</h2>
        <Tooltip content="Scan for drift and index changed files">
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1.5 px-2"
            disabled={!vm.connected || reindexing}
            onClick={() => void runReindex(false)}
          >
            {reindexing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync
          </Button>
        </Tooltip>
      </div>

      {indexing && indexing.total > 0 && (
        <div className="rounded-lg bg-muted/50 p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="font-medium capitalize text-foreground/80">
              {indexing.phase === "embed" ? "Embedding" : "Indexing"}…
            </span>
            <span className="tabular-nums text-muted-foreground">
              {indexing.done}/{indexing.total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width: `${Math.min(100, (indexing.done / indexing.total) * 100)}%`,
              }}
            />
          </div>
          {indexing.currentPath && (
            <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
              {indexing.currentPath}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <Stat icon={FileCode2} label="Files" value={stats?.files} />
        <Stat icon={Braces} label="Symbols" value={stats?.symbols} />
        <Stat icon={Workflow} label="Call edges" value={stats?.edges} />
        <Stat icon={ScanSearch} label="Chunks" value={stats?.chunks} />
        <Stat icon={Sparkles} label="Embedded" value={stats?.embedded} />
        <Stat
          icon={Network}
          label="Features"
          value={Math.max(vm.features.length, stats?.features ?? 0)}
          busy={vm.featureScan !== null}
        />
        <Stat icon={GraduationCap} label="Lessons" value={stats?.lessons} />
      </div>
      {stats?.lastIndexedAt != null && (
        <p className="text-[10px] text-muted-foreground/70">
          Last indexed {new Date(stats.lastIndexedAt).toLocaleTimeString()}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Button
          size="sm"
          className="h-9 w-full gap-2"
          disabled={!vm.connected}
          onClick={() => vm.openGraph("workspace")}
        >
          <Network className="h-4 w-4" />
          View graph
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 w-full gap-1.5"
          disabled={!vm.connected}
          onClick={onOpenRag}
        >
          <ScanSearch className="h-3.5 w-3.5" />
          RAG inspector
        </Button>
        <Tooltip content="Scan routes & endpoints and summarize each as a feature (Haiku)">
          <Button
            size="sm"
            variant="secondary"
            className="h-8 w-full gap-1.5"
            disabled={!vm.connected || vm.featureScan !== null}
            onClick={() => void vm.scanFeatures()}
          >
            {vm.featureScan ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {vm.featureScan
              ? vm.featureScan.phase === "discover"
                ? "Discovering routes…"
                : `Scanning ${vm.featureScan.done}/${vm.featureScan.total}`
              : "Scan features"}
          </Button>
        </Tooltip>
      </div>

      {(vm.features.length > 0 || vm.featureScan) && (
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Features
            {vm.featureScan && vm.featureScan.total > 0 && (
              <span className="font-normal normal-case text-primary">
                · scanning {vm.featureScan.done}/{vm.featureScan.total}
                {vm.featureScan.current ? ` · ${vm.featureScan.current}` : ""}
              </span>
            )}
          </h3>
          <ul className="space-y-1.5">
            {vm.features.slice(0, 8).map((feature) => (
              <Tooltip key={feature.id} content={feature.summary}>
                <li className="rounded-lg bg-muted/40 px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                      {feature.name}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold",
                        feature.status === "fresh"
                          ? "bg-success/15 text-success"
                          : feature.status === "stale"
                            ? "bg-amber-500/15 text-amber-500"
                            : "bg-muted text-muted-foreground"
                      )}
                    >
                      {feature.status}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80">
                    {feature.summary}
                  </p>
                </li>
              </Tooltip>
            ))}
          </ul>
        </div>
      )}

      {vm.lessons.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Lessons learned
          </h3>
          <ul className="space-y-1.5">
            {vm.lessons.slice(0, 5).map((lesson) => (
              <Tooltip key={lesson.id} content={lesson.body}>
                <li className="rounded-lg bg-muted/40 px-2.5 py-1.5">
                  <div className="flex items-start gap-1.5">
                    <GraduationCap className="mt-0.5 h-3 w-3 shrink-0 text-amber-500/80" />
                    <p className="min-w-0 text-[11px] leading-snug">{lesson.title}</p>
                  </div>
                  <p className="mt-0.5 truncate pl-[18px] text-[10px] text-muted-foreground/70">
                    {lesson.kind}
                    {lesson.links.length > 0 && ` · ${lesson.links.join(", ")}`}
                    {lesson.useCount > 0 && ` · used ${lesson.useCount}×`}
                  </p>
                </li>
              </Tooltip>
            ))}
          </ul>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Recent updates
        </h3>
        {vm.recentUpdates.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">
            Knowledge deltas appear here as code changes.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {vm.recentUpdates.map((update) => (
              <li
                key={update.ts + (update.files[0] ?? "")}
                className="rounded-lg bg-muted/40 px-2.5 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px]">
                    {update.files[0] ?? "embedding backfill"}
                    {update.files.length > 1 &&
                      ` +${update.files.length - 1} more`}
                  </span>
                  <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/70">
                    {new Date(update.ts).toLocaleTimeString(undefined, {
                      hour12: false,
                    })}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {formatDelta("sym", update.symbolsDelta)}
                  {" · "}
                  {formatDelta("edge", update.edgesDelta)}
                  {" · "}
                  {update.embeddingsDelta} embedded
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        onClick={() => void runReindex(true)}
        disabled={!vm.connected || reindexing}
        className={cn(
          "text-left text-[10px] text-muted-foreground/60 transition-colors",
          "hover:text-muted-foreground disabled:opacity-50"
        )}
      >
        Force full re-index
      </button>
    </div>
  );
}

function Stat(props: {
  icon: typeof Database;
  label: string;
  value: number | undefined;
  busy?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <props.icon className="h-3 w-3" />
        <span className="text-[10px]">{props.label}</span>
        {props.busy && (
          <Loader2 className="ml-auto h-3 w-3 animate-spin text-primary" />
        )}
      </div>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">
        {props.value ?? "—"}
      </p>
    </div>
  );
}

function formatDelta(noun: string, n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n} ${noun}${Math.abs(n) === 1 ? "" : "s"}`;
}
