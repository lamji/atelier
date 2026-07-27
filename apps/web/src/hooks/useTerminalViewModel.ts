import { useCallback, useEffect } from "react";
import { bridge } from "@/services/bridge-client";
import { terminalRegistry } from "@/services/terminal-registry";
import { useConnectionStore } from "@/state/connection.store";
import { useTerminalStore } from "@/state/terminal.store";
import { useThemeStore } from "@/state/theme.store";

/** ViewModel for the terminal island: session tabs, create, kill, mount. */
export function useTerminalViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const sessions = useTerminalStore((s) => s.sessions);
  const activeTermId = useTerminalStore((s) => s.activeTermId);
  const setActive = useTerminalStore((s) => s.setActive);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("terminal.list", {})
      .then(({ sessions }) => useTerminalStore.getState().setSessions(sessions))
      .catch(() => undefined);
  }, [connected]);

  useEffect(() => {
    terminalRegistry.setTheme(theme === "dark");
  }, [theme]);

  const create = useCallback(async () => {
    try {
      const { session } = await bridge.rpc("terminal.create", {});
      useTerminalStore.getState().addSession(session);
    } catch {
      // agent unavailable
    }
  }, []);

  const kill = useCallback(async (termId: string) => {
    try {
      await bridge.rpc("terminal.kill", { termId });
    } catch {
      // already dead — event handler will clean up
    }
  }, []);

  // Stable across theme changes — the registry updates live terminals'
  // theme via setTheme(), so mount reads the theme lazily and never needs
  // to re-run (a new mount reference would wrongly re-trigger effects).
  const mount = useCallback((termId: string, container: HTMLElement) => {
    const dark = useThemeStore.getState().theme === "dark";
    terminalRegistry.mount(termId, container, dark);
  }, []);

  const refit = useCallback((termId: string) => {
    terminalRegistry.fitAndSync(termId);
  }, []);

  return {
    sessions,
    activeTermId,
    isDark: theme === "dark",
    setActive,
    create,
    kill,
    mount,
    refit,
  };
}
