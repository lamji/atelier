import { z } from "zod";
import {
  ProviderCheck,
  ProviderCredential,
  ProviderId,
  ProviderModel,
  ProviderUsage,
} from "../models/provider.js";

export const providersMethods = {
  "providers.list": {
    params: z.object({}).optional(),
    result: z.object({ providers: z.array(ProviderCredential) }),
  },
  /** Stores a key/host. Omitting apiKey keeps the stored one. */
  "providers.save": {
    params: z.object({
      id: ProviderId,
      apiKey: z.string().optional(),
      host: z.string().optional(),
    }),
    result: z.object({ providers: z.array(ProviderCredential) }),
  },
  "providers.remove": {
    params: z.object({ id: ProviderId }),
    result: z.object({ providers: z.array(ProviderCredential) }),
  },
  /** Live check against the provider's API — proves the key works. */
  "providers.check": {
    params: z.object({ id: ProviderId }),
    result: z.object({ check: ProviderCheck }),
  },
  /** Everything the provider offers, with each model's on/off state. */
  "providers.models": {
    params: z.object({ id: ProviderId }),
    result: z.object({ models: z.array(ProviderModel) }),
  },
  /** What Atelier has spent on this provider, measured locally. */
  "providers.usage": {
    params: z.object({ id: ProviderId }),
    result: z.object({ usage: ProviderUsage }),
  },
  /** Switches one model in or out of the composer's picker. */
  "providers.setModelEnabled": {
    params: z.object({
      id: ProviderId,
      name: z.string(),
      enabled: z.boolean(),
    }),
    result: z.object({ models: z.array(ProviderModel) }),
  },
} as const;
