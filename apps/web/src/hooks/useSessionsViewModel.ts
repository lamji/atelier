import { useCallback, useEffect, useState } from "react";
import { newId } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useSessionsStore, type SessionVm } from "@/state/sessions.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/**
 * ViewModel for the multi-agent session flow: session list, create/select,
 * per-session send/cancel. Each session is an independent agent run.
 */
export type EffortChoice = "default" | "low" | "medium" | "high" | "max";
export type ModelChoice = "default" | "opus" | "sonnet" | "haiku";

export function useSessionsViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const { sessions, order, selectedId } = useSessionsStore();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelChoice>(
    () => (localStorage.getItem("atelier.model") as ModelChoice) || "default"
  );
  const [effort, setEffort] = useState<EffortChoice>(
    () => (localStorage.getItem("atelier.effort") as EffortChoice) || "default"
  );
  const [planMode, setPlanMode] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);

  const selected: SessionVm | null =
    (selectedId ? sessions[selectedId] : null) ?? null;
  const sessionList = order
    .map((id) => sessions[id])
    .filter((s): s is SessionVm => s !== undefined);
  const workingCount = sessionList.filter((s) => s.status === "working").length;

  // Bootstrap: load conversations once connected.
  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("session.listConversations", {})
      .then(({ conversations }) => {
        const store = useSessionsStore.getState();
        if (conversations.length === 0 && store.order.length === 0) {
          void createSession();
          return;
        }
        store.upsertConversations(conversations);
      })
      .catch((e) => setError(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Hydrate message history when a session is first selected.
  useEffect(() => {
    if (!connected || !selected || selected.hydrated) return;
    const conversationId = selected.conversation.id;
    void bridge
      .rpc("session.getMessages", { conversationId })
      .then(({ messages }) => {
        useSessionsStore.getState().hydrate(
          conversationId,
          messages.map((m) => ({ id: m.id, role: m.role, text: m.text }))
        );
      })
      .catch(() => undefined);
  }, [connected, selected]);

  const createSession = useCallback(async () => {
    try {
      const { conversation } = await bridge.rpc("session.createConversation", {});
      useSessionsStore.getState().addSession(conversation);
      useWorkspaceStore.getState().setRightTab("chat");
      setInput("");
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  /** Selecting a session always brings the Chat view to the front. */
  const selectSession = useCallback((conversationId: string) => {
    useSessionsStore.getState().select(conversationId);
    useWorkspaceStore.getState().setRightTab("chat");
    setError(null);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !selected || selected.status === "working") return;
    const conversationId = selected.conversation.id;
    const prompt =
      attachments.length > 0
        ? `${text}\n\nAttached files:\n${attachments
            .map((p) => `- ${p}`)
            .join("\n")}`
        : text;
    setInput("");
    setAttachments([]);
    setError(null);
    useSessionsStore.getState().addUserMessage(conversationId, newId("local"), text);
    try {
      const { taskId } = await bridge.rpc("task.start", {
        conversationId,
        prompt,
        model: model === "default" ? undefined : model,
        effort: effort === "default" ? undefined : effort,
        planMode: planMode || undefined,
      });
      useSessionsStore.getState().taskStarted(
        conversationId,
        taskId,
        titleFrom(selected, text)
      );
    } catch (e) {
      setError(errText(e));
      useSessionsStore.getState().taskEnded(conversationId, "error", errText(e));
    }
  }, [input, selected, attachments, model, effort, planMode]);

  const changeModel = useCallback((value: ModelChoice) => {
    setModel(value);
    localStorage.setItem("atelier.model", value);
  }, []);

  const changeEffort = useCallback((value: EffortChoice) => {
    setEffort(value);
    localStorage.setItem("atelier.effort", value);
  }, []);

  const addAttachment = useCallback((path: string) => {
    setAttachments((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  }, []);

  const cancel = useCallback(async () => {
    const taskId = selected?.activeTaskId;
    if (!taskId) return;
    try {
      await bridge.rpc("task.cancel", { taskId });
    } catch {
      // task may already be done
    }
  }, [selected]);

  return {
    sessionList,
    selected,
    selectedId,
    workingCount,
    input,
    setInput,
    error,
    connected,
    createSession,
    selectSession,
    send,
    cancel,
    model,
    changeModel,
    effort,
    changeEffort,
    planMode,
    setPlanMode,
    attachments,
    addAttachment,
    removeAttachment,
  };
}

function titleFrom(session: SessionVm, prompt: string): string | undefined {
  if (session.conversation.title !== "New conversation") return undefined;
  return prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
}

function errText(e: unknown): string {
  return String((e as { message?: string } | undefined)?.message ?? e);
}
