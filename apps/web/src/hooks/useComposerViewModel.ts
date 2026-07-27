import { useCallback, useEffect, useState } from "react";
import type { ModelOption, SlashCommand } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useSessionsStore, type SessionVm } from "@/state/sessions.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import {
  usePreferencesStore,
  type EffortChoice,
  type ModelChoice,
} from "@/state/preferences.store";
import { useMentionBrowser, type MentionBrowser } from "./useMentionBrowser";

export type { EffortChoice, ModelChoice };

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
    reader.onerror = () =>
      resolve({ ok: false, reason: `couldn't read ${name}` });
    reader.readAsDataURL(file);
  });
}

export interface ComposerViewModel {
  input: string;
  setInput: (value: string) => void;
  /** Ready to send: connected AND a session is selected. */
  connected: boolean;
  busy: boolean;
  cancelling: boolean;
  error: string | null;
  send: () => void;
  cancel: () => void;
  model: ModelChoice;
  models: ModelOption[];
  changeModel: (value: ModelChoice) => void;
  effort: EffortChoice;
  changeEffort: (value: EffortChoice) => void;
  planMode: boolean;
  setPlanMode: (value: boolean) => void;
  vibe: boolean;
  changeVibe: (value: boolean) => void;
  attachments: string[];
  addAttachment: (path: string) => void;
  removeAttachment: (path: string) => void;
  /** Currently selected file in the explorer, used by the attach button. */
  attachCandidate: string | null;
  images: PendingImage[];
  addImages: (files: File[] | FileList) => void;
  removeImage: (id: string) => void;
  slashCommands: SlashCommand[];
  mentions: MentionBrowser;
}

/**
 * ViewModel for the chat composer — the draft the user is typing plus
 * everything that rides along with it (model/effort/plan/vibe picks, staged
 * files and images, the "/" catalog and the "@" file browser).
 *
 * It lives HERE rather than in the session ViewModel on purpose: keystrokes
 * are the highest-frequency state change in the app, and the composer is the
 * only thing that needs to see them. Hoisting this into the shell made every
 * character re-render the whole console (Monaco, xterm, timeline, graph).
 * Everything it reads from stores is read through narrow selectors for the
 * same reason.
 */
