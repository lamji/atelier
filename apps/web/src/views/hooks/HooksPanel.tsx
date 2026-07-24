import { useState } from "react";
import { Loader2, Plus, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import type { useHooksViewModel } from "@/hooks/useHooksViewModel";

export interface HooksPanelProps {
  vm: ReturnType<typeof useHooksViewModel>;
}

const EVENT_OPTIONS = [
  { value: "preTool", label: "Before tool call" },
  { value: "preTask", label: "Before task" },
  { value: "postTool", label: "After tool call" },
  { value: "postTask", label: "After task" },
];

const ACTION_OPTIONS = [
  { value: "block", label: "Block" },
  { value: "allow", label: "Allow" },
  { value: "annotate", label: "Annotate" },
  { value: "runCommand", label: "Run command" },
];

/**
 * Hook configuration: list, enable/disable, delete, and a small creation
 * form. Hooks gate every tool call the agent makes; blocks land on the
 * timeline as hook.blocked and the model adapts.
 */
export function HooksPanel({ vm }: HooksPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const { draft, setDraft } = vm;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <Webhook className="h-4 w-4 text-primary/80" />
        <h2 className="text-sm font-semibold">Hooks</h2>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 gap-1 px-2"
          disabled={!vm.connected}
          onClick={() => setExpanded((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      {expanded && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-2.5">
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Hook name (e.g. Protect env files)"
            className="h-8 text-xs"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Select
              value={draft.event}
              onChange={(v) =>
                setDraft({ ...draft, event: v as typeof draft.event })
              }
              options={EVENT_OPTIONS}
            />
            <Select
              value={draft.action}
              onChange={(v) =>
                setDraft({ ...draft, action: v as typeof draft.action })
              }
              options={ACTION_OPTIONS}
            />
          </div>
          <Input
            value={draft.matcher}
            onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}
            placeholder='Tool matcher: "*" or write_file|replace_code'
            className="h-8 font-mono text-[11px]"
          />
          <Input
            value={draft.pathGlob}
            onChange={(e) => setDraft({ ...draft, pathGlob: e.target.value })}
            placeholder="Path glob (optional): **/*.env"
            className="h-8 font-mono text-[11px]"
          />
          <Input
            value={draft.argument}
            onChange={(e) => setDraft({ ...draft, argument: e.target.value })}
            placeholder={
              draft.action === "runCommand"
                ? "Shell command (non-zero exit blocks)"
                : "Message / reason (optional)"
            }
            className="h-8 text-[11px]"
          />
          <Button
            size="sm"
            className="h-8 w-full"
            disabled={!draft.name.trim() || vm.saving}
            onClick={() => void vm.create()}
          >
            {vm.saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Create hook"
            )}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {vm.hooks.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">
            No hooks yet. Hooks gate every agent tool call — e.g. block
            writes to <span className="font-mono">**/*.env</span>.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {vm.hooks.map((hook) => (
              <li key={hook.id} className="rounded-lg bg-muted/40 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <button
                    title={hook.enabled ? "Disable" : "Enable"}
                    onClick={() => void vm.toggle(hook)}
                    className={cn(
                      "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                      hook.enabled ? "bg-primary" : "bg-muted-foreground/30"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
                        hook.enabled ? "left-3.5" : "left-0.5"
                      )}
                    />
                  </button>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[12px] font-medium",
                      !hook.enabled && "opacity-50"
                    )}
                  >
                    {hook.name}
                  </span>
                  {!hook.id.startsWith("builtin-") && (
                    <button
                      title="Delete hook"
                      onClick={() => void vm.remove(hook.id)}
                      className="shrink-0 rounded p-1 text-muted-foreground/60 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-1 truncate pl-9 font-mono text-[10px] text-muted-foreground/70">
                  {hook.event} · {hook.matcher}
                  {hook.pathGlob && ` · ${hook.pathGlob}`} · {hook.action}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
