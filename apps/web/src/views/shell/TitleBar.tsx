import { cn } from "@/lib/cn";
import { desktopPlatform, isDesktop } from "@/lib/desktop";
import { WindowControls } from "./WindowControls";

/**
 * How much room the window buttons take at the end of the title bar.
 *
 * It is published as a CSS variable rather than kept here, because the
 * header needs it: the buttons used to sit OUTSIDE the header's box, so a
 * header-centred element landed half the button strip left of the window's
 * true centre — visibly off, and exactly the kind of misalignment nobody can
 * name but everybody sees. The header now spans the whole window and
 * reserves this width instead.
 *
 * Four 48px buttons on Windows and Linux (kiosk, minimize, maximize,
 * close); macOS keeps its native traffic lights and only renders two.
 */
const CONTROLS_WIDTH: Record<string, string> = {
  darwin: "96px",
};
const DEFAULT_CONTROLS_WIDTH = "192px";

/**
 * Custom draggable title bar for the frameless desktop window. Hosts the
 * existing header content in its no-drag center region; Windows/Linux get
 * inline window controls, macOS keeps its native traffic lights.
 * Renders nothing in the browser.
 */
export function TitleBar(props: { children: React.ReactNode }) {
  if (!isDesktop()) return null;
  const controlsWidth =
    CONTROLS_WIDTH[desktopPlatform() ?? ""] ?? DEFAULT_CONTROLS_WIDTH;
  return (
    <div
      className={cn(
        "app-drag relative flex h-[var(--topnav-h)] shrink-0 items-stretch"
      )}
      style={{ ["--window-controls-w" as string]: controlsWidth }}
    >
      {/* Full width, so anything the header centres is centred on the WINDOW.
          The bar stays draggable; interactive children inside HeaderBar opt
          out individually with app-no-drag. */}
      <div className="min-w-0 flex-1">{props.children}</div>
      {/* Over the header's trailing edge, which reserves exactly this width
          with pr-[var(--window-controls-w)] — so nothing is ever underneath
          them. */}
      <div className="absolute inset-y-0 right-0 flex items-stretch">
        <WindowControls />
      </div>
    </div>
  );
}
