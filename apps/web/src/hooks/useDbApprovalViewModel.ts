import { useCallback, useState } from "react";
import { bridge } from "@/services/bridge-client";
import { useDbApprovalStore } from "@/state/db-approval.store";

/**
 * ViewModel for the database approval modal. The agent's tool call is
 * parked on the other side, so answering is the only thing that moves it:
 * approve lets the command run, deny (or ignoring it until the deadline)
 * refuses it.
 */
export function useDbApprovalViewModel() {
  const requests = useDbApprovalStore((s) => s.requests);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = requests[0] ?? null;

  const answer = useCallback(
    async (approved: boolean) => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      try {
        const { ok } = await bridge.rpc("hooks.resolveApproval", {
          id: current.id,
          approved,
        });
        // Not pending any more: it expired or the task was cancelled.
        if (!ok) setError("This request already expired.");
        useDbApprovalStore.getState().remove(current.id);
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, "").slice(0, 200));
      } finally {
        setBusy(false);
      }
    },
    [current, busy]
  );

  return {
    current,
    queued: Math.max(0, requests.length - 1),
    busy,
    error,
    approve: () => void answer(true),
    deny: () => void answer(false),
  };
}

export type DbApprovalViewModel = ReturnType<typeof useDbApprovalViewModel>;
