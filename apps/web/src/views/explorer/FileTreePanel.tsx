import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  X,
} from "lucide-react";
import { pathDirname } from "@atelier/shared";
import { cn } from "@/lib/cn";
import type { FileTreeNode } from "@atelier/protocol";
import type { FileExplorerViewModel } from "@/hooks/useFileExplorerViewModel";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { TreeContextMenu, type MenuItem } from "./TreeContextMenu";

export interface FileTreePanelProps {
  vm: FileExplorerViewModel;
}

/** One rendered line: either a real entry or the pending new-name input. */
type Row =
  | { kind: "node"; depth: number; node: FileTreeNode }
  | { kind: "draft"; depth: number };

const INDENT_PX = 12;
const BASE_PAD_PX = 8;

/** Characters no file system on our targets accepts in a name. */
const INVALID_NAME = /[\\:*?"<>|]/;

function validateName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null; // an empty input is a cancel, not an error
  if (INVALID_NAME.test(name)) return 'A name cannot contain \\ : * ? " < > |';
  if (name === "." || name === "..") return "That name is reserved";
  return null;
}

/** Visible rows, in display order, honouring the expanded set. */
function flatten(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  depth: number,
  out: Row[]
): void {
  for (const node of nodes) {
    out.push({ kind: "node", depth, node });
    if (node.type === "dir" && expanded.has(node.path)) {
      flatten(node.children ?? [], expanded, depth + 1, out);
    }
  }
}

/**
 * VS Code-style file explorer: right-click menu, inline create and rename,
 * cut/copy/paste, duplicate, drag-to-move, and keyboard navigation.
 */
