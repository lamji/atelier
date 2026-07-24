import { create } from "zustand";
import type { ProjectInfo } from "@atelier/protocol";

interface ProjectsStore {
  projects: ProjectInfo[];
  /** The project the bridge is currently pointed at. */
  activeId: string | null;
  /** True while a project switch is spawning/connecting. */
  switching: boolean;
  hubConnected: boolean;
  setProjects: (projects: ProjectInfo[]) => void;
  /** Upsert one project (from a project.status event). */
  upsert: (project: ProjectInfo) => void;
  setActive: (activeId: string | null) => void;
  setSwitching: (switching: boolean) => void;
  setHubConnected: (hubConnected: boolean) => void;
  active: () => ProjectInfo | undefined;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  activeId: null,
  switching: false,
  hubConnected: false,

  setProjects: (projects) => set({ projects }),
  upsert: (project) =>
    set((s) => {
      const exists = s.projects.some((p) => p.id === project.id);
      return {
        projects: exists
          ? s.projects.map((p) => (p.id === project.id ? project : p))
          : [...s.projects, project],
      };
    }),
  setActive: (activeId) => set({ activeId }),
  setSwitching: (switching) => set({ switching }),
  setHubConnected: (hubConnected) => set({ hubConnected }),
  active: () => get().projects.find((p) => p.id === get().activeId),
}));
