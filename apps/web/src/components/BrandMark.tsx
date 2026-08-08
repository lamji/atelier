import { useId } from "react";
import { cn } from "@/lib/cn";

export interface BrandMarkProps {
  className?: string;
  /**
   * Draws the dark rounded tile behind the ring — the packaged app icon.
   * Off by default: inside the app the mark sits on the shell's own
   * surfaces, where a second background would read as a pasted-in sticker.
   */
  tile?: boolean;
  /** Accessible name; omit for a purely decorative mark. */
  title?: string;
}

/**
 * The Atelier mark, inline. Same geometry as apps/web/public/icon.svg — the
 * file the favicon and the packaged exe icon are built from — so the app
 * header, the login screen, and the taskbar all show one logo rather than
 * three near-misses.
 *
 * Kept as a component (not an <img src="/icon.svg">) so it takes its size
 * from the caller's classes, paints with no extra request, and can drop the
 * icon tile when it is sitting on the app's own background.
 */
export function BrandMark({ className, tile = false, title }: BrandMarkProps) {
  // Gradient ids are document-global: two marks on screen with the same id
  // would both resolve to whichever mounted first.
  const uid = useId().replace(/:/g, "");
  const sweep = `brand-sweep-${uid}`;
  const glow = `brand-glow-${uid}`;

  return (
    <svg
      viewBox="0 0 512 512"
      className={cn("shrink-0", className)}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <defs>
        {/* SVG has no conic gradient; across the ring's 308° arc a diagonal
            ramp through the same three hues as .orb is indistinguishable.
            The ramp runs the brand's own mineral-teal range: #224248 at the
            dark end, up through the lighter teals the app uses for focus and
            active states. Fixed hex, not theme vars — this mark is also the
            packaged exe icon and the favicon, where no CSS is loaded. */}
        <linearGradient id={sweep} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#224248" />
          <stop offset="38%" stopColor="#35666e" />
          <stop offset="70%" stopColor="#68aeb8" />
          <stop offset="100%" stopColor="#9ad2d8" />
        </linearGradient>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#68aeb8" stopOpacity="0.22" />
          <stop offset="70%" stopColor="#68aeb8" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#68aeb8" stopOpacity="0" />
        </radialGradient>
      </defs>

      {tile && (
        <>
          <rect width="512" height="512" rx="112" ry="112" fill="#101718" />
          <rect
            x="1"
            y="1"
            width="510"
            height="510"
            rx="111"
            ry="111"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.07"
            strokeWidth="2"
          />
        </>
      )}

      <circle cx="256" cy="256" r="190" fill={`url(#${glow})`} />
      {/* Open ring, gap centred on the top-right diagonal. */}
      <path
        d="M 378.9 213.7 A 130 130 0 1 1 298.3 133.1"
        fill="none"
        stroke={`url(#${sweep})`}
        strokeWidth="52"
        strokeLinecap="round"
      />
      {/* The bead in the gap: a workshop in motion, not a target. */}
      <circle cx="347.9" cy="164.1" r="27" fill={`url(#${sweep})`} />
    </svg>
  );
}
