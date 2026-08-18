import { forwardRef, useId, type SVGProps } from "react";
import { cn } from "@/lib/cn";

/**
 * Dock marks for the two hosted providers. The rest of the dock's tiles take
 * Lucide glyphs, but these two are a brand cue — picking Claude vs Codex is
 * picking a product, not a shape — so they carry a recognisable mark instead
 * of a generic sparkles/code glyph.
 *
 * Each is `currentColor`-driven so it inherits the dock's `text-foreground`
 * like a Lucide icon, and accepts the same `className`/`size` shape the dock
 * passes to `<tile.icon>`. Fixed to a 24×24 viewBox to match Lucide's grid.
 */

type MarkProps = SVGProps<SVGSVGElement> & { size?: string | number };

function useMark(props: MarkProps) {
  const { size, className, ...rest } = props;
  return {
    className: cn("shrink-0", className),
    width: size ?? "1em",
    height: size ?? "1em",
    ...rest,
  } as SVGProps<SVGSVGElement>;
}

/**
 * Claude: the radiating sunburst the product uses as its mark. Twelve tapered
 * petals around a warm core — the silhouette reads as Claude's asterisk at
 * small sizes without tracing the trademark.
 */
export const ClaudeMark = forwardRef<SVGSVGElement, MarkProps>(
  function ClaudeMark(props, ref) {
    // Gradient ids are document-global; two marks on screen with the same id
    // would both resolve to whichever mounted first.
    const uid = useId().replace(/:/g, "");
    const fill = `claude-fill-${uid}`;
    const core = `claude-core-${uid}`;
    const svg = useMark(props);

    // 12 petals, each a thin diamond from the centre outward.
    const petals = Array.from({ length: 12 }, (_, i) => {
      const angle = (i * 360) / 12;
      return (
        <rect
          key={i}
          x="11.1"
          y="0.6"
          width="1.8"
          height="8.4"
          rx="0.9"
          fill={`url(#${fill})`}
          transform={`rotate(${angle} 12 12)`}
        />
      );
    });

    return (
      <svg
        ref={ref}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        {...svg}
      >
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d97757" />
            <stop offset="100%" stopColor="#c2410c" />
          </linearGradient>
          <radialGradient id={core} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f4a27a" />
            <stop offset="100%" stopColor="#d97757" />
          </radialGradient>
        </defs>
        {petals}
        <circle cx="12" cy="12" r="3.1" fill={`url(#${core})`} />
      </svg>
    );
  }
);

/**
 * Codex: the OpenAI-adjacent CLI's mark reads as a terminal prompt inside a
 * rounded frame — `›_` with a leading chevron and a trailing block. A square
 * bracket pair behind it carries the "code" reading without a literal `</>`.
 */
export const CodexMark = forwardRef<SVGSVGElement, MarkProps>(
  function CodexMark(props, ref) {
    const uid = useId().replace(/:/g, "");
    const ink = `codex-ink-${uid}`;
    const svg = useMark(props);

    return (
      <svg
        ref={ref}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        {...svg}
      >
        <defs>
          <linearGradient id={ink} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#10a37f" />
            <stop offset="100%" stopColor="#0b7a5e" />
          </linearGradient>
        </defs>
        {/* Rounded terminal frame. */}
        <rect
          x="2.5"
          y="4.5"
          width="19"
          height="15"
          rx="3.5"
          stroke={`url(#${ink})`}
          strokeWidth="1.8"
        />
        {/* Prompt chevron `›`. */}
        <path
          d="M7.6 9.2 L10.4 12 L7.6 14.8"
          stroke={`url(#${ink})`}
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Underscore cursor `_`. */}
        <path
          d="M12.4 14.8 H16.2"
          stroke={`url(#${ink})`}
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    );
  }
);