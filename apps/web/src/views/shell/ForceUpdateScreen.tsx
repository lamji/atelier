import { ArrowUpCircle, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { BareTitleBar } from "./WindowControls";
import type { UpdateStage } from "@/hooks/useUpdatesViewModel";

export interface ForceUpdateScreenProps {
  /** The newer version on GitHub; null renders nothing. */
  available: string | null;
  /** The version running now. */
  current: string;
  stage: UpdateStage;
  /** Download progress, 0-100, or null when the size is unknown. */
  percent: number | null;
  /** Why the update stopped, when it stopped badly. */
  error: string | null;
  /** Downloads and runs the installer in place. */
  onInstall: () => void;
}

/** True while the installer is being fetched or started. */
function isBusy(stage: UpdateStage): boolean {
  return (
    stage === "downloading" || stage === "verifying" || stage === "launching"
  );
}

/** What the single control says at each stage. */
function buttonLabel(
  stage: UpdateStage,
  version: string,
  percent: number | null
): string {
  if (stage === "downloading") {
    return percent === null ? "Downloading…" : `Downloading ${percent}%`;
  }
  if (stage === "verifying") return "Verifying…";
  if (stage === "launching") return "Starting installer…";
  if (stage === "error") return "Try again";
  return `Update to ${version}`;
}

/**
 * The whole window, when a newer release exists.
 *
 * There is no way past it: the only action is to install. Older builds
 * talk to an agent runtime and a session DB whose schema moves with each
 * release, so letting a stale build keep running is how "it worked
 * yesterday" bugs are born. The window stays movable and closable — the
 * bare title bar handles that — but the workspace underneath is unreachable
 * until the installer has taken over.
 */
export function ForceUpdateScreen(props: ForceUpdateScreenProps) {
  if (!props.available) return null;
  const busy = isBusy(props.stage);
  const failed = props.stage === "error";

  return (
    <div
      className="app-canvas fixed inset-0 z-[200] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Update required: Atelier ${props.available}`}
    >
      <BareTitleBar />

      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
          <BrandMark />

          <span
            className={cn(
              "grid h-12 w-12 place-items-center rounded-2xl",
              failed
                ? "bg-destructive/10 text-destructive"
                : "bg-primary/12 text-primary"
            )}
          >
            {failed ? (
              <TriangleAlert className="h-6 w-6" />
            ) : busy ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-6 w-6" />
            )}
          </span>

          <div className="flex flex-col gap-1.5">
            <h1 className="text-lg font-semibold leading-tight">
              Update required
            </h1>
            <p className="text-sm text-muted-foreground">
              Atelier {props.available} is available. You are on{" "}
              {props.current}. This version can no longer be used — install
              the update to continue.
            </p>
          </div>

          {failed && props.error && (
            <p
              role="alert"
              className={cn(
                "w-full rounded-lg border border-destructive/30",
                "bg-destructive/10 px-3 py-2 text-left text-xs",
                "text-destructive"
              )}
            >
              {props.error}
            </p>
          )}

          <div className="flex w-full flex-col gap-3">
            {/* Progress lives under the button rather than inside it, so the
                label stays readable while the bar fills. */}
            {props.stage === "downloading" && (
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={props.percent ?? undefined}
              >
                <div
                  className="h-full bg-primary transition-[width] duration-300"
                  style={{ width: `${props.percent ?? 0}%` }}
                />
              </div>
            )}
            <Button
              variant={failed ? "destructive" : "default"}
              className="app-no-drag h-10 w-full text-sm"
              disabled={busy}
              onClick={props.onInstall}
            >
              {buttonLabel(props.stage, props.available, props.percent)}
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Atelier closes once the installer starts and reopens on the new
            version.
          </p>
        </div>
      </div>
    </div>
  );
}
