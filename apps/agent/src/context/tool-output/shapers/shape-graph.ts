const MAX_NODES = 50;
const MAX_EDGES = 100;

/** Knowledge-graph results are capped with explicit omission counts. */
export function shapeGraph(result: unknown): string | null {
  const r = result as { nodes?: unknown[]; edges?: unknown[] };
  if (!Array.isArray(r?.nodes) || !Array.isArray(r?.edges)) return null;
  const out: Record<string, unknown> = {
    nodes: r.nodes.slice(0, MAX_NODES),
    edges: r.edges.slice(0, MAX_EDGES),
  };
  if (r.nodes.length > MAX_NODES) {
    out.moreNodes = `+${r.nodes.length - MAX_NODES} omitted — narrow the scope`;
  }
  if (r.edges.length > MAX_EDGES) {
    out.moreEdges = `+${r.edges.length - MAX_EDGES} omitted`;
  }
  return JSON.stringify(out);
}
