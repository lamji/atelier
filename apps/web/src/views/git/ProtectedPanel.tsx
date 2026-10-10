import { Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Branches the agent may not edit on.
 *
 * A list rather than a single toggle because a real project has more than
 * one: `main`, whatever staging is called, and often a release branch too.
 *
 * Branches are PICKED, not typed. Every branch this checkout knows about is
 * already known — local and remote — so a free-text box only offered new
 * ways to be wrong: a typo protects nothing and looks exactly like a
 * protection that works. Stored patterns may still be globs (the guard
 * matches them), which keeps any rule written before this and lets one be
 * added by hand for a family like `release/*`.
 *
 * The pane states plainly what protection does and does NOT do. It stops
 * the AGENT — and the app's own commit and push buttons — while the
 * checkout is on a matching branch. It is not a server-side branch
 * protection rule, and nothing here stops a plain `git` in a terminal
 * outside Atelier. Overstating that would be worse than not having it.
 */
export function ProtectedPanel(props: {
  branches: string[];
  currentBranch: string;
  /** Every branch this checkout knows about, local and remote. */
  known: string[];
  busy: boolean;
  onAdd: (pattern: string) => void;
  onRemove: (pattern: string) => void;
}) {
  const protectedSet = new Set(props.branches.map((b) => b.toLowerCase()));
  // Only branches that are not already protected — a menu offering a choice
  // that does nothing is a menu that has to be explained.
  const choices = props.known
    .filter((name) => !protectedSet.has(name.toLowerCase()))
    .sort((a, b) =>
      a === props.currentBranch ? -1 : b === props.currentBranch ? 1 : a.localeCompare(b)
    );

  const options = choices.map((name) => ({
    value: name,
    label: name === props.currentBranch ? `${name}  (current)` : name,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 pt-1">
      <div className="flex shrink-0 items-center gap-1.5 px-1">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <Select
          value=""
          onChange={(name) => {
            if (name) props.onAdd(name);
          }}
          options={options}
          placeholder={
            choices.length > 0 ? "Protect a branch…" : "Every branch is protected"
          }
          disabled={props.busy || choices.length === 0}
          className="min-w-0 flex-1"
          searchable
          searchPlaceholder="Filter branches…"
        />
        {props.busy && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {props.branches.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
            <ShieldCheck className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-[11px] text-muted-foreground">
              No protected branches.
            </p>
            <p className="text-[10px] leading-relaxed text-muted-foreground/60">
              Add one and editing, committing and pushing are all refused
              while this checkout is on it — on Claude, Codex and local
              models alike, and in this app's own buttons.
            </p>
          </div>
        ) : (
          props.branches.map((pattern) => {
            const active = matches(props.currentBranch, pattern);
            return (
              <div
                key={pattern}
                className={cn(
                  "group flex items-center gap-1.5 rounded-md px-1.5 py-1",
                  "hover:bg-accent/60"
                )}
              >
                <ShieldCheck
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    active ? "text-warning" : "text-muted-foreground/50"
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                  {pattern}
                </span>
                {active && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 text-[9px] leading-[15px]",
                      "bg-warning/15 text-warning"
                    )}
                  >
                    on it now
                  </span>
                )}
                <Tooltip content={`Stop protecting ${pattern}`}>
                  <button
                    onClick={() => props.onRemove(pattern)}
                    disabled={props.busy}
                    aria-label={`Remove protection for ${pattern}`}
                    className={cn(
                      "shrink-0 rounded p-1 text-muted-foreground opacity-0",
                      "transition-opacity hover:text-danger",
                      "group-hover:opacity-100 focus-visible:opacity-100"
                    )}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            );
          })
        )}
      </div>

      <p className="shrink-0 px-2 pb-1 text-[10px] leading-relaxed text-muted-foreground/60">
        Blocks editing, committing and pushing while the checkout is on a
        matching branch — for the agent (enforced at the tool boundary, so it
        covers every provider) and for this app's own buttons. It is not a
        GitHub branch rule and it cannot stop git run outside Atelier.
      </p>
    </div>
  );
}

/** Mirror of the agent's matcher, for the "on it now" mark only. */
function matches(branch: string, pattern: string): boolean {
  const name = branch.trim().toLowerCase();
  const rule = pattern.trim().toLowerCase();
  if (!name || !rule) return false;
  if (rule === name) return true;
  if (!rule.includes("*")) return false;
  const escaped = rule
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`).test(name);
}
