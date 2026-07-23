import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { cn } from "@/lib/cn";
import type { FileTreeNode } from "@atelier/protocol";

export interface FileTreePanelProps {
  tree: FileTreeNode | null;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export function FileTreePanel(props: FileTreePanelProps) {
  if (!props.tree) {
    return (
      <p className="pt-8 text-center text-xs text-muted-foreground">
        Waiting for workspace…
      </p>
    );
  }
  return (
    <div className="h-full overflow-y-auto py-1 text-sm">
      {(props.tree.children ?? []).map((node) => (
        <TreeNode key={node.path} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}

interface TreeNodeProps extends FileTreePanelProps {
  node: FileTreeNode;
  depth: number;
}

function TreeNode(props: TreeNodeProps) {
  const { node, depth } = props;
  const isDir = node.type === "dir";
  const isOpen = props.expanded.has(node.path);
  const isSelected = props.selectedPath === node.path;

  return (
    <div>
      <button
        onClick={() =>
          isDir ? props.onToggleDir(node.path) : props.onOpenFile(node.path)
        }
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={cn(
          "flex w-full items-center gap-1.5 truncate py-0.5 pr-2 text-left",
          "hover:bg-accent/60",
          isSelected && "bg-accent text-accent-foreground"
        )}
      >
        {isDir ? (
          <>
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            )}
            <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          </>
        ) : (
          <FileText className="ml-[18px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && isOpen && (
        <div>
          {(node.children ?? []).map((child) => (
            <TreeNode key={child.path} {...props} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
