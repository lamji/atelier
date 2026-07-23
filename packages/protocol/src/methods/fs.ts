import { z } from "zod";
import { FileEntry, FileTreeNode, SearchMatch } from "../models/fs.js";
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
