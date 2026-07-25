import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
  disabled?: boolean;
  /** Rendered as inline instead of block; use for inline text triggers. */
  inline?: boolean;
}

const GAP = 8;
const VIEWPORT_PADDING = 8;
const MAX_WIDTH = 240;

export function Tooltip({
  content,
  children,
  side = "top",
  delay = 350,
  className,
  disabled,
  inline,
}: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
  const wrapperRef = React.useRef<HTMLSpanElement>(null);
  const showTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const tooltipRef = React.useRef<HTMLDivElement>(null);

  const clearShowTimer = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
  };

  const computePosition = React.useCallback(() => {
    // The wrapper itself is `display: contents` (no box of its own), so measure
    // its first rendered child instead.
    const anchor = wrapperRef.current?.firstElementChild;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const tipEl = tooltipRef.current;
    const tipWidth = tipEl?.offsetWidth ?? MAX_WIDTH;
    const tipHeight = tipEl?.offsetHeight ?? 32;

    let top = 0;
    let left = 0;

    if (side === "top" || side === "bottom") {
      left = rect.left + rect.width / 2 - tipWidth / 2;
      top = side === "top" ? rect.top - tipHeight - GAP : rect.bottom + GAP;
    } else {
      top = rect.top + rect.height / 2 - tipHeight / 2;
      left = side === "left" ? rect.left - tipWidth - GAP : rect.right + GAP;
    }

    // Flip vertically if it would overflow the viewport
    if (side === "top" && top < VIEWPORT_PADDING) {
      top = rect.bottom + GAP;
    } else if (side === "bottom" && top + tipHeight > window.innerHeight - VIEWPORT_PADDING) {
      top = rect.top - tipHeight - GAP;
    }

    // Clamp horizontally/vertically so it never overlaps the viewport edge
    left = Math.min(
      Math.max(left, VIEWPORT_PADDING),
      window.innerWidth - tipWidth - VIEWPORT_PADDING
    );
    top = Math.min(
      Math.max(top, VIEWPORT_PADDING),
      window.innerHeight - tipHeight - VIEWPORT_PADDING
    );

    setPos({ top, left });
  }, [side]);

  const handleEnter = () => {
    if (disabled || !content) return;
    clearShowTimer();
    showTimer.current = setTimeout(() => setOpen(true), delay);
  };

  const handleLeave = () => {
    clearShowTimer();
    setOpen(false);
  };

  React.useLayoutEffect(() => {
    if (!open) return;
    computePosition();
    const onScrollOrResize = () => computePosition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, computePosition]);

  React.useEffect(() => clearShowTimer, []);

  return (
    <span
      ref={wrapperRef}
      style={{ display: inline ? "inline" : "contents" }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleEnter}
      onBlur={handleLeave}
    >
      {children}
      {open && content
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              style={{
                position: "fixed",
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                maxWidth: MAX_WIDTH,
                visibility: pos ? "visible" : "hidden",
              }}
              className={cn(
                "z-[9999] rounded-md border border-border bg-card px-2.5 py-1.5",
                "text-xs leading-snug text-card-foreground shadow-lg",
                "whitespace-normal break-words pointer-events-none",
                className
              )}
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}
