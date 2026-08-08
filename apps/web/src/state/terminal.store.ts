import { create } from "zustand";
import type { TerminalSession } from "@atelier/protocol";

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
  setSessions: (sessions: TerminalSession[]) => void;
  addSession: (session: TerminalSession) => void;
  removeSession: (termId: string) => void;
  renameSession: (termId: string, name: string) => void;
  setActive: (termId: string | null) => void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  sessions: [],
  activeTermId: null,
  labels: {},

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

  setActive: (activeTermId) => set({ activeTermId }),
}));
