/** A package-manager invocation that should be held for user approval. */
export interface PackageCommandIntent {
  manager: "npm" | "pnpm" | "yarn" | "bun";
  operation: string;
  command: string;
}

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
const READ_PREFIX_RE =
  /^\s*(rg|grep|egrep|findstr|select-string|cat|type|head|tail|less|more|git|ls|dir|echo|code|which|where)\b/i;
const FLAG_RE = /^(--?[\w-]+)(=\S*)?$/;
const FLAGS_WITH_VALUE = new Set([
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--prefix",
  "-w",
  "--workspace",
]);

/**
 * Detects npm-family commands independently from dev-server detection. Script
 * runs (`build`, `test`, `lint`) and lifecycle operations (`install`, `add`,
 * `exec`) are all approval-gated, including compound commands.
 */
export function detectPackageCommandIntent(
  toolName: string,
  input: unknown
): PackageCommandIntent | null {
  if (toolName !== "run_terminal") return null;
  const i = (input ?? {}) as Record<string, unknown>;
  const command = typeof i.command === "string" ? i.command.trim() : "";
  if (!command) return null;

  for (const segment of command
    .split(/&&|\|\||;|\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (READ_PREFIX_RE.test(segment)) continue;
    const tokens = segment.split(/\s+/).filter(Boolean);
    const manager = tokens.shift()?.toLowerCase();
    if (!manager || !PACKAGE_MANAGERS.includes(manager as never)) continue;

    while (tokens.length > 0 && FLAG_RE.test(tokens[0]!)) {
      const flag = tokens.shift()!;
      if (FLAGS_WITH_VALUE.has(flag) && tokens.length > 0) tokens.shift();
    }

    const subcommand = tokens.shift();
    if (!subcommand || subcommand.startsWith("-")) continue;
    const script =
      subcommand === "run" || subcommand === "run-script"
        ? tokens.shift()
        : undefined;
    return {
      manager: manager as PackageCommandIntent["manager"],
      operation: script ? `${subcommand} ${script}` : subcommand,
      command: command.slice(0, 400),
    };
  }
  return null;
}
