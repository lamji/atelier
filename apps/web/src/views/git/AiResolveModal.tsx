import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import type { ModelOption } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { bridge } from "@/services/bridge-client";
import { Button } from "@/components/ui/button";
import { Select, type SelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { usePreferencesStore } from "@/state/preferences.store";

/**
 * Presets that cover the instruction people actually give — a side to
 * prefer, or a thing that must survive the merge. Clicking one drops its
 * text into the box so it can be edited rather than sent as-is.
 */
const PRESETS = [
  { label: "Prefer incoming", text: "Prefer the incoming side where the two disagree." },
  { label: "Prefer ours", text: "Prefer our side where the two disagree." },
  { label: "Keep both", text: "Keep both sides, deduplicated, in a sensible order." },
  { label: "Explain first", text: "Say what each side is doing before you choose." },
];

/** Sits at the top of the picker; "" tells the resolver to use its own. */
const DEFAULT_MODEL: SelectOption = {
  value: "",
  label: "Default (Sonnet 5)",
  hint: "what the resolver uses when nothing is picked",
};

export interface AiResolveModalProps {
  open: boolean;
  /** Files the resolver will be pointed at; drives the subtitle. */
  paths: string[];
  onClose: () => void;
  /** Called with the (possibly empty) guidance and model for the run. */
  onSubmit: (guidance: string, model: string) => void;
}

/**
 * The chatbox in front of "resolve with AI".
 *
 * Firing the resolver straight off the button gave the model a merge and
 * nothing else, and the one thing the person clicking it always knows —
 * which side matters, what must not be dropped — had no way in. This asks
 * for that first. It is optional: Enter on an empty box starts the same
 * run the button used to.
 */
export function AiResolveModal(props: AiResolveModalProps) {
  const { open, paths, onClose, onSubmit } = props;
  const [text, setText] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const model = usePreferencesStore((s) => s.resolverModel);
  const setModel = usePreferencesStore((s) => s.setResolverModel);

  // The roster is whatever providers are configured right now, so it is
  // read when the modal opens rather than cached for the session.
  useEffect(() => {
    if (!open) return;
    void bridge
      .rpc("models.list", {})
      .then((result) => setModels(result.models))
      .catch(() => undefined);
  }, [open]);

  // Each opening is a fresh instruction — carrying the last one over would
  // silently re-apply it to a different conflict.
  useEffect(() => {
    if (open) setText("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  // A pick that is no longer on the roster (provider removed, key gone)
  // would leave the trigger blank and start a run on a model that is not
  // there; both the picker and the run fall back to the default row.
  const known = model === "" || models.some((row) => row.value === model);
  const picked = known ? model : "";

  const send = () => {
    onSubmit(text.trim(), picked);
    onClose();
  };

  const options: SelectOption[] = [
    DEFAULT_MODEL,
    ...models.map((row) => ({
      value: row.value,
      label: row.label,
      hint: row.description,
    })),
  ];

  const add = (preset: string) =>
    setText((prev) => (prev.trim() ? `${prev.trim()} ${preset}` : preset));

  const target =
    paths.length === 1
      ? (paths[0] ?? "")
      : `${paths.length} conflicted file${paths.length === 1 ? "" : "s"}`;

  return createPortal(
    <AnimatePresence>
      {open && (
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
            aria-label="Resolve with AI"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="modal-surface island flex w-full max-w-md flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center",
                  "rounded-lg bg-primary/15 text-primary"
                )}
              >
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Resolve with AI</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {target}
                </p>
              </div>
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

            <div className="flex flex-col gap-2 p-4">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  Model
                </span>
                <Select
                  value={picked}
                  onChange={setModel}
                  options={options}
                  className="h-7 flex-1 text-xs"
                />
              </div>
              <label
                htmlFor="ai-resolve-guidance"
                className="text-[11px] text-muted-foreground"
              >
                What should it do with this conflict?
              </label>
              <Textarea
                id="ai-resolve-guidance"
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                placeholder={
                  "e.g. “keep our error handling but take their new props”, " +
                  "“this is a rename — apply it everywhere”"
                }
                className="resize-none text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
                }}
              />
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => add(preset.text)}
                    className={cn(
                      "rounded-md bg-secondary/60 px-1.5 py-0.5 text-[10px]",
                      "text-muted-foreground ring-1 ring-white/5",
                      "hover:bg-secondary hover:text-foreground"
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/70">
                Optional. The resolver edits files only — you still stage the
                result. Ctrl+Enter sends.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-white/5 px-4 py-3">
              <Button size="sm" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={send}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {text.trim() ? "Resolve with this" : "Resolve without guidance"}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
