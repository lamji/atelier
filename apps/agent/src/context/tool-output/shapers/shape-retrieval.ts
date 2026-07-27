const MAX_CHUNKS = 8;
const PREVIEW_CHARS = 400;
const MAX_FEATURES = 3;
const FEATURE_SUMMARY_CHARS = 200;

/**
 * retrieve_knowledge / search_workspace results dominate transcript size:
 * previews arrive at up to 1200 chars per chunk. Keep the top chunks with
 * tighter previews, surface only feature names, and report what was
 * omitted so the model can refine instead of re-fetching blindly.
 */
export function shapeRetrieval(result: unknown): string | null {
  const r = result as {
    strategy?: string;
    chunks?: Array<{
      path: string;
      kind: string;
      score: number;
      preview: string;
      startRow?: number;
      endRow?: number;
    }>;
    graphNodes?: unknown[];
    features?: Array<{ name: string; summary: string }>;
    matches?: unknown[];
  };

  // search_workspace already collapses to one compact row per file —
  // compact serialization is all it needs.
  if (Array.isArray(r?.matches)) {
    return JSON.stringify({ strategy: r.strategy, matches: r.matches });
  }
  if (!Array.isArray(r?.chunks)) return null;

  const shown = r.chunks.slice(0, MAX_CHUNKS).map((c) => ({
    path: c.path,
    kind: c.kind,
    score: Math.round(c.score * 100) / 100,
    ...(c.startRow !== undefined
      ? { rows: `${c.startRow}-${c.endRow ?? "?"}` }
      : {}),
    preview: clip(c.preview, PREVIEW_CHARS),
  }));

  const out: Record<string, unknown> = { strategy: r.strategy, chunks: shown };
  if (r.chunks.length > shown.length) {
    out.more =
      `${r.chunks.length - shown.length} lower-ranked chunk(s) omitted — ` +
      "refine the query to see them";
  }
  const features = (r.features ?? [])
    .slice(0, MAX_FEATURES)
    .map((f) => ({ name: f.name, summary: clip(f.summary, FEATURE_SUMMARY_CHARS) }));
  if (features.length > 0) out.features = features;
  if (Array.isArray(r.graphNodes) && r.graphNodes.length > 0) {
    out.graphNodes = `${r.graphNodes.length} (use query_knowledge_graph for detail)`;
  }
  return JSON.stringify(out);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
