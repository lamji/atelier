import { useEffect } from "react";
import type { ContextRequestStats } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useContextStore } from "@/state/context.store";

export interface ContextStatsVm {
  available: boolean;
  /** The most recent context request (with SDK actuals once attached). */
  last: ContextRequestStats | null;
  /** Rollup over the loaded window (most recent 50 requests). */
  totals: {
    requests: number;
    freshInputTokens: number;
    cacheReadTokens: number;
    savedTokens: number;
  };
}

/**
 * ViewModel for live context-engineering metrics: what each LLM request's
 * assembled context cost, what it saved vs naive assembly, and how much
 * of the real input was served from prompt cache.
 */
export function useContextStatsViewModel(): ContextStatsVm {
  const connected = useConnectionStore((s) => s.state === "connected");
  const requests = useContextStore((s) => s.requests);

  // Seed from persisted stats on connect; live events keep it current.
  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("context.stats", { limit: 50 })
      .then(({ requests }) => useContextStore.getState().hydrate(requests))
      .catch(() => undefined);
  }, [connected]);

  const totals = requests.reduce(
    (acc, r) => ({
      requests: acc.requests + 1,
      freshInputTokens: acc.freshInputTokens + (r.actualInputTokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (r.cacheReadTokens ?? 0),
      savedTokens: acc.savedTokens + r.savedTokens,
    }),
    { requests: 0, freshInputTokens: 0, cacheReadTokens: 0, savedTokens: 0 }
  );

  return {
    available: requests.length > 0,
    last: requests[0] ?? null,
    totals,
  };
}
