import type { Router } from "../bridge/router.js";
import type { SettingsRepo } from "../storage/repositories/settings.js";
import {
  listProviders,
  migrateProjectCredentials,
  removeProvider,
  saveProvider,
  setModelEnabled,
} from "./credentials.js";
import { listOllamaModels, ollamaHost, ollamaReachable } from "./ollama/client.js";
import { listOllamaCatalog } from "./ollama/models.js";
import { initUsage, usageWindows } from "./ollama/usage.js";

/**
 * Provider credential handlers. Keys are stored by the agent and never
 * returned — providers.list reports only whether one is set, plus a short
 * hint so the user can recognise which key it is.
 *
 * Credentials themselves are machine-global rather than per project, so
 * these handlers read and write the shared store; `settings` is only the
 * project db, still needed for the legacy migration and the usage meter.
 */
export function registerProviderHandlers(
  router: Router,
  settings: SettingsRepo
): void {
  migrateProjectCredentials(settings);
  initUsage(settings);

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

  router.register("providers.models", async () => ({
    models: await listOllamaCatalog(),
  }));

  router.register("providers.usage", () => ({
    usage: {
      windows: usageWindows(Date.now()),
      dashboardUrl: "https://ollama.com/settings",
      updatedAt: Date.now(),
    },
  }));

  router.register("providers.setModelEnabled", async (params) => {
    setModelEnabled(params.id, params.name, params.enabled);
    return { models: await listOllamaCatalog() };
  });

  // A live call, not a format check: the only thing worth reporting is
  // whether these credentials actually reach the API and see models.
  router.register("providers.check", async () => {
    const host = ollamaHost();
    if (!(await ollamaReachable())) {
      return {
        check: {
          ok: false,
          detail: `No response from ${host}. Check the key and the host.`,
          modelCount: 0,
        },
      };
    }
    const models = await listOllamaModels();
    return {
      check: {
        ok: models.length > 0,
        detail:
          models.length > 0
            ? `Connected to ${host} — ${models.length} model(s) available.`
            : `Reached ${host}, but no models are available to this account.`,
        modelCount: models.length,
      },
    };
  });
}
