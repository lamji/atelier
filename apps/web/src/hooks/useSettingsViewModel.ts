import { useCallback, useEffect, useState } from "react";
import type { Settings } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { usePreferencesStore } from "@/state/preferences.store";
import { useThemeStore, type Theme } from "@/state/theme.store";

export interface SettingsVm {
  connected: boolean;
  /** Agent-side settings, null until the first load lands. */
  settings: Settings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  vibe: boolean;
  setVibe: (value: boolean) => void;
  theme: Theme;
  toggleTheme: () => void;
  setValidationRetries: (value: number) => void;
}

/**
 * ViewModel for the Settings panel. Client-only preferences (Vibe, theme)
 * live in stores and apply immediately; agent settings round-trip through
 * settings.get / settings.save so they persist per project.
 */
export function useSettingsViewModel(): SettingsVm {
  const connected = useConnectionStore((s) => s.state === "connected");
  const vibe = usePreferencesStore((s) => s.vibe);
  const setVibe = usePreferencesStore((s) => s.setVibe);
  const { theme, toggle } = useThemeStore();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    setLoading(true);
    void bridge
      .rpc("settings.get", {})
      .then(({ settings }) => setSettings(settings))
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [connected]);

  const save = useCallback((partial: Partial<Settings>) => {
    setSaving(true);
    setError(null);
    // Optimistic: the switch should never lag behind the pointer.
    setSettings((prev) => (prev ? { ...prev, ...partial } : prev));
    void bridge
      .rpc("settings.save", { settings: partial })
      .then(({ settings }) => setSettings(settings))
      .catch((e) => setError(errText(e)))
      .finally(() => setSaving(false));
  }, []);

  const setValidationRetries = useCallback(
    (value: number) => {
      const clamped = Math.min(Math.max(Math.round(value), 0), 5);
      save({ maxValidationRetries: clamped });
    },
    [save]
  );

  return {
    connected,
    settings,
    loading,
    saving,
    error,
    vibe,
    setVibe,
    theme,
    toggleTheme: toggle,
    setValidationRetries,
  };
}

function errText(e: unknown): string {
  return String((e as { message?: string } | undefined)?.message ?? e);
}
