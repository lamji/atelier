import { resolveEdit } from "../workspace/file-service.js";
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
    async (input: { path: string; offset?: number; limit?: number }) => {
      try {
        return await files.readFile(input.path, {
          offset: input.offset,
          limit: input.limit,
        });
      } catch (error) {
        throw await withSiblings(files, input.path, error);
      }
    }
  );

  registry.register(
    "read_many_files",
    async (
      input: {
        files: Array<{ path: string; offset?: number; limit?: number }>;
      }
    ) => {
      const requested = input.files.slice(0, 20);
      // One bad path must not throw away the other nineteen reads. It used
      // to: a single rejection failed the whole Promise.all, the model got
      // an error instead of the files that were there, and it re-read the
      // entire batch. Each file now reports its own outcome.
      const results = await Promise.all(
        requested.map(async (file) => {
          try {
            return {
              path: file.path,
              ...(await files.readFile(file.path, {
                offset: file.offset,
                limit: file.limit,
              })),
            };
          } catch (error) {
            return {
              path: file.path,
              error: String(await withSiblings(files, file.path, error)),
            };
          }
        })
      );
      const failed = results.filter((entry) => "error" in entry).length;
      return {
        files: results,
        // Stated outright so the model reads the successes rather than
        // treating a partial batch as a failed call.
        ...(failed > 0
          ? { note: `${results.length - failed} read, ${failed} failed` }
          : {}),
      };
    }
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
    "replace_many",
    async (
      input: {
        edits: Array<{
          path: string;
          oldString: string;
          newString: string;
          replaceAll?: boolean;
        }>;
      },
      ctx
    ) => {
      const byPath = new Map<
        string,
        Array<{
          oldString: string;
          newString: string;
          replaceAll?: boolean;
        }>
      >();
      for (const edit of input.edits.slice(0, 50)) {
        const edits = byPath.get(edit.path) ?? [];
        edits.push(edit);
        byPath.set(edit.path, edits);
      }

      const results = [];
      for (const [path, edits] of byPath) {
        const before = (await files.readFile(path)).content;
        let after = before;
        for (const edit of edits) {
          // Same CRLF tolerance as replace_code — see resolveEdit.
          const match = resolveEdit(after, edit.oldString, edit.newString);
          if (match.count === 0) {
            throw new Error(`oldString not found in ${path}`);
          }
          if (match.count > 1 && !edit.replaceAll) {
            throw new Error(
              `oldString occurs ${match.count} times in ${path}; pass ` +
                "replaceAll or a more specific string"
            );
          }
          after = edit.replaceAll
            ? after.split(match.oldString).join(match.newString)
            : after.replace(match.oldString, match.newString);
        }
        const diff = await files.writeFile(path, after, { taskId: ctx.taskId });
        results.push({
          path: diff.path,
          diffId: diff.id,
          applied: diff.applied,
          replacements: edits.length,
        });
      }
      return { edits: results };
    }
  );

  // NOTE: search_workspace is registered by registerKnowledgeTools so it
  // resolves through the live engine-knowledge index (fast + relevance
  // ranked), not a native filesystem scan. files.search stays for the UI
  // editor grep (fs.search RPC) and internal word-boundary lookups.

  // Model-facing listing: a wrong path returns the nearest real directory
  // plus a note naming what was missing, instead of a dead-end ENOENT the
  // model cannot recover from. The UI editor keeps the strict fs.list RPC.
  registry.register(
    "list_dir",
    async (input: { path?: string }) => files.listForModel(input.path ?? "")
  );

  registry.register(
    "search_text",
    async (
      input: {
        query: string;
        glob?: string;
        maxResults?: number;
        regex?: boolean;
      },
      ctx
    ) => {
      const outcome = await files.search(
        input.query,
        input.glob,
        Math.min(Math.max(input.maxResults ?? 100, 1), 500),
        input.regex ?? false,
        { signal: ctx.signal }
      );
      // Said out loud, because a truncated search that looks complete is how
      // "it is not in the codebase" gets reported about a file that is.
      const note = outcome.truncated
        ? `Search stopped early after scanning ${outcome.scanned} files ` +
          "(time/size limit). These matches are partial — narrow it with a " +
          "glob (e.g. src/**/*.ts) or a more specific query."
        : undefined;
      return { matches: outcome.matches, scanned: outcome.scanned, note };
    }
  );
}

/**
 * A missing file is recoverable if the model can see what IS in the
 * folder, so the real sibling names are appended to the error. Any other
 * failure (too large, binary, escape) passes through untouched.
 */
async function withSiblings(
  files: FileService,
  relPath: string,
  error: unknown
): Promise<unknown> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== "ENOENT" && code !== "ENOTDIR") return error;
  const siblings = await files.suggestFor(relPath);
  if (!siblings) return error;
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message + siblings), { code });
}
