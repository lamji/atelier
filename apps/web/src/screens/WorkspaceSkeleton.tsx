import { BrandMark } from "@/components/BrandMark";
import { BareTitleBar } from "@/views/shell/WindowControls";

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
      className="app-canvas flex h-full flex-col overflow-hidden"
      aria-busy="true"
      aria-live="polite"
      aria-label="Opening workspace"
    >
      {/* The nav is drawn, not just reserved: it is the header the shell will
          fill, and an empty strip there reads as a broken window. */}
      <div className="flex h-[var(--topnav-h)] shrink-0 items-center gap-3 px-4">
        <BrandMark className="h-7 w-7" tile />
        <span className="hidden h-2.5 w-16 rounded-full bg-muted-foreground/20 sm:block" />
        <div className="ml-2 hidden items-center gap-5 md:flex" aria-hidden>
          {[44, 36, 52, 40].map((width, index) => (
            <span
              key={index}
              className="block h-2 rounded-full bg-muted-foreground/15"
              style={{ width }}
            />
          ))}
        </div>
        <div className="ml-auto">
          <BareTitleBar />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="dock-rail items-center gap-1.5 py-2" aria-hidden>
          <span className="h-8 w-8 rounded-lg bg-muted-foreground/15" />
          {[0, 1, 2, 3, 4].map((index) => (
            <span
              key={index}
              className="h-9 w-9 rounded-lg bg-muted-foreground/10"
            />
          ))}
          <span className="mt-auto h-9 w-9 rounded-lg bg-muted-foreground/10" />
        </div>
        <div className="flex min-h-0 flex-1 gap-[var(--shell-gap)] px-[var(--shell-gap)] pb-[var(--shell-gap)]">
          <div className="island sidebar-panel w-[clamp(240px,22%,21rem)] shrink-0">
            <div
              className="flex items-center px-4"
              style={{ height: "var(--panel-header-h)" }}
            >
              <span className="h-2.5 w-20 rounded-full bg-muted-foreground/20" />
            </div>
            <div className="space-y-3 px-4 pb-4">
              {[92, 76, 84, 64, 88].map((width, index) => (
                <span
                  key={index}
                  className="block h-2 rounded-full bg-muted-foreground/12"
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
        </div>

        {/* Centre: the one place a progress signal belongs, since it is the
            region the user is waiting on. */}
        <div className="island flex min-w-0 flex-1 flex-col">
          <div
            className="flex shrink-0 items-center px-3"
            style={{ height: "var(--tabbar-h)" }}
          >
            <span className="h-8 w-44 rounded-full bg-muted-foreground/10" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <BrandMark className="h-10 w-10 opacity-90" />
            <p className="text-xs text-muted-foreground">Opening workspace…</p>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
