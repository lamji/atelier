import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface MenuItem {
  /** A separator when `label` is absent. */
  label?: string;
  /** Right-aligned shortcut hint, e.g. "F2". */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

export interface TreeContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 210;
const VIEWPORT_MARGIN = 8;

/**
 * The explorer's right-click menu. Rendered at the cursor and flipped back
 * inside the viewport when the cursor is near an edge, so the last item of
 * a menu opened at the bottom of the panel is still clickable.
 */
export function TreeContextMenu(props: TreeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const maxLeft = window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    setPos({
      left: Math.max(VIEWPORT_MARGIN, Math.min(props.x, maxLeft)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(props.y, maxTop)),
    });
  }, [props.x, props.y, props.items.length]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) props.onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    // `capture` so the menu closes before the click lands on a tree row.
    window.addEventListener("mousedown", close, true);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", props.onClose);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", props.onClose);
    };
  }, [props.onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
      className={cn(
        "island fixed z-[110] py-1 shadow-pop"
      )}
    >
      {props.items.map((item, index) =>
        item.label === undefined ? (
          <div key={`sep-${index}`} className="my-1 h-px bg-white/5" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              props.onClose();
              item.onSelect?.();
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
              "disabled:pointer-events-none disabled:opacity-40",
              item.danger
                ? "text-destructive hover:bg-destructive/10"
                : "hover:bg-accent/70"
            )}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {item.hint}
              </span>
            )}
          </button>
        )
      )}
    </div>
  );
}
