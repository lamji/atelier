import { useCallback, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { buildDockGroups, type DockInput, type DockTile } from "./dock-items";

/**
 * How far a magnified tile grows, and how many neighbours it carries with it.
 * A dock that only scaled the tile under the cursor reads as a hover state;
 * the falloff onto the neighbours is what makes it read as a dock.
 */
const MAX_SCALE = 1.3;
const REACH = 2;

/**
 * A tile plus its position across the WHOLE dock. Magnification falls off onto
 * neighbours regardless of which group they are in — a separator divides the
 * tiles' meaning, not the physical row the cursor is running along.
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
  scaleFor: (flatIndex: number) => number;
  focusTile: (flatIndex: number) => void;
  releaseTiles: () => void;
}

/**
 * Dock view-model: turns shell state into tiles, owns the magnification, and
 * owns whether the usage modal is up.
 *
 * The tile list is rebuilt every render rather than memoized — it is a dozen
 * plain objects, and every field on it (active view, badges, theme) changes
 * with the props anyway, so a memo would recompute on nearly every render
 * while pretending otherwise.
 */
export function useDockViewModel(props: DockProps): DockVm {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const reducedMotion = useReducedMotion();

  const scaleFor = useCallback(
    (flatIndex: number) => {
      if (reducedMotion || activeIndex === null) return 1;
      const distance = Math.abs(flatIndex - activeIndex);
      if (distance > REACH) return 1;
      // Linear falloff: the cursor's tile takes the full growth, and each
      // step out keeps one fewer share of it.
      const share = 1 - distance / (REACH + 1);
      return 1 + (MAX_SCALE - 1) * share;
    },
    [activeIndex, reducedMotion]
  );

  const focusTile = useCallback((flatIndex: number) => {
    setActiveIndex(flatIndex);
  }, []);

  const releaseTiles = useCallback(() => setActiveIndex(null), []);
  const toggleUsage = useCallback(() => setUsageOpen((open) => !open), []);
  const closeUsage = useCallback(() => setUsageOpen(false), []);

  let flatIndex = 0;
  const groups = buildDockGroups({
    ...props,
    usageOpen,
    onToggleUsage: toggleUsage,
  }).map((group) => group.map((tile) => ({ ...tile, flatIndex: flatIndex++ })));

  return { groups, usageOpen, closeUsage, scaleFor, focusTile, releaseTiles };
}
