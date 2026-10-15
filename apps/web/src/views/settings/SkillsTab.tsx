import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Zap,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SlashCommand } from "@atelier/protocol";
import { Switch } from "@/components/ui/switch";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { cn } from "@/lib/cn";

/**
 * Compact skill catalog, split by source: the skills that ship inside
 * Atelier (with how to run each) and those found outside it. Skills are
 * toggled here, and a skill's full SKILL.md opens in place of the list.
 */
export function SkillsTab() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [view, setView] = useState<SkillSource>("app");
  const [cliNames, setCliNames] = useState<Set<string>>(new Set());
  // The skill being read. Shown in place of the list, inside this modal,
  // so the way back is one click and the list keeps its tab.
  const [detail, setDetail] = useState<CommandDetail | null>(null);

  // Which app skills the Claude and Codex CLIs also load. An older agent
  // without `cli.skills` just shows every app skill as chat-only.
  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("cli.skills", {})
      .then(({ skills }) => setCliNames(new Set(skills.map((s) => s.name))))
      .catch(() => undefined);
  }, [connected]);

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
      .then(setDetail)
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

  if (detail) {
    return <SkillDetail detail={detail} onClose={() => setDetail(null)} />;
  }

  const inApp = commands.filter((c) => c.scope === "app");
  const outside = commands.filter((c) => c.scope !== "app");
  const skills = outside.filter((c) => c.kind === "skill");
  const slash = outside.filter((c) => c.kind === "command");

  return (
    <div className="space-y-3">
      <SourceTabs
        view={view}
        onSelect={setView}
        counts={{ app: inApp.length, outside: outside.length }}
      />
      {view === "app" ? (
        <InAppSkills
          items={inApp}
          cliNames={cliNames}
          onOpen={open}
          onToggle={toggle}
          saving={saving}
        />
      ) : (
        <OutsideSkills
          skills={skills}
          slash={slash}
          onOpen={open}
          onToggle={toggle}
          saving={saving}
        />
      )}
    </div>
  );
}

type SkillSource = "app" | "outside";

const SOURCE_TABS: { id: SkillSource; label: string }[] = [
  { id: "app", label: "In-app" },
  { id: "outside", label: "Outside app" },
];

function SourceTabs(props: {
  view: SkillSource;
  onSelect: (view: SkillSource) => void;
  counts: Record<SkillSource, number>;
}) {
  return (
    <div
      role="tablist"
      aria-label="Skill source"
      className="flex items-center gap-1 border-b border-white/5 pb-1.5"
    >
      {SOURCE_TABS.map((t) => {
        const active = props.view === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onSelect(t.id)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2",
              "text-[11px] font-medium transition-colors",
              active
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-muted/60"
            )}
          >
            {t.label}
            <span className="text-[10px] text-muted-foreground/70">
              {props.counts[t.id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The skills that ship inside Atelier. Atelier's chat runs every one of
 * them; the ones `cli.skills` lists are also loaded into the Claude and
 * Codex CLIs the app starts.
 */
function InAppSkills(props: {
  items: SlashCommand[];
  cliNames: Set<string>;
  onOpen: (item: SlashCommand) => void;
  onToggle: (item: SlashCommand, enabled: boolean) => void;
  saving: string | null;
}) {
  if (props.items.length === 0) return <Empty text="No in-app skills found." />;
  return (
    <AccordionList>
      {props.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          onOpen={props.onOpen}
          onToggle={props.onToggle}
          saving={props.saving}
        >
          <Usage name={item.name} inCli={props.cliNames.has(item.name)} />
        </ItemRow>
      ))}
    </AccordionList>
  );
}

/**
 * What runs a skill by itself, in the Claude and Codex CLIs Atelier starts.
 * The impact check is never typed; re-init can be, but a compact runs it.
 */
const AUTOMATIC: Record<string, { text: string; only?: boolean }> = {
  "atelier-impact-check": {
    text:
      "Runs by itself before every file edit, in Claude and Codex. " +
      "Nothing to type.",
    only: true,
  },
  "atelier-re-init-feature": {
    text:
      "Runs by itself after a compact: the session's own reports are " +
      "loaded back in. A new session does not need it.",
  },
};

/** Where a skill runs and what to type there. */
function Usage({ name, inCli }: { name: string; inCli: boolean }) {
  const automatic = AUTOMATIC[name];
  if (automatic?.only) return <AutomaticNote text={automatic.text} />;
  const places = [
    { where: "Atelier chat", type: `/${name}` },
    ...(inCli
      ? [
          { where: "Claude CLI", type: `/${name}` },
          { where: "Codex CLI", type: `$${name}` },
        ]
      : []),
  ];
  return (
    <div className="space-y-1">
      <p
        className={cn(
          "text-[10px] font-semibold uppercase tracking-wide",
          "text-muted-foreground/60"
        )}
      >
        How to use
      </p>
      <div className="flex flex-wrap gap-1.5">
        {places.map((p) => (
          <span
            key={p.where}
            className="flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-[10px]"
          >
            <span className="text-muted-foreground">{p.where}</span>
            <code className="font-mono font-semibold text-foreground">{p.type}</code>
          </span>
        ))}
      </div>
      {!inCli && (
        <p className="text-[10px] text-muted-foreground/60">
          Only in Atelier's chat, not the Claude or Codex CLIs.
        </p>
      )}
      {automatic && <AutomaticNote text={automatic.text} />}
      <SamplePrompts name={name} inCli={inCli} />
    </div>
  );
}

function AutomaticNote({ text }: { text: string }) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 rounded-md bg-primary/10 px-2 py-1.5",
        "text-[10px] leading-relaxed text-foreground/80"
      )}
    >
      <Zap className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
      {text}
    </p>
  );
}

