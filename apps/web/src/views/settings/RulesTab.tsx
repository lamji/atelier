import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { UserRule } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConnectionStore } from "@/state/connection.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import { useGitStore } from "@/state/git.store";

function errText(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

/**
 * The user's own standing rules — one markdown file each, under
 * .atelier/rules, appended to the system rules on every run.
 *
 * Titles only: a rule is prose, and prose belongs in the editor rather
 * than in a settings panel, so a row opens the same markdown editor the
 * rest of the workspace uses. The switch decides whether the file rides
 * along with the next run; it never deletes anything.
 */
export function RulesTab() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const [rules, setRules] = useState<UserRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    void bridge
      .rpc("rules.list", {})
      .then(({ rules }) => setRules(rules))
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(() => {
    if (!connected) return;
    load();
  }, [connected, load]);

  /** Opens the rule in the main editor, same as any workspace file. */
  const openRule = async (path: string) => {
    try {
      const file = await bridge.rpc("fs.readFile", { path });
      useGitStore.getState().setGitDiff(null);
      useWorkspaceStore
        .getState()
        .setSelectedFile(file.path, file.content, file.mtime);
    } catch (e) {
      setError(errText(e));
    }
  };

  const create = async () => {
    const name = draftName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      const { rule } = await bridge.rpc("rules.create", { name });
      setDraftName("");
      setCreating(false);
      load();
      await openRule(rule.path);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (rule: UserRule, enabled: boolean) => {
    // Optimistic: the switch moves under the finger, then the file catches up.
    setRules((prev) =>
      (prev ?? []).map((r) => (r.path === rule.path ? { ...r, enabled } : r))
    );
    void bridge
      .rpc("rules.setEnabled", { path: rule.path, enabled })
      .catch((e) => {
        setError(errText(e));
        load();
      });
  };

  const remove = (rule: UserRule) => {
    const ok = window.confirm(
      `Delete the rule "${rule.title}"?\n\n` +
        `${rule.path} is removed from the workspace. This cannot be undone.`
    );
    if (!ok) return;
    void bridge
      .rpc("rules.delete", { path: rule.path })
      .then(load)
      .catch((e) => setError(errText(e)));
  };

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-0.5">
        <h3 className="text-[11px] font-semibold text-muted-foreground/60">
          Your rules{rules ? ` · ${rules.length}` : ""}
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 gap-1 px-1.5 text-[10px]"
          disabled={!connected}
          onClick={() => setCreating((v) => !v)}
        >
          <Plus className="h-3 w-3" />
          Add rule
        </Button>
      </div>
      <p className="px-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
        Markdown files in{" "}
        <span className="font-mono">.atelier/rules</span>, given to the agent
        with every run. Restart Atelier after adding one so running agents
        pick it up.
      </p>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {error}
        </p>
      )}

      {creating && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-2.5">
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Rule name, e.g. Commit style"
            className="h-8 text-xs"
            autoFocus
          />
          <Button
            size="sm"
            className="h-8 w-full"
            disabled={!draftName.trim() || saving}
            onClick={() => void create()}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Create and edit"
            )}
          </Button>
        </div>
      )}

      {!rules ? (
        <p className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground/60">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading rules…
        </p>
      ) : rules.length === 0 ? (
        <p className="px-0.5 text-[11px] leading-relaxed text-muted-foreground/60">
          No rules yet. Add one to give every run a standing instruction —
          how to name things, what to never touch, how you want commits
          written.
        </p>
      ) : (
        <ul className="space-y-1">
          {rules.map((rule) => (
            <li
              key={rule.path}
              className="flex items-center gap-1.5 rounded-xl bg-muted/40 px-2.5 py-2"
            >
              <button
                className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-foreground hover:text-primary"
                title={rule.path}
                onClick={() => void openRule(rule.path)}
              >
                {rule.title}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Delete rule"
                onClick={() => remove(rule)}
                className="!h-6 !w-6 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
              <Switch
                checked={rule.enabled}
                onChange={(next) => toggle(rule, next)}
                label={`${rule.title} applies to every run`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
