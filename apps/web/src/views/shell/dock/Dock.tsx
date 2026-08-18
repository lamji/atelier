import { Fragment } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { DockTile } from "./dock-items";
import { useDockViewModel, type DockProps } from "./useDockViewModel";
import { UsageModal } from "./UsageModal";

const GROUP_LABELS = ["Workspace views", "Agent provider", "Workspace layout", "Application"];

/**
 * The dock: every icon control in the app, gathered into one floating bar at
 * the bottom of the canvas.
 *
 * It replaces the header's icon row. The header was carrying three separate
 * clusters of glyphs — destinations in the middle, layout toggles and app
 * controls trailing — which made the top of the window the busiest part of
 * it. Down here they are one object with one reading order, and the header is
 * left with the three things that answer "what am I looking at".
 *
 * The tiles magnify under the cursor, with the growth falling off onto their
 * neighbours. That is the dock's whole affordance: it is a small target that
 * becomes a large one as you approach, so the bar can stay compact without
 * being fiddly. It is suppressed under `prefers-reduced-motion`.
 */
export function Dock(props: DockProps) {
  const vm = useDockViewModel(props);

  return (
    <>
      <UsageModal
        open={vm.usageOpen}
        onClose={vm.closeUsage}
        usage={props.usage}
      />
      <div
        role="toolbar"
        aria-label="Workspace dock"
        className="dock"
        onMouseLeave={vm.releaseTiles}
      >
        {vm.groups.map((group, groupIndex) => (
          <Fragment key={GROUP_LABELS[groupIndex]}>
            {groupIndex > 0 && <span aria-hidden className="dock-sep" />}
            <div
              role="group"
              aria-label={GROUP_LABELS[groupIndex]}
              className="flex items-end gap-0.5"
            >
              {group.map((tile) => (
                <DockSlot
                  key={tile.id}
                  tile={tile}
                  scale={1}
                  onEnter={() => vm.focusTile(tile.flatIndex)}
                  onLeave={vm.releaseTiles}
                />
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </>
  );
}

/**
 * One dock position: the tile itself, plus the running dot beneath it. The dot
 * is a sibling rather than a child so the magnification does not scale it —
 * the indicator marks the slot, not the glyph.
 */
function DockSlot(props: {
  tile: DockTile;
  scale: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { tile } = props;
  const isTab = tile.kind === "tab";

  return (
    <span className="flex flex-col items-center">
      <Tooltip content={tile.label} side="top">
        <button
          type="button"
          aria-label={tile.label}
          aria-current={isTab && tile.active ? "page" : undefined}
          aria-pressed={isTab ? undefined : tile.active}
          onClick={tile.onSelect}
          onMouseEnter={props.onEnter}
          onFocus={props.onEnter}
          onBlur={props.onLeave}
          className="dock-tile"
          style={{ transform: `scale(${props.scale})` }}
        >
          <tile.icon className="h-[18px] w-[18px] shrink-0" />
          {tile.badge !== null && (
            <span
              className={cn(
                "absolute -right-1 -top-1 min-w-[16px] rounded-full px-1",
                "text-[9px] font-semibold leading-[16px] tabular-nums",
                "ring-2 ring-canvas",
                tile.badgeTone === "danger"
                  ? "bg-destructive text-white"
                  : "bg-primary text-primary-foreground"
              )}
            >
              {tile.badge > 99 ? "99+" : tile.badge}
            </span>
          )}
        </button>
      </Tooltip>
      {/* Always rendered, transparent when idle: an indicator that appears and
          disappears would nudge every tile in the dock by its own height.
          For a destination it means "you are here"; where a tile sets a tone
          it means "there is something in here to look at". */}
      <span
        aria-hidden
        className={cn(
          "dock-dot",
          isTab && tile.active && "dock-dot-on",
          tile.dotTone === "warning" && "dock-dot-warning",
          tile.dotTone === "danger" && "dock-dot-danger"
        )}
      />
    </span>
  );
}
