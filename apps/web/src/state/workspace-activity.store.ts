import { create } from "zustand";

/** What a background workspace's agent is doing right now. */
export interface WorkspaceActivity {
  /** A task is actually running in that project. */
  working: boolean;
  /** Count of active tasks, for the tooltip. */
  tasks: number;
  /** The monitor has a live link to that agent (so `working` is truthful). */
  observed: boolean;
}

interface WorkspaceActivityStore {
  byProject: Record<string, WorkspaceActivity>;
  set: (projectId: string, patch: Partial<WorkspaceActivity>) => void;
  forget: (projectId: string) => void;
  clear: () => void;
}

/**
 * Live activity of the workspaces you are NOT currently looking at.
 *
 * The supervisor only knows whether an agent PROCESS is alive — it stays
 * warm for every project you have opened this session — which says nothing
 * about whether that agent is working. This store is filled by
 * workspace-activity.ts, which observes each warm agent directly.
 */
export const useWorkspaceActivityStore = create<WorkspaceActivityStore>(
  (set) => ({
    byProject: {},
    set: (projectId, patch) =>
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: {
            working: false,
            tasks: 0,
            observed: false,
            ...s.byProject[projectId],
            ...patch,
          },
        },
      })),
    forget: (projectId) =>
      set((s) => {
        if (!(projectId in s.byProject)) return s;
        const byProject = { ...s.byProject };
        delete byProject[projectId];
        return { byProject };
      }),
    clear: () => set({ byProject: {} }),
  })
);
