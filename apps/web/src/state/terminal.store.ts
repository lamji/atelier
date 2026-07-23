import { create } from "zustand";
import type { TerminalSession } from "@atelier/protocol";

interface TerminalStore {
  sessions: TerminalSession[];
  activeTermId: string | null;
  setSessions: (sessions: TerminalSession[]) => void;
  addSession: (session: TerminalSession) => void;
  removeSession: (termId: string) => void;
  setActive: (termId: string | null) => void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  sessions: [],
  activeTermId: null,

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
      return {
        sessions,
        activeTermId:
          s.activeTermId === termId
            ? (sessions[0]?.id ?? null)
            : s.activeTermId,
      };
    }),

  setActive: (activeTermId) => set({ activeTermId }),
}));
