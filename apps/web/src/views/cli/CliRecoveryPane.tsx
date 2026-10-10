import { useEffect, useState } from "react";
import type { CliHistoryEntry } from "@atelier/protocol";
import { Loader2, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cliProvider,
  loadMoreCliHistory,
  refreshCliHistory,
  useCliConsoleStore,
} from "@/services/cli-console";

/** A saved CLI row must remain a CLI row even when its old pty has died. */
export function CliRecoveryPane({
  conversationId,
  providerId,
  onResume,
  onStartNew,
}: {
  conversationId: string;
  providerId: string;
  onResume: (entry: CliHistoryEntry) => Promise<void>;
  onStartNew: () => Promise<void>;
}) {
  const history = useCliConsoleStore((state) => state.history);
  const hasMore = useCliConsoleStore((state) => state.historyHasMore);
  const chats = useCliConsoleStore((state) => state.chats);
  const resumed = useCliConsoleStore((state) => state.resumed);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void refreshCliHistory().finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [conversationId, providerId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const provider = cliProvider(providerId);
  const alreadyBound = new Set(Object.entries(chats)
    .filter(([id]) => id !== conversationId)
    .map(([, binding]) => binding.sessionId ?? resumed[binding.termId])
    .filter((id): id is string => Boolean(id)));
  const entries = history.filter((entry) =>
    entry.providerId === providerId && !alreadyBound.has(entry.id)
  );
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-panel p-6 dark:bg-editor">
      <div className="w-full max-w-lg space-y-4">
        <TerminalSquare className="h-7 w-7 text-muted-foreground" />
        <div>
          <h2 className="text-base font-semibold">Reconnect {provider.label} CLI</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Atelier could not identify this row's saved CLI session. Choose its
            provider session below to restore the context, or start a new one.
          </p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading saved sessions…
          </div>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
            {entries.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No saved {provider.label} sessions found yet.</p>
            )}
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                disabled={busy}
                onClick={() => void run(() => onResume(entry))}
                className="flex w-full flex-col rounded-md px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
              >
                <span className="truncate font-medium">{entry.title || `${provider.label} session`}</span>
                <span className="text-xs text-muted-foreground">{new Date(entry.updatedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
        {hasMore && (
          <Button type="button" variant="ghost" disabled={busy || loading} onClick={() => void run(async () => { await loadMoreCliHistory(); })}>
            Load more sessions
          </Button>
        )}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void run(onStartNew)}>
          Start new {provider.label} CLI session
        </Button>
      </div>
    </div>
  );
}
