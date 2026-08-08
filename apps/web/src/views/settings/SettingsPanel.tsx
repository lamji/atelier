import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Cloud,
  Gauge,
  HelpCircle,
  Loader2,
  Plug,
  RefreshCw,
  Scale,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RulesTab } from "./RulesTab";
import { McpTab } from "./McpTab";
import { SkillsTab } from "./SkillsTab";
import { AccountTab } from "./AccountTab";
import { ProviderHelpModal } from "./ProviderHelpModal";
import { useProvidersViewModel, type ProvidersVm } from "@/hooks/useProvidersViewModel";
import type {
  ProviderCredential,
  ProviderId,
  ProviderUsage,
} from "@atelier/protocol";

/**
 * Settings: model providers the user supplies credentials for. Everything
 * else that used to live here (Vibe, theme, retries, workspace path) is
 * reachable where it is actually used — the composer, the rail, the header
 * — so this panel is only the thing that has nowhere else to go.
 */
export function SettingsPanel() {
  const [tab, setTab] = useState<Tab>("providers");

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/*
        No title row: the rail icon and its tooltip already say Settings, and
        the tab strip is the only thing here that does any work. It gets the
        full width instead of being pushed into the corner by a label.
      */}
      <div className="flex items-center">
        <div className="flex w-full items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {/* One tab for every model provider. They are the same kind of
              thing configured the same way, so splitting them across three
              icons only hid two of them at a time. */}
          <TabButton
            active={tab === "providers"}
            onClick={() => setTab("providers")}
            title="Model providers"
          >
            <Cloud className="h-3.5 w-3.5" />
          </TabButton>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <TabButton
            active={tab === "mcp"}
            onClick={() => setTab("mcp")}
            title="MCP servers"
          >
            <Plug className="h-3.5 w-3.5" />
          </TabButton>
          <TabButton
            active={tab === "skills"}
            onClick={() => setTab("skills")}
            title="Skills & commands"
          >
            <Wand2 className="h-3.5 w-3.5" />
          </TabButton>
          <TabButton
            active={tab === "rules"}
            onClick={() => setTab("rules")}
            title="Agent rules"
          >
            <Scale className="h-3.5 w-3.5" />
          </TabButton>
          <span className="mx-0.5 h-4 w-px bg-border" />
          {/* Last, and behind its own divider: this is about you, not about
              the workspace's model plumbing. */}
          <TabButton
            active={tab === "account"}
            onClick={() => setTab("account")}
            title="Account"
          >
            <UserRound className="h-3.5 w-3.5" />
          </TabButton>
        </div>
      </div>

      {tab === "providers" && <ProvidersTab />}
      {tab === "mcp" && <McpTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "rules" && <RulesTab />}
      {tab === "account" && <AccountTab />}
    </div>
  );
}

type ProviderTab = "ollama-cloud" | "codex" | "claude";
type Tab = "providers" | "mcp" | "skills" | "rules" | "account";

interface ProviderDef {
  id: ProviderTab;
  title: string;
  icon: typeof Cloud;
  /** Shown when the provider has no credential yet. */
  connectLabel: string;
  connectHint: string;
}

/**
 * Every model provider, rendered as one stacked list under a single tab.
 * The connect copy is per-provider: Ollama Cloud takes an API key, while
 * Codex and Claude are CLIs you sign in to, so telling all three to paste an
 * Ollama key (as one shared string used to) was simply wrong for two of them.
 */
const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: "ollama-cloud",
    title: "Ollama Cloud",
    icon: Cloud,
    connectLabel: "Connect Ollama Cloud",
    connectHint:
      "Use an API key from ollama.com/settings/keys. Atelier stores it " +
      "locally and never sends it back to the UI.",
  },
  {
    id: "codex",
    title: "Codex",
    icon: Terminal,
    connectLabel: "Connect Codex",
    connectHint:
      "Codex runs as a signed-in CLI on this machine. Sign in with the " +
      "codex CLI, then use Test to pick it up — no key is stored here.",
  },
  {
    id: "claude",
    title: "Claude",
    icon: Sparkles,
    connectLabel: "Connect Claude",
    connectHint:
      "Claude runs as a signed-in CLI on this machine. Sign in with the " +
      "claude CLI, then use Test to pick it up — no key is stored here.",
  },
];

