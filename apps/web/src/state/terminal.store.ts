import { create } from "zustand";
import {
  isTerminalProfileId,
  type TerminalProfileId,
} from "@/services/terminal-appearance";
import type { TerminalSession } from "@atelier/protocol";

const TERMINAL_PROFILE_KEY = "atelier.terminal.profile";

function initialProfile(): TerminalProfileId {
  const stored = localStorage.getItem(TERMINAL_PROFILE_KEY);
  // "system" by default: a terminal that stays aubergine while the rest of
  // the app is light reads as a foreign object dropped into the window.
  return isTerminalProfileId(stored) ? stored : "system";
}

interface TerminalStore {
  sessions: TerminalSession[];
  activeTermId: string | null;
  /**
   * Renderer-side display names, by terminal id.
   *
   * There is no terminal.rename RPC — the agent names a PTY once, at create.
   * Renaming is therefore a local label, and it is kept in its own map rather
   * than written into `sessions` because terminal.list() replaces that array
   * wholesale on every reconnect and would undo the rename. The name does
   * reach the agent eventually: the roster persists it, and the next launch
   * passes it to terminal.create().
   */
  labels: Record<string, string>;
  profile: TerminalProfileId;
  setSessions: (sessions: TerminalSession[]) => void;
  addSession: (session: TerminalSession) => void;
  removeSession: (termId: string) => void;
  renameSession: (termId: string, name: string) => void;
  setProfile: (profile: TerminalProfileId) => void;
  setActive: (termId: string | null) => void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  sessions: [],
  activeTermId: null,
  labels: {},
  profile: initialProfile(),

  setSessions: (sessions) =>
    set((s) => ({
      sessions,
      activeTermId:
        s.activeTermId && sessions.some((x) => x.id === s.activeTermId)
          ? s.activeTermId
          : (sessions[0]?.id ?? null),
    })),

  addSession: (session) =>
    set((s) => ({
      sessions: [...s.sessions, session],
      activeTermId: session.id,
    })),

  removeSession: (termId) =>
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== termId);
      // Drop the label too, or a reused id would inherit a dead name.
      const { [termId]: _gone, ...labels } = s.labels;
      return {
        sessions,
        labels,
        activeTermId:
          s.activeTermId === termId
            ? (sessions[0]?.id ?? null)
            : s.activeTermId,
      };
    }),

  renameSession: (termId, name) =>
    set((s) => {
      const trimmed = name.trim();
      if (!trimmed) return s;
      return { labels: { ...s.labels, [termId]: trimmed } };
    }),

  setProfile: (profile) => {
    localStorage.setItem(TERMINAL_PROFILE_KEY, profile);
    set({ profile });
  },

  setActive: (activeTermId) => set({ activeTermId }),
}));
