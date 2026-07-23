import { FolderOpen, Plug, PlugZap } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AgentStatus, ConnectionState } from "@/types";

export interface StatusBarProps {
  connection: ConnectionState;
  agentStatus: AgentStatus;
  agentStatusDetail?: string;
  workspaceRoot: string | null;
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
      <span className="ml-auto flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{props.workspaceRoot ?? "no workspace"}</span>
      </span>
    </div>
  );
}
