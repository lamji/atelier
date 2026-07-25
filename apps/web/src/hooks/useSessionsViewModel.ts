import { useCallback, useEffect, useState } from "react";
import type { ModelOption, SlashCommand } from "@atelier/protocol";
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
/** Any SDK model value, or "default" to let the agent decide. */
export type ModelChoice = string;

/** An image staged in the composer (screenshot paste / drop / file pick). */
export interface PendingImage {
  id: string;
  mediaType: string;
  /** Base64 payload sent to the agent (no data: prefix). */
  data: string;
  /** Full data URL for the composer/message thumbnail. */
  dataUrl: string;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** An image was staged, or it was rejected with a reason worth showing. */
type ImageResult =
  | { ok: true; image: PendingImage }
  | { ok: false; reason: string };

/**
 * Reads an image File into base64 + a data URL. Rejections carry a reason
 * so the composer can say why nothing appeared, rather than dropping the
 * file silently (a too-big screenshot used to look like "nothing attached").
 */
function readImage(file: File): Promise<ImageResult> {
  const name = file.name || "image";
  if (!file.type.startsWith("image/")) {
    return Promise.resolve({ ok: false, reason: `${name} isn't an image` });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return Promise.resolve({
      ok: false,
      reason: `${name} is ${mb} MB — images must be under 5 MB`,
    });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      resolve({
        ok: true,
        image: {
          id: newId("img"),
          mediaType: file.type,
          data: comma >= 0 ? dataUrl.slice(comma + 1) : "",
          dataUrl,
        },
      });
    };
    reader.onerror = () => resolve({ ok: false, reason: `couldn't read ${name}` });
    reader.readAsDataURL(file);
  });
}

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
  const [images, setImages] = useState<PendingImage[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);

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

  // Load the slash-command catalog for the composer's "/" menu.
  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("session.listCommands", {})
      .then(({ commands }) => setSlashCommands(commands))
      .catch(() => undefined);
  }, [connected]);

  // Load the workspace file list for the composer's "@" mention menu.
  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("fs.files", {})
      .then(({ files }) => setFilePaths(files))
      .catch(() => undefined);
  }, [connected]);

  // Load the live model roster from the SDK for the model picker.
  useEffect(() => {
    if (!connected) return;
    void bridge
      .rpc("models.list", {})
      .then(({ models }) => setModels(models))
      .catch(() => undefined);
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
    // An image-only message is valid; the model reads the screenshot.
    if ((!text && images.length === 0) || !selected) return;
    if (selected.status === "working") return;
    const conversationId = selected.conversation.id;
    const prompt =
      attachments.length > 0
        ? `${text}\n\nAttached files:\n${attachments
            .map((p) => `- ${p}`)
            .join("\n")}`
        : text || "(see attached image)";
    const sent = images;
    setInput("");
    setAttachments([]);
    setImages([]);
    setError(null);
    useSessionsStore
      .getState()
      .addUserMessage(
        conversationId,
        newId("local"),
        text,
        sent.map((i) => i.dataUrl)
      );
    try {
      const { taskId } = await bridge.rpc("task.start", {
        conversationId,
        prompt,
        model: model === "default" ? undefined : model,
        effort: effort === "default" ? undefined : effort,
        planMode: planMode || undefined,
        images:
          sent.length > 0
            ? sent.map((i) => ({ mediaType: i.mediaType, data: i.data }))
            : undefined,
      });
      useSessionsStore.getState().taskStarted(
        conversationId,
        taskId,
        titleFrom(selected, text || "image")
      );
    } catch (e) {
      setError(errText(e));
      useSessionsStore.getState().taskEnded(conversationId, "error", errText(e));
    }
  }, [input, selected, attachments, images, model, effort, planMode]);

  /** Stage image Files (from picker, paste, or drop); rejects report why. */
  const addImages = useCallback(async (files: File[] | FileList) => {
    const results = await Promise.all(Array.from(files).map(readImage));
    const added: PendingImage[] = [];
    const rejected: string[] = [];
    for (const r of results) {
      if (r.ok) added.push(r.image);
      else rejected.push(r.reason);
    }
    if (added.length > 0) setImages((prev) => [...prev, ...added]);
    // Surface skipped files so an attach never silently does nothing.
    if (rejected.length > 0) setError(rejected.join(" · "));
    else if (added.length > 0) setError(null);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((i) => i.id !== id));
  }, []);

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

  /**
   * Stopping is not instant — the agent finishes the in-flight step, so
   * the button goes into a "Stopping…" state that only clears when the
   * task actually ends (task.cancelled / completed / error).
   */
  const cancel = useCallback(async () => {
    const taskId = selected?.activeTaskId;
    if (!taskId || selected?.cancelling) return;
    const conversationId = selected.conversation.id;
    useSessionsStore.getState().taskCancelling(conversationId);
    try {
      await bridge.rpc("task.cancel", { taskId });
    } catch {
      // Task already finished; the store clears on its end event.
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
    images,
    addImages,
    removeImage,
    slashCommands,
    filePaths,
    models,
  };
}

function titleFrom(session: SessionVm, prompt: string): string | undefined {
  if (session.conversation.title !== "New conversation") return undefined;
  return prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
}

function errText(e: unknown): string {
  return String((e as { message?: string } | undefined)?.message ?? e);
}
