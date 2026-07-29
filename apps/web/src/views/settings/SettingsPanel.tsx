import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Cloud,
  Cpu,
  Gauge,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Scale,
  Settings as SettingsIcon,
  Terminal,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Switch } from "@/components/ui/switch";
import { RulesTab } from "./RulesTab";
import { McpTab } from "./McpTab";
import { SkillsTab } from "./SkillsTab";
import {
  ADDABLE_PROVIDERS,
  useProvidersViewModel,
  type ProvidersVm,
} from "@/hooks/useProvidersViewModel";
import type { ProviderCredential, ProviderUsage } from "@atelier/protocol";

/** Where the Ollama daemon listens unless the user says otherwise. */
const LOCAL_OLLAMA_HOST = "http://127.0.0.1:11434";

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
      <div className="flex items-center gap-2">
        <SettingsIcon className="h-4 w-4 text-primary/80" />
        <h2 className="text-sm font-semibold">Settings</h2>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          <TabButton
            active={tab === "providers"}
            onClick={() => setTab("providers")}
            title="Providers"
          >
            <Cloud className="h-3.5 w-3.5" />
          </TabButton>
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
        </div>
      </div>

      {tab === "providers" && <ProvidersTab />}
      {tab === "mcp" && <McpTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "rules" && <RulesTab />}
    </div>
  );
}

