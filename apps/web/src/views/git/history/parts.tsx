import { Cloud, Laptop, Tag } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { authorHue, initials, parseRefs, type ParsedRef } from "./format";

/** Initials on a colour picked from the name — a stand-in for a photo. */
export function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  const hue = authorHue(name);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-bold leading-none"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, Math.round(size * 0.38)),
        background: `hsl(${hue} 55% 45% / 0.28)`,
        color: `hsl(${hue} 70% 70%)`,
      }}
    >
      {initials(name)}
    </span>
  );
}

function RefPill(props: { item: ParsedRef; color: string | null }) {
  const { item: r, color } = props;
  const tag = r.kind === "tag";
  const where = [
    r.local ? "local" : null,
    ...r.remotes.map((remote) => `${remote}/${r.name}`),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip content={tag ? `Tag ${r.name}` : `${r.name} — ${where}`}>
      <span
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1 rounded px-1.5",
          "text-[10px] font-medium leading-[18px]",
          tag
            ? "bg-warning/15 text-warning"
            : "bg-white/5 text-foreground/90",
          r.head && "font-semibold"
        )}
        style={
          color && !tag
            ? { boxShadow: `inset 3px 0 0 ${color}`, paddingLeft: 7 }
            : undefined
        }
      >
        {tag ? (
          <Tag className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <>
            {r.local && (
              <Laptop
                className={cn(
                  "h-2.5 w-2.5 shrink-0",
                  r.head ? "text-success" : "text-muted-foreground"
                )}
              />
            )}
            {r.remotes.length > 0 && (
              <Cloud className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
            )}
          </>
        )}
        <span className="truncate">{r.name}</span>
      </span>
    </Tooltip>
  );
}

/**
 * A commit's branches and tags. In the graph's narrow ref column only the
 * first fits, with a "+N" that names the rest on hover.
 */
export function RefPills(props: {
  refs: string | undefined;
  color: string | null;
  max?: number;
  wrap?: boolean;
}) {
  const refs = parseRefs(props.refs);
  if (refs.length === 0) return null;
  const max = props.max ?? 1;
  const shown = refs.slice(0, max);
  const rest = refs.slice(max);
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1",
        props.wrap && "flex-wrap"
      )}
    >
      {shown.map((r) => (
        <RefPill key={`${r.kind}:${r.name}`} item={r} color={props.color} />
      ))}
      {rest.length > 0 && (
        <Tooltip content={rest.map((r) => r.name).join(", ")}>
          <span
            className={cn(
              "shrink-0 rounded bg-white/5 px-1 text-[10px] leading-[18px]",
              "text-muted-foreground"
            )}
          >
            +{rest.length}
          </span>
        </Tooltip>
      )}
    </span>
  );
}