export function FileTreePanel({ vm }: FileTreePanelProps) {
  const [menu, setMenu] = useState<
    { x: number; y: number; node: FileTreeNode | null } | null
  >(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (vm.tree) flatten(vm.tree.children ?? [], vm.expanded, 0, out);
    if (vm.draft) insertDraftRow(out, vm.draft.parent);
    return out;
  }, [vm.tree, vm.expanded, vm.draft]);

  // Opening a file elsewhere (search, git panel) should move the tree cursor
  // with it, so the next keystroke acts on what the user is looking at.
  useEffect(() => {
    if (vm.selectedPath) setFocused(vm.selectedPath);
  }, [vm.selectedPath]);

  const nodeAt = useCallback(
    (path: string | null): FileTreeNode | null => {
      if (!path) return null;
      for (const row of rows) {
        if (row.kind === "node" && row.node.path === path) return row.node;
      }
      return null;
    },
    [rows]
  );

  /** Where a "New File" or paste aimed at `node` should land. */
  const targetDir = useCallback((node: FileTreeNode | null): string => {
    if (!node) return "";
    return node.type === "dir" ? node.path : pathDirname(node.path);
  }, []);

  const activate = useCallback(
    (node: FileTreeNode) => {
      setFocused(node.path);
      if (node.type === "dir") vm.toggleDir(node.path);
      else void vm.openFile(node.path);
    },
    [vm]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // The inline name input owns its own keys (Enter/Escape/typing).
      if ((event.target as HTMLElement).tagName === "INPUT") return;

      const visible = rows.filter((r) => r.kind === "node") as Array<
        Extract<Row, { kind: "node" }>
      >;
      const index = visible.findIndex((r) => r.node.path === focused);
      const node = index >= 0 ? visible[index]!.node : null;
      const step = (delta: number) => {
        const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))];
        if (next) setFocused(next.node.path);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (index < 0) setFocused(visible[0]?.node.path ?? null);
          else step(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          step(-1);
          return;
        case "ArrowRight":
          event.preventDefault();
          if (node?.type === "dir" && !vm.expanded.has(node.path)) {
            vm.toggleDir(node.path);
          } else step(1);
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (node?.type === "dir" && vm.expanded.has(node.path)) {
            vm.toggleDir(node.path);
          } else if (node) {
            const parent = pathDirname(node.path);
            if (parent) setFocused(parent);
          }
          return;
        case "Enter":
          if (node) {
            event.preventDefault();
            activate(node);
          }
          return;
        case "F2":
          if (node) {
            event.preventDefault();
            vm.startRename(node.path);
          }
          return;
        case "Delete":
          if (node) {
            event.preventDefault();
            vm.requestDelete(node.path);
          }
          return;
        case "Escape":
          vm.cancelDraft();
          vm.cancelRename();
          return;
      }

      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      // Ctrl+D is the browser's bookmark dialog until we claim it.
      if ("cxvd".includes(key)) event.preventDefault();
      if (key === "c" && node) vm.copy(node.path);
      else if (key === "x" && node) vm.cut(node.path);
      else if (key === "v") void vm.paste(targetDir(node));
      else if (key === "d" && node) void vm.duplicate(node.path);
    },
    [activate, focused, rows, targetDir, vm]
  );

  const menuItems = useCallback(
    (node: FileTreeNode | null): MenuItem[] => {
      const dir = targetDir(node);
      const items: MenuItem[] = [
        { label: "New File…", onSelect: () => vm.startCreate(dir, "file") },
        { label: "New Folder…", onSelect: () => vm.startCreate(dir, "dir") },
      ];
      if (!node) {
        items.push(
          {},
          {
            label: "Paste",
            disabled: !vm.clipboard,
            onSelect: () => void vm.paste(""),
          },
          {},
          { label: "Refresh Explorer", onSelect: vm.refresh }
        );
        return items;
      }
      items.push(
        {},
        { label: "Cut", hint: "Ctrl+X", onSelect: () => vm.cut(node.path) },
        { label: "Copy", hint: "Ctrl+C", onSelect: () => vm.copy(node.path) },
        {
          label: "Paste",
          hint: "Ctrl+V",
          disabled: !vm.clipboard,
          onSelect: () => void vm.paste(dir),
        },
        {},
        {
          label: "Copy Path",
          onSelect: () => vm.copyToOsClipboard(vm.absolutePath(node.path)),
        },
        {
          label: "Copy Relative Path",
          onSelect: () => vm.copyToOsClipboard(node.path),
        },
        {},
        {
          label: "Duplicate",
          hint: "Ctrl+D",
          onSelect: () => void vm.duplicate(node.path),
        },
        {
          label: "Rename…",
          hint: "F2",
          onSelect: () => vm.startRename(node.path),
        },
        {
          label: "Delete",
          hint: "Del",
          danger: true,
          onSelect: () => vm.requestDelete(node.path),
        }
      );
      return items;
    },
    [targetDir, vm]
  );

  const openMenu = useCallback(
    (event: React.MouseEvent, node: FileTreeNode | null) => {
      event.preventDefault();
      event.stopPropagation();
      if (node) setFocused(node.path);
      setMenu({ x: event.clientX, y: event.clientY, node });
    },
    []
  );

  const onDropOn = useCallback(
    (event: React.DragEvent, node: FileTreeNode | null) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      const from = dragged.current ?? event.dataTransfer.getData("text/plain");
      dragged.current = null;
      if (!from) return;
      const dir = targetDir(node);
      // Dropping something back where it already lives is a no-op, and a
      // folder dropped on itself or its own child must not move at all.
      if (dir === pathDirname(from) || dir === from) return;
      if (dir.startsWith(`${from}/`)) return;
      void vm.move(from, dir);
    },
    [targetDir, vm]
  );

  if (!vm.tree) {
    return (
      <div className="flex h-full flex-col">
        <ExplorerHeader vm={vm} />
        <p className="pt-8 text-center text-xs text-muted-foreground">
          Waiting for workspace…
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ExplorerHeader vm={vm} />

      {vm.error && (
        <div
          className={cn(
            "mx-2 mb-1 flex items-start gap-1.5 rounded-lg bg-destructive/10",
            "px-2 py-1.5 text-[11px] text-destructive"
          )}
        >
          <span className="min-w-0 flex-1 break-words">{vm.error}</span>
          <button onClick={vm.clearError} title="Dismiss">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => openMenu(event, null)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDropOn(event, null)}
        className="min-h-0 flex-1 overflow-y-auto py-1 text-sm outline-none"
      >
        {rows.map((row) =>
          row.kind === "draft" ? (
            <NameInput
              key="draft"
              depth={row.depth}
              isDir={vm.draft?.type === "dir"}
              initial=""
              onCommit={(name) => void vm.commitDraft(name)}
              onCancel={vm.cancelDraft}
            />
          ) : vm.renaming === row.node.path ? (
            <NameInput
              key={`rename:${row.node.path}`}
              depth={row.depth}
              isDir={row.node.type === "dir"}
              initial={row.node.name}
              selectStem
              onCommit={(name) => void vm.commitRename(name)}
              onCancel={vm.cancelRename}
            />
          ) : (
            <TreeRow
              key={row.node.path}
              node={row.node}
              depth={row.depth}
              isOpen={vm.expanded.has(row.node.path)}
              isSelected={vm.selectedPath === row.node.path}
              isFocused={focused === row.node.path}
              isCut={vm.clipboard?.mode === "cut" && vm.clipboard.path === row.node.path}
              isDropTarget={dropTarget === row.node.path}
              onActivate={() => activate(row.node)}
              onContextMenu={(event) => openMenu(event, row.node)}
              onDragStart={(event) => {
                dragged.current = row.node.path;
                event.dataTransfer.setData("text/plain", row.node.path);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDropTarget(targetDir(row.node) || null);
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => onDropOn(event, row.node)}
            />
          )
        )}
      </div>

      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}

      <DeleteConfirmModal
        path={vm.pendingDelete}
        isDir={nodeAt(vm.pendingDelete)?.type === "dir"}
        onConfirm={() => void vm.confirmDelete()}
        onCancel={vm.cancelDelete}
      />
    </div>
  );
}

/**
 * Puts the pending new-name row where the created entry will appear: first
 * child of its folder, or top of the list at the workspace root.
 */
function insertDraftRow(rows: Row[], parent: string): void {
  if (!parent) {
    rows.unshift({ kind: "draft", depth: 0 });
    return;
  }
  const at = rows.findIndex((r) => r.kind === "node" && r.node.path === parent);
  if (at === -1) {
    rows.unshift({ kind: "draft", depth: 0 });
    return;
  }
  rows.splice(at + 1, 0, { kind: "draft", depth: rows[at]!.depth + 1 });
}

function ExplorerHeader({ vm }: { vm: FileExplorerViewModel }) {
  return (
    <div className="island-header justify-between">
      <div className="flex items-center gap-1.5">
        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="island-title">Explorer</span>
      </div>
      <div className="flex items-center gap-0.5">
        <HeaderButton
          title="New File"
          onClick={() => vm.startCreate("", "file")}
        >
          <FilePlus2 className="h-3.5 w-3.5" />
        </HeaderButton>
        <HeaderButton
          title="New Folder"
          onClick={() => vm.startCreate("", "dir")}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </HeaderButton>
        <HeaderButton title="Refresh Explorer" onClick={vm.refresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </HeaderButton>
        <HeaderButton title="Collapse Folders" onClick={vm.collapseAll}>
          <ChevronDown className="h-3.5 w-3.5" />
        </HeaderButton>
      </div>
    </div>
  );
}

function HeaderButton(props: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      className={cn(
        "rounded-md p-1 text-muted-foreground",
        "hover:bg-accent/60 hover:text-foreground"
      )}
    >
      {props.children}
    </button>
  );
}

interface TreeRowProps {
  node: FileTreeNode;
  depth: number;
  isOpen: boolean;
  isSelected: boolean;
  isFocused: boolean;
  isCut: boolean;
  isDropTarget: boolean;
  onActivate: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
}

function TreeRow(props: TreeRowProps) {
  const { node, isOpen } = props;
  const isDir = node.type === "dir";
  const FolderIcon = isOpen ? FolderOpen : Folder;

  return (
    <div
      role="treeitem"
      draggable
      onClick={props.onActivate}
      onContextMenu={props.onContextMenu}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      style={{ paddingLeft: `${props.depth * INDENT_PX + BASE_PAD_PX}px` }}
      className={cn(
        "flex w-full cursor-pointer select-none items-center gap-1.5 truncate",
        "py-0.5 pr-2 text-left hover:bg-accent/60",
        props.isSelected && "bg-accent text-accent-foreground",
        props.isFocused && !props.isSelected && "bg-accent/40",
        props.isDropTarget && "ring-1 ring-inset ring-primary/60",
        props.isCut && "opacity-50"
      )}
    >
      {isDir ? (
        <>
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        </>
      ) : (
        <FileText className="ml-[18px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{node.name}</span>
    </div>
  );
}

interface NameInputProps {
  depth: number;
  isDir?: boolean;
  initial: string;
  /** Preselect the name without its extension, the way VS Code renames. */
  selectStem?: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/** The inline row that names a new entry or renames an existing one. */
function NameInput(props: NameInputProps) {
  const [value, setValue] = useState(props.initial);
  const problem = validateName(value);
  const committed = useRef(false);

  const inputRef = useCallback(
    (input: HTMLInputElement | null) => {
      if (!input) return;
      input.focus();
      const dot = props.initial.lastIndexOf(".");
      if (props.selectStem && dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    },
    [props.initial, props.selectStem]
  );

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    if (problem || !value.trim()) props.onCancel();
    else props.onCommit(value);
  };

  const cancel = () => {
    if (committed.current) return;
    committed.current = true;
    props.onCancel();
  };

  return (
    <div
      style={{ paddingLeft: `${props.depth * INDENT_PX + BASE_PAD_PX}px` }}
      className="py-0.5 pr-2"
    >
      <div className="flex items-center gap-1.5">
        {props.isDir ? (
          <Folder className="ml-[18px] h-3.5 w-3.5 shrink-0 text-primary/70" />
        ) : (
          <FileText className="ml-[18px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") commit();
            if (event.key === "Escape") cancel();
          }}
          className={cn(
            "min-w-0 flex-1 rounded-sm border bg-input/60 px-1 py-0",
            "text-xs outline-none",
            problem ? "border-destructive" : "border-primary/60"
          )}
        />
      </div>
      {problem && (
        <p className="ml-[26px] pt-0.5 text-[10px] text-destructive">{problem}</p>
      )}
    </div>
  );
}