type Tab = "providers" | "mcp" | "skills" | "rules";

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
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex h-6 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function ProvidersTab() {
  const vm = useProvidersViewModel();
  const [adding, setAdding] = useState(false);

  // Providers that have no entry yet are the ones "Add provider" offers.
  const configuredIds = new Set(vm.providers.filter((p) => p.configured).map((p) => p.id));
  const available = ADDABLE_PROVIDERS.filter((p) => !configuredIds.has(p.id));

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

      <section className="space-y-1.5">
        <div className="flex items-center gap-2 px-0.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            Providers
          </h3>
          {available.length > 0 && (
            <button
              type="button"
              disabled={!vm.connected}
              onClick={() => setAdding((v) => !v)}
              className={cn(
                "ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5",
                "text-[10px] font-medium transition-colors",
                "bg-primary/10 text-primary hover:bg-primary/20",
                "disabled:cursor-not-allowed disabled:opacity-40"
              )}
            >
              {adding ? (
                <X className="h-3 w-3" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              {adding ? "Cancel" : "Add provider"}
            </button>
          )}
        </div>

        {adding && (
          <div className="space-y-1 rounded-xl bg-muted/40 p-1.5">
            {available.map((option) => (
              <ProviderForm
                key={option.id}
                id={option.id}
                label={option.label}
                hint={option.hint}
                vm={vm}
                onDone={() => setAdding(false)}
              />
            ))}
          </div>
        )}

        {vm.providers.filter((p) => p.configured && !p.keyless).length === 0 &&
          !adding && (
            <p className="rounded-xl bg-muted/40 px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground/70">
              No API-key providers configured. The signed-in CLIs and the local
              daemon below need no key. Add a provider to run calls against a
              hosted account as well.
            </p>
          )}

        {vm.providers
          .filter((p) => p.configured)
          .map((provider) => (
            <ProviderCard key={provider.id} provider={provider} vm={vm} />
          ))}
      </section>
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
  const Icon = provider.hostless ? Terminal : provider.keyless ? Cpu : Cloud;

  return (
    <div className="overflow-hidden rounded-xl bg-muted/40">
      <div className="flex items-start gap-2.5 p-2.5">
        <Icon
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0",
            provider.enabled ? "text-primary/80" : "text-muted-foreground/50"
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{provider.label}</p>
          <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground/70">
            {provider.hostless ? (
              <>signed-in session · no key needed</>
            ) : provider.keyless ? (
              <>{provider.host ?? LOCAL_OLLAMA_HOST} · no key needed</>
            ) : (
              <>
                key {provider.keyHint ?? "stored"}
                {provider.host ? ` · ${provider.host}` : ""}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={busy || !vm.connected}
            onClick={() => vm.check(provider.id)}
            className={cn(
              "rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground",
              "hover:text-foreground disabled:opacity-40"
            )}
          >
            {busy ? "Checking…" : "Test"}
          </button>
          <button
            type="button"
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
            className="rounded-md p-1 text-muted-foreground hover:text-destructive disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
          </button>
          {/* The whole provider, in one move. Kept beside the label rather
              than inside the model list: it decides whether that list means
              anything at all. Model choices survive being switched off. */}
          <Switch
            checked={provider.enabled}
            disabled={!vm.connected}
            onChange={(next) => vm.setProviderEnabled(provider.id, next)}
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
          <button
            type="button"
            onClick={() => setShowModels((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
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
          </button>
          <button
            type="button"
            disabled={loadingModels || !vm.connected}
            onClick={() => loadCatalog(provider.id)}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
            title="Refresh model list"
          >
            <RefreshCw
              className={cn("h-3 w-3", loadingModels && "animate-spin")}
            />
          </button>
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
              : provider.keyless
                ? "Nothing pulled yet. Run `ollama pull <model>` in a terminal, then refresh — anything you pull shows up here and in the chat picker."
                : "No models returned. Run Test to check the key and host."}
          </p>
        )}
      </div>

      {/* Nothing to edit on a signed-in CLI: no key of ours, no endpoint. */}
      {provider.hostless ? null : editing ? (
        <div className="space-y-1.5 border-t border-border/60 p-2">
          <ProviderForm
            id={provider.id}
            label={provider.label}
            hint={
              provider.keyless
                ? `Where the daemon listens — blank means ${LOCAL_OLLAMA_HOST}`
                : "Leave the key blank to keep the stored one"
            }
            vm={vm}
            keyless={provider.keyless}
            initialHost={provider.host ?? ""}
            onDone={() => setEditing(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full border-t border-border/60 px-2.5 py-1.5 text-left text-[10px] text-muted-foreground hover:text-foreground"
        >
          {provider.keyless ? "Edit host" : "Edit key or host"}
        </button>
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

/** Key + optional host entry. The key is never rendered back. */
function ProviderForm({
  id,
  label,
  hint,
  vm,
  keyless = false,
  initialHost = "",
  onDone,
}: {
  id: string;
  label: string;
  hint: string;
  vm: ProvidersVm;
  /** A daemon on this machine: host only, no secret to ask for. */
  keyless?: boolean;
  initialHost?: string;
  onDone: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [host, setHost] = useState(initialHost);

  const submit = () => {
    // An untouched key field means "keep what's stored", so it is omitted
    // rather than sent as an empty string that would clear the key.
    vm.save(id, {
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      host: host.trim(),
    });
    setApiKey("");
    onDone();
  };

  return (
    <div className="space-y-2 rounded-lg bg-background/40 p-2">
      <div>
        <p className="text-[11px] font-medium">{label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
          {hint}
        </p>
      </div>
      {!keyless && (
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder="API key"
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className={cn(
            "w-full rounded-md bg-muted px-2 py-1 font-mono text-[11px]",
            "outline-none placeholder:text-muted-foreground/50",
            "focus:ring-1 focus:ring-primary/40"
          )}
        />
      )}
      <input
        type="text"
        value={host}
        autoComplete="off"
        spellCheck={false}
        placeholder={
          keyless
            ? `Host (optional) — defaults to ${LOCAL_OLLAMA_HOST}`
            : "Host (optional) — defaults to https://ollama.com"
        }
        onChange={(e) => setHost(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className={cn(
          "w-full rounded-md bg-muted px-2 py-1 font-mono text-[11px]",
          "outline-none placeholder:text-muted-foreground/50",
          "focus:ring-1 focus:ring-primary/40"
        )}
      />
      <div className="flex gap-1.5 pt-0.5">
        <button
          type="button"
          disabled={vm.saving || !vm.connected}
          onClick={submit}
          className={cn(
            "rounded-md bg-primary px-2 py-0.5 text-[10px] font-medium",
            "text-primary-foreground hover:opacity-90 disabled:opacity-40"
          )}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
