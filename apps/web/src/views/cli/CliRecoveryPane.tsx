import { useEffect, useState } from "react";
import type { CliHistoryEntry } from "@atelier/protocol";
import { Loader2, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { since } from "./CliSessionListPanel";
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
    <div
      className={cn(
        "flex h-full items-center justify-center overflow-y-auto",
        "bg-panel p-6 dark:bg-editor"
      )}
    >
      <div className="flex w-full max-w-lg flex-col gap-5">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
              "bg-primary/10 text-primary"
            )}
          >
            <TerminalSquare className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight">
              Reconnect {provider.label} CLI
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              This row lost track of its {provider.label} session. Pick it below
              to restore the conversation, or start fresh.
            </p>
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          >
            {error}
          </p>
        )}

        <section
          className="overflow-hidden rounded-xl border border-border-subtle bg-card"
        >
          <header
            className={cn(
              "flex items-center justify-between border-b",
              "border-border-subtle px-3 py-2"
            )}
          >
            <span
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wide",
                "text-muted-foreground/70"
              )}
            >
              Saved sessions
            </span>
            {!loading && (
              <span className="text-[11px] text-muted-foreground/60">
                {entries.length}
              </span>
            )}
          </header>
          {loading ? (
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-4 text-[13px]",
                "text-muted-foreground"
              )}
            >
              <Loader2 className="h-4 w-4 animate-spin" /> Loading saved sessions…
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto overflow-x-hidden">
              {entries.length === 0 && (
                <li className="px-3 py-4 text-[13px] text-muted-foreground">
                  No saved {provider.label} sessions in this workspace yet.
                </li>
              )}
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="border-b border-border-subtle last:border-b-0"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => onResume(entry))}
                    title={entry.title || undefined}
                    className={cn(
                      "group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left",
                      "transition-colors hover:bg-accent/60 disabled:opacity-50"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[13px] font-medium",
                          !entry.title && "text-muted-foreground"
                        )}
                      >
                        {entry.title || "Untitled session"}
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 block truncate text-[11px]",
                          "text-muted-foreground/70"
                        )}
                      >
                        {since(entry.updatedAt)} ·{" "}
                        {new Date(entry.updatedAt).toLocaleString()}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[11px] font-medium text-primary opacity-0",
                        "transition-opacity group-hover:opacity-100"
                      )}
                    >
                      Resume
                    </span>
                  </button>
                </li>
              ))}
              {hasMore && (
                <li>
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() =>
                      void run(async () => {
                        await loadMoreCliHistory();
                      })
                    }
                    className={cn(
                      "w-full px-3 py-2 text-center text-[12px] text-muted-foreground",
                      "hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
                    )}
                  >
                    Load more sessions
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>

        <Button
          type="button"
          disabled={busy}
          onClick={() => void run(onStartNew)}
          className="self-start"
        >
          Start new {provider.label} session
        </Button>
      </div>
    </div>
  );
}
