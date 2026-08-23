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
 * Pane switcher for the main region — a segmented control, not a tab strip.
 *
 * The distinction matters: document tabs promise that each one is a file you
 * opened and can close, which was never true here. These are three fixed
 * views of one workspace, so a segmented control states the truth and stops
 * the main region from reading as an editor with files open in it.
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
  if (props.rightTab === "activity") {
    tabs.push({
      id: "activity",
      label: "Activity",
      title: "Execution timeline",
      icon: Activity,
    });
  }
  if (props.rightTab === "graph") {
    tabs.push({
      id: "graph",
      label: "Knowledge graph",
      title: "Knowledge graph",
      icon: Network,
    });
  }
  if (props.rightTab === "rag") {
    tabs.push({
      id: "rag",
      label: "RAG inspector",
      title: "RAG inspector",
      icon: Search,
    });
  }

  return (
    <div
      className="flex shrink-0 items-center px-3"
      style={{ height: "var(--tabbar-h)" }}
    >
      <div role="tablist" aria-label="Workspace panes" className="segmented">
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
              className={cn("segment max-w-[14rem]")}
            >
              <tab.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
