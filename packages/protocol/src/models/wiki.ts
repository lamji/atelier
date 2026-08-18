import { z } from "zod";

/** One feature-wiki page as the Knowledge panel lists it. */
export const WikiPageInfo = z.object({
  slug: z.string(),
  title: z.string(),
  status: z.enum(["fresh", "stale", "draft"]),
  aliases: z.array(z.string()).default([]),
  /** Slugs of related pages. */
  links: z.array(z.string()).default([]),
  sources: z.number(),
  /** Sources changed since the page was verified; non-empty means stale. */
  moved: z.array(z.string()).default([]),
  updatedAt: z.number(),
  verifiedBy: z.string().optional(),
  /** Workspace-relative path of the markdown file. */
  path: z.string(),
});
export type WikiPageInfo = z.infer<typeof WikiPageInfo>;

/** A problem the wiki lint found. */
export const WikiLintFinding = z.object({
  kind: z.enum(["broken-link", "missing-source", "stale", "no-flow", "shared-owner"]),
  slug: z.string(),
  detail: z.string(),
});
export type WikiLintFinding = z.infer<typeof WikiLintFinding>;
