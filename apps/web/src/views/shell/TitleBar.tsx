import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/desktop";
import { WindowControls } from "./WindowControls";

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
        "app-drag flex h-[var(--topnav-h)] shrink-0 items-stretch"
      )}
    >
      {/* The bar itself stays draggable; interactive children inside
          HeaderBar opt out individually with app-no-drag. */}
      <div className="min-w-0 flex-1">{props.children}</div>
      <WindowControls />
    </div>
  );
}
