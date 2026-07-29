import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";

interface Rule {
  title: string;
  body: string;
}

/**
 * The standing rules every agent run is given, read straight from the
 * agent. Read-only on purpose: this is the contract the orchestrator
 * injects, and showing a local copy would let the two drift apart.
 */
export function RulesTab() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("settings.rules", {})
      .then(({ rules }) => setRules(parseRules(rules)))
      .catch((e) =>
        setError(String((e as { message?: string })?.message ?? e))
      );
  }, [connected]);

  if (error) {
    return (
      <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
        {error}
      </p>
    );
  }

  if (!rules) {
    return (
      <p className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground/60">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading rules…
      </p>
    );
  }

  return (
    <section className="space-y-1.5">
      <h3 className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        Agent rules · {rules.length}
      </h3>
      <p className="px-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
        Given to every run, in this order. Read-only — they live with the
        orchestrator so what you see is what the agent was told.
      </p>
      <ul className="space-y-1">
        {rules.map((rule) => (
          <li key={rule.title} className="rounded-xl bg-muted/40 p-2.5">
            <p className="text-[11px] font-semibold text-foreground">
              {rule.title}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/75">
              {rule.body}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Rules arrive as one blob of "TITLE: body" lines. Splitting on the first
 * colon of each line keeps the panel in step with the constant — a rule
 * added there shows up here with no UI change.
 */
function parseRules(raw: string): Rule[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(":");
      if (at === -1) return { title: line, body: "" };
      return {
        title: line.slice(0, at).trim(),
        body: line.slice(at + 1).trim(),
      };
    });
}
