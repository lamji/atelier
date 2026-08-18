import { useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Box, Loader2, Network, Sparkles, Square } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { layoutGraph } from "@/lib/graph-layout";
import { Graph3D } from "./Graph3D";
import type { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";
import type { GraphScope } from "@/state/knowledge.store";

export interface GraphPaneProps {
  vm: ReturnType<typeof useKnowledgeViewModel>;
  theme: "dark" | "light";
  /** False while another dock pane is in front; parks the 3D render loop. */
  active?: boolean;
}

const SCOPES: Array<{ id: GraphScope; label: string; needsTarget: boolean }> = [
  { id: "workspace", label: "Workspace", needsTarget: false },
  { id: "file", label: "File", needsTarget: true },
  { id: "symbol", label: "Symbol", needsTarget: true },
];

const KIND_COLORS: Record<string, string> = {
  file: "#6366f1",
  feature: "#f59e0b",
  lesson: "#f59e0b",
  class: "#ec4899",
  interface: "#ec4899",
  function: "#10b981",
  method: "#10b981",
  hook: "#8b5cf6",
  component: "#0ea5e9",
};

/** Container node for a file: header label, symbols render inside. */
function FileGroupNode({ data }: NodeProps) {
  const label = String((data as { label?: unknown }).label ?? "");
  const basename = label.split("/").pop() ?? label;
  const dir = label.slice(0, label.length - basename.length);
  return (
    <Tooltip content={label}>
      <div className="px-2.5 pt-1.5 font-mono text-[10px]">
        <span className="opacity-50">{dir}</span>
        <span className="font-semibold">{basename}</span>
      </div>
    </Tooltip>
  );
}

const NODE_TYPES = { fileGroup: FileGroupNode };

/**
 * Knowledge graph pane. Workspace scope = file-level import map; file and
 * symbol scopes go symbol-level: files are boxes, their functions sit
 * inside, and edges connect the actual functions across files. Click a
 * file box to drill into it; click a symbol to see its callers/callees.
 */
export function GraphPane({ vm, theme, active = true }: GraphPaneProps) {
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"3d" | "2d">("3d");
  const activeScope = vm.graphScope;

  const { nodes, edges } = useMemo(() => {
    if (!vm.graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const positioned = layoutGraph(vm.graph);
    // React Flow requires parent containers to appear before children.
    positioned.sort((a, b) => Number(b.isGroup) - Number(a.isGroup));
    const nodes: Node[] = positioned.map((n) => {
      if (n.isGroup) {
        return {
          id: n.id,
          type: "fileGroup",
          position: { x: n.x, y: n.y },
          data: { label: n.label },
          style: {
            width: n.width,
            height: n.height,
            borderRadius: 12,
            border: "1.5px dashed rgba(120, 120, 160, 0.45)",
            background: "rgba(120, 120, 160, 0.06)",
          },
        };
      }
      const color = KIND_COLORS[n.kind] ?? "#94a3b8";
      return {
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: n.label },
        ...(n.parentId
          ? { parentId: n.parentId, extent: "parent" as const }
          : {}),
        style: {
          width: n.width,
          height: n.height,
          fontSize: 11,
          lineHeight: `${n.height - 10}px`,
          padding: "0 8px",
          borderRadius: 8,
          border: `1.5px solid ${color}`,
          background: "var(--color-card, transparent)",
          color: "inherit",
        },
      };
    });
    const edges: Edge[] = vm.graph.edges.map((e, i) => ({
      id: `${e.source}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
      animated: e.kind === "call",
      label: e.kind === "import" ? "imports" : undefined,
      labelStyle: { fontSize: 9, opacity: 0.6 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { opacity: e.kind === "ref" ? 0.35 : 0.75 },
      zIndex: 1000, // above group containers
    }));
    return { nodes, edges };
  }, [vm.graph]);

  const load = (scope: GraphScope) => {
    const def = SCOPES.find((s) => s.id === scope);
    void vm.loadGraph(scope, def?.needsTarget ? target : undefined);
  };

  /** Drill-down: file box -> file scope; symbol chip -> its call graph. */
  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (node.id.startsWith("file:")) {
        const graphNode = vm.graph?.nodes.find((n) => n.id === node.id);
        if (graphNode?.path) {
          setTarget(graphNode.path);
          void vm.loadGraph("file", graphNode.path);
        }
      } else if (node.id.startsWith("sym:")) {
        const symId = node.id.slice(4);
        const graphNode = vm.graph?.nodes.find((n) => n.id === node.id);
        if (graphNode) setTarget(graphNode.label);
        void vm.loadGraph("symbol", symId);
      }
    },
    [vm]
  );

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="border-b border-border-subtle px-3 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Network className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Knowledge graph</p>
              <p className="text-[11px] text-muted-foreground">
                {activeScope} scope
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <ScanFeaturesButton vm={vm} />
            {(
              [
                { id: "3d", icon: Box, label: "3D orbit" },
                { id: "2d", icon: Square, label: "2D boxes" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                title={m.label}
                onClick={() => setMode(m.id)}
                className={cn(
                  "flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors",
                  mode === m.id
                    ? "bg-primary/12 text-primary"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <m.icon className="h-3.5 w-3.5" />
                {m.id.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-muted/50 p-0.5">
            {SCOPES.map((scope) => (
              <button
                key={scope.id}
                onClick={() => load(scope.id)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors",
                  activeScope === scope.id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {scope.label}
              </button>
            ))}
          </div>
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                load(activeScope === "workspace" ? "symbol" : activeScope);
              }
            }}
            placeholder="Path or symbol"
            className="h-8 min-w-0 flex-1 rounded-lg text-[11px] sm:max-w-72"
          />
          {vm.graphLoading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {vm.graph === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">Loading code graph…</p>
          </div>
        ) : nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-muted-foreground">
              No graph data for this scope/target yet.
            </p>
          </div>
        ) : mode === "3d" ? (
          <Graph3D graph={vm.graph} theme={theme} active={active} />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            colorMode={theme}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={onNodeClick}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

/**
 * Kicks the route→feature scan and shows live progress. Haiku reads each
 * page/endpoint's reachable code and writes a feature into the knowledge
 * engine, so "add a card to the dashboard" retrieves the dashboard feature.
 */
function ScanFeaturesButton({
  vm,
}: {
  vm: ReturnType<typeof useKnowledgeViewModel>;
}) {
  const scan = vm.featureScan;
  const busy = scan !== null;
  const label = !scan
    ? "Scan features"
    : scan.phase === "discover"
      ? "Discovering routes…"
      : `Features ${scan.done}/${scan.total}`;
  return (
    <button
      onClick={() => void vm.scanFeatures()}
      disabled={busy}
      title="Scan routes & endpoints and summarize each as a feature (Haiku)"
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-colors",
        busy
          ? "text-primary"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
      <span className="max-w-40 truncate">{label}</span>
    </button>
  );
}
