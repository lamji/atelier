import { useEffect, useId } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface GitError {
  title: string;
  detail: string;
  /** A refusal by a protection rule reads differently from a failure. */
  kind?: "blocked" | "error";
}

/**
 * Git failures and refusals, as an interruption rather than a toast.
 *
 * A toast is the wrong shape for this class of message. It disappears on a
 * timer, it can be missed entirely if the user is looking at the editor,
 * and the two things it most often has to say — "this branch is protected"
 * and "the push was rejected" — are exactly the things that must not be
 * missed. A refused commit that only ever appeared as a four-second chip in
 * the corner reads, from the user's side, as a button that did nothing.
 *
 * So it blocks. It is dismissible with Escape, a click outside, or the
 * button, and it says what to do next rather than only what went wrong.
 */
export function GitErrorModal(props: {
  error: GitError | null;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const open = props.error !== null;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, props]);

  const blocked = props.error?.kind === "blocked";
  const Icon = blocked ? ShieldCheck : TriangleAlert;

  return (
    <AnimatePresence>
      {open && props.error && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={props.onDismiss}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.14 }}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-card p-5 shadow-pop ring-1 ring-white/10"
          >
            <div className="flex items-start gap-3">
              <span
                className={
                  blocked
                    ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning"
                    : "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-danger/15 text-danger"
                }
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-sm font-semibold">
                  {props.error.title}
                </h2>
                <p
                  id={bodyId}
                  className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-muted-foreground"
                >
                  {props.error.detail}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button size="sm" onClick={props.onDismiss} autoFocus>
                OK
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
