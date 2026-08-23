export const FEATURE_CONTEXT_COMMAND_NAME = "context";
export const FEATURE_CONTEXT_COMMAND_ID =
  "project:command:" + FEATURE_CONTEXT_COMMAND_NAME;

export const FEATURE_CONTEXT_UPDATE_COMMAND_NAME = "context_update";
export const FEATURE_CONTEXT_UPDATE_COMMAND_ID =
  "project:command:" + FEATURE_CONTEXT_UPDATE_COMMAND_NAME;

/**
 * Returns undefined when the prompt is not /context. An empty string means
 * the command was invoked without the required feature name.
 */
export function parseFeatureContextCommand(
  prompt: string
): string | undefined {
  const match = /^\/context(?:\s+(.*))?$/i.exec(prompt.trim());
  if (!match) return undefined;
  return (match[1] ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
}

/**
 * Returns undefined when the prompt is not /context_update. An empty string
 * means "rebuild whatever this conversation is already pinned to"; a name
 * repoints the pin at that feature instead. Both the underscore and the
 * hyphen spelling are accepted because either is a natural thing to type.
 */
export function parseFeatureContextUpdateCommand(
  prompt: string
): string | undefined {
  const match = /^\/context[_-]update(?:\s+(.*))?$/i.exec(prompt.trim());
  if (!match) return undefined;
  return (match[1] ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
}
