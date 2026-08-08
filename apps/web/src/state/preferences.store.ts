import { create } from "zustand";
import type { ReasoningEffort } from "@atelier/protocol";

const VIBE_KEY = "atelier.vibe";
const AUTO_REVIEW_KEY = "atelier.autoReview";
const DEFAULTS_KEY = "atelier.composer.defaults";
const PER_CHAT_KEY = "atelier.composer.byChat";
/** Keys from when the picks were one global setting; read once, then dead. */
const LEGACY_MODEL_KEY = "atelier.model";
const LEGACY_EFFORT_KEY = "atelier.effort";
/** Oldest per-chat entries are dropped past this many. */
const MAX_REMEMBERED_CHATS = 200;

/** Any SDK model value, or "default" to let the agent decide. */
export type ModelChoice = string;
export type EffortChoice = "default" | ReasoningEffort;

/** The composer picks that ride along with task.start. */
export interface ComposerPrefs {
  model: ModelChoice;
  effort: EffortChoice;
  planMode: boolean;
  /**
   * Run the task through Atelier's knowledge engine. Off means a plain
   * Claude/Codex turn: no retrieval, impact, plan, review or memory.
   */
  systemKnowledge: boolean;
  /**
   * Path of the markdown file used as this chat's prompt, or "" for none.
   *
   * It belongs to the CHAT and survives sending: a prompt file is the
   * instructions the conversation runs under, not a one-off attachment, so
   * clearing it after each message meant a pick made mid-session silently
   * stopped applying on the very next turn.
   */
  promptFile: string;
}

/**
 * Each project is an isolated workspace, so the picks that describe "how I
 * work HERE" (model, effort, knowledge, vibe) are stored per project. The
 * unscoped key remains the fallback, so an existing install keeps its
 * choices the first time it opens each project.
 */
let projectScope = "";

function scoped(key: string): string {
  return projectScope ? `${key}::${projectScope}` : key;
}

function parse<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function readVibe(): boolean {
  const own = localStorage.getItem(scoped(VIBE_KEY));
  return (own ?? localStorage.getItem(VIBE_KEY)) === "1";
}

/** Reviewing your own changes is the default; only "0" turns it off. */
function readAutoReview(): boolean {
  const own = localStorage.getItem(scoped(AUTO_REVIEW_KEY));
  return (own ?? localStorage.getItem(AUTO_REVIEW_KEY)) !== "0";
}

/** What a chat with no pick of its own gets — your last choice here. */
function readDefaults(): ComposerPrefs {
  const stored =
    parse<Partial<ComposerPrefs>>(scoped(DEFAULTS_KEY)) ??
    parse<Partial<ComposerPrefs>>(DEFAULTS_KEY) ??
    {};
  return {
    model: stored.model ?? localStorage.getItem(LEGACY_MODEL_KEY) ?? "default",
    effort:
      stored.effort ??
      ((localStorage.getItem(LEGACY_EFFORT_KEY) as EffortChoice | null) ??
        "default"),
    // Plan mode is a per-task decision; a new chat never inherits it.
    planMode: false,
    // Nor does a new chat inherit a prompt file: it sticks where it was
    // chosen, rather than quietly governing every conversation after it.
    promptFile: "",
    // The pipeline is what Atelier is; bypassing it is the deliberate act.
    systemKnowledge: stored.systemKnowledge ?? true,
  };
}

/**
 * Per-chat picks, scoped per project so a busy workspace's conversations
 * cannot evict another workspace's picks out of the capped map.
 */
function readByChat(): Record<string, Partial<ComposerPrefs>> {
  return (
    parse<Record<string, Partial<ComposerPrefs>>>(scoped(PER_CHAT_KEY)) ??
    (projectScope
      ? {}
      : (parse<Record<string, Partial<ComposerPrefs>>>(PER_CHAT_KEY) ?? {}))
  );
}

function prune(
  byChat: Record<string, Partial<ComposerPrefs>>
): Record<string, Partial<ComposerPrefs>> {
  const ids = Object.keys(byChat);
  if (ids.length <= MAX_REMEMBERED_CHATS) return byChat;
  const trimmed: Record<string, Partial<ComposerPrefs>> = {};
  for (const id of ids.slice(-MAX_REMEMBERED_CHATS)) trimmed[id] = byChat[id]!;
  return trimmed;
}

/**
 * Client-side preferences that outlive a session. Kept in one store so the
 * composer toggle and the Settings panel are the same switch rather than
 * two copies that drift apart.
 */
interface PreferencesStore {
  /** Vibe Coding Mode: the agent owns the feature end to end. */
  vibe: boolean;
  setVibe: (value: boolean) => void;
  /** Independent review pass after the changes land. */
  autoReview: boolean;
  setAutoReview: (value: boolean) => void;
  /** Applied to a chat that has never had a pick of its own. */
  defaults: ComposerPrefs;
  /**
   * Per-conversation picks. Model and effort belong to the CHAT, not the
   * app: one chat on haiku and another on sonnet must stay that way when
   * you switch between them.
   */
  byChat: Record<string, Partial<ComposerPrefs>>;
  setComposer: (
    conversationId: string | null,
    patch: Partial<ComposerPrefs>
  ) => void;
  /**
   * Re-point the store at a project's own picks. Called on every project
   * switch so each workspace keeps its own model/effort/knowledge/vibe
   * rather than inheriting whatever the last project was set to.
   */
  setProjectScope: (projectId: string | null) => void;
}

export const usePreferencesStore = create<PreferencesStore>((set) => ({
  vibe: readVibe(),
  setVibe: (value) => {
    localStorage.setItem(scoped(VIBE_KEY), value ? "1" : "0");
    set({ vibe: value });
  },

  autoReview: readAutoReview(),
  setAutoReview: (value) => {
    localStorage.setItem(scoped(AUTO_REVIEW_KEY), value ? "1" : "0");
    set({ autoReview: value });
  },

  defaults: readDefaults(),
  byChat: readByChat(),

  setProjectScope: (projectId) => {
    const next = projectId ?? "";
    if (next === projectScope) return;
    projectScope = next;
    set({
      vibe: readVibe(),
      autoReview: readAutoReview(),
      defaults: readDefaults(),
      byChat: readByChat(),
    });
  },

  setComposer: (conversationId, patch) =>
    set((s) => {
      // The pick also becomes the starting point for the next new chat, so
      // choosing a model still feels sticky — it just stops leaking sideways
      // into chats you already set.
      const defaults: ComposerPrefs = {
        ...s.defaults,
        ...patch,
        planMode: false,
        promptFile: "",
      };
      localStorage.setItem(scoped(DEFAULTS_KEY), JSON.stringify(defaults));
      if (!conversationId) return { defaults };
      const byChat = prune({
        ...s.byChat,
        [conversationId]: { ...s.byChat[conversationId], ...patch },
      });
      localStorage.setItem(scoped(PER_CHAT_KEY), JSON.stringify(byChat));
      return { defaults, byChat };
    }),
}));
