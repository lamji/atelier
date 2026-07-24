import { z } from "zod";

/** A caller/importer reached by walking reverse dependencies from a change. */
export const ImpactNode = z.object({
  path: z.string(),
  /** Symbol name when the hop is a call edge; absent for file imports. */
  symbol: z.string().optional(),
  kind: z.string().optional(),
  /** Hops from the changed file: 1 = direct caller, 2 = its caller, … */
  depth: z.number(),
  /** "call" (behavioural) or "import" (structural) reach. */
  via: z.enum(["call", "import"]),
});
export type ImpactNode = z.infer<typeof ImpactNode>;

/** A user-facing flow (route/component/feature) sitting downstream of a change. */
export const ImpactFlow = z.object({
  name: z.string(),
  path: z.string().optional(),
  kind: z.string(),
});
export type ImpactFlow = z.infer<typeof ImpactFlow>;

/**
 * The blast radius of an upcoming edit: everything that could break or need
 * to re-align if the target files change. Computed before execution so the
 * user (and the model) can see the reach before a line is touched.
 */
export const ImpactRadius = z.object({
  /** Files the task intends to change. */
  targets: z.array(z.string()),
  /** Transitive callers/importers, nearest first. */
  affected: z.array(ImpactNode).default([]),
  /** Downstream routes/components/features that ride on the targets. */
  flows: z.array(ImpactFlow).default([]),
  /** Test/spec files that exercise the targets or their callers. */
  testsAtRisk: z.array(z.string()).default([]),
  /** Same-unit files (template/class/spec) no import edge links. */
  companions: z.array(z.string()).default([]),
  /** Past lessons anchored to the targets — repeat-mistake warnings. */
  risks: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
  /** Rolled-up regression exposure from fan-out + risk signals. */
  level: z.enum(["low", "medium", "high"]),
  /** One-line human summary for the status/log line. */
  summary: z.string(),
});
export type ImpactRadius = z.infer<typeof ImpactRadius>;

/** One place that uses the symbol being edited. */
export const EditUseSite = z.object({
  path: z.string(),
  /** Caller/using symbol name, when known. */
  symbol: z.string().optional(),
  row: z.number().optional(),
  /**
   * How the use was found. "call" / "ref" / "import" are graph-resolved
   * (high confidence). "text" is a name match the graph could NOT resolve
   * — a dynamic/string-keyed use the model must verify.
   */
  via: z.enum(["call", "ref", "import", "text"]),
  sameFile: z.boolean(),
});
export type EditUseSite = z.infer<typeof EditUseSite>;

/**
 * Symbol-level impact of an edit at a specific site: the exact function/
 * component being changed, whether it's exported, and every place that
 * uses it — so the model (and user) can decide "update the callers too"
 * vs "this is isolated, change it freely."
 */
export const EditImpact = z.object({
  path: z.string(),
  /** The symbol the edit sits inside. */
  symbol: z.string(),
  kind: z.string(),
  /** True when the symbol crosses the module boundary (export). */
  exported: z.boolean(),
  /** Every use, same-file first. */
  uses: z.array(EditUseSite).default([]),
  /** Distinct files (besides this one) that use the symbol. */
  externalFiles: z.array(z.string()).default([]),
  /** Files mentioning the name that the graph couldn't resolve — verify. */
  textualFiles: z.array(z.string()).default([]),
  /** "isolated" | "local" (same file only) | "shared" (crosses files). */
  reach: z.enum(["isolated", "local", "shared"]),
  /** One-line guidance for the model / status line. */
  summary: z.string(),
});
export type EditImpact = z.infer<typeof EditImpact>;
