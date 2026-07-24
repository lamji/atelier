import type { Router } from "../bridge/router.js";
import type { FileService } from "./file-service.js";

export function registerFsHandlers(router: Router, files: FileService): void {
  router.register("fs.tree", async (params) => ({
    root: await files.tree(params.path, params.depth),
  }));

  router.register("fs.list", async (params) => ({
    entries: await files.list(params.path),
  }));

  router.register("fs.files", async () => ({ files: await files.allFiles() }));

  router.register("fs.stat", async (params) => ({
    entry: await files.stat(params.path),
  }));

  router.register("fs.readFile", async (params) => {
    const { content, mtime } = await files.readFile(params.path);
    return { path: params.path, content, mtime };
  });

  router.register("fs.writeFile", async (params) => ({
    diff: await files.writeFile(params.path, params.content),
  }));

  router.register("fs.replaceCode", async (params) => ({
    diff: await files.replaceCode(
      params.path,
      params.oldString,
      params.newString,
      params.replaceAll ?? false
    ),
  }));

  router.register("fs.search", async (params) => ({
    matches: await files.search(
      params.query,
      params.glob,
      params.maxResults,
      params.regex
    ),
  }));
}
