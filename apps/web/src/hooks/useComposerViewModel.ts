import { useCallback, useEffect, useState } from "react";
import type { MarkdownFile, ModelOption, SlashCommand } from "@atelier/protocol";
import {
  composePromptFilePrompt,
  conversationTitle,
  newId,
} from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useSessionsStore, type SessionVm } from "@/state/sessions.store";
import { useMarkdownStore } from "@/state/markdown.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import {
  BACKEND_ENGINEER_CHOICE,
  markUiUxReferencesSent,
  UI_UX_DESIGNER_CHOICE,
  UI_UX_DESIGNER_REFERENCE_PATHS,
  uiUxReferencesWereSent,
} from "@/lib/agent-skills";
import { useProvidersStore } from "@/state/providers.store";
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

/** A prompt file is the main prompt, so the cap is generous — but a huge
 *  vendored md file must not blow the request. */
const MAX_PROMPT_FILE_CHARS = 32_000;

/** Sentinel for "no prompt file selected" in the composer dropdown. */
export const NO_PROMPT_FILE = "none";

const MD_REFETCH_DEBOUNCE_MS = 400;

/**
 * The picker exposes agent roles beside the provider rows. UI/UX Designer
 * takes the Claude roster's advertised Opus 5 row when present (`opus` is
 * the SDK alias fallback if a probe is unavailable or labels have changed).
 * Backend Engineer takes the FIRST Codex row: the Codex CLI catalog arrives
 * priority-sorted with the flagship on top, so the first row is the highest
 * and latest Codex model; `codex/default` defers to the signed-in session's
 * configured model if the roster carries no Codex rows.
 */
function resolveAgentModel(
  choice: ModelChoice,
  models: ModelOption[]
): string | undefined {
  if (choice === "default") return undefined;
  if (choice === BACKEND_ENGINEER_CHOICE) {
    const flagship = models.find((model) => model.provider === "codex");
    return flagship?.value ?? "codex/default";
  }
  if (choice !== UI_UX_DESIGNER_CHOICE) return choice;
  const opusFive = models.find(
    (model) =>
      (model.provider ?? "claude") === "claude" &&
      /\bopus\s*5\b/i.test(
        `${model.label} ${model.description ?? ""} ${model.resolvedModel ?? ""}`
      )
  );
  return opusFive?.value ?? "opus";
}

/** Low → high, mirroring the agent's own ordering of reasoning levels. */
const EFFORT_RANK = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Backend Engineer defaults to the resolved Codex row's HIGHEST supported
 * reasoning level ("Codex highest"); an explicit pick always wins, and any
 * other role keeps the plain default-means-unset behavior.
 */
function resolveAgentEffort(
  choice: ModelChoice,
  models: ModelOption[]
): NonNullable<ModelOption["reasoningLevels"]>[number] | undefined {
  if (choice !== BACKEND_ENGINEER_CHOICE) return undefined;
  const flagship = models.find((model) => model.provider === "codex");
  const levels = flagship?.reasoningLevels;
  if (!levels || levels.length === 0) return undefined;
  return [...levels].sort(
    (a, b) => EFFORT_RANK.indexOf(a) - EFFORT_RANK.indexOf(b)
  )[levels.length - 1];
}

function promptForAgentSkill(choice: ModelChoice, prompt: string): string {
  if (choice === UI_UX_DESIGNER_CHOICE) return `/ui-ux-designer ${prompt}`;
  if (choice === BACKEND_ENGINEER_CHOICE) {
    return `/secure-backend-integrator ${prompt}`;
  }
  return prompt;
}

function clipPromptFile(content: string): string {
  if (content.length <= MAX_PROMPT_FILE_CHARS) return content;
  return `${content.slice(0, MAX_PROMPT_FILE_CHARS)}\n\n[...truncated]`;
}

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

/**
 * UI/UX Designer has visual references, not merely a written style guide.
 * Resolve through Vite's base URL so the exact same files load in dev and
 * from the packaged desktop app's file:// bundle.
 */
