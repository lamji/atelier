import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { desktopPlatform, isDesktop } from "@/lib/desktop";

/**
 * Custom draggable title bar for the frameless desktop window. Hosts the
 * existing header content in its no-drag center region; Windows/Linux get
 * inline window controls, macOS keeps its native traffic lights.
 * Renders nothing in the browser.
 */
export function TitleBar(props: { children: React.ReactNode }) {
  if (!isDesktop()) return null;
  return (
    <div
      className={cn(
        "app-drag flex h-[var(--titlebar-h)] shrink-0 items-stretch",
        "border-b border-border bg-card"
      )}
    >
      <div className="app-no-drag min-w-0 flex-1">{props.children}</div>
      <WindowControls />
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const api = window.atelierDesktop?.window;

  useEffect(() => {
    if (!api) return;
    void api.isMaximized().then(setMaximized);
    return api.onMaximizedChanged(setMaximized);
  }, [api]);

  // macOS draws its own traffic lights over the drag region.
  if (!api || desktopPlatform() === "darwin") return null;

  const buttonClass = cn(
    "app-no-drag flex h-full w-12 items-center justify-center",
    "text-muted-foreground transition-colors hover:bg-accent",
    "hover:text-foreground"
  );

  return (
    <div className="flex shrink-0 items-stretch">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => api.minimize()}
        className={buttonClass}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => api.maximizeToggle()}
        className={buttonClass}
      >
        {maximized ? (
          <Copy className="h-3 w-3 -scale-x-100" />
        ) : (
          <Square className="h-3 w-3" />
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => api.close()}
        className={cn(buttonClass, "hover:bg-destructive hover:text-white")}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
