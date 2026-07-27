import { create } from "zustand";
import type { ProjectInfo } from "@atelier/protocol";
import type { ConnectionState } from "@/types";

interface ProjectsStore {
  projects: ProjectInfo[];
  /** The project the bridge is currently pointed at. */
  activeId: string | null;
  /** True while a project switch is spawning/connecting. */
  switching: boolean;
  /**
   * True from the moment the hub connects until the initial project list is
   * loaded and a project has been selected. Distinguishes "still booting"
   * from "genuinely nothing open" for the connection gate.
   */
  bootstrapping: boolean;
  /**
   * Live link to the supervisor. Kept as the full state, not a boolean, so
   * the connection gate can tell "still dialling" from "not running".
   */
  hubState: ConnectionState;
  setProjects: (projects: ProjectInfo[]) => void;
  /** Upsert one project (from a project.status event). */
  upsert: (project: ProjectInfo) => void;
  setActive: (activeId: string | null) => void;
  setSwitching: (switching: boolean) => void;
  setBootstrapping: (bootstrapping: boolean) => void;
  setHubState: (hubState: ConnectionState) => void;
  active: () => ProjectInfo | undefined;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  activeId: null,
  switching: false,
  bootstrapping: false,
  // Optimistic: startHub() dials on mount, so treating the first paint as
  // "connecting" keeps a normal boot from reading as a dead supervisor.
  hubState: "connecting",

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
  setBootstrapping: (bootstrapping) => set({ bootstrapping }),
  setHubState: (hubState) => set({ hubState }),
  active: () => get().projects.find((p) => p.id === get().activeId),
}));
