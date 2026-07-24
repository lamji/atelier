import { z } from "zod";

/** Lifecycle of a project's agent, as tracked by the supervisor. */
export const ProjectStatus = z.enum([
  "stopped",
  "starting",
  "running",
  "error",
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** A project known to the supervisor (persisted in projects.json). */
export const ProjectInfo = z.object({
  id: z.string(),
  /** Display name, derived from the folder basename. */
  name: z.string(),
  /** Absolute workspace path. */
  path: z.string(),
  status: ProjectStatus,
  /** Present while running — the agent's bridge port. */
  port: z.number().optional(),
  /** Last error detail when status is "error". */
  error: z.string().optional(),
  lastOpenedAt: z.number().optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;

/** Endpoint the UI needs to connect its BridgeClient to a running agent. */
export const ProjectEndpoint = z.object({
  id: z.string(),
  port: z.number(),
  token: z.string(),
});
export type ProjectEndpoint = z.infer<typeof ProjectEndpoint>;

/**
 * Supervisor ("hub") control surface. Served on the hub port alongside the
 * web UI; the UI's HubClient drives it to list / add / start / stop the
 * per-project agents. Shares the bridge handshake (session.hello) + token.
 */
export const projectsMethods = {
  "projects.list": {
    params: z.object({}).optional(),
    result: z.object({ projects: z.array(ProjectInfo) }),
  },
  "projects.add": {
    params: z.object({ path: z.string() }),
    result: z.object({ project: ProjectInfo }),
  },
  "projects.start": {
    // Spawns the agent if needed (idempotent) and returns its endpoint.
    params: z.object({ id: z.string() }),
    result: z.object({ endpoint: ProjectEndpoint }),
  },
  "projects.stop": {
    params: z.object({ id: z.string() }),
    result: z.object({ project: ProjectInfo }),
  },
  "projects.remove": {
    params: z.object({ id: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
} as const;
