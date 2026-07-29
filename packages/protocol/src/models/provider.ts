import { z } from "zod";

/** Backends the user can supply their own credentials for. */
export const ProviderId = z.enum(["ollama-cloud"]);
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * A configured provider as the UI sees it. The API key itself never leaves
 * the agent — only whether one is stored and a few trailing characters, so
 * the user can tell which key is in place without it being readable.
 */
export const ProviderCredential = z.object({
  id: ProviderId,
  label: z.string(),
  configured: z.boolean(),
  /** Last 4 characters of the stored key, e.g. "…9f2c". */
  keyHint: z.string().optional(),
  /** Custom endpoint; empty means the provider's default. */
  host: z.string().optional(),
});
export type ProviderCredential = z.infer<typeof ProviderCredential>;

/**
 * One model offered by a provider, with whether the user has switched it
 * on. Only enabled models reach the composer's picker — a provider can
 * offer dozens and almost none of them are wanted in day-to-day use.
 */
export const ProviderModel = z.object({
  /** Id the picker and task options use, e.g. "ollama/gpt-oss:20b". */
  value: z.string(),
  /** The provider's own tag, e.g. "gpt-oss:20b". */
  name: z.string(),
  enabled: z.boolean(),
  detail: z.string().optional(),
});
export type ProviderModel = z.infer<typeof ProviderModel>;

/**
 * What Atelier itself has spent on a provider over one rolling window.
 *
 * Deliberately not a percentage: Ollama Cloud exposes no quota endpoint, so
 * there is no denominator to divide by. These are measured totals from the
 * token counters each response carries — Atelier's own consumption, not the
 * account's, since other clients on the same key are invisible to us.
 */
export const ProviderUsageWindow = z.object({
  kind: z.string(),
  /** "last 5h", "last 7d" — rolling, not aligned to the plan's reset. */
  label: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** Total request duration the daemon reported, in seconds. */
  seconds: z.number(),
});
export type ProviderUsageWindow = z.infer<typeof ProviderUsageWindow>;

export const ProviderUsage = z.object({
  windows: z.array(ProviderUsageWindow).default([]),
  /** Where the real plan figures live, for a link out. */
  dashboardUrl: z.string().optional(),
  updatedAt: z.number().nullable().default(null),
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

/** Result of checking a provider's credentials against its API. */
export const ProviderCheck = z.object({
  ok: z.boolean(),
  detail: z.string(),
  modelCount: z.number().default(0),
});
export type ProviderCheck = z.infer<typeof ProviderCheck>;
