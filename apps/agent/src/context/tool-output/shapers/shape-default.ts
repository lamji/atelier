/**
 * Compact-JSON fallback for tool results with no dedicated shaper.
 * Pretty-printing (2-space indent) roughly doubles whitespace tokens for
 * zero model benefit, so results are always serialized compact.
 */
export function shapeDefault(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "ok";
  return JSON.stringify(result);
}
