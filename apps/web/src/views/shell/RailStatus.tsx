import { useEffect, useState } from "react";
import { Check, FolderOpen, Layers, Loader2, Plug, PlugZap, Activity } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { ConnectionState } from "@/types";
import type { IndexingProgress } from "@/state/knowledge.store";
import type { ContextStatsVm } from "@/hooks/useContextStatsViewModel";

/**
 * Workspace status, at the foot of the dock rail.
 *
 * It was a full-width strip along the bottom of the window: one row of the
 * shell's height spent on a connection label, a path, a sync line and a
 * token pill, none of which is read more than once a session. The rail
 * already runs the height of the window and already holds every other
 * always-available control, so the status went where the controls are and
 * the strip went away.
 *
 * What survives is one tile carrying the only thing that is urgent — the
 * bridge being down — with the rest a click behind it.
 */
export interface RailStatusProps {
  connection: ConnectionState;
  agentStatusDetail?: string;
  workspaceRoot: string | null;
  /** Live context-engineering token metrics. */
  contextStats: ContextStatsVm;
  /** Live indexing indicator. */
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

export function RailStatus(props: RailStatusProps) {
  const connOk = props.connection === "connected";
  const showSync = props.indexingActive || props.lastIndexedAt != null;
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div className="relative flex shrink-0 flex-col items-center pb-2">
      <Tooltip
        side="right"
        content={
          detailsOpen
            ? "Hide workspace details"
            : `Workspace details — ${CONNECTION_LABEL[props.connection]}` +
              (props.agentStatusDetail ? ` · ${props.agentStatusDetail}` : "")
        }
      >
        <button
          type="button"
          aria-label="Workspace details"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
          className={cn("dock-tile", detailsOpen && "dock-tile-on")}
        >
          <Activity className="h-[18px] w-[18px] shrink-0" />
          {/* The bridge being down is the one status worth a glance rather
              than a click, so it rides on the tile itself. */}
          {!connOk && (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full",
                "ring-2 ring-canvas",
                props.connection === "connecting"
                  ? "bg-warning"
                  : "bg-destructive"
              )}
            />
          )}
        </button>
      </Tooltip>
      {detailsOpen && (
        <div
          role="dialog"
          aria-label="Workspace details"
          className={cn(
            "absolute bottom-0 left-[calc(100%_+_0.5rem)] z-50 w-96",
            "rounded-lg border border-border-subtle bg-card p-4",
            "text-[11px] text-foreground shadow-pop"
          )}
        >
          <div className="mb-3 flex items-center gap-2 border-b border-border-subtle pb-3 font-medium">
            <Activity className="h-3.5 w-3.5 text-primary" />
            Workspace details
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-[90px_1fr] items-center gap-3">
              <span className="text-muted-foreground">Connection</span>
              <span
                className={cn(
                  "flex items-center gap-1.5 font-medium",
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
            </div>
            {props.agentStatusDetail && (
              <div className="grid grid-cols-[90px_1fr] items-start gap-3">
                <span className="text-muted-foreground">Agent</span>
                <span className="min-w-0 text-muted-foreground">
                  {props.agentStatusDetail}
                </span>
              </div>
            )}
            <div className="grid grid-cols-[90px_1fr] items-start gap-3">
              <span className="pt-1 text-muted-foreground">Workspace</span>
              <Tooltip content={props.workspaceRoot ?? "No workspace attached"}>
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate [direction:rtl] [text-align:left]">
                    {props.workspaceRoot ?? "no workspace"}
                  </span>
                </span>
              </Tooltip>
            </div>
            {showSync && (
              <div className="grid grid-cols-[90px_1fr] items-center gap-3">
                <span className="text-muted-foreground">Knowledge</span>
                <SyncStatus
                  active={props.indexingActive}
                  indexing={props.indexing}
                  lastIndexedAt={props.lastIndexedAt}
                />
              </div>
            )}
            {props.contextStats.available && props.contextStats.last && (
              <div className="grid grid-cols-[90px_1fr] items-center gap-3">
                <span className="text-muted-foreground">Context</span>
                <ContextPill stats={props.contextStats} />
              </div>
            )}
          </div>
        </div>
      )}
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
