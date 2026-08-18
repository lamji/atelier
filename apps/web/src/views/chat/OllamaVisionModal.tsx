import { useEffect, useMemo, useState } from "react";
import type { ProviderId, ProviderModel } from "@atelier/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { Eye, Loader2, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { bridge } from "@/services/bridge-client";
import { useWorkspaceStore } from "@/state/workspace.store";

interface VisionModel extends ProviderModel {
  providerId: Extract<ProviderId, "ollama-cloud" | "ollama-local">;
}

export interface OllamaVisionModalProps {
  open: boolean;
  currentModelLabel: string;
  onClose: () => void;
  onSelectModel: (value: string) => void;
}

const OLLAMA_PROVIDERS = [
  "ollama-cloud",
  "ollama-local",
] as const satisfies readonly ProviderId[];

function providerLabel(id: VisionModel["providerId"]): string {
  return id === "ollama-cloud" ? "Ollama Cloud" : "Ollama (local)";
}

/** Warns before an image is staged against an Ollama model without vision. */
export function OllamaVisionModal({
  open,
  currentModelLabel,
  onClose,
  onSelectModel,
}: OllamaVisionModalProps) {
  const [models, setModels] = useState<VisionModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    void Promise.allSettled(
      OLLAMA_PROVIDERS.map(async (providerId) => {
        const result = await bridge.rpc("providers.models", { id: providerId });
        return result.models
          .filter((model) => model.supportsImages === true)
          .map((model) => ({ ...model, providerId }));
      })
    )
      .then((results) => {
        const available = results.flatMap((result) =>
          result.status === "fulfilled" ? result.value : []
        );
        setModels(available);
        if (results.every((result) => result.status === "rejected")) {
          setError("Could not load either Ollama model catalog.");
        }
      })
      .finally(() => setLoading(false));
  }, [open]);

  const enabledModels = useMemo(
    () => models.filter((model) => model.enabled && !model.subscriptionRequired),
    [models]
  );
  const disabledModels = useMemo(
    () => models.filter((model) => !model.enabled || model.subscriptionRequired),
    [models]
  );

  const openProviders = () => {
    useWorkspaceStore.getState().openSettings();
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
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ollama-vision-title"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
            className="modal-surface island flex max-h-[min(76vh,640px)] w-full max-w-md flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <Eye className="h-4 w-4 text-primary" />
              <span id="ollama-vision-title" className="text-sm font-medium">
                Choose a vision model
              </span>
            </div>
            <div className="min-h-0 overflow-y-auto p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {currentModelLabel} does not support image input. Select an
                enabled Ollama vision model before attaching this image.
              </p>

              {loading ? (
                <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking Ollama model capabilities…
                </div>
              ) : error ? (
                <p className="py-4 text-xs text-destructive">{error}</p>
              ) : models.length === 0 ? (
                <p className="py-4 text-xs text-muted-foreground">
                  No vision-capable model was found in your Ollama catalogs.
                </p>
              ) : (
                <div className="mt-4 space-y-4">
                  {enabledModels.length > 0 && (
                    <section>
                      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Ready to use
                      </h3>
                      <div className="space-y-1">
                        {enabledModels.map((model) => (
                          <button
                            key={model.value}
                            type="button"
                            onClick={() => onSelectModel(model.value)}
                            className="flex w-full items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-left hover:bg-accent"
                          >
                            <span>
                              <span className="block font-mono text-xs">{model.name}</span>
                              <span className="block text-[10px] text-muted-foreground">
                                {providerLabel(model.providerId)}
                              </span>
                            </span>
                            <span className="text-[10px] font-medium text-primary">Use model</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  {disabledModels.length > 0 && (
                    <section>
                      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Available in provider settings
                      </h3>
                      <div className="space-y-1">
                        {disabledModels.map((model) => (
                          <div
                            key={model.value}
                            className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 opacity-70"
                          >
                            <span>
                              <span className="block font-mono text-xs">{model.name}</span>
                              <span className="block text-[10px] text-muted-foreground">
                                {providerLabel(model.providerId)}
                              </span>
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {model.subscriptionRequired ? "Subscription required" : "Not enabled"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-white/5 px-4 py-3">
              <Button size="sm" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={openProviders}>
                <Settings className="mr-1.5 h-3.5 w-3.5" />
                Open providers
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
