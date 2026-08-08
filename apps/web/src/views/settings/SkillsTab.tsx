import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { SlashCommand } from "@atelier/protocol";
import { Switch } from "@/components/ui/switch";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import { cn } from "@/lib/cn";

/**
 * Compact skill catalog. Skills are toggled here and opened into the main
 * chat pane for the full readable markdown body.
 */
export function SkillsTab() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const openSkillDetail = useWorkspaceStore((s) => s.openSkillDetail);
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("session.listCommands", {})
      .then(({ commands }) => {
        setCommands(commands);
        setError(null);
      })
      .catch((e) =>
        setError(String((e as { message?: string })?.message ?? e))
      );
  }, [connected]);

  const open = (item: SlashCommand) => {
    void bridge
      .rpc("session.getCommandDetail", { id: item.id })
      .then(openSkillDetail)
      .catch((e) =>
        setError(String((e as { message?: string })?.message ?? e))
      );
  };

  const toggle = (item: SlashCommand, enabled: boolean) => {
    setSaving(item.id);
    void bridge
      .rpc("session.setCommandEnabled", { id: item.id, enabled })
      .then(({ command }) => {
        setCommands((prev) =>
          prev?.map((entry) => (entry.id === command.id ? command : entry)) ?? null
        );
        setError(null);
      })
      .catch((e) =>
        setError(String((e as { message?: string })?.message ?? e))
      )
      .finally(() => setSaving(null));
  };

  if (error) {
    return (
      <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
        {error}
      </p>
    );
  }
  if (!commands) {
    return (
      <p className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground/60">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading...
      </p>
    );
  }

  const skills = commands.filter((c) => c.kind === "skill");
  const slash = commands.filter((c) => c.kind === "command");

  return (
    <div className="space-y-3">
      <Group
        title="Skills"
        items={skills}
        empty="No SKILL.md files found."
        onOpen={open}
        onToggle={toggle}
        saving={saving}
      />
      <Group
        title="Slash commands"
        items={slash}
        empty="No commands in .claude/commands."
        onOpen={open}
        saving={saving}
      />
    </div>
  );
}

function Group({
  title,
  items,
  empty,
  onOpen,
  onToggle,
  saving,
}: {
  title: string;
  items: SlashCommand[];
  empty: string;
  onOpen: (item: SlashCommand) => void;
  onToggle?: (item: SlashCommand, enabled: boolean) => void;
  saving: string | null;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        {title} - {items.length}
      </h3>
      {items.length === 0 ? (
        <p className="rounded-lg bg-muted/40 px-2.5 py-2 text-[10px] text-muted-foreground/60">
          {empty}
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id}>
              {/*
                Row is a plain container, NOT a button. Switch renders its own
                <button role="switch">, and nesting that inside a row button
                was invalid HTML — React logged a DOM-nesting error on every
                render, and the inner control could not be reached or
                activated by keyboard. The two actions are siblings now: the
                label opens the item, the switch toggles it.
              */}
              <div
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg bg-muted/40",
                  "px-2.5 py-2 transition-colors hover:bg-muted/70",
                  !item.enabled && "opacity-55"
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  className="min-w-0 flex-1 rounded text-left"
                >
                  <span className="block truncate font-mono text-[11px] font-semibold">
                    /{item.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] leading-4 text-muted-foreground/70">
                    {item.description || "No description."}
                  </span>
                </button>
                {item.kind === "skill" ? (
                  <Switch
                    checked={item.enabled}
                    disabled={saving === item.id}
                    onChange={(next) => onToggle?.(item, next)}
                    label={`${item.name} skill`}
                  />
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
                    {item.scope}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
