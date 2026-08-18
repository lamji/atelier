import { useCallback, useEffect, useState } from "react";
import type { OllamaCloudUsageWindow, UsageWindow } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useUsageStore } from "@/state/usage.store";

export interface UsageVm {
  available: boolean;
  status: "allowed" | "allowed_warning" | "rejected" | null;
  /** Windows to show as usage bars, 5-hour and weekly first. */
  windows: UsageWindow[];
  /** Activity observed from Ollama Cloud responses, not account quota. */
  ollamaCloudUsage: OllamaCloudUsageWindow[];
  /** True while a manual/auto refresh probe is in flight. */
  refreshing: boolean;
  /** Force a fresh probe of the plan usage. */
  refresh: () => void;
}

/** How often the usage is re-probed while the app is open. */
const AUTO_REFRESH_MS = 2 * 60_000;

/** 5-hour and weekly windows lead; per-model windows follow. */
const WINDOW_ORDER = ["five_hour", "seven_day"];

function orderWindows(windows: UsageWindow[]): UsageWindow[] {
  return [...windows].sort((a, b) => rank(a.kind) - rank(b.kind));
}

function rank(kind: string): number {
  const i = WINDOW_ORDER.indexOf(kind);
  return i >= 0 ? i : WINDOW_ORDER.length;
}

/**
 * ViewModel for live plan usage. Events (usage.updated) push new numbers
 * during tasks; on top of that this re-probes every 2 minutes (to catch
 * spend from other machines / claude.ai) and on demand via refresh().
 */
export function useUsageViewModel(): UsageVm {
  const connected = useConnectionStore((s) => s.state === "connected");
  const usage = useUsageStore((s) => s.usage);
  const [refreshing, setRefreshing] = useState(false);

  const probe = useCallback((force: boolean) => {
    if (force) setRefreshing(true);
    void bridge
      .rpc("usage.get", force ? { refresh: true } : {})
      .then(({ usage }) => useUsageStore.getState().set(usage))
      .catch(() => undefined)
      .finally(() => {
        if (force) setRefreshing(false);
      });
  }, []);

  // Seed on connect, then re-probe on an interval so the numbers stay fresh
  // even between task-driven rate_limit_events.
  useEffect(() => {
    if (!connected) return;
    probe(false);
    const timer = setInterval(() => probe(true), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [connected, probe]);

  const refresh = useCallback(() => {
    if (!refreshing) probe(true);
  }, [probe, refreshing]);

  return {
    available: usage.available,
    status: usage.status,
    windows: orderWindows(usage.windows),
    ollamaCloudUsage: usage.ollamaCloudUsage,
    refreshing,
    refresh,
  };
}
