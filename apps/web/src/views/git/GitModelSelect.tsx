import { useEffect, useState } from "react";
import type { ModelOption } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { Select, type SelectOption, type SelectSeparator } from "@/components/ui/select";
import { usePreferencesStore } from "@/state/preferences.store";
import { cn } from "@/lib/cn";

/** Sits at the top of the picker; "" sends no model and the agent uses its own. */
const DEFAULT_MODEL: SelectOption = {
  value: "",
  label: "Default (app model)",
  hint: "the model selected for the chat composer",
};

const PROVIDER_ORDER: Array<NonNullable<ModelOption["provider"]>> = [
  "claude",
  "ollama",
  "ollama-local",
  "grok",
  "codex",
];

function providerLabel(provider: NonNullable<ModelOption["provider"]>): string {
  switch (provider) {
    case "ollama":
      return "Ollama Cloud";
    case "ollama-local":
      return "Ollama (local)";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    default:
      return "Claude";
  }
}

/**
 * The provider/model pick for the git drafts — the commit message and the
 * PR title/body. The drafts used to run on whatever the chat composer had
 * selected, with no way to choose from the git screen; a commit message is
 * exactly the job a cheap local model is good for while the chat stays on
 * something heavier. The pick is one preference shared by both drafts and
 * remembered per project, like the merge resolver's.
 */
export function GitModelSelect(props: {
  disabled?: boolean;
  className?: string;
  /** "up" when the control sits near the bottom of its pane. */
  direction?: "down" | "up";
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const model = usePreferencesStore((s) => s.gitDraftModel);
  const setModel = usePreferencesStore((s) => s.setGitDraftModel);

  // The roster is whatever providers are configured right now, so it is
  // read when the control mounts rather than cached for the session.
  useEffect(() => {
    let cancelled = false;
    void bridge
      .rpc("models.list", {})
      .then((result) => {
        if (!cancelled) setModels(result.models);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // A pick that is no longer on the roster (provider removed, key gone)
  // would leave the trigger blank and draft on a model that is not there;
  // both the picker and the draft fall back to the default row.
  const known = model === "" || models.some((row) => row.value === model);
  const picked = known ? model : "";

  const options: Array<SelectOption | SelectSeparator> = [DEFAULT_MODEL];
  for (const provider of PROVIDER_ORDER) {
    const rows = models.filter((m) => (m.provider ?? "claude") === provider);
    if (rows.length === 0) continue;
    options.push({
      separator: true,
      value: `provider:${provider}`,
      label: providerLabel(provider),
    });
    options.push(
      ...rows.map((row) => ({
        value: row.value,
        label: row.label,
        hint: row.description,
      }))
    );
  }

  return (
    <Select
      value={picked}
      onChange={setModel}
      options={options}
      direction={props.direction}
      disabled={props.disabled}
      className={cn("h-7 text-xs", props.className)}
    />
  );
}

/** The pick as the RPCs want it: a model id, or undefined for the default. */
export function gitDraftModel(): string | undefined {
  return usePreferencesStore.getState().gitDraftModel || undefined;
}
