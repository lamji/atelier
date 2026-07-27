import { create } from "zustand";

const VIBE_KEY = "atelier.vibe";
const DEFAULTS_KEY = "atelier.composer.defaults";
const PER_CHAT_KEY = "atelier.composer.byChat";
/** Keys from when the picks were one global setting; read once, then dead. */
const LEGACY_MODEL_KEY = "atelier.model";
const LEGACY_EFFORT_KEY = "atelier.effort";
/** Oldest per-chat entries are dropped past this many. */
const MAX_REMEMBERED_CHATS = 200;

/** Any SDK model value, or "default" to let the agent decide. */
export type ModelChoice = string;
export type EffortChoice = "default" | "low" | "medium" | "high" | "max";

/** The composer picks that ride along with task.start. */
export interface ComposerPrefs {
  model: ModelChoice;
  effort: EffortChoice;
  planMode: boolean;
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
  return localStorage.getItem(VIBE_KEY) === "1";
}

/** What a chat with no pick of its own gets — your last choice. */
function readDefaults(): ComposerPrefs {
  const stored = parse<Partial<ComposerPrefs>>(DEFAULTS_KEY) ?? {};
  return {
    model: stored.model ?? localStorage.getItem(LEGACY_MODEL_KEY) ?? "default",
    effort:
      stored.effort ??
      ((localStorage.getItem(LEGACY_EFFORT_KEY) as EffortChoice | null) ??
        "default"),
    // Plan mode is a per-task decision; a new chat never inherits it.
    planMode: false,
  };
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
}

export const usePreferencesStore = create<PreferencesStore>((set) => ({
  vibe: readVibe(),
  setVibe: (value) => {
    localStorage.setItem(VIBE_KEY, value ? "1" : "0");
    set({ vibe: value });
  },

  defaults: readDefaults(),
  byChat: parse<Record<string, Partial<ComposerPrefs>>>(PER_CHAT_KEY) ?? {},

  setComposer: (conversationId, patch) =>
    set((s) => {
      // The pick also becomes the starting point for the next new chat, so
      // choosing a model still feels sticky — it just stops leaking sideways
      // into chats you already set.
      const defaults: ComposerPrefs = { ...s.defaults, ...patch, planMode: false };
      localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
      if (!conversationId) return { defaults };
      const byChat = prune({
        ...s.byChat,
        [conversationId]: { ...s.byChat[conversationId], ...patch },
      });
      localStorage.setItem(PER_CHAT_KEY, JSON.stringify(byChat));
      return { defaults, byChat };
    }),
}));