/** Icon-only tab: the title is the tooltip and the accessible name. */
function TabButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "!h-6 !w-7 rounded-md",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </Button>
  );
}

/** All model providers, one section each, under the single Cloud tab. */
function ProvidersTab() {
  const vm = useProvidersViewModel();

  return (
    <div className="flex flex-col gap-3">
      {(vm.loading || vm.saving) && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      )}

      {vm.error && (
        <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {vm.error}
        </p>
      )}

      {PROVIDER_DEFS.map((definition) => {
        const provider = vm.providers.find(
          (candidate) => candidate.id === definition.id
        );
        return (
          <section key={definition.id} className="space-y-1.5">
            <div className="flex items-center gap-1.5 px-0.5">
              <definition.icon className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                {definition.title}
              </h3>
            </div>

            {!provider || vm.loading ? (
              <p className="rounded-xl bg-muted/40 px-2.5 py-3 text-[11px] text-muted-foreground/70">
                Loading provider…
              </p>
            ) : provider.configured ? (
              <ProviderCard provider={provider} vm={vm} />
            ) : provider.hostless ? (
              // No key to take and no endpoint to set: the only way in is to
              // sign in to the CLI, so a key form here would be a dead end.
              <p className="rounded-xl bg-muted/40 px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground/70">
                {definition.connectHint}
              </p>
            ) : (
              <ProviderForm
                id={provider.id}
                label={definition.connectLabel}
                hint={definition.connectHint}
                vm={vm}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

/** A stored provider: status, its models, the connection check, removal. */
function ProviderCard({
  provider,
  vm,
}: {
  provider: ProviderCredential;
  vm: ProvidersVm;
}) {
  const [editing, setEditing] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [helpFor, setHelpFor] = useState<string | null>(null);
  const check = vm.checks[provider.id];
  const busy = vm.checking === provider.id;
  const models = vm.catalog[provider.id];
  const loadingModels = vm.loadingCatalog === provider.id;
  const { loadCatalog } = vm;

  // Pull the catalog once the provider is on screen; the toggles are the
  // point of this card, so they shouldn't wait for a click to appear.
  useEffect(() => {
    if (vm.connected && models === undefined) loadCatalog(provider.id);
  }, [vm.connected, models, loadCatalog, provider.id]);

  // Usage is only rendered inside the accordion, so it is fetched when the
  // accordion opens — and refetched each time, since it moves with every call.
  const { loadUsage } = vm;
  useEffect(() => {
    if (vm.connected && showModels) loadUsage(provider.id);
  }, [vm.connected, showModels, loadUsage, provider.id]);

  const enabledCount = models?.filter((m) => m.enabled).length ?? 0;
  const Icon =
    provider.id === "claude"
      ? Sparkles
      : provider.id === "codex"
        ? Terminal
        : Cloud;

  return (
    <div className="overflow-hidden rounded-xl bg-muted/40">
      {/* "Already working" is read from what the card has: a Test result
          when the user has run one, otherwise a non-empty catalog — a CLI
          that is not signed in, or a bad key, offers no models. */}
      <ProviderHelpModal
        providerId={helpFor}
        ready={check ? check.ok : (models?.length ?? 0) > 0}
        onClose={() => setHelpFor(null)}
      />
      <div className="flex items-start gap-2.5 p-2.5">
        <Icon
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0",
            provider.enabled ? "text-primary/80" : "text-muted-foreground/50"
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{provider.label}</p>
          {/* A hostless provider has nothing to say here — it signs in
              through its own session, so there is no key or host to show. */}
          {!provider.hostless && (
            <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground/70">
              key {provider.keyHint ?? "stored"}
              {provider.host ? ` · ${provider.host}` : ""}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="How this provider connects"
            onClick={() => setHelpFor(provider.id)}
            className="!h-6 !w-6 text-muted-foreground hover:text-foreground"
          >
            <HelpCircle className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !vm.connected}
            onClick={() => vm.check(provider.id)}
            className="!h-5 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {busy ? "Checking…" : "Test"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // A keyless provider cannot be removed, only reset: it is a
            // program on this machine, and it comes back on the next list.
            title={
              provider.hostless
                ? "Reset model choices"
                : provider.keyless
                  ? "Reset host and model choices"
                  : "Remove"
            }
            disabled={vm.saving}
            onClick={() => vm.remove(provider.id)}
            className="!h-6 !w-6 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
          {/* The whole provider, in one move. Kept beside the label rather
              than inside the model list: it decides whether that list means
              anything at all. Model choices survive being switched off. */}
          <Switch
            checked={provider.enabled}
            disabled={!vm.connected}
            // Switching on is the moment the user expects models to appear;
            // if this provider needs a CLI sign-in or a key, that is the
            // moment to say so rather than let the list come back empty.
            onChange={(next) => {
              vm.setProviderEnabled(provider.id, next);
              if (next) setHelpFor(provider.id);
            }}
            label={`${provider.label} models in chat`}
            className="ml-0.5"
          />
        </div>
      </div>

      {check && (
        <p
          className={cn(
            "flex items-start gap-1.5 px-2.5 pb-2 text-[10px] leading-relaxed",
            check.ok ? "text-success" : "text-destructive"
          )}
        >
          {check.ok ? (
            <Check className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <X className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          <span className="break-all">{check.detail}</span>
        </p>
      )}

      {/* Dimmed rather than hidden while the provider is off: the model
          choices still stand and are worth being able to set up before
          switching the provider back on. */}
      <div
        className={cn(
          "border-t border-border/60 transition-opacity",
          !provider.enabled && "opacity-50"
        )}
      >
        {/* Collapsed by default: a provider can offer dozens of models and
            the list would otherwise own the whole panel. The enabled count
            stays visible while closed, which is the part worth glancing at. */}
        <div className="flex items-center gap-1 px-2.5 py-1.5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowModels((v) => !v)}
            className="!h-auto min-w-0 flex-1 justify-start gap-1.5 p-0 text-left hover:bg-transparent"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform",
                showModels && "rotate-90"
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
              Models
            </span>
            <span className="text-[10px] text-muted-foreground/50">
              {provider.enabled ? `${enabledCount} in chat` : "none in chat"}
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={loadingModels || !vm.connected}
            onClick={() => loadCatalog(provider.id)}
            className="!h-6 !w-6 shrink-0 text-muted-foreground hover:text-foreground"
            title="Refresh model list"
          >
            <RefreshCw
              className={cn("h-3 w-3", loadingModels && "animate-spin")}
            />
          </Button>
        </div>

        {showModels && <UsageBlock usage={vm.usage[provider.id]} />}

        {!showModels ? null : loadingModels && models === undefined ? (
          <p className="px-2.5 py-2 text-[10px] text-muted-foreground/60">
            Loading models…
          </p>
        ) : models && models.length > 0 ? (
          <>
            <p className="px-2.5 pb-1 pt-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
              {provider.enabled
                ? "Switched-on models appear in the chat model picker."
                : "This provider is switched off, so none of these reach the chat model picker. These choices are kept for when you switch it back on."}
            </p>
            <ul className="max-h-64 overflow-y-auto px-1 pb-1">
              {models.map((model) => (
                <li key={model.name}>
                  {/* Switch is itself a role=switch button, so this row is a
                      plain container — a <label> around it would forward the
                      click and toggle twice. */}
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded-md px-1.5 py-1",
                      "hover:bg-accent/50"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-all font-mono text-[11px]">
                        {model.name}
                      </span>
                      {model.detail && (
                        <span className="block text-[10px] text-muted-foreground/60">
                          {model.detail}
                        </span>
                      )}
                    </span>
                    <Switch
                      checked={model.enabled}
                      onChange={(next) =>
                        vm.setModelEnabled(provider.id, model.name, next)
                      }
                      label={model.name}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground/60">
            {provider.hostless
              ? "No models returned. Run Test to check you are signed in to this CLI."
              : "No models returned. Run Test to check the Ollama Cloud API key."}
          </p>
        )}
      </div>

      {/* Nothing to edit on a signed-in CLI: no key of ours, no endpoint. */}
      {provider.hostless ? null : editing ? (
        <div className="space-y-1.5 border-t border-border/60 p-2">
          <ProviderForm
            id={provider.id}
            label={provider.label}
            hint="Enter a replacement Ollama Cloud API key."
            vm={vm}
            onDone={() => setEditing(false)}
          />
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setEditing(true)}
          className="!h-auto w-full justify-start rounded-none border-t border-border/60 px-2.5 py-1.5 text-left text-[10px] text-muted-foreground hover:text-foreground"
        >
          Edit API key
        </Button>
      )}
    </div>
  );
}

/**
 * What Atelier has spent on this provider. Counts, not percentages: Ollama
 * Cloud publishes no quota endpoint, so there is no denominator — and other
 * clients on the same key spend limit we cannot see. The link out goes to
 * the dashboard, which is where the real plan figure lives.
 */
function UsageBlock({ usage }: { usage?: ProviderUsage }) {
  if (!usage || usage.windows.length === 0) return null;

  return (
    <div className="mx-1 mb-1 rounded-lg bg-background/40 p-2">
      <div className="flex items-center gap-1.5">
        <Gauge className="h-3 w-3 text-primary/70" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          Usage by Atelier
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {usage.windows.map((w) => (
          <div key={w.kind} className="flex items-baseline gap-2 text-[10px]">
            <span className="w-12 shrink-0 text-muted-foreground/60">
              {w.label}
            </span>
            <span className="tabular-nums text-foreground/80">
              {w.requests} {w.requests === 1 ? "call" : "calls"}
            </span>
            <span className="tabular-nums text-muted-foreground/70">
              {compact(w.inputTokens + w.outputTokens)} tok
            </span>
            <span className="ml-auto tabular-nums text-muted-foreground/60">
              {duration(w.seconds)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/50">
        Measured here — Ollama has no quota API, so this is what Atelier
        spent, not your plan total.{" "}
        {usage.dashboardUrl && (
          <a
            href={usage.dashboardUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Plan usage ↗
          </a>
        )}
      </p>
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function duration(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

/** Ollama Cloud key entry. The key is never rendered back. */
function ProviderForm({
  id,
  label,
  hint,
  vm,
  onDone,
}: {
  id: ProviderId;
  label: string;
  hint: string;
  vm: ProvidersVm;
  onDone?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");

  const submit = () => {
    const key = apiKey.trim();
    if (!key) return;
    vm.save(id, { apiKey: key });
    setApiKey("");
    onDone?.();
  };

  return (
    <div className="space-y-2 rounded-lg bg-background/40 p-2">
      <div>
        <p className="text-[11px] font-medium">{label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
          {hint}
        </p>
      </div>
      <Input
        type="password"
        value={apiKey}
        autoComplete="off"
        spellCheck={false}
        placeholder="Ollama Cloud API key"
        onChange={(e) => setApiKey(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className="!h-7 px-2 py-1 font-mono text-[11px]"
      />
      <div className="flex gap-1.5 pt-0.5">
        <Button
          type="button"
          size="sm"
          disabled={vm.saving || !vm.connected || !apiKey.trim()}
          onClick={submit}
          className="!h-6 px-2 py-0.5 text-[10px]"
        >
          Save
        </Button>
        {onDone && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDone}
            className="!h-6 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
