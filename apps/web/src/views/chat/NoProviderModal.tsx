import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/state/workspace.store";

export interface NoProviderModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Shown when every provider is switched off and the user tries to pick a
 * model or send a turn.
 *
 * Without it the composer fails silently in two confusing ways: the model
 * menu still lists the built-in fallback names (Opus, Sonnet, …) as though
 * they were available, and sending starts a turn with nothing behind it.
 * Both are dead ends the user cannot diagnose from the chat, so this names
 * the cause and opens the one panel that fixes it.
 */
export function NoProviderModal({ open, onClose }: NoProviderModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const openSettings = () => {
    useWorkspaceStore.getState().setActivityView("settings");
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
            className="island flex w-full max-w-sm flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <PlugZap className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">No provider enabled</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-xs text-muted-foreground">
                Every provider is switched off, so there is no model to run
                this chat. Turn one on in Settings → Providers, then come
                back — your draft stays where it is.
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={onClose}>
                  Not now
                </Button>
                <Button size="sm" onClick={openSettings}>
                  Open providers
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
