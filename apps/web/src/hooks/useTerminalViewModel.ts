import { useCallback, useEffect } from "react";
import { bridge } from "@/services/bridge-client";
import { terminalRegistry } from "@/services/terminal-registry";
import { useConnectionStore } from "@/state/connection.store";
import { useTerminalStore } from "@/state/terminal.store";
import { useThemeStore } from "@/state/theme.store";

/** ViewModel for the terminal island: session tabs, create, kill, mount. */
export function useTerminalViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const { sessions, activeTermId, setActive } = useTerminalStore();
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

  const mount = useCallback(
    (termId: string, container: HTMLElement) => {
      terminalRegistry.mount(termId, container, theme === "dark");
    },
    [theme]
  );

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
