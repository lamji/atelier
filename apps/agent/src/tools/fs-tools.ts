import type { FileService } from "../workspace/file-service.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Registers filesystem tools. Same implementations serve UI RPCs and
 * model-invoked SDK tool calls.
 */
export function registerFsTools(
  registry: ToolRegistry,
  files: FileService
): void {
  registry.register(
    "read_file",
    async (input: { path: string; offset?: number; limit?: number }) =>
      files.readFile(input.path, { offset: input.offset, limit: input.limit })
  );

  registry.register(
    "write_file",
    async (input: { path: string; content: string }, ctx) => {
      const diff = await files.writeFile(input.path, input.content, {
        taskId: ctx.taskId,
      });
      return { path: diff.path, diffId: diff.id, applied: diff.applied };
    }
  );

  registry.register(
    "replace_code",
    async (
      input: {
        path: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      },
      ctx
    ) => {
      const diff = await files.replaceCode(
        input.path,
        input.oldString,
        input.newString,
        input.replaceAll ?? false,
        { taskId: ctx.taskId }
      );
      return { path: diff.path, diffId: diff.id, applied: diff.applied };
    }
  );

  // NOTE: search_workspace is registered by registerKnowledgeTools so it
  // resolves through the live engine-knowledge index (fast + relevance
  // ranked), not a native filesystem scan. files.search stays for the UI
  // editor grep (fs.search RPC) and internal word-boundary lookups.

  registry.register(
    "list_dir",
    async (input: { path?: string }) => ({
      entries: await files.list(input.path ?? ""),
    })
  );
}
