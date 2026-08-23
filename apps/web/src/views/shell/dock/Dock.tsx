import { Fragment } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { DockTile } from "./dock-items";
import { useDockViewModel, type DockProps } from "./useDockViewModel";
import { UsageModal } from "./UsageModal";

const GROUP_LABELS = ["Workspace views", "Agent provider", "Workspace layout", "Application"];

/**
 * The dock: every icon control in the app, gathered into one rail down the
 * left edge of the window — the Ubuntu arrangement. It ran along the bottom
 * strip before, sharing that strip with the workspace status; a window is
 * wider than it is tall, so the edge with room to spare is the side one, and
 * the status text gets its strip back.
 *
 * Reading order runs top to bottom: destinations, the provider pair, the
 * workbench toggles, and — pinned to the foot of the rail, the way Ubuntu
 * pins its applications button — the tiles that configure the app itself.
 *
 * Tiles do not grow under the cursor. The magnification was a toy on a rail
 * that is always on screen: every pass of the pointer on its way to the
 * editor set a dozen icons moving, which is motion the user did not ask for
 * and cannot switch off. Hover is a colour change and nothing else.
 */
export function Dock(props: DockProps) {
  const vm = useDockViewModel(props);
  const lastGroup = vm.groups.length - 1;

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
        aria-orientation="vertical"
        className="dock"
      >
        {vm.groups.map((group, groupIndex) => (
          <Fragment key={GROUP_LABELS[groupIndex]}>
            {groupIndex > 0 && (
              <span
                aria-hidden
                className={cn(
                  "dock-sep",
                  // The trailing group sits at the foot of the rail, so the
                  // separator above it takes all the slack.
                  groupIndex === lastGroup && "mt-auto"
                )}
              />
            )}
            <div
              role="group"
              aria-label={GROUP_LABELS[groupIndex]}
              className="flex flex-col items-center gap-px"
            >
              {group.map((tile) => (
                <DockSlot key={tile.id} tile={tile} />
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </>
  );
}

/**
 * One dock position: the tile itself, plus the running indicator beside it.
 * The indicator is a sibling rather than a child so it marks the slot rather
 * than the glyph, and it sits on the rail's outer edge, which is where a
 * left-hand dock puts it.
 */
function DockSlot(props: { tile: DockTile }) {
  const { tile } = props;
  const isTab = tile.kind === "tab";

  return (
    <span className="flex items-center gap-1">
      {/* Always rendered, transparent when idle: an indicator that appears and
          disappears would nudge every tile in the dock sideways by its own
          width. For a destination it means "you are here"; where a tile sets
          a tone it means "there is something in here to look at". */}
      <span
        aria-hidden
        className={cn(
          "dock-dot",
          isTab && tile.active && "dock-dot-on",
          tile.dotTone === "warning" && "dock-dot-warning",
          tile.dotTone === "danger" && "dock-dot-danger"
        )}
      />
      <Tooltip content={tile.label} side="right">
        <button
          type="button"
          aria-label={tile.label}
          aria-current={isTab && tile.active ? "page" : undefined}
          aria-pressed={isTab ? undefined : tile.active}
          onClick={tile.onSelect}
          className="dock-tile"
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
    </span>
  );
}
