import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { McpServerInfo } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { cn } from "@/lib/cn";

/**
 * MCP servers a run will load, read from the agent. Read-only: these come
 * from the same config files Claude Code reads, and editing them belongs
 * in those files, not in a second place that could disagree.
 */
export function McpTab() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("session.listMcpServers", {})
      .then(({ servers }) => setServers(servers))
      .catch((e) =>
        setError(String((e as { message?: string })?.message ?? e))
      );
  }, [connected]);

  if (error) {
    return (
      <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
        {error}
      </p>
    );
  }
  if (!servers) return <Loading />;

  return (
    <section className="space-y-1.5">
      <h3 className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        MCP servers · {servers.length}
      </h3>
      <p className="px-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
        From .mcp.json and .claude/settings.json, user then project. Edit
        those files to change them.
      </p>
      <ul className="space-y-1">
        {servers.map((server) => (
          <li
            key={`${server.scope}:${server.name}`}
            className="rounded-xl bg-muted/40 p-2.5"
          >
            <div className="flex items-center gap-1.5">
              <p className="min-w-0 flex-1 truncate text-[11px] font-semibold">
                {server.name}
              </p>
              <ScopeChip scope={server.scope} />
            </div>
            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground/70">
              {server.transport} · {server.detail || "—"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScopeChip({ scope }: { scope: McpServerInfo["scope"] }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wide",
        scope === "builtin"
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground/70"
      )}
    >
      {scope}
    </span>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground/60">
      <Loader2 className="h-3 w-3 animate-spin" />
      Loading…
    </p>
  );
}