async function loadUiUxDesignerReferences(): Promise<PendingImage[]> {
  const results = await Promise.all(
    UI_UX_DESIGNER_REFERENCE_PATHS.map(async (path, index) => {
      const url = new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`couldn't load UI reference ${index + 1}`);
      }
      const blob = await response.blob();
      return readImage(
        new File([blob], `ui-ux-reference-${index + 1}.png`, {
          type: blob.type || "image/png",
        })
      );
    })
  );
  const rejected = results.find((result) => !result.ok);
  if (rejected && !rejected.ok) throw new Error(rejected.reason);
  return results.flatMap((result) => (result.ok ? [result.image] : []));
}

export interface ComposerViewModel {
  input: string;
  setInput: (value: string) => void;
  /** Ready to send: connected AND a session is selected. */
  connected: boolean;
  /**
   * A turn is in flight. Model, effort, prompt file and the mode switches
   * are read once at task.start, so they lock WHILE a run is happening —
   * changing them mid-flight would only look like it applied. The moment
   * the agent is idle they unlock again: the next turn is free to use a
   * different model or drop out of plan mode.
   */
  busy: boolean;
  cancelling: boolean;
  /**
   * Follow-ups typed while the agent was working, still waiting their turn.
   * Sending during a run queues rather than refuses, so this is how many
   * turns are already lined up behind the one in flight.
   */
  queuedCount: number;
  /** Drops every waiting follow-up; the running task is left alone. */
  clearQueue: () => void;
  error: string | null;
  send: () => void;
  cancel: () => void;
  model: ModelChoice;
  models: ModelOption[];
  /**
   * The roster came back empty — every provider is switched off, so there
   * is nothing to send a turn to. Distinct from "not loaded yet": false
   * until the agent has actually answered.
   */
  noProvidersEnabled: boolean;
  changeModel: (value: ModelChoice) => void;
  effort: EffortChoice;
  changeEffort: (value: EffortChoice) => void;
  planMode: boolean;
  setPlanMode: (value: boolean) => void;
  /** Ticked: the full pipeline. Unticked: a plain Claude/Codex turn. */
  systemKnowledge: boolean;
  setSystemKnowledge: (value: boolean) => void;
  vibe: boolean;
  changeVibe: (value: boolean) => void;
  /** Ticked: an independent reviewer checks the changes before the summary. */
  autoReview: boolean;
  changeAutoReview: (value: boolean) => void;
  /** Ticked: typecheck/lint/test run over what the task changed. */
  autoValidate: boolean;
  changeAutoValidate: (value: boolean) => void;
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
  /** Path of the md file used as the prompt, or NO_PROMPT_FILE. */
  promptFile: string;
  setPromptFile: (path: string) => void;
  promptFiles: MarkdownFile[];
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
  const queuedCount = useSessionsStore((s) =>
    s.selectedId ? (s.sessions[s.selectedId]?.queuedTaskIds.length ?? 0) : 0
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
  // Auto review rides with it: both are "how the agent works here", sticky
  // per project rather than something to re-tick every message.
  const autoReview = usePreferencesStore((s) => s.autoReview);
  const changeAutoReview = usePreferencesStore((s) => s.setAutoReview);
  const autoValidate = usePreferencesStore((s) => s.autoValidate);
  const changeAutoValidate = usePreferencesStore((s) => s.setAutoValidate);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  // The prompt file is a per-chat preference, not composer-local state:
  // it has to survive both sending and switching away and back.
  const storedPromptFile = own?.promptFile ?? "";
  const setPromptFile = useCallback(
    (value: string) =>
      setComposer(selectedId, {
        promptFile: value === NO_PROMPT_FILE ? "" : value,
      }),
    [setComposer, selectedId]
  );
  const promptFiles = useMarkdownStore((s) => s.files);
  const catalogLoaded = useMarkdownStore((s) => s.fetchedVersion) >= 0;
  // A remembered file that has since been deleted or renamed must not sit
  // in the pill claiming to govern the chat. The catalog has to be loaded
  // before that judgement is made, or the pick would clear itself on every
  // reload while the list is still in flight.
  const promptFile =
    storedPromptFile &&
    (!catalogLoaded || promptFiles.some((file) => file.path === storedPromptFile))
      ? storedPromptFile
      : NO_PROMPT_FILE;
  const treeVersion = useWorkspaceStore((s) => s.treeVersion);
  const mentions = useMentionBrowser();

  // Keep the prompt-file dropdown's catalog fresh. The markdown store
  // dedupes by treeVersion, so this and the Markdown panel share one RPC.
  useEffect(() => {
    if (!online) return;
    const timer = setTimeout(
      () => void useMarkdownStore.getState().refresh(treeVersion),
      treeVersion === 0 ? 0 : MD_REFETCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [online, treeVersion]);

  // Load the slash-command catalog for the composer's "/" menu.
  useEffect(() => {
    if (!online) return;
    void bridge
      .rpc("session.listCommands", {})
      .then(({ commands }) =>
        setSlashCommands(
          commands.filter((command) => command.kind !== "skill" || command.enabled)
        )
      )
      .catch(() => undefined);
  }, [online]);

  // Load the live model roster (Claude + any configured provider) for the
  // picker. Re-runs when provider credentials change, so a key saved in
  // Settings brings its models in without a reload.
  const providerRevision = useProvidersStore((s) => s.revision);
  useEffect(() => {
    if (!online) return;
    void bridge
      .rpc("models.list", {})
      .then(({ models }) => {
        setModels(models);
        // Only a real answer proves the roster is empty; a failed probe
        // must not be read as "you turned everything off".
        setModelsLoaded(true);
      })
      .catch(() => undefined);
  }, [online, providerRevision]);

  // Switching chats clears the draft's attachments, not the text: the text
  // is the thought in progress, the attachments belonged to the old chat.
  useEffect(() => {
    setAttachments([]);
    setError(null);
  }, [selectedId]);

  // Switching WORKSPACES clears the draft outright. A thought in progress
  // belongs to the project it was typed for — carrying the text (or staged
  // images) into another workspace would send it to a different agent.
  const workspaceEpoch = useWorkspaceStore((s) => s.workspaceEpoch);
  useEffect(() => {
    setInput("");
    setImages([]);
  }, [workspaceEpoch]);

  const send = useCallback(() => {
    const text = input.trim();
    // An image-only or prompt-file-only message is valid.
    if (!text && images.length === 0 && promptFile === NO_PROMPT_FILE) return;
    const store = useSessionsStore.getState();
    const id = store.selectedId;
    const selected = id ? store.sessions[id] : undefined;
    // A busy session no longer refuses the send: the agent queues it behind
    // the running task, so a correction costs its turn in line instead of
    // costing the run.
    if (!id || !selected) return;

    // Async because a prompt file is read at send time — never cached on
    // select, so an edit between picking and sending is always honored.
    // Captured before the resets below: the agent needs to know WHICH note
    // drove this run so it can track its status and write the report back.
    const note = promptFile === NO_PROMPT_FILE ? undefined : promptFile;

    void (async () => {
      let body = text;
      if (note) {
        let content: string;
        try {
          ({ content } = await bridge.rpc("fs.readFile", { path: note }));
        } catch {
          // Draft stays intact; the user re-picks or clears the file.
          setError(`Couldn't read ${note}`);
          return;
        }
        // Shared format: the agent splits this apart again to record what
        // the user asked rather than the note quoting itself.
        // The path rides with the body: "update this md file" has to name a
        // file the agent can write back to, not one it has to guess at.
        body = composePromptFilePrompt(clipPromptFile(content), text, note);
      }

      const prompt =
        attachments.length > 0
          ? `${body}\n\nAttached files:\n${attachments
              .map((p) => `- ${p}`)
              .join("\n")}`
          : body || "(see attached image)";
      const prefs = usePreferencesStore.getState();
      const pick = { ...prefs.defaults, ...prefs.byChat[id] };
      let taskImages = images;
      const attachDesignerReferences =
        pick.model === UI_UX_DESIGNER_CHOICE &&
        !uiUxReferencesWereSent(id);
      if (attachDesignerReferences) {
        try {
          taskImages = [...(await loadUiUxDesignerReferences()), ...images];
        } catch (error) {
          // Keep the user's draft and attachments intact if the bundled
          // visual authority cannot be sent with this design task.
          setError(`Couldn't load UI/UX Designer references: ${errText(error)}`);
          return;
        }
      }
      // The transcript shows the pick, not the whole md file.
      const shown = text || (note ? `Prompt from ${note}` : "");
      const sent = images;
      setInput("");
      setAttachments([]);
      setImages([]);
      // The prompt file deliberately survives the send — it governs the
      // conversation, not the one message it was picked on.
      setError(null);
      store.addUserMessage(
        id,
        newId("local"),
        shown,
        sent.map((i) => i.dataUrl)
      );

      void bridge
        .rpc("task.start", {
          conversationId: id,
          prompt: promptForAgentSkill(pick.model, prompt),
          model: resolveAgentModel(pick.model, models),
          effort:
            pick.effort === "default"
              ? resolveAgentEffort(pick.model, models)
              : pick.effort,
          planMode: pick.planMode || undefined,
          // Only ever sent when OFF: absent means the normal pipeline, so
          // an older agent that ignores the flag still behaves correctly.
          systemKnowledge: pick.systemKnowledge === false ? false : undefined,
          vibe: prefs.vibe || undefined,
          // Always explicit, unlike the flags above. The agent's default is
          // now OFF — review is the most expensive thing a turn can do once
          // the answer is already on screen — so an absent flag no longer
          // means "on" and the tick has to say which way it is set. Sending
          // the boolean both ways also reads the same to an older agent.
          autoReview: prefs.autoReview,
          // Explicit for the same reason: the agent skips the validators
          // unless this says otherwise.
          autoValidate: prefs.autoValidate,
          images:
            taskImages.length > 0
              ? taskImages.map((i) => ({ mediaType: i.mediaType, data: i.data }))
              : undefined,
          promptFile: note,
        })
        .then(({ taskId, queued }) => {
          // Accepted means the agent received the images, whether this task
          // starts now or waits in the conversation queue. Failed RPCs do not
          // mark delivery, so retrying still carries the visual authority.
          if (attachDesignerReferences) markUiUxReferencesSent(id);
          // Queued behind a running task: it owns neither the live feed nor
          // the busy state yet. It announces itself with task.started when
          // its turn comes, and taskStarted takes it out of the line then.
          if (queued) {
            useSessionsStore.getState().taskQueued(id, taskId);
            return;
          }
          // Read fresh rather than closed over, so the catalog refreshing
          // does not rebuild this whole callback on every file write.
          const noteTitle = note
            ? useMarkdownStore.getState().files.find((f) => f.path === note)
                ?.title
            : undefined;
          useSessionsStore
            .getState()
            .taskStarted(
              id,
              taskId,
              titleFrom(selected, shown || "image", noteTitle)
            );
        })
        // The session carries the failure (ChatPanel renders lastError), so
        // don't also raise it here — one failed send, one message.
        .catch((e: unknown) => {
          useSessionsStore.getState().taskEnded(id, "error", errText(e));
        });
    })();
  }, [input, attachments, images, models, promptFile]);

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
    if (!id || !taskId) return;
    store.taskCancelling(id);
    void bridge
      .rpc("task.cancel", { taskId })
      .then(({ cancelled }) => {
        // Nothing live to stop: the run already ended, or the agent restarted
        // under a task this tab still believes is running. Either way no end
        // event is coming, so clear here — otherwise the composer sits in
        // "Stopping…" and the session can never be used again.
        if (!cancelled) useSessionsStore.getState().taskEnded(id, "cancelled");
      })
      .catch(() => {
        useSessionsStore.getState().taskEnded(id, "cancelled");
      });
  }, []);

  /**
   * Drops the follow-ups still waiting, leaving the running task alone.
   *
   * Each cancel comes back as its own task.cancelled, which is what takes
   * the entry out of the line — so a drop that the agent has already
   * promoted to running is simply cancelled instead, never lost silently.
   */
  const clearQueue = useCallback(() => {
    const store = useSessionsStore.getState();
    const id = store.selectedId;
    const waiting = id ? (store.sessions[id]?.queuedTaskIds ?? []) : [];
    for (const taskId of waiting) {
      void bridge.rpc("task.cancel", { taskId }).catch(() => undefined);
    }
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
    (value: ModelChoice) => {
      // The reasoning pick belongs to the MODEL it was made under. Codex
      // tops out at xhigh, an Ollama reasoning model only has off/on, a
      // non-reasoning model has nothing — so a level chosen for Claude may
      // not exist on the row being switched to. Carrying it across anyway
      // is how a turn starts with an effort the provider rejects; reset to
      // default whenever the new row does not support the current pick.
      const prefs = usePreferencesStore.getState();
      const current =
        prefs.byChat[selectedId ?? ""]?.effort ?? prefs.defaults.effort;
      const row = models.find((m) => m.value === value);
      const keeps =
        current === "default" ||
        row === undefined ||
        (row.supportsEffort !== false &&
          (row.reasoningLevels === undefined ||
            row.reasoningLevels.includes(
              current as NonNullable<typeof row.reasoningLevels>[number]
            )));
      setComposer(
        selectedId,
        keeps ? { model: value } : { model: value, effort: "default" }
      );
    },
    [setComposer, selectedId, models]
  );

  const changeEffort = useCallback(
    (value: EffortChoice) => setComposer(selectedId, { effort: value }),
    [setComposer, selectedId]
  );

  const setPlanMode = useCallback(
    (value: boolean) => setComposer(selectedId, { planMode: value }),
    [setComposer, selectedId]
  );

  // Belongs to the CHAT like model and effort do: a thread opened for a
  // quick plain-Claude question stays that way when you switch back to it.
  const setSystemKnowledge = useCallback(
    (value: boolean) => setComposer(selectedId, { systemKnowledge: value }),
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
    queuedCount,
    clearQueue,
    error,
    send,
    cancel,
    model: own?.model ?? defaults.model,
    models,
    noProvidersEnabled: modelsLoaded && models.length === 0,
    changeModel,
    effort: own?.effort ?? defaults.effort,
    changeEffort,
    planMode: own?.planMode ?? false,
    setPlanMode,
    systemKnowledge: own?.systemKnowledge ?? defaults.systemKnowledge,
    setSystemKnowledge,
    vibe,
    changeVibe,
    autoReview,
    changeAutoReview,
    autoValidate,
    changeAutoValidate,
    attachments,
    addAttachment,
    removeAttachment,
    attachCandidate,
    images,
    addImages,
    removeImage,
    slashCommands,
    mentions,
    promptFile,
    setPromptFile,
    promptFiles,
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

/**
 * The name this send gives the conversation, or undefined to leave it as
 * it is. A picked note always wins: the note is the unit of work, so the
 * session list must read as its heading no matter what was typed alongside
 * it. Without a note the old rule stands — only an unnamed conversation
 * takes its name from the prompt.
 *
 * Optimistic only; the agent persists the same value from the same helper.
 */
function titleFrom(
  session: SessionVm,
  prompt: string,
  noteTitle?: string
): string | undefined {
  if (noteTitle) return conversationTitle(noteTitle);
  if (session.conversation.title !== "New conversation") return undefined;
  return conversationTitle(prompt);
}

function errText(e: unknown): string {
  return String((e as { message?: string } | undefined)?.message ?? e);
}
