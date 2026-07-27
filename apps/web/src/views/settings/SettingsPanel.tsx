import { Loader2, Moon, Settings as SettingsIcon, Sparkles, Sun } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import type { SettingsVm } from "@/hooks/useSettingsViewModel";

export interface SettingsPanelProps {
  vm: SettingsVm;
}

const RETRY_OPTIONS = [0, 1, 2, 3];

/**
 * Settings: client preferences that apply instantly (Vibe, theme) and
 * agent settings persisted per project (validation retries). Vibe is also
 * on the composer — same switch, two places, because it is a per-run
 * decision people make while typing the task.
 */
export function SettingsPanel({ vm }: SettingsPanelProps) {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <SettingsIcon className="h-4 w-4 text-primary/80" />
        <h2 className="text-sm font-semibold">Settings</h2>
        {(vm.loading || vm.saving) && (
          <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {vm.error && (
        <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {vm.error}
        </p>
      )}

      <Section title="Agent">
        <Row
          icon={<Sparkles className="h-3.5 w-3.5 text-primary/80" />}
          title="Vibe Coding Mode"
          detail={
            "The agent acts as an autonomous product builder: it completes " +
            "the obvious follow-up work, designs UI before building it, and " +
            "carries a feature to production-ready instead of stopping at " +
            "the literal request."
          }
          control={
            <Switch
              checked={vm.vibe}
              onChange={vm.setVibe}
              label="Vibe Coding Mode"
            />
          }
        />
        <Row
          title="Validation retries"
          detail={
            "How many times the agent re-runs validators and fixes findings " +
            "before handing the task back."
          }
          control={
            <div className="flex gap-1">
              {RETRY_OPTIONS.map((n) => {
                const active = vm.settings?.maxValidationRetries === n;
                return (
                  <button
                    key={n}
                    type="button"
                    disabled={!vm.connected || vm.settings === null}
                    onClick={() => vm.setValidationRetries(n)}
                    className={cn(
                      "h-6 w-6 rounded-md text-[11px] tabular-nums transition-colors",
                      "disabled:cursor-not-allowed disabled:opacity-40",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          }
        />
      </Section>

      <Section title="Appearance">
        <Row
          icon={
            vm.theme === "dark" ? (
              <Moon className="h-3.5 w-3.5 text-primary/80" />
            ) : (
              <Sun className="h-3.5 w-3.5 text-primary/80" />
            )
          }
          title="Dark mode"
          detail="Also on the rail, at the bottom."
          control={
            <Switch
              checked={vm.theme === "dark"}
              onChange={vm.toggleTheme}
              label="Dark mode"
            />
          }
        />
      </Section>

      <Section title="Workspace">
        <p className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/70">
          {vm.settings?.workspaceRoot ?? "Not connected"}
        </p>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1">
      <h3 className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </h3>
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl bg-muted/40">
        {children}
      </div>
    </section>
  );
}

function Row({
  icon,
  title,
  detail,
  control,
}: {
  icon?: React.ReactNode;
  title: string;
  detail: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 p-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {icon}
          <p className="text-xs font-medium">{title}</p>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
          {detail}
        </p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}
