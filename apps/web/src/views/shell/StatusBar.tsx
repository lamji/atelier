import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  GaugeCircle,
  GitBranch,
  Loader2,
  Plug,
  PlugZap,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { AgentStatus, ConnectionState } from "@/types";
import type { IndexingProgress } from "@/state/knowledge.store";
import type { UsageVm } from "@/hooks/useUsageViewModel";
import type { UsageWindow } from "@atelier/protocol";

export interface StatusBarProps {
  connection: ConnectionState;
  agentStatus: AgentStatus;
  agentStatusDetail?: string;
  workspaceRoot: string | null;
  /** Live current git branch, straight from git.state.changed. */
  branch: string | null;
  /** Live plan usage. */
  usage: UsageVm;
  /** Live indexing indicator (shown beside the folder path). */
  indexingActive: boolean;
  indexing: IndexingProgress | null;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  handshaking: "Handshaking…",
  connected: "Connected",
  unauthorized: "Unauthorized",
};

export function StatusBar(props: StatusBarProps) {
  const connOk = props.connection === "connected";
  const agentTone =
    props.agentStatus === "waiting-auth" || props.agentStatus === "error"
      ? "text-destructive"
      : props.agentStatus === "working"
        ? "text-primary"
        : "text-muted-foreground";

  return (
    <div className="flex h-full items-center gap-4 px-3 text-[11px]">
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
      <span className={cn("flex items-center gap-1.5 font-medium", agentTone)}>
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full bg-current",
            props.agentStatus === "working" && "animate-pulse"
          )}
        />
        agent {props.agentStatus}
      </span>
      {props.agentStatusDetail && (
        <span className="truncate text-muted-foreground">
          {props.agentStatusDetail}
        </span>
      )}
      {props.branch && (
        <span
          className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground"
          title="Current branch"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="max-w-[160px] truncate">{props.branch}</span>
        </span>
      )}
      <UsagePill usage={props.usage} />
      {props.indexingActive && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="tabular-nums">
            {props.indexing
              ? `Indexing ${props.indexing.done}/${props.indexing.total}`
              : "Indexing…"}
          </span>
        </span>
      )}
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-muted-foreground",
          !props.indexingActive && "ml-auto"
        )}
      >
        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{props.workspaceRoot ?? "no workspace"}</span>
      </span>
    </div>
  );
}

/**
 * Live plan usage as compact bars — one per window (5-hour, weekly, …),
 * each showing how much has been USED and when it resets. Hidden for
 * API-key sessions where plan limits do not apply.
 */
function UsagePill({ usage }: { usage: UsageVm }) {
  // Tick once a second so the reset countdowns advance live.
  const [now, setNow] = useState(() => Date.now());
  const lastResetRefresh = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // When any window's countdown crosses zero the window has reset — pull a
  // fresh probe (guarded so it fires once, not every tick) to get the new
  // reset time and the reset utilization.
  const anyExpired = usage.windows.some(
    (w) => w.resetsAt != null && w.resetsAt - now <= 0
  );
  useEffect(() => {
    if (!anyExpired || usage.refreshing) return;
    if (now - lastResetRefresh.current < 15_000) return;
    lastResetRefresh.current = now;
    usage.refresh();
  }, [anyExpired, now, usage]);

  if (!usage.available || usage.windows.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-3">
      <GaugeCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {usage.windows.map((w) => (
        <UsageBar key={w.kind} window={w} now={now} />
      ))}
      <button
        onClick={usage.refresh}
        disabled={usage.refreshing}
        title="Refresh usage now (auto-refreshes every 2 min)"
        className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw
          className={cn("h-3 w-3", usage.refreshing && "animate-spin")}
        />
      </button>
    </span>
  );
}

/** One window: label, a fill bar of % used, the %, and a live countdown. */
function UsageBar({ window: w, now }: { window: UsageWindow; now: number }) {
  const used = Math.round(w.utilization);
  const fill =
    used >= 90 ? "bg-destructive" : used >= 70 ? "bg-amber-500" : "bg-primary";
  const remaining = w.resetsAt != null ? w.resetsAt - now : null;
  return (
    <span
      className="flex items-center gap-1.5"
      title={`${w.label}: ${used}% used${
        w.resetsAt ? ` · resets in ${formatCountdown(w.resetsAt - now)}` : ""
      }`}
    >
      <span className="font-medium text-muted-foreground">{w.label}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted-foreground/20">
        <span
          className={cn("block h-full rounded-full", fill)}
          style={{ width: `${Math.min(100, Math.max(2, used))}%` }}
        />
      </span>
      <span className="tabular-nums text-muted-foreground">{used}%</span>
      {remaining != null && (
        <span className="tabular-nums text-muted-foreground/60">
          · {formatCountdown(remaining)}
        </span>
      )}
    </span>
  );
}

/** Time-remaining countdown: "3d 4h", "2h 05m", "4m 12s", "9s", "reset". */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "reset";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
