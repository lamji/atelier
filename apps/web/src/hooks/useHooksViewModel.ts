import { useCallback, useEffect, useState } from "react";
import type { HookConfig } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";

export interface HookDraft {
  name: string;
  event: HookConfig["event"];
  matcher: string;
  pathGlob: string;
  action: HookConfig["action"];
  argument: string;
}

export const EMPTY_DRAFT: HookDraft = {
  name: "",
  event: "preTool",
  matcher: "write_file|replace_code",
  pathGlob: "",
  action: "block",
  argument: "",
};

/** ViewModel for the hooks configuration panel. */
export function useHooksViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [draft, setDraft] = useState<HookDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { hooks } = await bridge.rpc("hooks.list", {});
      setHooks(hooks);
    } catch {
      // agent offline; list stays stale
    }
  }, []);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  const toggle = useCallback(
    async (hook: HookConfig) => {
      await bridge
        .rpc("hooks.save", { hook: { ...hook, enabled: !hook.enabled } })
        .catch(() => undefined);
      await refresh();
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      await bridge.rpc("hooks.delete", { id }).catch(() => undefined);
      await refresh();
    },
    [refresh]
  );

  const create = useCallback(async () => {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    try {
      const hook: HookConfig = {
        id: newId("hook"),
        name: draft.name.trim(),
        enabled: true,
        event: draft.event,
        matcher: draft.matcher.trim() || "*",
        pathGlob: draft.pathGlob.trim() || undefined,
        action: draft.action,
        argument: draft.argument.trim() || undefined,
      };
      await bridge.rpc("hooks.save", { hook });
      setDraft(EMPTY_DRAFT);
      await refresh();
    } finally {
      setSaving(false);
    }
  }, [draft, saving, refresh]);

  return { connected, hooks, draft, saving, setDraft, toggle, remove, create };
}
