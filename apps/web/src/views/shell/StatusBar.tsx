import { useEffect, useState, type ReactNode } from "react";
import { Check, FolderOpen, Layers, Loader2, Plug, PlugZap, Activity } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { ConnectionState } from "@/types";
import type { IndexingProgress } from "@/state/knowledge.store";
import type { ContextStatsVm } from "@/hooks/useContextStatsViewModel";

/**
 * What is left in the bottom strip once the dock has it.
 *
 * Agent state and the current branch are gone from here: the dock badges
 * working agents and changed files, and the chat's own header reports what
 * the agent is doing, so the bar was saying it a second time in smaller type.
 * Plan usage is gone too — it is behind the dock's gauge tile now, where it
 * has room for the reset times.
 */
export interface StatusBarProps {
  /**
   * Centred between the two status clusters — the dock. The bar owns the
   * bottom strip, and the dock has to sit in the middle of it, so it is
   * passed in rather than the shell stacking a second full-width layer here
   * that would overlap the status text at narrow widths.
   */
  left?: ReactNode;
  connection: ConnectionState;
  agentStatusDetail?: string;
  workspaceRoot: string | null;
  /** Live context-engineering token metrics. */
  contextStats: ContextStatsVm;
  /** Live indexing indicator (shown beside the folder path). */
  indexingActive: boolean;
  indexing: IndexingProgress | null;
  /** Epoch ms of the last completed knowledge sync, null if never. */
  lastIndexedAt: number | null;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
};

