import type { ModelOption, ProviderModel } from "@atelier/protocol";
import { probeModels } from "../orchestrator/models-probe.js";
import { probeCodexModels } from "./codex/models.js";
import { probeOllamaModels } from "./ollama/models.js";
import { probeGrokModels } from "./grok/models.js";
import {
  allowlistImpliesAll,
  CLAUDE,
  CODEX,
  enabledModelsFor,
  providerEnabled,
} from "./credentials.js";

/**
 * The one place the composer's model picker is assembled, so the Settings
 * toggles and the picker can never disagree about what is switched on.
 *
 * Two filters apply, in this order: the provider's own switch decides
 * whether any of its rows appear at all, then its allowlist decides which.
 * Keeping them separate is what lets a provider be silenced for a while and
 * come back with the same handful of models still chosen.
 */

/** Providers served by a signed-in CLI rather than an HTTP endpoint. */
type SessionProvider = typeof CLAUDE | typeof CODEX;

/**
 * The SDK roster costs a process to probe, so it is read once and kept.
 * Ollama and Codex are re-read per call — an `ollama pull` or a Codex
 * update should show up without restarting the agent.
 */
let claudeCache: ModelOption[] | null = null;

async function sessionModels(
  id: SessionProvider,
  cwd: string,
  refresh = false
): Promise<ModelOption[]> {
  if (id === CODEX) return probeCodexModels();
  if (refresh || !claudeCache) claudeCache = await probeModels(cwd);
  return claudeCache;
}

/**
 * Re-probes a session provider, ignoring the cache. For the Test button:
 * there is no key to validate here, so the only honest answer is whether
 * the CLI actually responds with a roster right now.
 */
export function probeSession(
  id: SessionProvider,
  cwd: string
): Promise<ModelOption[]> {
  return sessionModels(id, cwd, true);
}

/**
 * A session provider's rows for the picker: nothing when it is switched
 * off, otherwise whatever its allowlist admits.
 */
async function pickerSlice(
  id: SessionProvider,
  cwd: string
): Promise<ModelOption[]> {
  if (!providerEnabled(id)) return [];
  const models = await sessionModels(id, cwd);
  const enabled = enabledSet(id, models);
  return models.filter((m) => enabled.has(m.value));
}

/**
 * Which model ids of a session provider reach the picker. An untouched
 * allowlist means all of them: signing in to the CLI is already the choice,
 * and an empty picker would just read as the provider being broken.
 */
function enabledSet(id: SessionProvider, models: ModelOption[]): Set<string> {
  const stored = enabledModelsFor(id);
  if (stored.length > 0) return new Set(stored);
  if (allowlistImpliesAll(id)) return new Set(models.map((m) => m.value));
  return new Set();
}

/**
 * Every model the composer may offer, in picker order. Ollama filters
 * itself the same way — its own module owns the two endpoints.
 */
export async function pickerRoster(cwd: string): Promise<ModelOption[]> {
  const [claude, ollama, grok, codex] = await Promise.all([
    slice("claude", () => pickerSlice(CLAUDE, cwd)),
    slice("ollama", () => probeOllamaModels()),
    slice("grok", () => probeGrokModels()),
    slice("codex", () => pickerSlice(CODEX, cwd)),
  ]);
  return [...claude, ...ollama, ...grok, ...codex];
}

/**
 * How long one provider gets to answer before the picker goes on without it.
 *
 * Every probe here talks to something that can be slow or gone: a CLI that
 * may not be installed, a daemon that may not be running, a hosted endpoint
 * over the network. Serially awaited and unbounded, the slowest of them set
 * the latency of the whole picker, and ONE rejection emptied it — the RPC
 * failed, the composer's `.catch` swallowed it, and every provider vanished
 * because of a provider the user may not even use.
 */
const PROBE_TIMEOUT_MS = 12_000;

/**
 * One provider's rows, or none — never an exception and never a wait
 * without end. A provider that fails is a provider that is missing from the
 * picker, which is exactly what it is.
 */
async function slice(
  name: string,
  probe: () => Promise<ModelOption[]>
): Promise<ModelOption[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<ModelOption[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} probe timed out`)),
          PROBE_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    // No logger reaches this module; the roster is read on demand and the
    // reason belongs where the user is looking — Settings' Test button asks
    // the same probe and reports what it says.
    console.warn(
      `[roster] ${name} offered no models:`,
      (error as Error).message ?? error
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A session provider's full catalog for the Settings list, each row
 * carrying its on/off state. Never filtered — the toggles are what the
 * user opened this card to change.
 *
 * The stored id is the model's `value` ("sonnet", "codex/gpt-5"), not its
 * label: labels move with every SDK release, ids do not.
 */
export async function sessionCatalog(
  id: SessionProvider,
  cwd: string
): Promise<ProviderModel[]> {
  const models = await sessionModels(id, cwd);
  const enabled = enabledSet(id, models);
  return models.map((m) => ({
    value: m.value,
    name: m.value,
    enabled: enabled.has(m.value),
    ...(m.label && m.label !== m.value ? { detail: m.label } : {}),
  }));
}

/** True for the providers this module serves, as a type guard. */
export function isSessionProvider(id: string): id is SessionProvider {
  return id === CLAUDE || id === CODEX;
}
