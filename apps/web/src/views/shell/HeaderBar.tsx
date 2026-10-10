import { Bot, Monitor, Square } from "lucide-react";
import { cn } from "@/lib/cn";
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
}

/**
 * The app header: identity, workspace and the two Agent-screen surfaces on
 * the left. Search lives on the dock rail with the other always-available
 * controls, as does every other control.
 *
 * Two groups, not one row: the leading group truncates within its own half
 * while the trailing group mirrors it so the centre stays centred.
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

      {/* Trailing group. Mirrors the leading one so the centre stays centred
          and pads past the window buttons floating over this end. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center justify-end",
          "pr-[var(--window-controls-w,0px)]"
        )}
      />
    </div>
  );
}
