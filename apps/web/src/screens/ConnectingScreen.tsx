import { BrandMark } from "@/components/BrandMark";
import { useConnectProgress } from "@/hooks/useConnectProgress";
import { useConnectionStore } from "@/state/connection.store";
import { BareTitleBar } from "@/views/shell/WindowControls";

/**
 * The whole window while a workspace's agent comes up. The workbench is
 * not mounted behind it: until the agent answers, every panel would only
 * render disabled controls and empty states.
 */
export function ConnectingScreen() {
  const { percent, label } = useConnectProgress();
  const root = useConnectionStore((s) => s.workspaceRoot);

  return (
    <div className="app-canvas relative flex h-full flex-col">
      <BareTitleBar />
      <main className="grid min-h-0 flex-1 place-items-center px-6">
        <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
          <BrandMark className="h-12 w-12" />

          <div className="flex flex-col gap-1">
            <h1 className="text-base font-semibold">Connecting agent</h1>
            {root && (
              <p className="truncate text-xs text-muted-foreground">{root}</p>
            )}
          </div>

          <div className="flex w-full flex-col gap-2">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15"
              role="progressbar"
              aria-label="Connecting agent"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>{label}…</span>
              <span className="font-mono tabular-nums">{percent}%</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
