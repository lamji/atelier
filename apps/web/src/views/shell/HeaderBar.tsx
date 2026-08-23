import {
  ArrowUpCircle,
  Bot,
  Loader2,
  Monitor,
  Square,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { CommandCenter } from "./CommandCenter";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { BrandMark } from "@/components/BrandMark";

export type AgentSurface = "agent" | "preview";

interface HeaderBarProps {
  activeAgentSurface: AgentSurface | null;
  pagePreviewRunning: boolean;
  /** False when the workspace has no web app to preview. */
  showPagePreview: boolean;
  /** What to call it — Expo's web build is not a "page". */
  pagePreviewLabel: string;
  onSelectAgent: () => void;
  onSelectPagePreview: () => void;
  onStopPagePreview: () => void;
  /** Opens the command palette; the query seeds the mode (">" = commands). */
  onOpenPalette: (initialQuery: string) => void;
  /** The newer version on GitHub, or null when this build is current. */
  updateAvailable: string | null;
  /** Downloads and runs that version's installer, in place. */
  onInstallUpdate: () => void;
  /** How far that has got. */
  updateStage: "idle" | "downloading" | "verifying" | "launching" | "error";
  /** Download progress, 0-100, or null when the size is unknown. */
  updatePercent: number | null;
  /** Why the update stopped, when it stopped badly. */
  updateError: string | null;
}

/** What the update control says at each stage of an in-app install. */
function updateLabel(
  stage: HeaderBarProps["updateStage"],
  version: string,
  percent: number | null
): string {
  if (stage === "downloading") {
    return percent === null ? "Downloading…" : `Downloading ${percent}%`;
  }
  if (stage === "verifying") return "Verifying…";
  if (stage === "launching") return "Starting installer…";
  if (stage === "error") return "Update failed — retry";
  return `Update to ${version}`;
}

/**
 * The app header: identity and workspace on the left, search in the middle,
 * the two Agent-screen surfaces beside them. Every other control lives on
 * the dock rail down the left edge.
 *
 * Three groups, not one row: search has to sit in the MIDDLE, and in a plain
 * flex row it would land wherever the workspace name and the tab labels left
 * it — drifting every time a project with a longer name was opened. The two
 * outer groups are equal (`flex-1`), so the middle one is centred whatever
 * they contain, and each side truncates within its own half.
 *
 * The trailing group reserves the window buttons' width, because the header
 * spans the whole window and they sit over its end. Without that reserve the
 * centre is centred on "the window minus the buttons", which reads as
 * off-centre by half the button strip.
 */
export function HeaderBar(props: HeaderBarProps) {
  return (
    <div className="flex h-full items-center gap-3 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="app-no-drag flex min-w-0 shrink-0 items-center gap-2.5">
        <BrandMark className="h-8 w-8 shrink-0" />
        <p className="hidden shrink-0 text-sm font-semibold tracking-tight sm:block">
          Atelier
        </p>
      </div>

      <div className="app-no-drag min-w-0">
        <WorkspaceSwitcher />
      </div>

      <div className="app-no-drag ml-1 flex min-w-0 items-center gap-1">
        <div
          className="segmented min-w-0"
          role="tablist"
          aria-label="Agent workspace tabs"
        >
          <button
            type="button"
            role="tab"
            aria-selected={props.activeAgentSurface === "agent"}
            className="segment min-w-0"
            onClick={props.onSelectAgent}
          >
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Agent</span>
          </button>
          {/* Only where a browser has something to show: see
              useWebTargetViewModel. A tab that opens onto a connection error
              is worse than no tab. */}
          {props.showPagePreview && (
            <button
              type="button"
              role="tab"
              aria-selected={props.activeAgentSurface === "preview"}
              title={
                props.pagePreviewRunning
                  ? "Return to the running preview"
                  : "Preview this app at real device viewport sizes"
              }
              className="segment min-w-0"
              onClick={props.onSelectPagePreview}
            >
              <Monitor className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{props.pagePreviewLabel}</span>
            </button>
          )}
        </div>
        {props.pagePreviewRunning && (
          <button
            type="button"
            title="Stop the page preview server"
            aria-label="Stop page preview server"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-destructive/25 bg-destructive/10 text-destructive transition-colors hover:bg-destructive/15"
            onClick={props.onStopPagePreview}
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        )}
        </div>
      </div>

      <div className="app-no-drag w-[min(30rem,100%)] shrink-0">
        <CommandCenter onOpen={props.onOpenPalette} />
      </div>

      {/* Trailing group. Mirrors the leading one so the centre stays centred,
          pads past the window buttons floating over this end, and is where an
          update announces itself — that belongs to the app, not a workspace. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center justify-end",
          "pr-[var(--window-controls-w,0px)]"
        )}
      >
        {props.updateAvailable && (
          <button
            type="button"
            onClick={props.onInstallUpdate}
            disabled={
              props.updateStage === "downloading" ||
              props.updateStage === "verifying" ||
              props.updateStage === "launching"
            }
            title={
              props.updateError ||
              `Download and install Atelier ${props.updateAvailable}`
            }
            className={cn(
              "app-no-drag relative inline-flex h-8 shrink-0 items-center gap-1.5",
              "overflow-hidden rounded-full border px-3",
              "text-xs font-medium transition-colors disabled:cursor-default",
              props.updateStage === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
                : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
            )}
          >
            {/* The progress bar IS the button's background, so the control
                stays one object instead of sprouting a second widget. */}
            {props.updateStage === "downloading" && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-primary/20 transition-[width] duration-300"
                style={{ width: `${props.updatePercent ?? 0}%` }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {props.updateStage === "idle" && (
                <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
              )}
              {props.updateStage === "error" && (
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              )}
              {(props.updateStage === "downloading" ||
                props.updateStage === "verifying" ||
                props.updateStage === "launching") && (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              )}
              <span className="whitespace-nowrap">
                {updateLabel(
                  props.updateStage,
                  props.updateAvailable,
                  props.updatePercent
                )}
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
