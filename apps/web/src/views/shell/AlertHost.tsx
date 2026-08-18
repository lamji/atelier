import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAlertsStore, type AlertTone } from "@/state/alerts.store";

const ICON: Record<AlertTone, typeof Info> = {
  info: Info,
  success: Check,
  warning: TriangleAlert,
  danger: CircleAlert,
};

const TONE_RING: Record<AlertTone, string> = {
  info: "ring-primary/40",
  success: "ring-success/40",
  warning: "ring-warning/50",
  danger: "ring-destructive/40",
};

const TONE_ICON: Record<AlertTone, string> = {
  info: "bg-primary/15 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
};

const TONE_ACTION: Record<AlertTone, string> = {
  info: "bg-primary text-primary-foreground hover:bg-primary/90",
  success: "bg-success text-white hover:bg-success/90",
  warning: "bg-warning text-black hover:bg-warning/90",
  danger: "bg-destructive text-white hover:bg-destructive/90",
};

/**
 * Renders the alert stack top-centre, under the header. Alerts are pills,
 * not cards: one line of outcome, an optional detail, one optional action.
 * They must be noticed without ever covering what the user is doing.
 */
export function AlertHost() {
  const alerts = useAlertsStore((s) => s.alerts);
  const dismiss = (id: string) => {
    useAlertsStore.getState().alerts.find((a) => a.id === id)?.onDismiss?.();
    useAlertsStore.getState().dismiss(id);
  };
  const reduced = useReducedMotion();

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--topnav-h,40px)+10px)] z-40 flex flex-col items-center gap-1.5 px-4"
    >
      <AnimatePresence initial={false}>
        {alerts.map((a) => {
          const Icon = ICON[a.tone];
          return (
            <motion.div
              key={a.id}
              layout
              role="status"
              initial={reduced ? false : { opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className={cn(
                "island pointer-events-auto flex max-w-[min(38rem,90vw)] items-center gap-2 rounded-full py-1 pl-1.5 pr-1 shadow-pop ring-1",
                TONE_RING[a.tone]
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                  TONE_ICON[a.tone]
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 truncate text-xs">
                <span className="font-medium">{a.title}</span>
                {a.detail && (
                  <span className="text-muted-foreground"> · {a.detail}</span>
                )}
              </span>
              {a.action && (
                <button
                  onClick={() => {
                    a.action?.run();
                    dismiss(a.id);
                  }}
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
                    TONE_ACTION[a.tone]
                  )}
                >
                  {a.action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(a.id)}
                aria-label="Dismiss"
                className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
