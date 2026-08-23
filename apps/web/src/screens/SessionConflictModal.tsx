import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Laptop, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/state/auth.store";

function formatLastActive(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "recently";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function SessionConflictModal() {
  const conflict = useAuthStore((state) => state.sessionConflict);
  const busy = useAuthStore((state) => state.sessionActionBusy);
  const error = useAuthStore((state) => state.sessionError);
  const continueOnThisDevice = useAuthStore(
    (state) => state.continueOnThisDevice
  );
  const cancel = useAuthStore((state) => state.cancelSessionConflict);

  useEffect(() => {
    if (!conflict || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, cancel, conflict]);

  return createPortal(
    <AnimatePresence>
      {conflict && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="session-conflict-title"
            aria-describedby="session-conflict-description"
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="modal-surface island flex w-full max-w-md flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 border-b border-white/5 px-5 py-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-400">
                <ShieldAlert className="h-5 w-5" />
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2
                  id="session-conflict-title"
                  className="text-sm font-semibold"
                >
                  Account already in use
                </h2>
                <p className="text-xs text-muted-foreground">
                  Only one device can use this account at a time.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-4 p-5">
              <div className="flex items-start gap-3 rounded-xl border border-border bg-background/40 p-4">
                <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="truncate text-xs font-medium">
                    {conflict.deviceLabel}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Last active {formatLastActive(conflict.lastActiveAt)}
                  </p>
                </div>
              </div>

              <p
                id="session-conflict-description"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                This account is still signed in on another device. If you
                continue here, Atelier will automatically sign it out there.
              </p>

              {error && (
                <p
                  role="alert"
                  className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {error}
                </p>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void continueOnThisDevice()}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Continue here
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
