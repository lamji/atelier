import { z } from "zod";

export const FileEntry = z.object({
  /** Workspace-relative, forward-slash path. */
  path: z.string(),
  name: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().optional(),
  mtime: z.number().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const FileTreeNode: z.ZodType<FileTreeNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    type: z.enum(["file", "dir"]),
    children: z.array(FileTreeNode).optional(),
  })
);
export type FileTreeNode = {
  path: string;
  name: string;
  type: "file" | "dir";
  children?: FileTreeNode[];
};

export const SearchMatch = z.object({
  path: z.string(),
  row: z.number(),
  col: z.number(),
  line: z.string(),
});
export type SearchMatch = z.infer<typeof SearchMatch>;