export function useComposerViewModel(): ComposerViewModel {
  const online = useConnectionStore((s) => s.state === "connected");
  const selectedId = useSessionsStore((s) => s.selectedId);
  const busy = useSessionsStore((s) => statusOf(s.sessions, s.selectedId));
  const cancelling = useSessionsStore((s) =>
    s.selectedId ? (s.sessions[s.selectedId]?.cancelling ?? false) : false
  );
  const attachCandidate = useWorkspaceStore((s) => s.selectedPath);

  // Model / effort / plan mode belong to the CHAT: picking haiku here must
  // not repoint the sonnet chat next door. The store keeps a per-conversation
  // pick plus a default for chats that never chose.
  const defaults = usePreferencesStore((s) => s.defaults);
  const own = usePreferencesStore((s) =>
    selectedId ? s.byChat[selectedId] : undefined
  );
  const setComposer = usePreferencesStore((s) => s.setComposer);
  // Vibe coding is a sticky GLOBAL mode, not a per-send flag: the composer
  // switch and the Settings switch are the same control.
  const vibe = usePreferencesStore((s) => s.vibe);
  const changeVibe = usePreferencesStore((s) => s.setVibe);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const mentions = useMentionBrowser();

  // Load the slash-command catalog for the composer's "/" menu.
  useEffect(() => {
    if (!online) return;
    void bridge
      .rpc("session.listCommands", {})
      .then(({ commands }) => setSlashCommands(commands))
      .catch(() => undefined);
  }, [online]);

  // Load the live model roster from the SDK for the model picker.
  useEffect(() => {
    if (!online) return;
    void bridge
      .rpc("models.list", {})
      .then(({ models }) => setModels(models))
      .catch(() => undefined);
  }, [online]);

  // Switching chats clears the draft's attachments, not the text: the text
  // is the thought in progress, the attachments belonged to the old chat.
  useEffect(() => {
    setAttachments([]);
    setError(null);
  }, [selectedId]);

  const send = useCallback(() => {
    const text = input.trim();
    // An image-only message is valid; the model reads the screenshot.
    if (!text && images.length === 0) return;
    const store = useSessionsStore.getState();
    const id = store.selectedId;
    const selected = id ? store.sessions[id] : undefined;
    if (!id || !selected || selected.status === "working") return;

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
    store.addUserMessage(
      id,
      newId("local"),
      text,
      sent.map((i) => i.dataUrl)
    );

    const prefs = usePreferencesStore.getState();
    const pick = { ...prefs.defaults, ...prefs.byChat[id] };
    void bridge
      .rpc("task.start", {
        conversationId: id,
        prompt,
        model: pick.model === "default" ? undefined : pick.model,
        effort: pick.effort === "default" ? undefined : pick.effort,
        planMode: pick.planMode || undefined,
        vibe: prefs.vibe || undefined,
        images:
          sent.length > 0
            ? sent.map((i) => ({ mediaType: i.mediaType, data: i.data }))
            : undefined,
      })
      .then(({ taskId }) => {
        useSessionsStore
          .getState()
          .taskStarted(id, taskId, titleFrom(selected, text || "image"));
      })
      // The session carries the failure (ChatPanel renders lastError), so
      // don't also raise it here — one failed send, one message.
      .catch((e: unknown) => {
        useSessionsStore.getState().taskEnded(id, "error", errText(e));
      });
  }, [input, attachments, images]);

  /**
   * Stopping is not instant — the agent finishes the in-flight step, so
   * the button goes into a "Stopping…" state that only clears when the
   * task actually ends (task.cancelled / completed / error).
   */
  const cancel = useCallback(() => {
    const store = useSessionsStore.getState();
    const id = store.selectedId;
    const session = id ? store.sessions[id] : undefined;
    const taskId = session?.activeTaskId;
    if (!id || !taskId || session?.cancelling) return;
    store.taskCancelling(id);
    void bridge.rpc("task.cancel", { taskId }).catch(() => {
      // Task already finished; the store clears on its end event.
    });
  }, []);

  /** Stage image Files (from picker, paste, or drop); rejects report why. */
  const addImages = useCallback((files: File[] | FileList) => {
    void Promise.all(Array.from(files).map(readImage)).then((results) => {
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
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const changeModel = useCallback(
    (value: ModelChoice) => setComposer(selectedId, { model: value }),
    [setComposer, selectedId]
  );

  const changeEffort = useCallback(
    (value: EffortChoice) => setComposer(selectedId, { effort: value }),
    [setComposer, selectedId]
  );

  const setPlanMode = useCallback(
    (value: boolean) => setComposer(selectedId, { planMode: value }),
    [setComposer, selectedId]
  );

  const addAttachment = useCallback((path: string) => {
    setAttachments((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  }, []);

  return {
    input,
    setInput,
    connected: online && selectedId !== null,
    busy,
    cancelling,
    error,
    send,
    cancel,
    model: own?.model ?? defaults.model,
    models,
    changeModel,
    effort: own?.effort ?? defaults.effort,
    changeEffort,
    planMode: own?.planMode ?? false,
    setPlanMode,
    vibe,
    changeVibe,
    attachments,
    addAttachment,
    removeAttachment,
    attachCandidate,
    images,
    addImages,
    removeImage,
    slashCommands,
    mentions,
  };
}

/** True while the selected session has a task running. */
function statusOf(
  sessions: Record<string, SessionVm>,
  selectedId: string | null
): boolean {
  if (!selectedId) return false;
  return sessions[selectedId]?.status === "working";
}

function titleFrom(session: SessionVm, prompt: string): string | undefined {
  if (session.conversation.title !== "New conversation") return undefined;
  return prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
}

function errText(e: unknown): string {
  return String((e as { message?: string } | undefined)?.message ?? e);
}
