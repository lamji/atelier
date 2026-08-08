import { Activity, Sidebar, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { BrandMark } from "@/components/BrandMark";
import { Tooltip } from "@/components/ui/tooltip";
import type { RightTab } from "@/state/workspace.store";
import { CommandCenter } from "./CommandCenter";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export interface HeaderBarProps {
  workingCount: number;
  rightTab: RightTab;
  terminalCount: number;
  workbenchVisible: boolean;
  /** Whether the terminal dock is expanded. */
  bottomOpen: boolean;
  onSelectTab: (tab: RightTab) => void;
  onToggleWorkbench: () => void;
  /** Opens the command palette; the query seeds its mode. */
  onOpenCommands: (initialQuery: string) => void;
}

/**
 * Title-bar content: identity and workspace on the left, layout controls on
 * the right.
 *
 * The pane tabs used to live here; they now sit in the editor region's own
 * tab bar, which is the region they act on. What stays is genuinely global or
 * layout-scoped: which workspace is open, the command center, and the two
 * toggles. Both are aria-pressed toggles rather than tabs: Terminal shows or
 * hides the bottom dock, Activity raises the execution timeline in the editor
 * area.
 */
export function HeaderBar(props: HeaderBarProps) {
  return (
    <div className="flex h-full items-center gap-2 pl-2.5 pr-1">
      <div className="flex min-w-0 items-center gap-2">
        <BrandMark className="h-[18px] w-[18px]" title="Atelier" />
        <p className="shrink-0 text-xs font-semibold tracking-tight">Atelier</p>
        {props.workingCount > 0 && (
          <Tooltip
            content={`${props.workingCount} agent${
              props.workingCount > 1 ? "s" : ""
            } working in this workspace`}
          >
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5",
                "text-[10px] font-semibold tabular-nums text-primary"
              )}
              style={{ background: "var(--atelier-brand-soft)" }}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              {props.workingCount} working
            </span>
          </Tooltip>
        )}
      </div>

      <div className="app-no-drag ml-1 min-w-0">
        <WorkspaceSwitcher />
      </div>

      {/*
       * Centred command center. The wrapper is what centres it: `mx-auto` on a
       * width-capped flex item keeps it near the middle of the bar without
       * pinning it to an exact centre it would have to fight the two side
       * groups for at narrow widths.
       */}
      <div className="mx-auto hidden min-w-0 max-w-[26rem] flex-1 px-2 md:block">
        <CommandCenter onOpen={props.onOpenCommands} />
      </div>

      <div className="app-no-drag flex shrink-0 items-center gap-0.5">
        <Tooltip
          content={
            props.workbenchVisible ? "Hide pane tabs" : "Show pane tabs"
          }
        >
          <button
            type="button"
            onClick={props.onToggleWorkbench}
            aria-label={
              props.workbenchVisible ? "Hide pane tabs" : "Show pane tabs"
            }
            aria-pressed={props.workbenchVisible}
            className={cn(
              "tool-btn",
              props.workbenchVisible && "text-primary"
            )}
          >
            <Sidebar className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content="Toggle terminal panel (Ctrl+`)">
          <button
            type="button"
            onClick={() => props.onSelectTab("terminal")}
            aria-label="Toggle terminal panel"
            aria-pressed={props.bottomOpen}
            className={cn(
              "tool-btn relative",
              props.bottomOpen && "text-primary"
            )}
          >
            <TerminalSquare className="h-4 w-4" />
            {props.terminalCount > 0 && (
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 min-w-[13px] rounded-full",
                  "bg-primary px-[3px] text-[9px] font-semibold leading-[13px]",
                  "tabular-nums text-primary-foreground"
                )}
              >
                {props.terminalCount}
              </span>
            )}
          </button>
        </Tooltip>
        <Tooltip content="Show the execution timeline">
          <button
            type="button"
            onClick={() => props.onSelectTab("activity")}
            aria-label="Show the execution timeline"
            aria-pressed={props.rightTab === "activity"}
            className={cn(
              "tool-btn",
              props.rightTab === "activity" && "text-primary"
            )}
          >
            <Activity className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
