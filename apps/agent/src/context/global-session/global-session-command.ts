export const GLOBAL_SESSION_COMMAND_NAME = "global-session";
export const GLOBAL_SESSION_COMMAND_ID =
  `project:command:${GLOBAL_SESSION_COMMAND_NAME}`;

export function isGlobalSessionCommand(prompt: string): boolean {
  return /^\/global-session\s*$/i.test(prompt.trim());
}

/** Accept strict JSON when supported, with a plain-text fallback for CLIs. */
export function parseGeneratedGlobalAlias(response: string): string {
  const unfenced = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let candidate = unfenced;
  try {
    const parsed = JSON.parse(unfenced) as { alias?: unknown };
    if (typeof parsed.alias === "string") candidate = parsed.alias;
  } catch {
    // Codex/Claude may return the requested value without the JSON wrapper.
  }
  const alias = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!alias) throw new Error("The AI did not produce a usable session alias.");
  return alias;
}
