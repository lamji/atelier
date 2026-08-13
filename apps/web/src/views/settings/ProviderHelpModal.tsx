import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Cloud, HardDrive, Orbit, Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";

/** What a provider needs before it can answer a turn. */
interface ProviderHelp {
  icon: typeof Cloud;
  title: string;
  /** How this provider authenticates, in one breath. */
  summary: string;
  /** The steps, in the order they have to happen. */
  steps: string[];
  /** Shown in place of the steps once the provider is working. */
  readyLine: string;
  /** Left under the steps when there is a gotcha worth naming. */
  note?: string;
}

const PROVIDER_HELP: Record<string, ProviderHelp> = {
  claude: {
    icon: Sparkles,
    title: "How Claude connects",
    summary:
      "Atelier does not hold a Claude key. It runs the claude CLI already " +
      "installed on this machine and borrows whatever session that CLI is " +
      "signed in with — so you need your own Claude subscription or API " +
      "access, signed in there.",
    steps: [
      "Open a terminal and run: claude",
      "Complete the sign-in it prompts for (browser or API key).",
      "Come back here and press Test — it should report a signed-in session.",
    ],
    readyLine: "Signed in — the claude CLI session is live.",
    note:
      "Signing in while Atelier is running? Restart Atelier so it picks up " +
      "the new session.",
  },
  codex: {
    icon: Terminal,
    title: "How Codex connects",
    summary:
      "Same shape as Claude: no key is stored here. Atelier runs the codex " +
      "CLI on this machine and uses its signed-in session, so the " +
      "subscription has to be yours and signed in there.",
    steps: [
      "Open a terminal and run: codex login",
      "Finish the sign-in in the browser it opens.",
      "Back here, press Test — it should report a signed-in session.",
    ],
    readyLine: "Signed in — the codex CLI session is live.",
    note:
      "Signing in while Atelier is running? Restart Atelier so it picks up " +
      "the new session.",
  },
  "ollama-cloud": {
    icon: Cloud,
    title: "How Ollama Cloud connects",
    summary:
      "This one is key-based rather than a CLI session. You paste an API " +
      "key and Atelier stores it locally — it is never sent back to this UI.",
    steps: [
      "Create a key at ollama.com/settings/keys",
      "Paste it into the key field here and save.",
      "Press Test to confirm the key works, then pick your models below.",
    ],
    readyLine: "Key stored and working.",
    note: "If the models list stays empty after saving, restart Atelier.",
  },
  "ollama-local": {
    icon: HardDrive,
    title: "How Ollama Local connects",
    summary:
      "Atelier talks directly to the Ollama daemon on this machine. No API " +
      "key or hosted account is required.",
    steps: [
      "Install Ollama and start the local daemon.",
      "Pull at least one model with: ollama pull <model>",
      "Press Test, then choose the local models you want in chat.",
    ],
    readyLine: "Local Ollama is running and returning models.",
  },
  grok: {
    icon: Orbit,
    title: "How Grok connects",
    summary:
      "Grok is key-based. Atelier calls xAI directly, stores the key locally, " +
      "and exposes the same workspace and knowledge tools used by Ollama.",
    steps: [
      "Create an API key in the xAI Console at console.x.ai.",
      "Paste it into the key field here and save.",
      "Press Test, then switch on the Grok models you want in the chat picker.",
    ],
    readyLine: "xAI key stored and working.",
  },
};

export interface ProviderHelpModalProps {
  /** Provider id to explain, or null when the dialog is closed. */
  providerId: string | null;
  /**
   * Whether this provider already has a working session or key. When it
   * does, the setup steps are noise — the user has done them.
   */
  ready: boolean;
  onClose: () => void;
}

/**
 * Explains what a provider actually needs before it will answer.
 *
 * Switching a provider on looks like it should be enough, but two of the
 * providers are only a window onto a CLI that must already be signed in with
 * the user's OWN subscription — a distinction nothing in the card makes.
 * Shown on enable, and reachable afterwards from the card.
 */
export function ProviderHelpModal({
  providerId,
  ready,
  onClose,
}: ProviderHelpModalProps) {
  useEffect(() => {
    if (!providerId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [providerId, onClose]);

  const help = providerId ? PROVIDER_HELP[providerId] : undefined;
  const Icon = help?.icon ?? Cloud;

  return (
    <AnimatePresence>
      {help && (
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
              <Icon className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">{help.title}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {help.summary}
              </p>
              {/* Setup steps are for someone who still has to do them. A
                  provider that already answers gets the one line that
                  matters instead. */}
              {ready ? (
                <p className="flex items-center gap-1.5 text-xs text-success">
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  {help.readyLine}
                </p>
              ) : (
                <ol className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                  {help.steps.map((step, index) => (
                    <li key={step} className="flex gap-2">
                      <span className="shrink-0 font-mono text-[10px] text-primary/80">
                        {index + 1}.
                      </span>
                      <span className="leading-relaxed">{step}</span>
                    </li>
                  ))}
                </ol>
              )}
              {!ready && help.note && (
                <p className="rounded-lg bg-muted/50 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/80">
                  {help.note}
                </p>
              )}
              <div className="flex items-center justify-end">
                <Button size="sm" onClick={onClose}>
                  Got it
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
