import {
  Activity,
  FileCode2,
  MessageSquare,
  Network,
  Search,
  TerminalSquare,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { RightTab } from "@/state/workspace.store";

export interface EditorTabBarProps {
  /** Which editor-area pane is showing. */
  rightTab: RightTab;
  /** Path of the open file, shown as the Editor tab's label when there is one. */
  selectedPath: string | null;
  /** Whether a git diff has taken over the editor pane. */
  diffPath: string | null;
  onSelectTab: (tab: RightTab) => void;
}

interface TabDef {
  id: RightTab;
  label: string;
  title: string;
  icon: typeof FileCode2;
}

/** Basename, for the Editor tab label — a full path never fits a tab. */
function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * VS Code-style tab strip for the editor region. It lists the panes the
 * central area can show and nothing else — the bottom dock owns its own
 * Terminal/Timeline tabs, and the shell's layout toggles live in the title
 * bar, so no action appears in two places.
 *
 * Graph and RAG are reached from the Knowledge view rather than opened here,
 * so they only appear once they are the active pane: enough to show where you
 * are and to switch back, without advertising them as top-level destinations.
 */
export function EditorTabBar(props: EditorTabBarProps) {
  const openFile = props.diffPath ?? props.selectedPath;

  const tabs: TabDef[] = [
    { id: "chat", label: "Chat", title: "Chat", icon: MessageSquare },
    {
      id: "editor",
      label: openFile ? basename(openFile) : "Editor",
      title: openFile ?? "Editor",
      icon: FileCode2,
    },
    // Permanent, unlike Graph/RAG below: it is the only place the output of
    // a running validator can be read, so it has to be reachable at the
    // moment a task looks stuck rather than only once already open.
    {
      id: "output",
      label: "Output",
      title: "Agent process output",
      icon: TerminalSquare,
    },
  ];
  if (props.rightTab === "graph") {
    tabs.push({
      id: "graph",
      label: "Graph",
      title: "Knowledge graph",
      icon: Network,
    });
  }
  if (props.rightTab === "activity") {
    tabs.push({
      id: "activity",
      label: "Activity",
      title: "Execution timeline",
      icon: Activity,
    });
  }
  if (props.rightTab === "rag") {
    tabs.push({
      id: "rag",
      label: "Retrieval",
      title: "Retrieval inspector",
      icon: Search,
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Editor panes"
      className={cn(
        "flex shrink-0 items-stretch overflow-x-auto border-b border-border",
        "bg-panel"
      )}
      style={{ height: "var(--tabbar-h)" }}
    >
      {tabs.map((tab) => {
        const active = props.rightTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={tab.title}
            onClick={() => props.onSelectTab(tab.id)}
            className={cn(
              "group relative flex max-w-[16rem] shrink-0 items-center gap-1.5",
              "border-r border-border-subtle px-3 text-xs transition-colors",
              active
                ? "bg-editor text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {/* Slim top rule instead of a filled block — the active tab is
                identified by its surface matching the editor below it. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-0 top-0 h-[2px] bg-primary transition-opacity",
                active ? "opacity-100" : "opacity-0"
              )}
            />
            <tab.icon className="h-4 w-4 shrink-0 opacity-80" />
            <span className="truncate">{tab.label}</span>
          </button>
        );
      })}
      {/* Empty run of the strip: same surface, so tabs read as sitting in a
          bar rather than floating. */}
      <span aria-hidden className="min-w-0 flex-1" />
    </div>
  );
}
