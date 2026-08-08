import { BrandMark } from "@/components/BrandMark";
import { BareTitleBar } from "@/views/shell/WindowControls";
import { cn } from "@/lib/cn";

/**
 * The workbench, before it has anything to put in it.
 *
 * Shown while the editor chunk parses and the agent forks. It exists because
 * the alternative — a spinner centred on an empty field — reads as a stalled
 * app: there is no product on screen, so "Starting the agent…" is the entire
 * first impression of Atelier on every launch.
 *
 * This draws the real regions at their real sizes from the same tokens the
 * live shell uses, so the transition into the workbench is a fill, not a
 * replacement. Deliberately cheap: plain divs, no Monaco, no xterm, no view
 * models — it has to paint on the first frame or it is pointless.
 */
export function WorkspaceSkeleton() {
  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-background"
      aria-busy="true"
      aria-live="polite"
      aria-label="Opening workspace"
    >
      <BareTitleBar />

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex w-[var(--activitybar-w)] shrink-0 flex-col items-center",
            "gap-1 border-r border-border bg-activity py-1"
          )}
        >
          {Array.from({ length: 7 }).map((_, index) => (
            <span
              key={index}
              className="h-11 w-11 shrink-0 p-[13px]"
              aria-hidden
            >
              <span className="block h-full w-full rounded bg-muted-foreground/15" />
            </span>
          ))}
        </div>

        <div className="w-[clamp(190px,22%,20rem)] shrink-0 border-r border-border bg-sidebar">
          <div
            className="flex items-center border-b border-border-subtle px-3"
            style={{ height: "var(--panel-header-h)" }}
          >
            <span className="h-2 w-20 rounded bg-muted-foreground/20" />
          </div>
          <div className="space-y-3 p-3">
            {[92, 76, 84, 64, 88].map((width, index) => (
              <span
                key={index}
                className="block h-2 rounded bg-muted-foreground/12"
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
        </div>

        {/* Centre: the one place a progress signal belongs, since it is the
            region the user is waiting on. */}
        <div className="flex min-w-0 flex-1 flex-col bg-editor">
          <div
            className="shrink-0 border-b border-border bg-panel"
            style={{ height: "var(--tabbar-h)" }}
          />
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <BrandMark className="h-9 w-9 opacity-90" />
            <p className="text-xs text-muted-foreground">Opening workspace…</p>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center gap-3 border-t border-border",
          "bg-titlebar px-2"
        )}
        style={{ height: "var(--statusbar-h)" }}
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        <span className="text-[11px] text-muted-foreground">Connecting…</span>
      </div>
    </div>
  );
}
