import { motion } from "framer-motion";
import {
  Bot,
  Files,
  GitBranch,
  Moon,
  Network,
  Settings,
  Sun,
  Webhook,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { Theme } from "@/state/theme.store";

export type ActivityView =
  | "agents"
  | "explorer"
  | "git"
  | "knowledge"
  | "hooks"
  | "monitor"
  | "settings";

const ITEMS: Array<{ id: ActivityView; icon: typeof Files; label: string }> = [
  { id: "agents", icon: Bot, label: "Agents" },
  { id: "explorer", icon: Files, label: "Explorer" },
  { id: "git", icon: GitBranch, label: "Git" },
  { id: "knowledge", icon: Network, label: "Knowledge" },
  { id: "hooks", icon: Webhook, label: "Hooks" },
  { id: "monitor", icon: Activity, label: "Monitor" },
  { id: "settings", icon: Settings, label: "Settings" },
];

export interface ActivityBarProps {
  active: ActivityView;
  theme: Theme;
  onSelect: (view: ActivityView) => void;
  onToggleTheme: () => void;
}

export function ActivityBar({
  active,
  theme,
  onSelect,
  onToggleTheme,
}: ActivityBarProps) {
  return (
    <div className="flex h-full w-full flex-col items-center gap-1 py-2">
      {ITEMS.map(({ id, icon: Icon, label }) => (
        <Tooltip key={id} content={label} side="right">
          <button
            onClick={() => onSelect(id)}
            className={cn(
              "relative flex h-10 w-10 items-center justify-center rounded-xl",
              "text-muted-foreground transition-colors hover:text-foreground",
              active === id && "text-primary"
            )}
          >
            {active === id && (
              <motion.span
                layoutId="activity-active"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
                className="absolute inset-0 rounded-xl bg-primary/12"
              />
            )}
            <Icon className="relative h-[18px] w-[18px]" />
          </button>
        </Tooltip>
      ))}
      <Tooltip
        content={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        side="right"
      >
        <motion.button
          whileTap={{ scale: 0.85, rotate: 40 }}
          onClick={onToggleTheme}
          className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground"
        >
          {theme === "dark" ? (
            <Sun className="h-[18px] w-[18px]" />
          ) : (
            <Moon className="h-[18px] w-[18px]" />
          )}
        </motion.button>
      </Tooltip>
    </div>
  );
}
