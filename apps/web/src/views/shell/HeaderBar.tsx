import { motion } from "framer-motion";
import {
  Activity,
  FileCode2,
  FileDiff,
  MessageSquare,
  TerminalSquare,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { RightTab } from "@/state/workspace.store";

export interface HeaderBarProps {
  workingCount: number;
  rightTab: RightTab;
  diffCount: number;
  terminalCount: number;
  onSelectTab: (tab: RightTab) => void;
}

interface TabDef {
  id: RightTab;
  label: string;
  icon: typeof Activity;
  badge?: number;
}

/**
 * Top app header: brand on the left; the workbench tabs (Editor / Diffs /
 * Terminal / Activity) on the right, controlling the right dock.
 */
export function HeaderBar(props: HeaderBarProps) {
  const tabs: TabDef[] = [
    { id: "chat", label: "Chat", icon: MessageSquare },
    { id: "editor", label: "Editor", icon: FileCode2 },
    { id: "diffs", label: "Diffs", icon: FileDiff, badge: props.diffCount },
    {
      id: "terminal",
      label: "Terminal",
      icon: TerminalSquare,
      badge: props.terminalCount,
    },
    { id: "activity", label: "Activity", icon: Activity },
  ];

  return (
    <div className="flex h-full items-center gap-3 px-3">
      <div className="flex items-center gap-2.5">
        <div className="orb flex h-8 w-8 items-center justify-center rounded-xl text-sm font-bold text-white">
          A
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold tracking-tight">Atelier</p>
          <p className="text-[10px] text-muted-foreground">
            agentic engineering
          </p>
        </div>
        {props.workingCount > 0 && (
          <span className="ml-1 flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            {props.workingCount} working
          </span>
        )}
      </div>

      <nav className="ml-auto flex items-center gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => props.onSelectTab(tab.id)}
            className={cn(
              "relative flex h-8 items-center gap-1.5 rounded-lg px-3",
              "text-xs font-medium transition-colors",
              props.rightTab === tab.id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {props.rightTab === tab.id && (
              <motion.span
                layoutId="header-dock-tab"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className="absolute inset-0 rounded-lg bg-accent"
              />
            )}
            <tab.icon className="relative h-4 w-4" />
            <span className="relative">{tab.label}</span>
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="relative rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
