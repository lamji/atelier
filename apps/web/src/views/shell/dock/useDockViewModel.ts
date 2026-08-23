import { useCallback, useState } from "react";
import { buildDockGroups, type DockInput, type DockTile } from "./dock-items";

/**
 * A tile plus its position across the WHOLE dock. Kept after the
 * magnification was removed because the flat index is what the dock's
 * ordering and its group boundaries are described by.
 */
export type PlacedDockTile = DockTile & { flatIndex: number };

/**
 * What the shell hands the dock. The usage modal's open state is not in it:
 * nothing outside the dock opens that modal, so the dock owns it rather than
 * making the shell hold a flag on its behalf.
 */
export type DockProps = Omit<DockInput, "usageOpen" | "onToggleUsage">;

export interface DockVm {
  groups: PlacedDockTile[][];
  usageOpen: boolean;
  closeUsage: () => void;
}

/**
 * Dock view-model: turns shell state into tiles, and owns whether the usage
 * modal is up.
 *
 * The tile list is rebuilt every render rather than memoized — it is a dozen
 * plain objects, and every field on it (active view, badges, theme) changes
 * with the props anyway, so a memo would recompute on nearly every render
 * while pretending otherwise.
 */
export function useDockViewModel(props: DockProps): DockVm {
  const [usageOpen, setUsageOpen] = useState(false);
  const toggleUsage = useCallback(() => setUsageOpen((open) => !open), []);
  const closeUsage = useCallback(() => setUsageOpen(false), []);

  let flatIndex = 0;
  const groups = buildDockGroups({
    ...props,
    usageOpen,
    onToggleUsage: toggleUsage,
  }).map((group) => group.map((tile) => ({ ...tile, flatIndex: flatIndex++ })));

  return { groups, usageOpen, closeUsage };
}
