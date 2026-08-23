import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, CircleAlert, Loader2, Sparkles, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE_LABELS } from "@/lib/stage-labels";
import { useElapsed } from "@/hooks/useElapsed";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Button } from "@/components/ui/button";
import type { SessionVm } from "@/state/sessions.store";

export interface AiResolverModalProps {
  open: boolean;
  session: SessionVm | null;
  working: boolean;
  onClose: () => void;
  /** Stop the running task; hidden when nothing is running. */
  onCancel: () => void;
}

/**
 * The resolver's work, at full size.
 *
 * It used to live in the merge banner, in a panel a third of a screen
 * wide: the model's reasoning arrived four words to a line behind two
 * scrollbars, so the one place it explains WHY it picked a side was the
 * least readable surface in the app. The banner keeps a one-line status
 * and opens this instead.
 */
export function AiResolverModal(props: AiResolverModalProps) {
  const { open, session, working, onClose, onCancel } = props;

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
      {open && session && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="AI resolver"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className={cn(
              "modal-surface island flex max-h-[85vh] w-full max-w-3xl",
              "flex-col overflow-hidden"
            )}
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-3">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center",
                  "rounded-lg bg-primary/15 text-primary"
                )}
              >
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">AI resolver</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {working
                    ? "Working — files are read-only until it finishes"
                    : "Finished — review the files it touched, then complete the merge"}
                </p>
              </div>
              {working && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={session.cancelling}
                  onClick={onCancel}
                >
                  {session.cancelling ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Stopping…
                    </>
                  ) : (
                    <>
                      <Square className="mr-1.5 h-3 w-3 fill-current" />
                      Stop
                    </>
                  )}
                </Button>
              )}
              <button
                onClick={onClose}
                aria-label="Close"
                className={cn(
                  "shrink-0 rounded-lg p-1.5 text-muted-foreground",
                  "hover:bg-accent/60 hover:text-foreground"
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {working && (
              <div className="shrink-0 px-4 pt-3">
                <AiProgress session={session} />
              </div>
            )}

            <AiTranscript session={session} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/** Live trace of the resolver task: current stage, last tool calls, timer. */
function AiProgress({ session }: { session: SessionVm }) {
  const elapsed = useElapsed(session.taskStartedAt);
  const recent = session.actions.slice(-3);
  const running = recent.find((a) => a.status === "running");
  const headline =
    running?.label ?? (session.stage ? STAGE_LABELS[session.stage] : "starting…");
  return (
    <div className="rounded-lg bg-black/15 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px]">{headline}</span>
        {session.taskStartedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      {recent.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {recent.map((action) => (
            <p
              key={action.id}
              className="flex items-center gap-1.5 truncate font-mono text-[10px] text-muted-foreground"
            >
              {action.status === "running" ? (
                <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-primary/70" />
              ) : action.status === "done" ? (
                <Check className="h-2.5 w-2.5 shrink-0 text-success" />
              ) : (
                <CircleAlert className="h-2.5 w-2.5 shrink-0 text-destructive" />
              )}
              <span className="truncate">{action.label}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The whole resolver conversation, newest at the bottom. Nothing is
 * clipped here — the banner's copy showed the last twelve entries because
 * that was all that fit; this is the room the reasoning needed.
 */
function AiTranscript({ session }: { session: SessionVm }) {
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>([
    session.items.length,
    session.items[session.items.length - 1]?.text,
  ]);
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4"
    >
      {session.items.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing yet.</p>
      )}
      {session.items.map((item) => {
        if (item.role === "log" || item.role === "diff") {
          return (
            <p
              key={item.id}
              className="truncate font-mono text-[11px] text-muted-foreground"
            >
              {item.role === "diff" ? `Edited ${item.text}` : item.text}
            </p>
          );
        }
        return (
          <div
            key={item.id}
            className={cn(
              "text-xs leading-relaxed",
              item.role === "user" ? "italic text-muted-foreground" : "chat-md"
            )}
          >
            {item.role === "user" ? (
              <p>» {item.text}</p>
            ) : (
              <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
            )}
            {item.streaming && (
              <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-primary/60" />
            )}
          </div>
        );
      })}
    </div>
  );
}
