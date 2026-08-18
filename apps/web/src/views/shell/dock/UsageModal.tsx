import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { GaugeCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import type { UsageVm } from "@/hooks/useUsageViewModel";
import type { UsageWindow } from "@atelier/protocol";

export interface UsageModalProps {
  open: boolean;
  onClose: () => void;
  usage: UsageVm;
}

/**
 * Plan usage in full, raised from the dock.
 *
 * It used to be three compact bars wedged into the status bar, where it was
 * the first thing to be hidden at narrow widths and never had room for the
 * reset times. Here each window gets a labelled row that says how much is
 * gone and when it comes back — which is the question the bars were only ever
 * hinting at.
 */
export function UsageModal(props: UsageModalProps) {
  // Tick once a second so the reset countdowns advance while the modal is up.
  const [now, setNow] = useState(() => Date.now());
  const lastResetRefresh = useRef(0);
  const { open, onClose, usage } = props;

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  // When a countdown crosses zero the window has reset — pull a fresh probe
  // (guarded so it fires once, not every tick) for the new reset time and the
  // reset utilization.
  const anyExpired = usage.windows.some(
    (w) => w.resetsAt != null && w.resetsAt - now <= 0
  );
  useEffect(() => {
    if (!open || !anyExpired || usage.refreshing) return;
    if (now - lastResetRefresh.current < 15_000) return;
    lastResetRefresh.current = now;
    usage.refresh();
  }, [anyExpired, now, open, usage]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/60 p-4"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="usage-modal-title"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
            className="modal-surface island flex max-h-[calc(100dvh-2rem)] w-full max-w-sm flex-col overflow-hidden"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-4 py-3">
              <GaugeCircle className="h-4 w-4 text-primary" />
              <span id="usage-modal-title" className="text-sm font-medium">
                Plan usage
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={usage.refreshing}
                onClick={usage.refresh}
                aria-label="Refresh usage now"
                className="ml-auto h-7 gap-1.5 px-2 text-[11px]"
              >
                <RefreshCw
                  className={cn("h-3 w-3", usage.refreshing && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
            <div className="min-h-0 overflow-y-auto p-4">
              <div className="flex flex-col gap-6">
                <UsageBody usage={usage} now={now} />
                <OllamaUsageBody usage={usage} />
                <span className="text-[11px] text-muted-foreground">
                  Re-probed every 2 minutes and after each task.
                </span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

function OllamaUsageBody({ usage }: { usage: UsageVm }) {
  const ollamaCloudUsage = usage.ollamaCloudUsage ?? [];
  if (ollamaCloudUsage.length === 0) return null;

  return (
    <div className="flex flex-col gap-3.5 border-t border-white/5 pt-2">
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-medium opacity-60">Ollama Cloud activity</span>
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          Remaining plan usage and reset times are available only in Ollama settings.
        </span>
      </div>
      {ollamaCloudUsage.map((w) => (
        <div key={w.kind} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-medium">{w.label}</span>
            <div className="ml-auto flex gap-3 tabular-nums text-muted-foreground">
              <span>{w.requests} reqs</span>
              <span>{((w.inputTokens + w.outputTokens) / 1000).toFixed(1)}k tokens</span>
            </div>
          </div>
          <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
             <span>{w.seconds}s GPU time</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The windows, or an honest account of why there are none. */
function UsageBody({ usage, now }: { usage: UsageVm; now: number }) {
  if (!usage.available) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        This session authenticates with an API key, so there are no plan limits
        to report. Usage appears here on plan-backed sessions.
      </p>
    );
  }
  if (usage.windows.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        No usage reported yet. The first probe lands once the agent has run a
        task, or you can refresh now.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      {usage.windows.map((w) => (
        <UsageRow key={w.kind} window={w} now={now} />
      ))}
    </div>
  );
}

/** One window: what it is, how much is gone, and when it comes back. */
function UsageRow({ window: w, now }: { window: UsageWindow; now: number }) {
  const used = Math.round(w.utilization);
  // Semantic, not decorative: the bar changes meaning at these thresholds, so
  // it uses the shared danger/warning tokens rather than a one-off amber.
  const fill = fillFor(used);
  const remaining = w.resetsAt != null ? w.resetsAt - now : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium">{w.label}</span>
        <span className="ml-auto tabular-nums font-medium">{used}%</span>
      </div>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20">
        <span
          className={cn("block h-full rounded-full", fill)}
          style={{ width: `${Math.min(100, Math.max(2, used))}%` }}
        />
      </span>
      {remaining != null && (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          Resets in {formatCountdown(remaining)}
        </span>
      )}
    </div>
  );
}

function fillFor(used: number): string {
  if (used >= 90) return "bg-destructive";
  if (used >= 70) return "bg-warning";
  return "bg-primary";
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
