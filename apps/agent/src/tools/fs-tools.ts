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
    async (input: { path: string }) => files.readFile(input.path)
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

  registry.register(
    "search_workspace",
    async (input: {
      query: string;
      glob?: string;
      maxResults?: number;
      regex?: boolean;
    }) => ({
      matches: await files.search(
        input.query,
        input.glob,
        input.maxResults ?? 100,
        input.regex ?? false
      ),
    })
  );

  registry.register(
    "list_dir",
    async (input: { path?: string }) => ({
      entries: await files.list(input.path ?? ""),
    })
  );
}
