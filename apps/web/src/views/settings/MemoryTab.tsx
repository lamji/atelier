import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import type { MemoryEntry, MemoryType } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConnectionStore } from "@/state/connection.store";
import { confirmDialog } from "@/state/confirm.store";
import { cn } from "@/lib/cn";

function errText(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

const TYPE_OPTIONS: Array<{ value: MemoryType; label: string; hint: string }> = [
  { value: "correction", label: "Correction", hint: "Something the agent got wrong" },
  { value: "environment", label: "Environment", hint: "What runs here, what does not" },
  { value: "naming", label: "Naming", hint: "Which repo or app a name means" },
  { value: "preference", label: "Preference", hint: "How you want work done" },
  { value: "fact", label: "Fact", hint: "Any other lasting project fact" },
];

interface Draft {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

const EMPTY: Draft = { name: "", description: "", type: "correction", body: "" };

/**
 * The workspace's own memory: one file per fact in .atelier/memory, read
 * into every Claude and Codex session Atelier starts. The agents add to it
 * when you correct them; here you can read, fix, add, and delete entries.
 */
export function MemoryTab() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    void bridge
      .rpc("memory.list", {})
      .then(({ entries }) => {
        setEntries(entries);
        setError(null);
      })
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  const save = async (draft: Draft, previousName?: string) => {
    await bridge.rpc("memory.save", { ...draft, previousName });
    load();
  };

  const remove = async (entry: MemoryEntry) => {
    const ok = await confirmDialog({
      title: "Delete memory",
      message:
        `Forget "${entry.name}"?\n\n` +
        "Sessions started after this will no longer know it.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    void bridge
      .rpc("memory.delete", { name: entry.name })
      .then(load)
      .catch((e) => setError(errText(e)));
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5 px-0.5">
        <h3 className="text-[11px] font-semibold text-muted-foreground/60">
          Workspace memory{entries ? ` · ${entries.length}` : ""}
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 gap-1 px-1.5 text-[10px]"
          disabled={!connected}
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="h-3 w-3" />
          Add memory
        </Button>
      </div>
      <p className="px-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
        Facts this project's agents keep, one file each in{" "}
        <span className="font-mono">.atelier/memory</span>. Claude and Codex
        sessions started from Atelier read them at start and after a compact,
        instead of Codex's global memory. Agents add an entry when you correct
        them or state a lasting fact, or when you run{" "}
        <span className="font-mono">$atelier-remember</span>{" "}
        (<span className="font-mono">/atelier-remember</span> in Claude). Memory guides where to look; it is never
        taken as proof of a cause.
      </p>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {error}
        </p>
      )}

      {adding && (
        <div className="rounded-xl border border-border-subtle bg-card p-3">
          <MemoryForm
            initial={EMPTY}
            submitLabel="Save memory"
            onCancel={() => setAdding(false)}
            onSubmit={async (draft) => {
              await save(draft);
              setAdding(false);
            }}
          />
        </div>
      )}

      {!entries ? (
        <p className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground/60">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading...
        </p>
      ) : entries.length === 0 ? (
        <p className="rounded-lg bg-muted/40 px-2.5 py-2 text-[10px] text-muted-foreground/60">
          Nothing remembered yet. Correct an agent, or add an entry here.
        </p>
      ) : (
        <ul
          className={cn(
            "overflow-hidden rounded-xl border border-border-subtle bg-card",
            "[&>*+*]:border-t [&>*+*]:border-border-subtle"
          )}
        >
          {entries.map((entry) => (
            <MemoryRow
              key={entry.name}
              entry={entry}
              onSave={(draft) => save(draft, entry.name)}
              onDelete={() => void remove(entry)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryRow({
  entry,
  onSave,
  onDelete,
}: {
  entry: MemoryEntry;
  onSave: (draft: Draft) => Promise<void>;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90"
            )}
          />
          <TypeBadge type={entry.type} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[11px] font-semibold">
              {entry.name}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground/70">
              {entry.description || "No description."}
            </span>
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Delete"
          onClick={onDelete}
          className="!h-6 !w-6 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      {open && (
        <div className="border-t border-border-subtle bg-muted/20 px-3 py-3">
          <MemoryForm
            initial={entry}
            submitLabel="Save changes"
            onCancel={() => setOpen(false)}
            onSubmit={async (draft) => {
              await onSave(draft);
              setOpen(false);
            }}
          />
        </div>
      )}
    </li>
  );
}

function TypeBadge({ type }: { type: MemoryType }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase",
        type === "correction"
          ? "bg-destructive/10 text-destructive"
          : "bg-primary/10 text-primary"
      )}
    >
      {type}
    </span>
  );
}

/** Name, type, one-line description, and the fact itself. */
function MemoryForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    name: initial.name,
    description: initial.description,
    type: initial.type,
    body: initial.body,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const ready = draft.name.trim() !== "" && draft.body.trim() !== "";

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draft);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const label = "text-[10px] font-medium text-muted-foreground";
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-[1fr_9rem] gap-2">
        <label className="space-y-1">
          <span className={label}>Name</span>
          <Input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="no-redis-locally"
            className="h-8 font-mono text-xs"
          />
        </label>
        <div className="space-y-1">
          <span className={label}>Type</span>
          <Select
            value={draft.type}
            onChange={(value) => set({ type: value as MemoryType })}
            options={TYPE_OPTIONS}
            className="h-8 text-xs"
          />
        </div>
      </div>
      <label className="block space-y-1">
        <span className={label}>Description (one line)</span>
        <Input
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Local runs have no Redis"
          className="h-8 text-xs"
        />
      </label>
      <label className="block space-y-1">
        <span className={label}>What to remember</span>
        <Textarea
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
          placeholder={
            "Local serves KPIs from snapshot + live only; there is no Redis. " +
            "Do not blame a cache for stale numbers here."
          }
          rows={5}
          className="text-xs leading-relaxed"
        />
      </label>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={!ready || saving}
          onClick={() => void submit()}
          className="h-7 px-2.5 text-[11px]"
        >
          {saving ? "Saving…" : submitLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="h-7 px-2.5 text-[11px] text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
