import { Bot, Monitor, Square } from "lucide-react";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export type AgentSurface = "agent" | "preview";

interface HeaderBarProps {
  activeAgentSurface: AgentSurface | null;
  pagePreviewRunning: boolean;
  onSelectAgent: () => void;
  onSelectPagePreview: () => void;
  onStopPagePreview: () => void;
}

/**
 * The app header: identity, workspace, and the two Agent-screen surfaces.
 * Workspace tools stay in the bottom dock; the title-bar tabs only switch
 * between the conversation workbench and its runtime-backed page preview.
 */
export function HeaderBar(props: HeaderBarProps) {
  return (
    <div className="flex h-full items-center gap-3 px-4">
      <div className="app-no-drag flex min-w-0 shrink-0 items-center gap-2.5">
        <p className="hidden shrink-0 text-sm font-semibold tracking-tight sm:block">
          Atelier
        </p>
      </div>

      <div className="app-no-drag min-w-0 shrink-0">
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
          <button
            type="button"
            role="tab"
            aria-selected={props.activeAgentSurface === "preview"}
            title={
              props.pagePreviewRunning
                ? "Return to the running page preview"
                : "Preview a full application page at real device viewport sizes"
            }
            className="segment min-w-0"
            onClick={props.onSelectPagePreview}
          >
            <Monitor className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Page preview</span>
          </button>
        </div>
        {props.pagePreviewRunning && (
          <button
            type="button"
            title="Stop the page preview server"
            aria-label="Stop page preview server"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-destructive/25 bg-destructive/10 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15"
            onClick={props.onStopPagePreview}
          >
            <Square className="h-3 w-3 fill-current" />
            <span className="hidden sm:inline">Stop</span>
          </button>
        )}
      </div>
    </div>
  );
}
