import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Eye, FileCode2, ImageOff, MonitorCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { FrontendReviewRequest } from "@/lib/frontend-review";

export interface FrontendReviewModalProps {
  request: FrontendReviewRequest | null;
  expiresAt: number | null;
  previewReady: boolean;
  error: string | null;
  modelSelectionRequired: boolean;
  unsupportedModelLabel: string | null;
  selectedModel: string;
  modelOptions: Array<{ value: string; label: string; hint?: string }>;
  onModelChange: (value: string) => void;
  onApprove: () => void;
  onDismiss: () => void;
  onClosed: () => void;
}

function useCountdown(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (expiresAt === null) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function FrontendReviewModal({
  request,
  expiresAt,
  previewReady,
  error,
  modelSelectionRequired,
  unsupportedModelLabel,
  selectedModel,
  modelOptions,
  onModelChange,
  onApprove,
  onDismiss,
  onClosed,
}: FrontendReviewModalProps) {
  const secondsLeft = useCountdown(expiresAt);

  return (
    <AnimatePresence onExitComplete={onClosed}>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6"
          onClick={onDismiss}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="frontend-review-title"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
            className="modal-surface island flex w-full max-w-[560px] flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <MonitorCheck className="h-4 w-4 text-primary" />
              <span id="frontend-review-title" className="text-sm font-medium">
                {modelSelectionRequired
                  ? "Choose an image-capable model"
                  : "Review the frontend changes?"}
              </span>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                skips in 0:{String(secondsLeft).padStart(2, "0")}
              </span>
            </div>
            <div className="flex flex-col gap-4 p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {modelSelectionRequired
                  ? "The captured Page preview is ready, but the current model cannot inspect image attachments. Choose a compatible model to continue with the same screenshot."
                  : "This completed task changed frontend files. With your approval, Atelier will inspect the live Page preview in headless Playwright at desktop and mobile sizes, then run a separate review timeline with its screenshot and final report. Without approval, the review is skipped and Page preview stays closed."}
              </p>
              <div className="rounded-lg border border-border/60 bg-muted/35 px-3 py-2">
                <div className="flex items-center gap-2">
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <p className="truncate text-xs font-medium text-foreground">
                    {request.changedFiles.length} frontend file
                    {request.changedFiles.length === 1 ? "" : "s"} changed
                  </p>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  {request.request}
                </p>
              </div>
              {!modelSelectionRequired && !previewReady && (
                <div className="flex items-start gap-2 rounded-lg bg-primary/8 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  Page preview is not running yet. Approval will open it; the
                  review starts automatically when its local server is ready.
                </div>
              )}
              {modelSelectionRequired && (
                <div
                  role="alert"
                  className="space-y-3 rounded-lg border border-warning/25 bg-warning/8 px-3 py-3"
                >
                  <div className="flex items-start gap-2">
                    <ImageOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">
                        {unsupportedModelLabel ?? "The selected model"} does not
                        support screenshots
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {modelOptions.length > 0
                          ? "Select another enabled model with image input support."
                          : "No enabled model currently advertises image input support. Enable one in Settings, then retry the review."}
                      </p>
                    </div>
                  </div>
                  <Select
                    value={selectedModel}
                    onChange={onModelChange}
                    options={modelOptions}
                    disabled={modelOptions.length === 0}
                    className="h-8 w-full justify-between px-2.5"
                    menuClassName="z-[110]"
                  />
                </div>
              )}
              {error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={onDismiss}
                >
                  Not now
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={onApprove}
                  disabled={modelSelectionRequired && !selectedModel}
                >
                  <MonitorCheck className="h-3.5 w-3.5" />
                  {modelSelectionRequired
                    ? "Review with selected model"
                    : previewReady
                      ? "Review in Page preview"
                      : "Open Page preview"}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
