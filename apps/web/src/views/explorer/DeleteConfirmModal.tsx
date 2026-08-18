import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trash2 } from "lucide-react";
import { pathBasename } from "@atelier/shared";
import { Button } from "@/components/ui/button";

export interface DeleteConfirmModalProps {
  /** Workspace-relative path awaiting confirmation, or null when idle. */
  path: string | null;
  isDir: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Delete gate for the explorer. VS Code moves deletes to the OS trash and
 * so can afford a quieter prompt; this delete is permanent, so the dialog
 * names the target and says so.
 */
export function DeleteConfirmModal(props: DeleteConfirmModalProps) {
  const { path, onCancel, onConfirm } = props;

  useEffect(() => {
    if (!path) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, onCancel, onConfirm]);

  return (
    <AnimatePresence>
      {path && (
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
            className="modal-surface island flex w-full max-w-sm flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <Trash2 className="h-4 w-4 text-destructive" />
              <span className="text-sm font-medium">
                Delete {props.isDir ? "folder" : "file"}
              </span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-xs text-muted-foreground">
                Permanently delete{" "}
                <span className="font-mono text-foreground">
                  {pathBasename(path)}
                </span>
                {props.isDir && " and everything inside it"}? This cannot be
                undone.
              </p>
              <p className="truncate font-mono text-[10px] text-muted-foreground/60">
                {path}
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={onCancel}>
                  Cancel
                </Button>
                <Button size="sm" variant="destructive" onClick={onConfirm}>
                  Delete
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
