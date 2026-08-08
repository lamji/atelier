import { useCallback, useEffect, useMemo, useState } from "react";
import { bridge } from "@/services/bridge-client";
import { replayProcessTimeline } from "@/services/event-dispatcher";
import { useConnectionStore } from "@/state/connection.store";
import { useSessionsStore, type SessionVm } from "@/state/sessions.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/**
 * ViewModel for the multi-agent session flow: the session list, create /
 * select, and the bootstrap that loads conversations and re-attaches to
 * tasks still running after a reload.
 *
 * Deliberately does NOT hold the composer draft or the selected chat's
 * transcript — those live in useComposerViewModel / useChatViewModel so the
 * shell never re-renders on a keystroke or a streamed token. Everything read
 * here is either a primitive selector or the session list itself.
 */
export function useSessionsViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const sessions = useSessionsStore((s) => s.sessions);
  const order = useSessionsStore((s) => s.order);
  const selectedId = useSessionsStore((s) => s.selectedId);
  const workingCount = useSessionsStore(countWorking);
  const busy = useSessionsStore(
    (s) => (s.selectedId ? s.sessions[s.selectedId]?.status : null) === "working"
  );
  // Conversation id whose history still needs fetching, else null — a
  // primitive, so this doesn't re-subscribe the shell to message contents.
  const needsHydration = useSessionsStore(pendingHydration);
  const [error, setError] = useState<string | null>(null);

  // Most recently active first. `order` is arrival order (the agent's list,
  // then anything created since), which is not what the list should read as:
  // the chat you last worked in belongs at the top. updatedAt is stamped by
  // the agent and re-stamped locally the moment a run starts, so a chat rises
  // as soon as it becomes active rather than after the next refetch.
  const sessionList = useMemo(
    () =>
      order
        .map((id) => sessions[id])
        .filter((s): s is SessionVm => s !== undefined)
        .sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt),
    [order, sessions]
  );

  const createSession = useCallback(async () => {
    try {
      const { conversation } = await bridge.rpc("session.createConversation", {});
      useSessionsStore.getState().addSession(conversation);
      useWorkspaceStore.getState().setRightTab("chat");
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  // Bootstrap: load conversations once connected.
  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("session.listConversations", {})
      .then(async ({ conversations }) => {
        const store = useSessionsStore.getState();
        if (conversations.length === 0 && store.order.length === 0) {
          void createSession();
          return;
        }
        store.upsertConversations(conversations);
        // After a reload the backend may still be running tasks. Restore the
        // busy UI (spinner, stop button, disabled composer) and re-map
        // task -> conversation so the live event stream resolves again.
        try {
          const { tasks } = await bridge.rpc("task.list", { activeOnly: true });
          store.restoreActiveTasks(
            tasks.map((t) => ({
              id: t.id,
              conversationId: t.conversationId,
              startedAt: t.startedAt,
            }))
          );
          // Busy state alone leaves the process rail blank for a run that is
          // still going: its plan and activity feed live only in this tab's
          // memory, which a project switch resets. Rebuild them from the
          // agent's timeline so returning to a workspace shows the work.
          for (const t of tasks) {
            void replayProcessTimeline(t.id).catch(() => undefined);
          }
        } catch {
          // Non-fatal: the composer just won't show the running state.
        }
      })
      .catch((e) => setError(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Hydrate message history when a session is first selected.
  useEffect(() => {
    if (!connected || !needsHydration) return;
    const conversationId = needsHydration;
    void bridge
      .rpc("session.getMessages", { conversationId })
      .then(({ messages }) => {
        useSessionsStore.getState().hydrate(
          conversationId,
          messages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text,
            logTopic: m.logTopic,
            diff: m.diff,
          }))
        );
      })
      .catch(() => undefined);
  }, [connected, needsHydration]);

  /** Selecting a session always brings the Chat view to the front. */
  const selectSession = useCallback((conversationId: string) => {
    useSessionsStore.getState().select(conversationId);
    useWorkspaceStore.getState().setRightTab("chat");
    setError(null);
  }, []);

  /**
   * Rename optimistically: the title is the row's identity in the list, and
   * waiting a round trip to see your own edit reads as a dropped keystroke.
   * A failed rename is put back rather than left showing a title the agent
   * never accepted.
   */
  const renameSession = useCallback(
    (conversationId: string, title: string) => {
      const store = useSessionsStore.getState();
      const previous = store.sessions[conversationId]?.conversation.title;
      const next = title.trim();
      if (!next || next === previous) return;
      store.renameSession(conversationId, next);
      void bridge
        .rpc("session.renameConversation", { conversationId, title: next })
        .catch((e) => {
          if (previous !== undefined) {
            useSessionsStore.getState().renameSession(conversationId, previous);
          }
          setError(errText(e));
        });
    },
    []
  );

  /**
   * Delete for real, then drop the row — the opposite order of rename. A chat
   * put back after an optimistic delete would have lost its transcript from
   * this tab's memory, so the row stays until the agent confirms.
   */
  const deleteSession = useCallback(async (conversationId: string) => {
    try {
      await bridge.rpc("session.deleteConversation", { conversationId });
      useSessionsStore.getState().removeSession(conversationId);
      // Deleting the last chat leaves nothing to select; give the workspace a
      // fresh one rather than an empty pane with no way back.
      if (useSessionsStore.getState().order.length === 0) await createSession();
    } catch (e) {
      setError(errText(e));
    }
  }, [createSession]);

  return {
    sessionList,
    selectedId,
    workingCount,
    busy,
    connected,
    error,
    createSession,
    selectSession,
    renameSession,
    deleteSession,
  };
}

/** How many agents are running right now (a number, so identity is stable). */
function countWorking(state: { sessions: Record<string, SessionVm> }): number {
  let n = 0;
  for (const id in state.sessions) {
    if (state.sessions[id]!.status === "working") n += 1;
  }
  return n;
}

function pendingHydration(state: {
  selectedId: string | null;
  sessions: Record<string, SessionVm>;
}): string | null {
  const id = state.selectedId;
  if (!id) return null;
  const session = state.sessions[id];
  return session && !session.hydrated ? id : null;
}

function errText(e: unknown): string {
  return String((e as { message?: string } | undefined)?.message ?? e);
}
