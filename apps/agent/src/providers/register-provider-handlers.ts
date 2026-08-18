import type { ProviderId, ProviderModel } from "@atelier/protocol";
import type { Router } from "../bridge/router.js";
import type { SettingsRepo } from "../storage/repositories/settings.js";
import {
  allowlistImpliesAll,
  CLAUDE,
  enabledModelsFor,
  GROK,
  listProviders,
  OLLAMA_CLOUD,
  migrateProjectCredentials,
  OLLAMA_LOCAL,
  removeProvider,
  saveProvider,
  setModelEnabled,
  setModelSubscriptionRequired,
  setProviderEnabled,
} from "./credentials.js";
import {
  listOllamaModels,
  ollamaHost,
  ollamaReachable,
  probeOllamaModelAccess,
} from "./ollama/client.js";
import { listOllamaCatalog } from "./ollama/models.js";
import { initUsage, usageWindows } from "./ollama/usage.js";
import { isSessionProvider, sessionCatalog } from "./roster.js";
import { probeClaudeAuth } from "../orchestrator/models-probe.js";
import { probeCodexAuth } from "./codex/models.js";
import { grokHost, listGrokModels } from "./grok/client.js";
import { listGrokCatalog } from "./grok/models.js";
import {
  grokUsageWindows,
  initGrokUsage,
} from "./grok/usage.js";

/**
 * Provider credential handlers. Keys are stored by the agent and never
 * returned — providers.list reports only whether one is set, plus a short
 * hint so the user can recognise which key it is.
 *
 * Credentials themselves are machine-global rather than per project, so
 * these handlers read and write the shared store; `settings` is only the
 * project db, still needed for the legacy migration and the usage meter.
 *
 * `workspaceRoot` is where the Claude Agent SDK is probed from, which is
 * the one thing here that is per project.
 */
export function registerProviderHandlers(
  router: Router,
  settings: SettingsRepo,
  workspaceRoot: string
): void {
  migrateProjectCredentials(settings);
  initUsage(settings);
  initGrokUsage(settings);

  router.register("providers.list", () => ({ providers: listProviders() }));

  router.register("providers.save", (params) => ({
    providers: saveProvider(params.id, {
      apiKey: params.apiKey,
      host: params.host,
    }),
  }));

  router.register("providers.remove", (params) => ({
    providers: removeProvider(params.id),
  }));

  router.register("providers.setEnabled", (params) => ({
    providers: setProviderEnabled(params.id, params.enabled),
  }));

  router.register("providers.models", async (params) => ({
    models: await catalogFor(params.id, workspaceRoot),
  }));

  router.register("providers.usage", (params) => ({
    // Hosted API calls are metered from response token counts. Signed-in
    // CLIs bill through their own process, so Atelier has no honest counter.
    usage: isSessionProvider(params.id)
      ? { windows: [], updatedAt: Date.now() }
      : params.id === GROK
        ? {
            windows: grokUsageWindows(Date.now()),
            dashboardUrl: "https://console.x.ai/",
            updatedAt: Date.now(),
          }
      : {
          windows: usageWindows(Date.now()),
          // Local inference has no account and no bill, so there is nowhere
          // to link to; the counters above are still worth showing.
          ...(params.id === OLLAMA_LOCAL
            ? {}
            : { dashboardUrl: "https://ollama.com/settings" }),
          updatedAt: Date.now(),
        },
  }));

  router.register("providers.setModelEnabled", async (params) => {
    await applyModelToggle(params.id, params.name, params.enabled, workspaceRoot);
    return { models: await catalogFor(params.id, workspaceRoot) };
  });

  // A live call, not a format check: the only thing worth reporting is
  // whether these credentials actually reach the API and see models.
  router.register("providers.check", async (params) => {
    if (isSessionProvider(params.id)) {
      return { check: await checkSession(params.id, workspaceRoot) };
    }
    if (params.id === GROK) {
      try {
        const models = await listGrokModels();
        return {
          check: {
            ok: models.length > 0,
            detail:
              models.length > 0
                ? `Connected to ${grokHost()} — ${models.length} language model(s) available.`
                : `Reached ${grokHost()}, but no language models are available to this key.`,
            modelCount: models.length,
          },
        };
      } catch (error) {
        return {
          check: { ok: false, detail: String(error), modelCount: 0 },
        };
      }
    }
    const local = params.id === OLLAMA_LOCAL;
    const host = ollamaHost(params.id);
    if (!(await ollamaReachable(params.id))) {
      return {
        check: {
          ok: false,
          detail: local
            ? `No response from ${host}. Is the Ollama daemon running? ` +
              "Start it with `ollama serve`."
            : `No response from ${host}. Check the key and the host.`,
          modelCount: 0,
        },
      };
    }
    const models = await listOllamaModels(params.id);
    return {
      check: {
        ok: models.length > 0,
        detail:
          models.length > 0
            ? `Connected to ${host} — ${models.length} model(s) available.`
            : local
              ? `Reached ${host}, but nothing is pulled yet. Try ` +
                "`ollama pull <model>`."
              : `Reached ${host}, but no models are available to this account.`,
        modelCount: models.length,
      },
    };
  });
}

/** The provider's full catalog, from whichever backend serves it. */
function catalogFor(
  id: ProviderId,
  workspaceRoot: string
): Promise<ProviderModel[]> {
  if (isSessionProvider(id)) return sessionCatalog(id, workspaceRoot);
  if (id === GROK) return listGrokCatalog();
  return listOllamaCatalog(id);
}

/**
 * Test the exact account boundary each provider executes through. Claude
 * asks the Agent SDK for its authenticated account; Codex asks its CLI login
 * status. A fallback model row is deliberately not accepted as auth proof.
 */
async function checkSession(id: "claude" | "codex", workspaceRoot: string) {
  const status =
    id === CLAUDE
      ? await probeClaudeAuth(workspaceRoot)
      : await probeCodexAuth();
  return {
    ok: status.ok,
    detail: status.detail,
    modelCount: 0,
  };
}

/**
 * Writes one toggle.
 *
 * A provider whose empty allowlist means "everything" has to materialize
 * that implied set minus this one when the FIRST model is switched off —
 * otherwise the store stays empty, the rule still says "all", and the
 * toggle appears to spring back on.
 */
async function applyModelToggle(
  id: ProviderId,
  name: string,
  enabled: boolean,
  workspaceRoot: string
): Promise<void> {
  if (id === OLLAMA_CLOUD && enabled) {
    const access = await probeOllamaModelAccess(name, OLLAMA_CLOUD);
    if (access === "subscription-required") {
      setModelSubscriptionRequired(id, name, true);
    }
    if (access === "available") {
      setModelSubscriptionRequired(id, name, false);
    }
  }
  if (allowlistImpliesAll(id) && !enabled && enabledModelsFor(id).length === 0) {
    const catalog = await catalogFor(id, workspaceRoot);
    for (const model of catalog) {
      if (model.name !== name) setModelEnabled(id, model.name, true);
    }
    return;
  }
  setModelEnabled(id, name, enabled);
}
