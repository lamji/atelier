import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "@/services/bridge-client";
import { isCliConsoleSession } from "@/services/cli-console";
import { terminalRegistry } from "@/services/terminal-registry";
import {
  MAX_TERMINALS,
  nextTerminalName,
  readRoster,
  writeRoster,
} from "@/services/terminal-roster";
import { useConnectionStore } from "@/state/connection.store";
import { useTerminalStore } from "@/state/terminal.store";
import { useThemeStore } from "@/state/theme.store";

/** Display names of the terminals as they currently stand, in tab order. */
function currentNames(): string[] {
  const { sessions, labels } = useTerminalStore.getState();
  return sessions.map((session) => labels[session.id] ?? session.name);
}

/** Persist the current tab order and names for the next launch. */
function syncRoster(): void {
  writeRoster(currentNames());
}

/** ViewModel for the terminal island: session tabs, create, kill, mount. */
export function useTerminalViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const sessions = useTerminalStore((s) => s.sessions);
  const labels = useTerminalStore((s) => s.labels);
  const activeTermId = useTerminalStore((s) => s.activeTermId);
  const profile = useTerminalStore((s) => s.profile);
  const setActive = useTerminalStore((s) => s.setActive);
  const setProfile = useTerminalStore((s) => s.setProfile);
  const theme = useThemeStore((s) => s.theme);
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl+F is captured inside xterm, which has no way back into React —
  // the registry calls this to raise the find bar.
  useEffect(() => {
    terminalRegistry.onSearchRequest(() => setSearchOpen(true));
  }, []);

  /*
   * Adopt the agent's terminals, and restore the roster when it has none.
   *
   * Two cases land here. A reconnect inside one app run finds live PTYs and
   * simply adopts them. A cold start finds none — the agent process is new —
   * so the workspace's saved terminals are recreated by name, and a workspace
   * with nothing on record gets its first terminal opened for it. The panel is
   * never an empty shell you have to prime by hand.
   *
   * Guarded by a ref: this must run once per connection, or a re-render mid
   * restore would spawn the roster twice.
   */
  const restoring = useRef(false);
  useEffect(() => {
    if (!connected) {
      restoring.current = false;
      return;
    }
    if (restoring.current) return;
    restoring.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const { sessions: live } = await bridge.rpc("terminal.list", {});
        if (cancelled) return;
        // The CLI-mode console is adopted by its own pane, not the dock —
        // and it must not suppress the roster restore for the dock's tabs.
        const dockLive = live.filter((s) => !isCliConsoleSession(s.name));
        if (dockLive.length > 0) {
          useTerminalStore.getState().setSessions(dockLive);
          syncRoster();
          return;
        }
        const wanted = readRoster();
        const names = wanted.length > 0 ? wanted : [nextTerminalName([])];
        for (const name of names.slice(0, MAX_TERMINALS)) {
          if (cancelled) return;
          const { session } = await bridge.rpc("terminal.create", { name });
          useTerminalStore.getState().addSession(session);
        }
        if (!cancelled) {
          // Land on the first one, not the last one created.
          const first = useTerminalStore.getState().sessions[0];
          if (first) useTerminalStore.getState().setActive(first.id);
          syncRoster();
        }
      } catch {
        // Agent unavailable; the next connect retries the whole restore.
        restoring.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected]);

  useEffect(() => {
    terminalRegistry.setTheme(theme === "dark");
  }, [theme]);

  useEffect(() => {
    terminalRegistry.setProfile(profile);
  }, [profile]);

  const create = useCallback(async () => {
    try {
      const name = nextTerminalName(currentNames());
      const { session } = await bridge.rpc("terminal.create", { name });
      useTerminalStore.getState().addSession(session);
      syncRoster();
    } catch {
      // agent unavailable
    }
  }, []);

  const kill = useCallback(async (termId: string) => {
    try {
      await bridge.rpc("terminal.kill", { termId });
    } catch {
      // already dead — event handler will clean up
    } finally {
      // Remove it from the roster now, so a killed terminal does not come
      // back on the next launch.
      useTerminalStore.getState().removeSession(termId);
      syncRoster();
    }
  }, []);

  /** Rename a tab. Local label now, real session name on the next launch. */
  const rename = useCallback((termId: string, name: string) => {
    useTerminalStore.getState().renameSession(termId, name);
    syncRoster();
  }, []);

  // Stable across theme changes — the registry updates live terminals'
  // theme via setTheme(), so mount reads the theme lazily and never needs
  // to re-run (a new mount reference would wrongly re-trigger effects).
  const mount = useCallback((termId: string, container: HTMLElement) => {
    const dark = useThemeStore.getState().theme === "dark";
    const profile = useTerminalStore.getState().profile;
    terminalRegistry.mount(termId, container, dark, { profile });
  }, []);

  const refit = useCallback((termId: string) => {
    terminalRegistry.fitAndSync(termId);
  }, []);

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Sessions with their display names applied, so every consumer renders the
  // renamed tab without each one having to know about the label map.
  const labelled = useMemo(
    () =>
      sessions.map((session) =>
        labels[session.id] ? { ...session, name: labels[session.id]! } : session
      ),
    [sessions, labels]
  );

  return {
    sessions: labelled,
    activeTermId,
    isDark: theme === "dark",
    profile,
    searchOpen,
    setActive,
    setProfile,
    create,
    kill,
    rename,
    mount,
    refit,
    openSearch,
    closeSearch,
  };
}
