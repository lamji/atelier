import { z } from "zod";

/**
 * One session out of a provider CLI's OWN history — the same rows its
 * `resume` picker shows, read from the transcripts it writes under the
 * user's home directory. Atelier does not own these: a session started in
 * a plain terminal appears here too, which is the point.
 */
export const CliHistoryEntry = z.object({
  /** The provider's session id — exactly what its resume command takes. */
  id: z.string(),
  providerId: z.string(),
  /** First real thing asked in the session; empty when nothing was. */
  title: z.string(),
  /** Session start, ms. What "16s ago / 11d ago" is measured from. */
  startedAt: z.number(),
  /** Last write to the transcript, ms. The list sorts on this. */
  updatedAt: z.number(),
  /** Directory the session ran in — already filtered to this workspace. */
  cwd: z.string(),
});
export type CliHistoryEntry = z.infer<typeof CliHistoryEntry>;

/** One reviewable file change owned by a provider CLI session. */
export const CliSessionChange = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
  firstTouchedAt: z.number(),
  lastTouchedAt: z.number(),
  alsoTouchedBy: z.array(z.string()).default([]),
});
export type CliSessionChange = z.infer<typeof CliSessionChange>;
