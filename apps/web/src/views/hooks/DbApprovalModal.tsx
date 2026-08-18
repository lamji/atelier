import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CircleAlert,
  Database,
  Loader2,
  Package,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DbApprovalViewModel } from "@/hooks/useDbApprovalViewModel";

export interface DbApprovalModalProps {
  vm: DbApprovalViewModel;
}

/** Whole seconds left before the agent-side deadline auto-denies. */
function useCountdown(expiresAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * Approval gate for database work. The agent's command is HELD while this
 * is on screen — approving runs it, denying refuses it, and letting the
 * countdown run out refuses it too.
 */
export function DbApprovalModal({ vm }: DbApprovalModalProps) {
  const request = vm.current;
  const isPackage = request?.kind === "npm";
  const Icon = isPackage ? Package : Database;
  const secondsLeft = useCountdown(request?.expiresAt);
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, "0");

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="modal-surface island flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <Icon className="h-4 w-4 text-primary/80" />
              <span className="text-sm font-medium">
                {isPackage ? "Run package command?" : "Approve database operation"}
              </span>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                auto-denies in {minutes}:{seconds}
              </span>
              <button
                onClick={vm.deny}
                title="Deny"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              <p className="text-xs text-muted-foreground">
                The agent is waiting to run a{" "}
                <span className="text-foreground">{request.operation}</span> —
                it {request.detail}.{" "}
                {isPackage
                  ? "Choose whether to run it or skip it."
                  : "Nothing has touched your database yet."}
              </p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                $ {request.command}
              </pre>
              {vm.error && (
                <p className="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                  <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                  {vm.error}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={vm.busy}
                  onClick={vm.approve}
                  // The dialog interrupts whatever had focus — the composer,
                  // the terminal, the editor — and those keep their own
                  // capture-phase pointer handlers. Taking focus on open puts
                  // the keyboard on the answer and stops the first click here
                  // from being spent moving focus out of them.
                  autoFocus
                >
                  {vm.busy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {/* JSX text is not HTML: "&amp;" here renders literally. */}
                  {isPackage ? "Run command" : "Approve & run"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={vm.busy}
                  onClick={vm.deny}
                >
                  {isPackage ? "Skip" : "Deny"}
                </Button>
                {vm.queued > 0 && (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {vm.queued} more waiting
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/60">
                Turn this gate off in the Hooks panel:{" "}
                <span className="font-mono">
                  {isPackage
                    ? "Package manager: ask before running npm commands"
                    : "Database: ask before running DB commands"}
                </span>
                .
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
