/**
 * Maps a raw Node fs error onto the workspace-relative wire contract.
 *
 * Node's ENOENT text carries the absolute host path and nothing the model
 * can act on ("scandir 'C:\\Users\\...'"). Every provider bridge — the
 * Claude MCP server, the Codex tool bridge, the Ollama loop — stringifies
 * whatever we throw, so the useful version has to be produced once here
 * instead of three times downstream.
 */
export function workspaceFsError(
  error: unknown,
  relPath: string,
  what: "file" | "directory" | "path"
): NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // The code rides along on the replacement so callers can still branch on
  // "missing" without re-parsing prose.
  return Object.assign(rewrite(error, code, relPath, what), { code });
}

function rewrite(
  error: unknown,
  code: string | undefined,
  relPath: string,
  what: "file" | "directory" | "path"
): Error {
  const shown = relPath || ".";
  switch (code) {
    case "ENOENT":
      return new Error(
        `No such ${what} in the workspace: ${shown}. The path was not ` +
          "found — do not assume a conventional layout; confirm with " +
          "list_dir or search_workspace."
      );
    case "ENOTDIR":
      return new Error(`Not a directory: ${shown}`);
    case "EISDIR":
      return new Error(`That path is a directory, not a file: ${shown}`);
    case "EACCES":
    case "EPERM":
      return new Error(`Permission denied accessing ${shown}`);
    default:
      return new Error(`Cannot access ${shown}: ${scrubPaths(String(error))}`);
  }
}

/**
 * Node quotes the offending absolute path in its message. Replace the
 * quoted span so a host path never reaches the model transcript.
 */
function scrubPaths(message: string): string {
  return message.replace(/'[^']*'/g, "<path>");
}
