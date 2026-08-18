import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Settings, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsPanel } from "./SettingsPanel";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/** Theme-aware application settings presented as a desktop preferences window. */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[210] flex items-center justify-center bg-black/55 p-6"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
            className="modal-surface island flex h-[min(82vh,760px)] w-[min(92vw,1040px)] flex-col overflow-hidden"
          >
            <div className="modal-titlebar relative flex h-12 shrink-0 items-center px-3">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Settings className="h-4 w-4 text-primary" />
                Atelier
              </span>
              <span
                id="settings-modal-title"
                className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm font-semibold"
              >
                Settings
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onClose}
                aria-label="Close Settings"
                className="ml-auto h-7 w-7 rounded-full border border-border bg-card hover:bg-destructive hover:text-white"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <SettingsPanel modal />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
