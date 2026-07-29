import { useCallback, useEffect, useState } from "react";
import type {
  ProviderCheck,
  ProviderCredential,
  ProviderId,
  ProviderModel,
  ProviderUsage,
} from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useProvidersStore } from "@/state/providers.store";

/** Providers the user can add. */
export const ADDABLE_PROVIDERS = [
  {
    id: "ollama-cloud" as const,
    label: "Ollama Cloud",
    hint: "API key from ollama.com/settings/keys",
  },
];

export interface ProvidersVm {
  connected: boolean;
  providers: ProviderCredential[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Per-provider result of the last connection check. */
  checks: Record<string, ProviderCheck | undefined>;
  checking: string | null;
  /** Full catalog per provider; only enabled rows reach the composer. */
  catalog: Record<string, ProviderModel[] | undefined>;
  loadingCatalog: string | null;
  save: (id: string, update: { apiKey?: string; host?: string }) => void;
  remove: (id: string) => void;
  check: (id: string) => void;
  loadCatalog: (id: string) => void;
  setModelEnabled: (id: string, name: string, enabled: boolean) => void;
  /** Switches a whole provider in or out of the composer's picker. */
  setProviderEnabled: (id: string, enabled: boolean) => void;
  /** Atelier's own measured spend per provider. */
  usage: Record<string, ProviderUsage | undefined>;
  loadUsage: (id: string) => void;
}

/**
 * ViewModel for provider credentials. The key is write-only: it is sent to
 * the agent and never read back, so the panel only ever shows whether one
 * is stored plus the hint the agent returns.
 */
export function useProvidersViewModel(): ProvidersVm {
  const connected = useConnectionStore((s) => s.state === "connected");
  const [providers, setProviders] = useState<ProviderCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, ProviderCheck>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, ProviderModel[]>>({});
  const [loadingCatalog, setLoadingCatalog] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, ProviderUsage>>({});

  useEffect(() => {
    if (!connected) return;
    setLoading(true);
    void bridge
      .rpc("providers.list", {})
      .then(({ providers }) => setProviders(providers))
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [connected]);

  const save = useCallback(
    (id: string, update: { apiKey?: string; host?: string }) => {
      setSaving(true);
      setError(null);
      void bridge
        .rpc("providers.save", { id: id as ProviderId, ...update })
        .then(({ providers }) => {
          setProviders(providers);
          // New credentials mean a different model roster — tell the picker.
          useProvidersStore.getState().bump();
        })
        .catch((e) => setError(errText(e)))
        .finally(() => setSaving(false));
    },
    []
  );

  const remove = useCallback((id: string) => {
    setSaving(true);
    void bridge
      .rpc("providers.remove", { id: id as ProviderId })
      .then(({ providers }) => {
        setProviders(providers);
        useProvidersStore.getState().bump();
        setChecks((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setSaving(false));
  }, []);

  const check = useCallback((id: string) => {
    setChecking(id);
    setError(null);
    void bridge
      .rpc("providers.check", { id: id as ProviderId })
      .then(({ check }) => setChecks((prev) => ({ ...prev, [id]: check })))
      .catch((e) => setError(errText(e)))
      .finally(() => setChecking(null));
  }, []);

  const loadCatalog = useCallback((id: string) => {
    setLoadingCatalog(id);
    setError(null);
    void bridge
      .rpc("providers.models", { id: id as ProviderId })
      .then(({ models }) => setCatalog((prev) => ({ ...prev, [id]: models })))
      .catch((e) => setError(errText(e)))
      .finally(() => setLoadingCatalog(null));
  }, []);

  const setModelEnabled = useCallback(
    (id: string, name: string, enabled: boolean) => {
      // Optimistic: a toggle must move under the finger, not after a round trip.
      setCatalog((prev) => ({
        ...prev,
        [id]: (prev[id] ?? []).map((m) =>
          m.name === name ? { ...m, enabled } : m
        ),
      }));
      void bridge
        .rpc("providers.setModelEnabled", {
          id: id as ProviderId,
          name,
          enabled,
        })
        .then(({ models }) => {
          setCatalog((prev) => ({ ...prev, [id]: models }));
          // The composer's picker shows exactly the enabled set.
          useProvidersStore.getState().bump();
        })
        .catch((e) => setError(errText(e)));
    },
    []
  );

  const setProviderEnabled = useCallback((id: string, enabled: boolean) => {
    // Optimistic, like the per-model toggles: the switch has to move under
    // the finger rather than after the round trip.
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, enabled } : p))
    );
    void bridge
      .rpc("providers.setEnabled", { id: id as ProviderId, enabled })
      .then(({ providers }) => {
        setProviders(providers);
        // The picker shows exactly the enabled providers' enabled models.
        useProvidersStore.getState().bump();
      })
      .catch((e) => setError(errText(e)));
  }, []);

  const loadUsage = useCallback((id: string) => {
    void bridge
      .rpc("providers.usage", { id: id as ProviderId })
      .then(({ usage }) => setUsage((prev) => ({ ...prev, [id]: usage })))
      // Surfaced, not swallowed: a stale agent answers "Unknown method"
      // here, and silently rendering nothing looks like zero usage.
      .catch((e) => setError(errText(e)));
  }, []);

  return {
    connected,
    providers,
    loading,
    saving,
    error,
    checks,
    checking,
    catalog,
    loadingCatalog,
    save,
    remove,
    check,
    loadCatalog,
    setModelEnabled,
    setProviderEnabled,
    usage,
    loadUsage,
  };
}

function errText(e: unknown): string {
  return String((e as { message?: string } | undefined)?.message ?? e);
}
