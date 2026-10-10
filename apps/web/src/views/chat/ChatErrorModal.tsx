import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatErrorModalProps {
  error: string | null;
  title: string;
  /** Lets a caller that opens the modal itself clear its own open state. */
  onDismiss?: () => void;
}

/** Presents chat/composer failures as an explicit, dismissible interruption. */
export function ChatErrorModal({
  error,
  title,
  onDismiss,
}: ChatErrorModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  useEffect(() => {
    setDismissedError(null);
  }, [error]);

  const open = error !== null && error !== dismissedError;
  const dismiss = () => {
    setDismissedError(error);
    onDismiss?.();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, error]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-6"
          onClick={dismiss}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
            className="modal-surface island flex w-full max-w-md flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
              <span id={titleId} className="text-sm font-medium">
                {title}
              </span>
            </div>
            <div className="flex flex-col gap-4 p-4">
              <span
                id={descriptionId}
                role="alert"
                className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground"
              >
                {error}
              </span>
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={dismiss} autoFocus>
                  Dismiss
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
