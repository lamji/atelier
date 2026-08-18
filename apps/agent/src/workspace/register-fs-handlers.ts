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

  router.register("fs.markdownFiles", async () => ({
    files: await files.markdownFiles(),
  }));

  router.register("fs.stat", async (params) => ({
    entry: await files.stat(params.path),
  }));

  router.register("fs.readFile", async (params) => {
    const { content, mtime } = await files.readFile(params.path);
    return { path: params.path, content, mtime };
  });

  router.register("fs.readImage", async (params) => {
    const image = await files.readImage(params.path);
    return { path: params.path, ...image };
  });

  router.register("fs.writeImage", async (params) => ({
    path: await files.writeImage(params.path, params.data, params.mediaType),
  }));

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

  router.register("fs.createFile", async (params) => ({
    path: await files.createFile(params.path),
  }));

  router.register("fs.createDir", async (params) => ({
    path: await files.createDir(params.path),
  }));

  router.register("fs.rename", async (params) => ({
    path: await files.rename(params.from, params.to),
  }));

  router.register("fs.copy", async (params) => ({
    path: await files.copy(params.from, params.to),
  }));

  router.register("fs.delete", async (params) => ({
    path: await files.remove(params.path),
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
