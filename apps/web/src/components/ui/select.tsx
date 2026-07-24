import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Menu opens below by default; use "up" near the bottom of the view. */
  direction?: "down" | "up";
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
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
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  // Click-outside / Escape both close the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
          className
        )}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: direction === "up" ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: direction === "up" ? 4 : -4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "absolute left-0 z-50 min-w-full overflow-hidden rounded-lg",
              "border border-white/10 bg-card p-1 shadow-xl",
              direction === "up" ? "bottom-full mb-1" : "top-full mt-1",
              menuClassName
            )}
          >
            {options.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 whitespace-nowrap rounded-md",
                    "px-2 py-1 text-left text-[11px]",
                    option.value === value
                      ? "text-primary"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  <span className="flex-1 truncate">{option.label}</span>
                  {option.value === value && (
                    <Check className="h-3 w-3 shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
