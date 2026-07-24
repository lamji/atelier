import type { KnowledgeGraph } from "@atelier/protocol";

export interface PositionedNode {
  id: string;
  label: string;
  kind: string;
  path?: string;
  parentId?: string;
  isGroup: boolean;
  /** Relative to parent for children; absolute for top-level nodes. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const COL_WIDTH = 300;
const COL_GAP = 90;
const ROW_GAP = 28;
const GROUP_WIDTH = 220;
const GROUP_HEADER = 30;
const CHILD_ROW = 34;
const CHILD_HEIGHT = 26;
const PLAIN_WIDTH = 170;
const PLAIN_HEIGHT = 40;

/**
 * Layered layout with container support: nodes carrying a parentId are
 * stacked INSIDE their parent (file) box; layering runs on the top-level
 * boxes using edges lifted to their containers. Left-to-right flow,
 * variable box heights, no external layout dependency.
 */
export function layoutGraph(graph: KnowledgeGraph): PositionedNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      const list = children.get(node.parentId) ?? [];
      list.push(node.id);
      children.set(node.parentId, list);
    }
  }
  const topLevel = graph.nodes.filter(
    (n) => !n.parentId || !byId.has(n.parentId)
  );
  const liftTo = (id: string): string => {
    const node = byId.get(id);
    return node?.parentId && byId.has(node.parentId) ? node.parentId : id;
  };

  // Layering on lifted edges.
  const inDegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const node of topLevel) {
    inDegree.set(node.id, 0);
    out.set(node.id, []);
  }
  const liftedSeen = new Set<string>();
  for (const edge of graph.edges) {
    const a = liftTo(edge.source);
    const b = liftTo(edge.target);
    if (a === b || !inDegree.has(a) || !inDegree.has(b)) continue;
    const key = `${a}>${b}`;
    if (liftedSeen.has(key)) continue;
    liftedSeen.add(key);
    inDegree.set(b, (inDegree.get(b) ?? 0) + 1);
    out.get(a)!.push(b);
  }

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const node of topLevel) {
    if ((inDegree.get(node.id) ?? 0) === 0) {
      layer.set(node.id, 0);
      queue.push(node.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const l = layer.get(id) ?? 0;
    for (const next of out.get(id) ?? []) {
      if (!layer.has(next)) {
        layer.set(next, l + 1);
        queue.push(next);
      }
    }
  }
  for (const node of topLevel) {
    if (!layer.has(node.id)) layer.set(node.id, 0);
  }

  const sizeOf = (id: string): { width: number; height: number } => {
    const kids = children.get(id) ?? [];
    if (kids.length > 0) {
      return {
        width: GROUP_WIDTH,
        height: GROUP_HEADER + kids.length * CHILD_ROW + 10,
      };
    }
    const node = byId.get(id)!;
    return node.kind === "file"
      ? { width: GROUP_WIDTH, height: GROUP_HEADER + 12 }
      : { width: PLAIN_WIDTH, height: PLAIN_HEIGHT };
  };

  // Stack each column with cumulative (variable) heights.
  const byLayer = new Map<number, string[]>();
  for (const node of topLevel) {
    const l = layer.get(node.id)!;
    const list = byLayer.get(l) ?? [];
    list.push(node.id);
    byLayer.set(l, list);
  }
  const columnHeight = (ids: string[]): number =>
    ids.reduce((h, id) => h + sizeOf(id).height + ROW_GAP, 0);
  const maxHeight = Math.max(
    ...[...byLayer.values()].map((ids) => columnHeight(ids)),
    1
  );

  const positioned: PositionedNode[] = [];
  for (const [l, ids] of byLayer) {
    let y = (maxHeight - columnHeight(ids)) / 2;
    for (const id of ids) {
      const node = byId.get(id)!;
      const size = sizeOf(id);
      positioned.push({
        id,
        label: node.label,
        kind: node.kind,
        path: node.path,
        isGroup: (children.get(id)?.length ?? 0) > 0,
        x: l * (COL_WIDTH + COL_GAP),
        y,
        width: size.width,
        height: size.height,
      });
      // Children stacked inside, positions relative to the parent box.
      const kids = children.get(id) ?? [];
      kids.forEach((childId, index) => {
        const child = byId.get(childId)!;
        positioned.push({
          id: childId,
          label: child.label,
          kind: child.kind,
          path: child.path,
          parentId: id,
          isGroup: false,
          x: 10,
          y: GROUP_HEADER + index * CHILD_ROW,
          width: GROUP_WIDTH - 20,
          height: CHILD_HEIGHT,
        });
      });
      y += size.height + ROW_GAP;
    }
  }
  return positioned;
}
