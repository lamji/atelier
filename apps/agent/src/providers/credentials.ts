import type { ProviderCredential } from "@atelier/protocol";
import type { SettingsRepo } from "../storage/repositories/settings.js";
import {
  readCredentialStore,
  writeCredentialStore,
  type CredentialStore,
  type ProviderConfig,
} from "./credential-store.js";

/**
 * Provider credentials the user entered in Settings. Machine-global (see
 * credential-store.ts), so a key added while working on one project is
 * already there in the next project you open.
 *
 * Keys are write-only from the UI's perspective: they go in through
 * providers.save and only ever come back as a 4-character hint.
 */

export type { ProviderConfig };

/** Settings-table key used before the store moved out of the project db. */
const LEGACY_KEY = "providerCredentials";

export const OLLAMA_CLOUD = "ollama-cloud";
const LABELS: Record<string, string> = {
  [OLLAMA_CLOUD]: "Ollama Cloud",
};

/** Reads what the Ollama client should use right now. */
export function ollamaConfig(): ProviderConfig {
  return readCredentialStore()[OLLAMA_CLOUD] ?? {};
}

/**
 * One-time lift of credentials saved before the store went global: older
 * builds wrote them into this project's settings table, where no other
 * project could see them. Anything found moves into the global file and
 * the row is cleared, so a key the user later removes can never come back
 * from a project that still had a copy.
 *
 * Fields already set globally win — the first project to migrate defines
 * the credential and later ones only fill in what is missing.
 */
export function migrateProjectCredentials(settings: SettingsRepo): void {
  const raw = settings.getRaw(LEGACY_KEY);
  if (!raw) return;

  let legacy: CredentialStore | null = null;
  try {
    const parsed = JSON.parse(raw) as CredentialStore;
    legacy = parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    legacy = null;
  }

  if (legacy) {
    const store = { ...readCredentialStore() };
    let changed = false;
    for (const [id, config] of Object.entries(legacy)) {
      if (!config || typeof config !== "object") continue;
      const merged = fillGaps(store[id] ?? {}, config);
      if (!merged) continue;
      store[id] = merged;
      changed = true;
    }
    if (changed) writeCredentialStore(store);
  }
  settings.setRaw(LEGACY_KEY, "");
}

/** Adds only the fields the global entry lacks; null when nothing is new. */
function fillGaps(
  current: ProviderConfig,
  legacy: ProviderConfig
): ProviderConfig | null {
  const next: ProviderConfig = { ...current };
  let changed = false;
  if (!next.apiKey && legacy.apiKey) {
    next.apiKey = legacy.apiKey;
    changed = true;
  }
  if (!next.host && legacy.host) {
    next.host = legacy.host;
    changed = true;
  }
  if (!next.enabledModels?.length && legacy.enabledModels?.length) {
    next.enabledModels = [...legacy.enabledModels];
    changed = true;
  }
  return changed ? next : null;
}

export function listProviders(): ProviderCredential[] {
  const store = readCredentialStore();
  return Object.keys(LABELS).map((id) => {
    const config = store[id];
    const key = config?.apiKey;
    return {
      id: id as ProviderCredential["id"],
      label: LABELS[id] ?? id,
      configured: Boolean(key),
      ...(key ? { keyHint: `…${key.slice(-4)}` } : {}),
      ...(config?.host ? { host: config.host } : {}),
    };
  });
}

/**
 * Stores a provider's settings. An undefined apiKey leaves the stored key
 * alone — the UI sends the field only when the user typed a new one, so
 * editing the host never wipes the key.
 */
export function saveProvider(
  id: string,
  update: { apiKey?: string; host?: string }
): ProviderCredential[] {
  const store = { ...readCredentialStore() };
  const current = store[id] ?? {};
  const next: ProviderConfig = {
    apiKey: update.apiKey === undefined ? current.apiKey : update.apiKey.trim(),
    host: update.host === undefined ? current.host : update.host.trim(),
    enabledModels: current.enabledModels,
  };
  if (!next.apiKey) delete next.apiKey;
  if (!next.host) delete next.host;
  if (!next.enabledModels?.length) delete next.enabledModels;

  store[id] = next;
  writeCredentialStore(store);
  return listProviders();
}

/** Adds/removes one model tag from a provider's enabled set. */
export function setModelEnabled(
  id: string,
  name: string,
  enabled: boolean
): string[] {
  const store = { ...readCredentialStore() };
  const current = store[id] ?? {};
  const set = new Set(current.enabledModels ?? []);
  if (enabled) set.add(name);
  else set.delete(name);

  const next: ProviderConfig = { ...current, enabledModels: [...set] };
  if (!next.enabledModels?.length) delete next.enabledModels;
  store[id] = next;
  writeCredentialStore(store);
  return [...set];
}

/** Enabled tags for a provider, for filtering the roster. */
export function enabledModelsFor(id: string): string[] {
  return readCredentialStore()[id]?.enabledModels ?? [];
}

export function removeProvider(id: string): ProviderCredential[] {
  const store = { ...readCredentialStore() };
  delete store[id];
  writeCredentialStore(store);
  return listProviders();
}