/**
 * What to type after each app skill's command. Written against what each
 * SKILL.md accepts: a flow to trace, which reports to read back (or
 * nothing), a bug to fix. `update <doc-id>` is left out: Atelier sends it
 * by itself at turn end, nobody types it.
 */
const SAMPLE_PROMPTS: Record<string, string[]> = {
  "atelier-init-feature": [
    "trace Google login from the sign-in button to the session cookie",
    "what calls the checkout API handler, and which branch runs here?",
  ],
  "atelier-re-init-feature": [
    "",
    "google-login",
    "the checkout reports",
  ],
  "atelier-remember": [
    "no Redis in the local environment",
    "Tiger means the finops-crystal-lens frontend",
    "forget no-redis-locally",
  ],
  debugging: [
    "the Save button on Account settings does nothing",
    "TypeError: cannot read 'id' of undefined on the orders page",
  ],
};

/** Example requests, each copyable as the full command line. */
function SamplePrompts({ name, inCli }: { name: string; inCli: boolean }) {
  const samples = SAMPLE_PROMPTS[name];
  if (!samples) return null;
  return (
    <div className="space-y-1 pt-1">
      <p
        className={cn(
          "text-[10px] font-semibold uppercase tracking-wide",
          "text-muted-foreground/60"
        )}
      >
        Sample prompts
      </p>
      <ul className="space-y-1">
        {samples.map((sample) => (
          <SampleLine key={sample} line={`/${name} ${sample}`.trim()} />
        ))}
      </ul>
      {inCli && (
        <p className="text-[10px] text-muted-foreground/60">
          In the Codex CLI, start with <code className="font-mono">$</code>{" "}
          instead of <code className="font-mono">/</code>.
        </p>
      )}
    </div>
  );
}

function SampleLine({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(line).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <li className="flex items-center gap-2 rounded-md bg-background/60 px-2 py-1">
      <code className="min-w-0 flex-1 break-words font-mono text-[10px] text-foreground">
        {line}
      </code>
      <button
        type="button"
        onClick={copy}
        title="Copy"
        aria-label={`Copy ${line}`}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </li>
  );
}

/** Skills and commands from ~/.claude and the project. */
function OutsideSkills(props: {
  skills: SlashCommand[];
  slash: SlashCommand[];
  onOpen: (item: SlashCommand) => void;
  onToggle: (item: SlashCommand, enabled: boolean) => void;
  saving: string | null;
}) {
  return (
    <div className="space-y-3">
      <Group
        title="Skills"
        items={props.skills}
        empty="No SKILL.md files found."
        onOpen={props.onOpen}
        onToggle={props.onToggle}
        saving={props.saving}
      />
      <Group
        title="Slash commands"
        items={props.slash}
        empty="No commands in .claude/commands."
        onOpen={props.onOpen}
        saving={props.saving}
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
      <h3 className="px-0.5 text-[11px] font-semibold text-muted-foreground/60">
        {title} - {items.length}
      </h3>
      {items.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <AccordionList>
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              onOpen={onOpen}
              onToggle={onToggle}
              saving={saving}
            />
          ))}
        </AccordionList>
      )}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg bg-muted/40 px-2.5 py-2 text-[10px] text-muted-foreground/60">
      {text}
    </p>
  );
}

/** One bordered table of rows, divided like the Providers list. */
function AccordionList({ children }: { children: ReactNode }) {
  return (
    <ul
      className={cn(
        "overflow-hidden rounded-xl border border-border-subtle bg-card",
        "[&>*+*]:border-t [&>*+*]:border-border-subtle"
      )}
    >
      {children}
    </ul>
  );
}

/**
 * A skill or command, closed by default: just its name and its switch (a
 * command has no switch, so its scope stands there). Opening it shows the
 * description, anything the caller adds, and the way to the full body.
 */
function ItemRow({
  item,
  onOpen,
  onToggle,
  saving,
  children,
}: {
  item: SlashCommand;
  onOpen: (item: SlashCommand) => void;
  onToggle?: (item: SlashCommand, enabled: boolean) => void;
  saving: string | null;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      {/*
        The header is a container, NOT a button. Switch renders its own
        <button role="switch">, and nesting that inside a row button was
        invalid HTML — React logged a DOM-nesting error on every render, and
        the inner control could not be reached by keyboard. The expander and
        the switch are siblings.
      */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2.5",
          !item.enabled && "opacity-55"
        )}
      >
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
          <span className="truncate font-mono text-[11px] font-semibold">
            /{item.name}
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
      {open && (
        <div className="space-y-2.5 border-t border-border-subtle bg-muted/20 px-3 py-2.5">
          <p className="text-[11px] leading-[1.15rem] text-muted-foreground">
            {item.description || "No description."}
          </p>
          {children}
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
          >
            <FileText className="h-3 w-3" />
            Open full {item.kind}
          </button>
        </div>
      )}
    </li>
  );
}

interface CommandDetail {
  command: SlashCommand;
  content: string;
}

/** A skill's or command's whole markdown file, with the way back. */
function SkillDetail({
  detail,
  onClose,
}: {
  detail: CommandDetail;
  onClose: () => void;
}) {
  const { command, content } = detail;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b border-white/5 pb-2">
        <button
          type="button"
          onClick={onClose}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px]",
            "font-medium text-muted-foreground hover:bg-muted/60",
            "hover:text-foreground"
          )}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Close
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold">
          /{command.name}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
          {command.scope}
        </span>
      </div>
      <div className="chat-md">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </div>
  );
}
