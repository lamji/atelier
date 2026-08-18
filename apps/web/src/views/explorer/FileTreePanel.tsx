import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { pathDirname } from "@atelier/shared";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  WorkspacePageBody,
  WorkspacePageHeader,
} from "@/components/ui/workspace-page";
import type { FileTreeNode } from "@atelier/protocol";
import type { FileExplorerViewModel } from "@/hooks/useFileExplorerViewModel";
import { useGitStore } from "@/state/git.store";
import { useWorkspaceStore } from "@/state/workspace.store";
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
/** Every row is pinned to this height so the SVG synapse overlay can compute
 * exact (x, y) node centers without measuring the DOM. */
const ROW_PX = 28;

/** x-center of a row's "neuron" dot for a given depth — matches the old
 * dashed guide's position so icons still line up on top of it. */
function connectorX(depth: number): number {
  return depth * INDENT_PX + BASE_PAD_PX + 6;
}

/** Characters no file system on our targets accepts in a name. */
const INVALID_NAME = /[\\:*?"<>|]/;

/** Per-language badge: short label + accent color, so the tree reads by
 * language at a glance instead of one generic file glyph. Keyed by
 * lowercased extension (without the dot); unmatched extensions/dotfiles
 * fall back to a generic file icon in <FileIcon>. */
const LANG_BADGE: Record<string, { label: string; color: string }> = {
  ts: { label: "TS", color: "text-sky-400 border-sky-400/40 bg-sky-400/10" },
  tsx: { label: "TSX", color: "text-sky-400 border-sky-400/40 bg-sky-400/10" },
  mts: { label: "TS", color: "text-sky-400 border-sky-400/40 bg-sky-400/10" },
  cts: { label: "TS", color: "text-sky-400 border-sky-400/40 bg-sky-400/10" },
  js: { label: "JS", color: "text-amber-400 border-amber-400/40 bg-amber-400/10" },
  jsx: { label: "JSX", color: "text-amber-400 border-amber-400/40 bg-amber-400/10" },
  mjs: { label: "JS", color: "text-amber-400 border-amber-400/40 bg-amber-400/10" },
  cjs: { label: "JS", color: "text-amber-400 border-amber-400/40 bg-amber-400/10" },
  json: { label: "{}", color: "text-amber-300 border-amber-300/40 bg-amber-300/10" },
  json5: { label: "{}", color: "text-amber-300 border-amber-300/40 bg-amber-300/10" },
  jsonc: { label: "{}", color: "text-amber-300 border-amber-300/40 bg-amber-300/10" },
  md: { label: "MD", color: "text-violet-400 border-violet-400/40 bg-violet-400/10" },
  mdx: { label: "MDX", color: "text-violet-400 border-violet-400/40 bg-violet-400/10" },
  css: { label: "CSS", color: "text-pink-400 border-pink-400/40 bg-pink-400/10" },
  scss: { label: "SC", color: "text-pink-400 border-pink-400/40 bg-pink-400/10" },
  sass: { label: "SA", color: "text-pink-400 border-pink-400/40 bg-pink-400/10" },
  less: { label: "LE", color: "text-pink-400 border-pink-400/40 bg-pink-400/10" },
  html: { label: "HTML", color: "text-orange-400 border-orange-400/40 bg-orange-400/10" },
  htm: { label: "HTML", color: "text-orange-400 border-orange-400/40 bg-orange-400/10" },
  xhtml: { label: "XHT", color: "text-orange-400 border-orange-400/40 bg-orange-400/10" },
  shtml: { label: "SHT", color: "text-orange-400 border-orange-400/40 bg-orange-400/10" },
  hbs: { label: "HBS", color: "text-rose-400 border-rose-400/40 bg-rose-400/10" },
  handlebars: { label: "HBS", color: "text-rose-400 border-rose-400/40 bg-rose-400/10" },
  ejs: { label: "EJS", color: "text-rose-400 border-rose-400/40 bg-rose-400/10" },
  twig: { label: "TWG", color: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10" },
  liquid: { label: "LQ", color: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10" },
  pug: { label: "PUG", color: "text-pink-400 border-pink-400/40 bg-pink-400/10" },
  jade: { label: "JDE", color: "text-pink-400 border-pink-400/40 bg-pink-400/10" },
  njk: { label: "NJK", color: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10" },
  nunjucks: { label: "NJK", color: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10" },
  mustache: { label: "MST", color: "text-amber-500 border-amber-500/40 bg-amber-500/10" },
  tpl: { label: "TPL", color: "text-orange-300 border-orange-300/40 bg-orange-300/10" },
  vue: { label: "VUE", color: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10" },
  svelte: { label: "SV", color: "text-orange-500 border-orange-500/40 bg-orange-500/10" },
  yml: { label: "YML", color: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10" },
  yaml: { label: "YML", color: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10" },
  toml: { label: "TML", color: "text-emerald-300 border-emerald-300/40 bg-emerald-300/10" },
  xml: { label: "XML", color: "text-orange-300 border-orange-300/40 bg-orange-300/10" },
  py: { label: "PY", color: "text-blue-400 border-blue-400/40 bg-blue-400/10" },
  rs: { label: "RS", color: "text-orange-600 border-orange-600/40 bg-orange-600/10" },
  go: { label: "GO", color: "text-cyan-400 border-cyan-400/40 bg-cyan-400/10" },
  java: { label: "JV", color: "text-red-400 border-red-400/40 bg-red-400/10" },
  kt: { label: "KT", color: "text-purple-400 border-purple-400/40 bg-purple-400/10" },
  kts: { label: "KT", color: "text-purple-400 border-purple-400/40 bg-purple-400/10" },
  swift: { label: "SW", color: "text-orange-400 border-orange-400/40 bg-orange-400/10" },
  dart: { label: "DT", color: "text-sky-300 border-sky-300/40 bg-sky-300/10" },
  c: { label: "C", color: "text-blue-300 border-blue-300/40 bg-blue-300/10" },
  h: { label: "H", color: "text-blue-300 border-blue-300/40 bg-blue-300/10" },
  cpp: { label: "C+", color: "text-blue-500 border-blue-500/40 bg-blue-500/10" },
  cc: { label: "C+", color: "text-blue-500 border-blue-500/40 bg-blue-500/10" },
  hpp: { label: "C+", color: "text-blue-500 border-blue-500/40 bg-blue-500/10" },
  cs: { label: "C#", color: "text-violet-500 border-violet-500/40 bg-violet-500/10" },
  php: { label: "PHP", color: "text-indigo-400 border-indigo-400/40 bg-indigo-400/10" },
  rb: { label: "RB", color: "text-rose-500 border-rose-500/40 bg-rose-500/10" },
  lua: { label: "LU", color: "text-blue-400 border-blue-400/40 bg-blue-400/10" },
  sh: { label: "SH", color: "text-lime-400 border-lime-400/40 bg-lime-400/10" },
  bash: { label: "SH", color: "text-lime-400 border-lime-400/40 bg-lime-400/10" },
  zsh: { label: "SH", color: "text-lime-400 border-lime-400/40 bg-lime-400/10" },
  ps1: { label: "PS", color: "text-blue-400 border-blue-400/40 bg-blue-400/10" },
  sql: { label: "SQL", color: "text-cyan-300 border-cyan-300/40 bg-cyan-300/10" },
  graphql: { label: "GQL", color: "text-pink-500 border-pink-500/40 bg-pink-500/10" },
  gql: { label: "GQL", color: "text-pink-500 border-pink-500/40 bg-pink-500/10" },
  proto: { label: "PB", color: "text-sky-500 border-sky-500/40 bg-sky-500/10" },
  dockerfile: { label: "DK", color: "text-sky-400 border-sky-400/40 bg-sky-400/10" },
  env: { label: "ENV", color: "text-yellow-400 border-yellow-400/40 bg-yellow-400/10" },
  txt: { label: "TXT", color: "text-muted-foreground border-border bg-muted/40" },
  csv: { label: "CSV", color: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10" },
  lock: { label: "LK", color: "text-muted-foreground border-border bg-muted/40" },
  png: { label: "IMG", color: "text-fuchsia-400 border-fuchsia-400/40 bg-fuchsia-400/10" },
  jpg: { label: "IMG", color: "text-fuchsia-400 border-fuchsia-400/40 bg-fuchsia-400/10" },
  jpeg: { label: "IMG", color: "text-fuchsia-400 border-fuchsia-400/40 bg-fuchsia-400/10" },
  gif: { label: "IMG", color: "text-fuchsia-400 border-fuchsia-400/40 bg-fuchsia-400/10" },
  webp: { label: "IMG", color: "text-fuchsia-400 border-fuchsia-400/40 bg-fuchsia-400/10" },
  svg: { label: "SVG", color: "text-fuchsia-400 border-fuchsia-400/40 bg-fuchsia-400/10" },
  ico: { label: "IMG", color: "text-fuchsia-400 border-fuchsia-400/40 bg-fuchsia-400/10" },
};

/** Filenames matched without an extension (dotfiles, well-known configs). */
const NAME_BADGE: Record<string, { label: string; color: string }> = {
  dockerfile: { label: "DK", color: "text-sky-400 border-sky-400/40 bg-sky-400/10" },
  makefile: { label: "MK", color: "text-muted-foreground border-border bg-muted/40" },
  ".gitignore": { label: "GIT", color: "text-orange-400 border-orange-400/40 bg-orange-400/10" },
  ".env": { label: "ENV", color: "text-yellow-400 border-yellow-400/40 bg-yellow-400/10" },
};

function langBadge(name: string): { label: string; color: string } | null {
  const lower = name.toLowerCase();
  if (NAME_BADGE[lower]) return NAME_BADGE[lower];
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return LANG_BADGE[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Per-language file icon: a small colored badge with the language's
 * abbreviation, falling back to a generic file glyph when unrecognized. */
function FileIcon({ name, className }: { name: string; className?: string }) {
  const badge = langBadge(name);
  if (!badge) {
    return <FileText className={cn(className, "text-muted-foreground")} />;
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[3px] border font-bold leading-none",
        "text-[6px] tracking-tighter",
        badge.color,
        className
      )}
    >
      {badge.label}
    </span>
  );
}

/** Same cycle as raw color for the SVG synapse overlay (Tailwind classes
 * don't apply to stroke/fill attributes). */
const DEPTH_HEX = ["#38bdf8", "#a78bfa", "#fbbf24", "#f472b6", "#34d399"];

function depthHex(depth: number): string {
  return DEPTH_HEX[depth % DEPTH_HEX.length]!;
}

interface RowGitStatus {
  char: string;
  color: string;
  conflict: boolean;
}

/** git status letter code -> color, mirroring GitPanel's own mapping. */
function statusColor(char: string): string {
  if (char === "U" || char === "!") return "text-destructive";
  if (char === "A" || char === "?") return "text-success";
  if (char === "D") return "text-destructive";
  if (char === "R") return "text-cyan";
  return "text-warning";
}

/** Per-file status plus, for every ancestor folder, whether it contains a
 * changed or conflicted descendant — the VS Code-style "dirty folder" cue. */
function useGitStatusMaps(): {
  fileStatus: Map<string, RowGitStatus>;
  dirtyDirs: Map<string, boolean>;
} {
  const files = useGitStore((s) => s.status?.files);
  const conflicts = useGitStore((s) => s.status?.conflicts);
  return useMemo(() => {
    const fileStatus = new Map<string, RowGitStatus>();
    const dirtyDirs = new Map<string, boolean>();
    // Every unmerged shape (UU, AA, DD, AU, …) — git's own list, not a
    // guess from the status letters, so the tree agrees with the panel.
    const conflictSet = new Set(conflicts ?? []);
    for (const f of files ?? []) {
      const conflict = conflictSet.has(f.path);
      const char = conflict ? "!" : f.workingDir || f.index || "?";
      fileStatus.set(f.path, { char, color: statusColor(char), conflict });

      let dir = pathDirname(f.path);
      while (dir) {
        const existingConflict = dirtyDirs.get(dir) ?? false;
        dirtyDirs.set(dir, existingConflict || conflict);
        dir = pathDirname(dir);
      }
    }
    return { fileStatus, dirtyDirs };
  }, [files, conflicts]);
}

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

/** Every file in the tree, regardless of expand state — what the search
 * box matches against, since a collapsed folder shouldn't hide results. */
function flattenAllFiles(nodes: FileTreeNode[], out: FileTreeNode[]): void {
  for (const node of nodes) {
    if (node.type === "dir") flattenAllFiles(node.children ?? [], out);
    else out.push(node);
  }
}

/**
 * Draws the tree as a branching timeline: one straight spine per sibling
 * group (a run of nodes sharing the same parent) with a single rounded
 * elbow dropping in from the parent, instead of a separate curve per row.
 * Rows are pinned to ROW_PX so every coordinate is computed, never measured.
 */
function TimelineLinks({ rows }: { rows: Row[] }) {
  const { spines, elbows } = useMemo(() => {
    type Spine = { key: string; x: number; y1: number; y2: number; color: string };
    type Elbow = { key: string; parentX: number; parentY: number; childX: number; childY: number; color: string };
    const spinesOut: Spine[] = [];
    const elbowsOut: Elbow[] = [];
    const lastIndexAtDepth = new Map<number, number>();
    let openGroup:
      | { depth: number; parentIndex: number; firstY: number; lastY: number }
      | undefined;

    const flushGroup = () => {
      if (!openGroup) return;
      const { depth, firstY, lastY } = openGroup;
      if (lastY > firstY) {
        spinesOut.push({
          key: `spine:${depth}:${firstY}`,
          x: connectorX(depth),
          y1: firstY,
          y2: lastY,
          color: depthHex(depth),
        });
      }
      openGroup = undefined;
    };

    rows.forEach((row, i) => {
      const { depth } = row;
      const parentIndex = lastIndexAtDepth.get(depth - 1);
      const y = i * ROW_PX + ROW_PX / 2;

      if (depth > 0 && parentIndex !== undefined) {
        if (!openGroup || openGroup.depth !== depth || openGroup.parentIndex !== parentIndex) {
          flushGroup();
          openGroup = { depth, parentIndex, firstY: y, lastY: y };
          elbowsOut.push({
            key: `elbow:${i}`,
            parentX: connectorX(depth - 1),
            parentY: parentIndex * ROW_PX + ROW_PX / 2,
            childX: connectorX(depth),
            childY: y,
            color: depthHex(depth),
          });
        } else {
          openGroup.lastY = y;
        }
      } else {
        flushGroup();
      }

      lastIndexAtDepth.set(depth, i);
      for (const d of lastIndexAtDepth.keys()) {
        if (d > depth) lastIndexAtDepth.delete(d);
      }
    });
    flushGroup();

    return { spines: spinesOut, elbows: elbowsOut };
  }, [rows]);

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-visible"
      width="100%"
      height={rows.length * ROW_PX}
    >
      {spines.map((s) => (
        <line
          key={s.key}
          x1={s.x}
          y1={s.y1}
          x2={s.x}
          y2={s.y2}
          stroke={s.color}
          strokeWidth={1.5}
          strokeOpacity={0.35}
          strokeLinecap="round"
        />
      ))}
      {elbows.map((e) => {
        const r = Math.min(4, Math.abs(e.childY - e.parentY) / 2 || 1);
        const midY = e.childY - r;
        return (
          <path
            key={e.key}
            d={`M ${e.parentX} ${e.parentY} V ${midY} Q ${e.parentX} ${e.childY}, ${e.parentX + r} ${e.childY} H ${e.childX}`}
            fill="none"
            stroke={e.color}
            strokeWidth={1.5}
            strokeOpacity={0.45}
            strokeLinecap="round"
          />
        );
      })}
      {rows.map((row, i) => (
        <circle
          key={`node:${i}`}
          cx={connectorX(row.depth)}
          cy={i * ROW_PX + ROW_PX / 2}
          r={row.depth === 0 ? 2.75 : 2}
          fill={depthHex(row.depth)}
          fillOpacity={0.75}
        />
      ))}
    </svg>
  );
}

/**
 * File explorer with color-coded rows and depth guides: right-click menu,
 * inline create and rename, cut/copy/paste, duplicate, drag-to-move, and
 * keyboard navigation.
 */
export function FileTreePanel({ vm }: FileTreePanelProps) {
  const [menu, setMenu] = useState<
    { x: number; y: number; node: FileTreeNode | null } | null
  >(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const dragged = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { fileStatus, dirtyDirs } = useGitStatusMaps();
  // The same query is mirrored into the workspace store so the Monaco
  // editor (which lives in a different view tree) can paint matching
  // highlights inside the open file. Keeping the local `query` for the
  // filter list avoids a re-read of the tree on every keystroke.
  const setSearchQuery = useWorkspaceStore((s) => s.setSearchQuery);
  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      setSearchQuery(value);
    },
    [setSearchQuery]
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (vm.tree) flatten(vm.tree.children ?? [], vm.expanded, 0, out);
    if (vm.draft) insertDraftRow(out, vm.draft.parent);
    return out;
  }, [vm.tree, vm.expanded, vm.draft]);

  const allFiles = useMemo(() => {
    const out: FileTreeNode[] = [];
    if (vm.tree) flattenAllFiles(vm.tree.children ?? [], out);
    return out;
  }, [vm.tree]);

  const trimmedQuery = query.trim();
  const searchResults = useMemo(() => {
    if (!trimmedQuery) return [];
    const needle = trimmedQuery.toLowerCase();
    return allFiles
      .filter((node) => node.path.toLowerCase().includes(needle))
      .sort((a, b) => {
        const aName = a.name.toLowerCase().indexOf(needle);
        const bName = b.name.toLowerCase().indexOf(needle);
        if (aName !== bName) return (aName < 0 ? Infinity : aName) - (bName < 0 ? Infinity : bName);
        return a.path.length - b.path.length;
      })
      .slice(0, 200);
  }, [allFiles, trimmedQuery]);

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
        <ExplorerHeader vm={vm} query={query} onQueryChange={onQueryChange} totalFiles={0} />
        <WorkspacePageBody
          className={cn(
            "flex min-h-0 flex-1 items-center justify-center px-3 pb-3"
          )}
        >
          <p className="text-sm text-muted-foreground">Waiting for workspace…</p>
        </WorkspacePageBody>
      </div>
    );
  }

  const searching = trimmedQuery.length > 0;

  return (
    <div className="flex h-full flex-col">
      <ExplorerHeader vm={vm} query={query} onQueryChange={onQueryChange} totalFiles={allFiles.length} />
      <WorkspacePageBody
        className={cn(
          "flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3"
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] p-2 shadow-sm",
            "border border-border/50 bg-gradient-to-b from-muted/50 to-muted/20"
          )}
        >
          {vm.error && (
            <div
              className={cn(
                "mb-2 flex items-start gap-1.5 rounded-xl bg-destructive/10",
                "px-3 py-2 text-xs text-destructive"
              )}
            >
              <span className="min-w-0 flex-1 break-words">{vm.error}</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={vm.clearError}
                title="Dismiss"
                className="!h-5 !w-5"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}

          {searching ? (
            <SearchResults
              query={trimmedQuery}
              results={searchResults}
              selectedPath={vm.selectedPath}
              onOpen={(node) => {
                setFocused(node.path);
                void vm.openFile(node.path);
              }}
            />
          ) : (
          <div
            ref={listRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => openMenu(event, null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDropOn(event, null)}
            className="min-h-0 flex-1 overflow-y-auto py-1 text-sm outline-none"
          >
            <div className="relative" style={{ minHeight: rows.length * ROW_PX }}>
              <TimelineLinks rows={rows} />
              <div className="relative z-10">
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
                  gitStatus={
                    row.node.type === "dir"
                      ? dirtyDirs.has(row.node.path)
                        ? {
                            char: "",
                            color: "",
                            conflict: dirtyDirs.get(row.node.path)!,
                          }
                        : undefined
                      : fileStatus.get(row.node.path)
                  }
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
            </div>
          </div>
          )}
        </div>
      </WorkspacePageBody>

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

/** git status letter -> its own stat-pill label, for the header strip. */
function statKind(char: string): "added" | "modified" | "deleted" | "other" {
  if (char === "A" || char === "?") return "added";
  if (char === "D") return "deleted";
  if (char === "U") return "other";
  return "modified";
}

function useChangeStats(): {
  added: number;
  modified: number;
  deleted: number;
  conflicts: number;
  total: number;
} {
  const files = useGitStore((s) => s.status?.files);
  const conflictPaths = useGitStore((s) => s.status?.conflicts);
  return useMemo(() => {
    let added = 0;
    let modified = 0;
    let deleted = 0;
    const conflictSet = new Set(conflictPaths ?? []);
    for (const f of files ?? []) {
      if (conflictSet.has(f.path)) continue;
      const char = f.workingDir || f.index || "?";
      const kind = statKind(char);
      if (kind === "added") added++;
      else if (kind === "deleted") deleted++;
      else modified++;
    }
    const conflicts = conflictSet.size;
    return {
      added,
      modified,
      deleted,
      conflicts,
      total: added + modified + deleted + conflicts,
    };
  }, [files, conflictPaths]);
}

function ExplorerHeader({
  vm,
  query,
  onQueryChange,
  totalFiles,
}: {
  vm: FileExplorerViewModel;
  query: string;
  onQueryChange: (value: string) => void;
  totalFiles: number;
}) {
  const stats = useChangeStats();

  return (
    <div className="shrink-0">
      <WorkspacePageHeader
        icon={Folder}
        title="Files"
        actions={
          <>
            <HeaderButton title="Refresh Explorer" onClick={vm.refresh}>
              <RefreshCw className="h-3.5 w-3.5" />
            </HeaderButton>
            <HeaderButton title="Collapse Folders" onClick={vm.collapseAll}>
              <ChevronDown className="h-3.5 w-3.5" />
            </HeaderButton>
          </>
        }
      />
      <div className="px-6 pb-3">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-medium text-foreground/70">
              <span className="font-bold">{totalFiles}</span> files
            </span>
            {stats.conflicts > 0 && (
              <button
                onClick={() => useWorkspaceStore.getState().setActivityView("git")}
                title="Open the merge conflicts in Changes"
                className="conflict-badge inline-flex items-center gap-1 rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 font-medium text-destructive hover:bg-destructive/20"
              >
                <span className="font-bold">{stats.conflicts}</span>
                {stats.conflicts === 1 ? "conflict" : "conflicts"}
                <span className="opacity-70">· resolve →</span>
              </button>
            )}
            {stats.total > 0 && (
              <>
                <div
                  className="flex h-1.5 w-24 overflow-hidden rounded-full bg-muted/40"
                  title={`${stats.added} added, ${stats.modified} modified, ${stats.deleted} deleted, ${stats.conflicts} conflicted`}
                >
                  {stats.conflicts > 0 && (
                    <span
                      className="h-full bg-destructive"
                      style={{ width: `${(stats.conflicts / stats.total) * 100}%` }}
                    />
                  )}
                  {stats.added > 0 && (
                    <span
                      className="h-full bg-success"
                      style={{ width: `${(stats.added / stats.total) * 100}%` }}
                    />
                  )}
                  {stats.modified > 0 && (
                    <span
                      className="h-full bg-warning"
                      style={{ width: `${(stats.modified / stats.total) * 100}%` }}
                    />
                  )}
                  {stats.deleted > 0 && (
                    <span
                      className="h-full bg-destructive"
                      style={{ width: `${(stats.deleted / stats.total) * 100}%` }}
                    />
                  )}
                </div>
                <StatPill label="changed" value={stats.total} color="text-foreground/70 border-border/60 bg-muted/40" />
                {stats.added > 0 && (
                  <StatPill label="added" value={stats.added} color="text-success border-success/40 bg-success/10" />
                )}
                {stats.modified > 0 && (
                  <StatPill label="modified" value={stats.modified} color="text-warning border-warning/40 bg-warning/10" />
                )}
                {stats.deleted > 0 && (
                  <StatPill label="deleted" value={stats.deleted} color="text-destructive border-destructive/40 bg-destructive/10" />
                )}
              </>
            )}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search files by name or path…"
              spellCheck={false}
              className={cn(
                "w-full rounded-full border border-border/60 bg-input/60 py-1.5 pl-8 pr-8",
                "text-xs outline-none transition-colors focus:border-primary/50"
              )}
            />
            {query && (
              <button
                type="button"
                onClick={() => onQueryChange("")}
                title="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium",
        color
      )}
    >
      <span className="font-bold">{value}</span>
      {label}
    </span>
  );
}

/** Flat, VS Code-like results list shown while `query` is non-empty, with
 * the matched substring highlighted in each file's name. */
function SearchResults({
  query,
  results,
  selectedPath,
  onOpen,
}: {
  query: string;
  results: FileTreeNode[];
  selectedPath: string | null;
  onOpen: (node: FileTreeNode) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <p className="text-sm text-muted-foreground">No files match "{query}"</p>
      </div>
    );
  }

  const needle = query.toLowerCase();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1 text-sm">
      {results.map((node) => {
        const lower = node.name.toLowerCase();
        const at = lower.indexOf(needle);
        const dir = pathDirname(node.path);
        return (
          <div
            key={node.path}
            role="button"
            onClick={() => onOpen(node)}
            className={cn(
              "flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-1.5",
              "text-left transition-colors hover:bg-accent/50",
              selectedPath === node.path && "bg-primary/10"
            )}
          >
            <FileIcon name={node.name} className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {at < 0 ? (
                node.name
              ) : (
                <>
                  {node.name.slice(0, at)}
                  <mark className="rounded-sm bg-primary/25 text-foreground">
                    {node.name.slice(at, at + needle.length)}
                  </mark>
                  {node.name.slice(at + needle.length)}
                </>
              )}
              {dir && (
                <span className="ml-2 truncate text-[11px] text-muted-foreground">{dir}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function HeaderButton(props: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      title={props.title}
      onClick={props.onClick}
      className={cn(
        "!h-8 !w-8 rounded-full transition-transform",
        "hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/10 hover:text-primary"
      )}
    >
      {props.children}
    </Button>
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
  /** Present when this row (or, for a folder, a descendant) has uncommitted
   * changes; `conflict` marks an unresolved merge conflict in red. */
  gitStatus?: RowGitStatus;
  onActivate: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
}

function TreeRow(props: TreeRowProps) {
  const { node, isOpen, depth, gitStatus } = props;
  const isDir = node.type === "dir";
  const FolderIcon = isOpen ? FolderOpen : Folder;
  const isDirty = !!gitStatus;
  const isConflict = !!gitStatus?.conflict;

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
      style={{ paddingLeft: `${depth * INDENT_PX + BASE_PAD_PX}px`, height: `${ROW_PX}px` }}
      className={cn(
        "group relative flex w-full cursor-pointer select-none items-center gap-1.5",
        "truncate rounded-lg pr-2 text-left transition-all",
        "hover:translate-x-0.5 hover:bg-accent/50",
        props.isSelected &&
          "bg-gradient-to-r from-primary/20 to-transparent text-accent-foreground shadow-[inset_2px_0_0_0] shadow-primary",
        props.isFocused && !props.isSelected && "bg-accent/30",
        props.isDropTarget && "ring-2 ring-inset ring-primary/60",
        props.isCut && "opacity-50"
      )}
    >
      {isDir ? (
        <>
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <FolderIcon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              isConflict ? "text-destructive" : isOpen ? "text-primary" : "text-primary/70"
            )}
          />
        </>
      ) : (
        <FileIcon name={node.name} className="ml-[18px] h-3.5 w-3.5 shrink-0" />
      )}
      <span
        className={cn(
          "truncate",
          isDirty && (isConflict ? "text-destructive" : "text-warning")
        )}
      >
        {node.name}
      </span>
      {!isDir && gitStatus?.char && (
        isConflict ? (
          <span
            title="Merge conflict — click to resolve"
            className="conflict-badge ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-[10px] font-bold text-destructive"
          >
            !
          </span>
        ) : (
          <span
            className={cn(
              "ml-auto shrink-0 pl-1 text-[10px] font-semibold",
              gitStatus.color
            )}
          >
            {gitStatus.char}
          </span>
        )
      )}
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
          <FileIcon name={value || "x.txt"} className="ml-[18px] h-3.5 w-3.5 shrink-0" />
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
            "min-w-0 flex-1 rounded-full border bg-input/60 px-2 py-0.5",
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
