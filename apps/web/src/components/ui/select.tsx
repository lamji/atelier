import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary line in the menu (e.g. the model's version blurb). */
  hint?: string;
  /** Optional action rendered separately from selecting this option. */
  action?: {
    label: string;
    onClick: () => void | Promise<void>;
  };
  separator?: false;
}

export interface SelectSeparator {
  value: string;
  label: string;
  separator: true;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<SelectOption | SelectSeparator>;
  /** Menu opens below by default; use "up" near the bottom of the view. */
  direction?: "down" | "up";
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  /** Optional right-click action for non-separator options. */
  onOptionContextMenu?: (option: SelectOption, event: MouseEvent) => void;
  /**
   * Pins a filter box to the top of the menu.
   *
   * Opt-in rather than automatic: most menus here are a handful of models
   * or modes, where a search box is furniture. A branch list is the other
   * kind — a real repository has hundreds, and scrolling to `main` past
   * forty backup branches is not a menu, it is a haystack.
   */
  searchable?: boolean;
  /** Placeholder for that box; defaults to "Search…". */
  searchPlaceholder?: string;
  /**
   * Trigger text when `value` matches no option — an "action" menu, where
   * nothing is selected and picking something DOES something.
   *
   * Without it such a menu needs a fake first option to carry its own
   * label, which then sits in the list as a row that means nothing and
   * cannot be picked.
   */
  placeholder?: string;
}

/**
 * Themed replacement for native <select>: same API shape, but the menu
 * is our own popover so it follows the app theme instead of the OS.
 */
export function Select({
  value,
  onChange,
  options,
  direction = "down",
  disabled,
  className,
  menuClassName,
  onOptionContextMenu,
  searchable = false,
  searchPlaceholder = "Search…",
  placeholder,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const selected = options.find((o) => !o.separator && o.value === value);

  // The menu renders in a portal on <body>: anchoring it to the trigger with
  // absolute positioning meant any scrolling/overflow-hidden ancestor (the
  // git flow modal, the dock panes) clipped it. Fixed coords tracked here.
  const [anchor, setAnchor] = useState({
    left: 0,
    width: 0,
    /** Viewport y of the trigger's bottom edge — the "down" menu's top. */
    belowTop: 0,
    /** Distance from viewport bottom to the trigger's top edge. */
    aboveBottom: 0,
    /** No room below — open upward regardless of the requested direction. */
    flip: false,
  });
  /** Keep in sync with the menu's max-height class below. */
  const MENU_MAX_PX = 288;

  const measure = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    setAnchor({
      left: rect.left,
      width: rect.width,
      belowTop: rect.bottom,
      aboveBottom: window.innerHeight - rect.top,
      // A trigger low in a scrolling list has no room beneath it; opening
      // downward there puts the menu past the viewport where it reads as
      // "nothing happened". Flip only when up is genuinely roomier.
      flip: below < Math.min(MENU_MAX_PX, above) && above > below,
    });
  }, []);

  /** Requested direction, overridden when that side has no room. */
  const up = anchor.flip || direction === "up";

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    // Capture phase so scrolls inside any ancestor reposition the menu too.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  // A filter is about THIS visit to the menu; carrying it to the next one
  // would reopen onto a list that looks mysteriously short.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Click-outside / Escape both close the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter(
        (option) =>
          !option.separator &&
          (option.label.toLowerCase().includes(needle) ||
            option.value.toLowerCase().includes(needle)),
      )
    : options;
  // The first real option, so Enter picks what the user is looking at.
  const firstMatch = visible.find((option) => !option.separator && option.value);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-6 cursor-pointer items-center gap-1 rounded-md bg-muted/80",
          "px-1.5 text-[11px] text-muted-foreground outline-none",
          "hover:text-foreground disabled:cursor-default disabled:opacity-50",
          className,
        )}
      >
        <span className={cn("truncate", !selected && placeholder && "text-muted-foreground/70")}>
          {selected?.label ?? (value ? value : (placeholder ?? value))}
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* The portal wraps AnimatePresence, never the reverse: given a
          portal object as its child, AnimatePresence cannot key or track
          it and renders nothing — the trigger's arrow flips and no menu
          ever appears. */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.ul
              key="select-menu"
              ref={menuRef}
              initial={{ opacity: 0, y: up ? 4 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: up ? 4 : -4 }}
              transition={{ duration: 0.12 }}
              style={{
                left: anchor.left,
                minWidth: anchor.width,
                ...(up
                  ? { bottom: anchor.aboveBottom + 4 }
                  : { top: anchor.belowTop + 4 }),
              }}
              className={cn(
                // Capped: model hints are a full sentence, and an uncapped
                // menu would stretch far past the composer that anchors it.
                "fixed z-[100] max-w-[min(20rem,80vw)]",
                // Long branch lists scroll instead of running off-screen.
                "max-h-[min(18rem,60vh)] overflow-y-auto overflow-x-hidden",
                "rounded-lg border border-border bg-card p-1 shadow-pop",
                menuClassName,
              )}
            >
              {searchable && (
                // Sticky, not merely first: the list scrolls under it, and a
                // filter box that scrolls away is one you have to scroll back
                // to in order to correct a typo.
                <li className="sticky top-0 z-10 -mx-1 -mt-1 mb-1 bg-card px-1 pb-1 pt-1">
                  <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && firstMatch) {
                        event.preventDefault();
                        onChange(firstMatch.value);
                        setOpen(false);
                      }
                      // Escape clears a filter first and closes second, so a
                      // mistyped query does not cost the whole menu.
                      if (event.key === "Escape" && query) {
                        event.preventDefault();
                        event.stopPropagation();
                        setQuery("");
                      }
                    }}
                    placeholder={searchPlaceholder}
                    className={cn(
                      "w-full rounded-md bg-muted/60 px-2 py-1 text-[11px]",
                      "text-foreground outline-none",
                      "placeholder:text-muted-foreground/60",
                      "focus:ring-1 focus:ring-primary/40",
                    )}
                  />
                </li>
              )}
              {visible.length === 0 && (
                <li className="px-2 py-3 text-center text-[11px] text-muted-foreground/60">
                  Nothing matches &ldquo;{query.trim()}&rdquo;.
                </li>
              )}
              {visible.map((option) => (
                <li key={option.value}>
                  {option.separator ? (
                    <div className="px-2 pb-1 pt-1.5 text-[9px] font-medium text-muted-foreground/50">
                      {option.label}
                    </div>
                  ) : (
                    <div className="flex items-stretch gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          onChange(option.value);
                          setOpen(false);
                        }}
                        onContextMenu={(event) => {
                          if (!onOptionContextMenu) return;
                          event.preventDefault();
                          event.stopPropagation();
                          onOptionContextMenu(option, event.nativeEvent);
                        }}
                        className={cn(
                          "flex min-w-0 flex-1 items-start gap-2 rounded-md",
                          "px-2 py-1 text-left text-[11px]",
                          option.value === value
                            ? "text-primary"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{option.label}</span>
                          {option.hint && (
                            <span className="mt-0.5 block text-[10px] leading-snug opacity-60">
                              {option.hint}
                            </span>
                          )}
                        </span>
                        {option.value === value && (
                          <Check className="mt-0.5 h-3 w-3 shrink-0" />
                        )}
                      </button>
                      {option.action && (
                        <button
                          type="button"
                          aria-label={option.action.label}
                          title={option.action.label}
                          onClick={(event) => {
                            event.stopPropagation();
                            void option.action?.onClick();
                          }}
                          className="flex shrink-0 items-center justify-center rounded-md px-2 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                        >
                          {option.action.label}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
