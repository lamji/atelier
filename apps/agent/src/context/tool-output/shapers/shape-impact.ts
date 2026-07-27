const MAX_ITEMS = 20;

/**
 * impact_of_edit / analyze_impact return unbounded dependent lists. Every
 * top-level array is capped at 20 entries with the omission count kept
 * beside it, so field names and structure stay exactly as the model
 * expects.
 */
export function shapeImpact(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length > MAX_ITEMS) {
      out[key] = value.slice(0, MAX_ITEMS);
      out[`${key}Omitted`] = value.length - MAX_ITEMS;
    } else {
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}
