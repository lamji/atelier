import { create } from "zustand";

interface ProvidersState {
  /**
   * Bumped whenever provider credentials change. The composer's model
   * picker watches this so a key added in Settings brings the new models
   * in straight away, instead of on the next reload.
   */
  revision: number;
  bump: () => void;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));
