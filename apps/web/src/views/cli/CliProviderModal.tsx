import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CLI_PROVIDERS,
  createCliSession,
  useCliConsoleStore,
} from "@/services/cli-console";

/** Provider choice for every user-created CLI session. */
export function CliProviderModal() {
  const open = useCliConsoleStore((s) => s.providerPickerOpen);
  const close = useCliConsoleStore((s) => s.closeProviderPicker);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !starting) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, open, starting]);

  const choose = async (providerId: string) => {
    setStarting(providerId);
    setError(null);
    try {
      await createCliSession(providerId);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(null);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => !starting && close()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cli-provider-title"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
            className="island flex w-full max-w-sm flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <TerminalSquare className="h-4 w-4 text-primary" />
              <span id="cli-provider-title" className="text-sm font-medium">
                Choose a CLI
              </span>
            </div>
            <div className="flex flex-col gap-2 p-4">
              <span className="text-xs text-muted-foreground">
                Codex and Claude use separate session flows. Choose which CLI
                should run this session.
              </span>
              {CLI_PROVIDERS.map((provider) => (
                <Button
                  key={provider.id}
                  type="button"
                  variant="outline"
                  disabled={starting !== null}
                  onClick={() => void choose(provider.id)}
                  className="h-auto justify-start gap-3 px-3 py-2.5 text-left"
                >
                  <Bot className="h-4 w-4 shrink-0 text-primary" />
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="text-xs font-medium">{provider.label}</span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {starting === provider.id
                        ? `Starting ${provider.command}…`
                        : `Open the ${provider.command} CLI`}
                    </span>
                  </span>
                </Button>
              ))}
              {error && (
                <span className="text-xs text-destructive" role="alert">
                  {error}
                </span>
              )}
              <div className="flex justify-end pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={starting !== null}
                  onClick={close}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
