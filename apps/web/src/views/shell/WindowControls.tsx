import { useEffect, useState } from "react";
import { Copy, Maximize2, Minimize2, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { desktopPlatform } from "@/lib/desktop";

/**
 * Minimize / maximize / close for the frameless window. Shared by the
 * workspace title bar and the standalone screens (login, welcome) — every
 * screen needs a way to close the app, not just the workspace.
 * macOS draws its own traffic lights over the drag region.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [kiosk, setKiosk] = useState(false);
  const api = window.atelierDesktop?.window;

  useEffect(() => {
    if (!api) return;
    void api.isMaximized().then(setMaximized);
    void api.isKiosk().then(setKiosk);
    const offMaximized = api.onMaximizedChanged(setMaximized);
    const offKiosk = api.onKioskChanged(setKiosk);
    return () => {
      offMaximized();
      offKiosk();
    };
  }, [api]);

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
        aria-label={kiosk ? "Restore normal window" : "Take over screen"}
        title={kiosk ? "Restore normal window" : "Take over screen"}
        onClick={() => api.kioskToggle()}
        className={buttonClass}
      >
        {kiosk ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </button>
      {!kiosk && (
        <>
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
        </>
      )}
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

/**
 * Chrome for screens that aren't the workspace: an invisible drag strip
 * with the window controls, so the login and welcome screens can be moved
 * and closed like any window.
 */
export function BareTitleBar() {
  if (!window.atelierDesktop) return null;
  return (
    <div className="app-drag absolute inset-x-0 top-0 z-10 flex h-[var(--titlebar-h)] items-stretch">
      <div className="min-w-0 flex-1" />
      <WindowControls />
    </div>
  );
}
