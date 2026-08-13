/**
 * Where provider credentials are persisted: one machine-global JSON file,
 * not the project database.
 *
 * Each project runs its own agent process against its own atelier.db
 * (the supervisor sets ATELIER_DATA_DIR per project), so a key written to
 * the settings table would exist only for the project it was typed in. An
 * API key is account-level — it belongs to the user, not to a checkout —
 * so it lives beside the other machine-wide files in the Atelier data root.
 *
 * Several agents run at once, which makes the file the source of truth
 * rather than a cache: reads re-stat it and reload when another process
 * has written, and writes swap it in whole so a concurrent reader never
 * parses a half-written store.
 */
import fs from "node:fs";
import path from "node:path";
import { atelierDataRoot } from "@atelier/shared/node";

export interface ProviderConfig {
  apiKey?: string;
  host?: string;
  /**
   * Whether the provider reaches the composer's picker at all. Absent means
   * on: this flag arrived after the store did, and a missing value must not
   * read as "the user switched this off".
   *
   * Kept separate from enabledModels so switching a provider off and back on
   * returns the exact model selection it had, rather than clearing it.
   */
  enabled?: boolean;
  /**
   * Model tags the user switched on. Absent/empty means none — a provider
   * can offer dozens of models and dumping them all into the composer's
   * picker would bury the handful anyone actually uses.
   */
  enabledModels?: string[];
  /** Models this account's /api/chat rejected as subscription-only. */
  subscriptionRequiredModels?: string[];
}

/** id -> config, for the providers we know about. */
export type CredentialStore = Record<string, ProviderConfig>;

const FILE_NAME = "providers.json";

let cache: CredentialStore = {};

/** mtimeMs the cache was built from; -1 until the first read. */
let cachedAt = -1;

export function credentialStorePath(): string {
  return path.join(atelierDataRoot(), FILE_NAME);
}

/**
 * The current store. Cheap enough to call per request: it stats the file
 * and only re-parses when another agent process has changed it.
 */
export function readCredentialStore(): CredentialStore {
  const file = credentialStorePath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // No file yet — nothing is configured on this machine.
    cache = {};
    cachedAt = 0;
    return cache;
  }
  if (mtimeMs === cachedAt) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CredentialStore;
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Corrupt, or caught mid-write: keep serving the last good value and
    // retry on the next read rather than dropping the user's key.
    return cache;
  }
  cachedAt = mtimeMs;
  return cache;
}

export function writeCredentialStore(store: CredentialStore): void {
  const file = credentialStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(store, null, 2);
  // Owner-only: this file holds API keys. Windows ignores the mode.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch {
    // Windows can refuse the swap while another agent has the file open;
    // writing in place still lands the change, and a reader that catches
    // it mid-write keeps its last good value.
    fs.writeFileSync(file, data, { encoding: "utf8", mode: 0o600 });
    fs.rmSync(temp, { force: true });
  }
  cache = store;
  try {
    cachedAt = fs.statSync(file).mtimeMs;
  } catch {
    cachedAt = -1;
  }
}
