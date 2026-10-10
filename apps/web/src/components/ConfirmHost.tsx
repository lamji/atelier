import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmStore } from "@/state/confirm.store";

/**
 * Shell-mounted renderer for `confirmDialog()`. Enter confirms, Escape
 * and a backdrop click cancel — the same keys the native dialog had.
 */
export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);
  const answer = useConfirmStore((s) => s.answer);

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") answer(false);
      else if (event.key === "Enter") answer(true);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, answer]);

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) answer(false);
          }}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="modal-surface island flex w-full max-w-sm flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <CircleAlert
                className={
                  pending.destructive
                    ? "h-4 w-4 text-destructive"
                    : "h-4 w-4 text-primary"
                }
              />
              <span className="text-sm font-medium">{pending.title}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <p className="whitespace-pre-line text-xs text-muted-foreground">
                {pending.message}
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => answer(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant={pending.destructive ? "destructive" : "default"}
                  onClick={() => answer(true)}
                >
                  {pending.confirmLabel ?? "OK"}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