export function StatusBar(props: StatusBarProps) {
  const connOk = props.connection === "connected";

  const showSync = props.indexingActive || props.lastIndexedAt != null;
  const [detailsOpen, setDetailsOpen] = useState(false);

  /*
   * Three columns, not one flex row: the dock has to be centred on the WINDOW,
   * and in a flex row it would sit wherever the status clusters left it —
   * drifting sideways every time a path or a sync label changed length. The
   * `1fr` sides are equal by construction, so the middle column is centred
   * whatever they contain, and each side truncates into its own half.
   */
  return (
    <div className="taskbar-grid">
      <div className="flex min-w-0 items-center justify-start gap-2 overflow-visible">
        {props.left}
      </div>

      <div
        role="status"
        aria-label="Workspace status"
        className="flex min-w-0 items-center justify-end gap-3.5 text-[11px]"
      >
        {props.agentStatusDetail && (
          <span className="hidden min-w-0 truncate text-muted-foreground 2xl:inline">
            {props.agentStatusDetail}
          </span>
        )}
        <div className="relative border-l border-border-subtle pl-3.5">
          <Tooltip content={detailsOpen ? "Hide workspace details" : "Show workspace details"}>
            <button
              type="button"
              aria-label="Show workspace details"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                detailsOpen
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              )}
            >
              <Activity className={cn("h-4 w-4", detailsOpen && "text-primary")} />
            </button>
          </Tooltip>
          {detailsOpen && (
            <div
              role="dialog"
              aria-label="Workspace details"
              className="absolute bottom-9 right-0 z-50 w-96 rounded-lg border border-border-subtle bg-card p-4 text-[11px] text-foreground shadow-pop"
            >
              <div className="mb-3 flex items-center gap-2 border-b border-border-subtle pb-3 font-medium">
                <Activity className="h-3.5 w-3.5 text-primary" />
                Workspace details
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-[90px_1fr] gap-3 items-center">
                  <span className="text-muted-foreground">Connection</span>
                  <span className={cn("flex items-center gap-1.5 font-medium", connOk ? "text-success" : "text-destructive")}>
                    {connOk ? <PlugZap className="h-3.5 w-3.5" /> : <Plug className="h-3.5 w-3.5" />}
                    {CONNECTION_LABEL[props.connection]}
                  </span>
                </div>
                <div className="grid grid-cols-[90px_1fr] gap-3 items-start">
                  <span className="text-muted-foreground pt-1">Workspace</span>
                  <Tooltip content={props.workspaceRoot ?? "No workspace attached"}>
                    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 flex-shrink-0" />
                      <span className="truncate [direction:rtl] [text-align:left]">{props.workspaceRoot ?? "no workspace"}</span>
                    </span>
                  </Tooltip>
                </div>
                {showSync && (
                  <div className="grid grid-cols-[90px_1fr] gap-3 items-center">
                    <span className="text-muted-foreground">Knowledge</span>
                    <SyncStatus active={props.indexingActive} indexing={props.indexing} lastIndexedAt={props.lastIndexedAt} />
                  </div>
                )}
                {props.contextStats.available && props.contextStats.last && (
                  <div className="grid grid-cols-[90px_1fr] gap-3 items-center">
                    <span className="text-muted-foreground">Context</span>
                    <ContextPill stats={props.contextStats} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="hidden items-center gap-3.5">
          <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          <ContextPill stats={props.contextStats} />
          {showSync && (
            <SyncStatus
              active={props.indexingActive}
              indexing={props.indexing}
              lastIndexedAt={props.lastIndexedAt}
            />
          )}
          <Tooltip content={props.workspaceRoot ?? "No workspace attached"}>
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[220px] truncate [direction:rtl] [text-align:left]">
                {props.workspaceRoot ?? "no workspace"}
              </span>
            </span>
          </Tooltip>
          <Tooltip content={`Agent bridge: ${CONNECTION_LABEL[props.connection]}`}>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 font-medium",
                connOk ? "text-success" : "text-destructive"
              )}
            >
              {connOk ? (
                <PlugZap className="h-3.5 w-3.5" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              {CONNECTION_LABEL[props.connection]}
            </span>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/**
 * Engine-knowledge sync status: while the index rebuilds from the latest
 * tree, a live progress bar; when idle, the time of the last completed sync
 * (relative, ticking). The index re-syncs off the newest code, so this is
 * how the user knows the knowledge answers reflect current source.
 */
function SyncStatus({
  active,
  indexing,
  lastIndexedAt,
}: {
  active: boolean;
  indexing: IndexingProgress | null;
  lastIndexedAt: number | null;
}) {
  // Tick so the "synced Xs ago" label stays fresh without a data refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  if (active) {
    const total = indexing?.total ?? 0;
    const done = indexing?.done ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
      <Tooltip
        content={
          indexing
            ? `Syncing knowledge from latest code — ${indexing.phase} ` +
              `${done}/${total}` +
              (indexing.currentPath ? ` · ${indexing.currentPath}` : "")
            : "Syncing knowledge from latest code"
        }
      >
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="tabular-nums">
            {indexing ? `Syncing ${done}/${total}` : "Syncing…"}
          </span>
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-primary/20">
            <span
              className={cn(
                "block h-full rounded-full bg-primary",
                total === 0 && "animate-pulse"
              )}
              style={{ width: total > 0 ? `${Math.max(4, pct)}%` : "100%" }}
            />
          </span>
        </span>
      </Tooltip>
    );
  }

  if (lastIndexedAt == null) return null;
  return (
    <Tooltip content={`Knowledge last synced ${new Date(lastIndexedAt).toLocaleString()}`}>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-success" />
        <span className="tabular-nums">
          Synced {formatSince(now - lastIndexedAt)}
        </span>
      </span>
    </Tooltip>
  );
}

/** Coarse "time ago": "just now", "45s ago", "3m ago", "2h ago", "4d ago". */
function formatSince(ms: number): string {
  if (ms < 5000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Live context-engineering metrics: what the last request's assembled
 * context cost, its savings vs naive assembly, and — across the recent
 * window — fresh input vs prompt-cache reads.
 */
function ContextPill({ stats }: { stats: ContextStatsVm }) {
  if (!stats.available || !stats.last) return null;
  const last = stats.last;
  const sections = last.sections
    .map((s) => `${s.name} ${s.tokens}t`)
    .join(" · ");
  const cacheShare =
    stats.totals.freshInputTokens + stats.totals.cacheReadTokens > 0
      ? Math.round(
          (stats.totals.cacheReadTokens /
            (stats.totals.freshInputTokens + stats.totals.cacheReadTokens)) *
            100
        )
      : null;
  const tip =
    `Last ${last.purpose}: context ${last.appendTokens}t` +
    (last.savedTokens > 0
      ? ` (saved ${last.savedTokens}t, ${last.savedPct}%)`
      : "") +
    (last.dedupedChunks > 0 ? ` · ${last.dedupedChunks} deduped` : "") +
    (sections ? ` · ${sections}` : "") +
    (last.actualInputTokens !== undefined
      ? ` · actual input ${fmtTokens(last.actualInputTokens)}` +
        (last.cacheReadTokens
          ? ` + ${fmtTokens(last.cacheReadTokens)} cached`
          : "")
      : "") +
    (cacheShare !== null ? ` · session cache share ${cacheShare}%` : "");
  return (
    <Tooltip content={tip}>
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="tabular-nums">
          ctx {fmtTokens(last.appendTokens)}
        </span>
        {last.savedPct > 0 && (
          <span className="tabular-nums text-success">−{last.savedPct}%</span>
        )}
      </span>
    </Tooltip>
  );
}

/** Compact token count: "840t", "12.4kt". */
function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}kt` : `${n}t`;
}
