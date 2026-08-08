import { z } from "zod";
import { FileEntry, FileTreeNode, MarkdownFile, SearchMatch } from "../models/fs.js";
import { Diff } from "../models/diff.js";

export const fsMethods = {
  "fs.tree": {
    params: z.object({ path: z.string().optional(), depth: z.number().optional() }),
    result: z.object({ root: FileTreeNode }),
  },
  "fs.list": {
    params: z.object({ path: z.string() }),
    result: z.object({ entries: z.array(FileEntry) }),
  },
  /** Flat list of workspace-relative file paths for the "@" mention menu. */
  "fs.files": {
    params: z.object({}).optional(),
    result: z.object({ files: z.array(z.string()) }),
  },
  /** The .md files under the workspace's .atelier cache folder,
   *  each with a title + one-line description. */
  "fs.markdownFiles": {
    params: z.object({}).optional(),
    result: z.object({ files: z.array(MarkdownFile) }),
  },
  "fs.stat": {
    params: z.object({ path: z.string() }),
    result: z.object({ entry: FileEntry }),
  },
  "fs.readFile": {
    params: z.object({ path: z.string() }),
    result: z.object({ path: z.string(), content: z.string(), mtime: z.number() }),
  },
  "fs.writeFile": {
    params: z.object({ path: z.string(), content: z.string() }),
    result: z.object({ diff: Diff }),
  },
  "fs.replaceCode": {
    params: z.object({
      path: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    result: z.object({ diff: Diff }),
  },
  /** Explorer authoring: create an empty file, refusing to clobber. */
  "fs.createFile": {
    params: z.object({ path: z.string() }),
    result: z.object({ path: z.string() }),
  },
  "fs.createDir": {
    params: z.object({ path: z.string() }),
    result: z.object({ path: z.string() }),
  },
  /** Rename or move; also the drag-and-drop move in the tree. */
  "fs.rename": {
    params: z.object({ from: z.string(), to: z.string() }),
    result: z.object({ path: z.string() }),
  },
  /** Copy a file or a whole directory (explorer copy/paste, duplicate). */
  "fs.copy": {
    params: z.object({ from: z.string(), to: z.string() }),
    result: z.object({ path: z.string() }),
  },
  /** Delete a file or a directory tree. */
  "fs.delete": {
    params: z.object({ path: z.string() }),
    result: z.object({ path: z.string() }),
  },
  "fs.search": {
    params: z.object({
      query: z.string(),
      glob: z.string().optional(),
      maxResults: z.number().optional(),
      regex: z.boolean().optional(),
    }),
    result: z.object({ matches: z.array(SearchMatch) }),
  },
} as const;
