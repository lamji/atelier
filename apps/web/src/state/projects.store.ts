import { create } from "zustand";

/**
 * Project list mirrored from the desktop main process (the registry +
 * per-agent run state). Fed by projects.onChanged pushes; there is no hub
 * connection state anymore — main is always reachable over IPC.
 */
interface ProjectsStore {
  projects: AtelierProjectInfo[];
  /** The project whose agent the bridge is currently attached to. */
  activeId: string | null;
  /** True while a project switch is starting/attaching. */
  switching: boolean;
  /** True once the first list has arrived — before that, "no projects" and
   *  "not asked yet" are indistinguishable and would misroute the app. */
  loaded: boolean;
  /** Why the last open failed. Held in the store because the screen that
   *  started the open is usually unmounted by the time it fails. */
  openError: string | null;
  setProjects: (projects: AtelierProjectInfo[]) => void;
  setActive: (activeId: string | null) => void;
  setSwitching: (switching: boolean) => void;
  setOpenError: (openError: string | null) => void;
  active: () => AtelierProjectInfo | undefined;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  activeId: null,
  switching: false,
  loaded: false,
  openError: null,

  setProjects: (projects) => set({ projects, loaded: true }),
  setActive: (activeId) => set({ activeId }),
  setSwitching: (switching) => set({ switching }),
  setOpenError: (openError) => set({ openError }),
  active: () => get().projects.find((p) => p.id === get().activeId),
}));
