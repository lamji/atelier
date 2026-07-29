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

/** Workflow state of a note, stored as `status:` in its frontmatter. */
export const MarkdownStatus = z.enum(["todo", "in-progress", "review", "done"]);
export type MarkdownStatus = z.infer<typeof MarkdownStatus>;

export const MarkdownFile = z.object({
  /** Workspace-relative, forward-slash path. */
  path: z.string(),
  /** First `# heading`, or the filename when the file has none. */
  title: z.string(),
  /** First prose line after the title, capped server-side. */
  description: z.string(),
  /** From frontmatter `status:`; "todo" when absent or unrecognized. */
  status: MarkdownStatus,
  mtime: z.number(),
});
export type MarkdownFile = z.infer<typeof MarkdownFile>;

export const SearchMatch = z.object({
  path: z.string(),
  row: z.number(),
  col: z.number(),
  line: z.string(),
});
export type SearchMatch = z.infer<typeof SearchMatch>;
