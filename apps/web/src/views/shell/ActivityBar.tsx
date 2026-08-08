import {
  Activity,
  BookOpen,
  Bot,
  Files,
  GitBranch,
  Moon,
  Network,
  Settings,
  Sun,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { Theme } from "@/state/theme.store";

export type ActivityView =
  | "agents"
  | "explorer"
  | "markdown"
  | "git"
  | "knowledge"
  | "hooks"
  | "monitor"
  | "settings";

interface Item {
  id: ActivityView;
  icon: typeof Files;
  label: string;
}

/**
 * Workspace destinations, top group. Ordered by how often a session reaches
 * for them, not alphabetically.
 */
const ITEMS: Item[] = [
  { id: "agents", icon: Bot, label: "Agents" },
  { id: "explorer", icon: Files, label: "Explorer" },
  { id: "git", icon: GitBranch, label: "Source Control" },
  { id: "knowledge", icon: Network, label: "Knowledge" },
  { id: "markdown", icon: BookOpen, label: "Notes" },
  { id: "hooks", icon: Webhook, label: "Hooks" },
  { id: "monitor", icon: Activity, label: "Monitor" },
];

export interface ActivityBarProps {
  active: ActivityView;
  theme: Theme;
  /** Number of agents currently working, badged onto the Agents destination. */
  workingCount: number;
  /** Number of changed files, badged onto Source Control. */
  changedCount: number;
  onSelect: (view: ActivityView) => void;
  onToggleTheme: () => void;
}

/**
 * The far-left destination rail. Settings and the theme toggle are pinned to
 * the bottom — the VS Code convention that separates "where am I working" from
 * "how is the app configured".
 *
 * The active destination is marked by a slim left rule plus a brighter icon,
 * rather than a filled tile: at 44px wide a filled block is most of the rail,
 * and it competes with the sidebar it opens.
 */
export function ActivityBar(props: ActivityBarProps) {
  const badgeFor = (id: ActivityView): number | null => {
    if (id === "agents" && props.workingCount > 0) return props.workingCount;
    if (id === "git" && props.changedCount > 0) return props.changedCount;
    return null;
  };

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Workspace views"
      className="flex h-full w-full flex-col items-center py-1"
    >
      {ITEMS.map((item) => (
        <RailButton
          key={item.id}
          item={item}
          active={props.active === item.id}
          badge={badgeFor(item.id)}
          onSelect={() => props.onSelect(item.id)}
        />
      ))}

      <div className="mt-auto flex flex-col items-center pt-1">
        <RailButton
          item={{ id: "settings", icon: Settings, label: "Settings" }}
          active={props.active === "settings"}
          badge={null}
          onSelect={() => props.onSelect("settings")}
        />
        <Tooltip
          content={
            props.theme === "dark"
              ? "Switch to light theme"
              : "Switch to dark theme"
          }
          side="right"
        >
          <button
            type="button"
            onClick={props.onToggleTheme}
            aria-label={
              props.theme === "dark"
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
            className={cn(
              "flex h-10 w-11 items-center justify-center text-muted-foreground",
              "transition-colors hover:text-foreground"
            )}
          >
            {props.theme === "dark" ? (
              <Sun className="h-[18px] w-[18px]" />
            ) : (
              <Moon className="h-[18px] w-[18px]" />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function RailButton(props: {
  item: Item;
  active: boolean;
  badge: number | null;
  onSelect: () => void;
}) {
  const { item, active } = props;
  return (
    <Tooltip content={item.label} side="right">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={item.label}
        onClick={props.onSelect}
        className={cn(
          "relative flex h-11 w-11 items-center justify-center",
          "transition-colors",
          active
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-1.5 left-0 w-[2px] rounded-r bg-primary",
            "transition-opacity",
            active ? "opacity-100" : "opacity-0"
          )}
        />
        <item.icon className="h-[18px] w-[18px]" />
        {props.badge !== null && (
          <span
            className={cn(
              "absolute bottom-1.5 right-1.5 min-w-[14px] rounded-full",
              "bg-primary px-[3px] text-[9px] font-semibold leading-[14px]",
              "tabular-nums text-primary-foreground"
            )}
          >
            {props.badge > 99 ? "99+" : props.badge}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
