import type { EventFrame, ProjectInfo } from "@atelier/protocol";
import { bridge } from "./bridge-client.js";
import { hub } from "./hub-client.js";
import { terminalRegistry } from "./terminal-registry.js";
import { useProjectsStore } from "@/state/projects.store";
import { resetWorkspaceStores } from "@/state/reset";

let hubStarted = false;

/**
 * Connect to the supervisor, load the project list, and select a project.
 * The hub stays connected for the whole session; the bridge re-points per
 * selected project via switchProject().
 */
export function startHub(): void {
  if (hubStarted) return;
  hubStarted = true;

  hub.onStatus(async (state) => {
    const store = useProjectsStore.getState();
    store.setHubConnected(state === "connected");
    if (state === "connected") await loadAndAutoSelect();
  });

  hub.subscribe("project.status", (frame: EventFrame) => {
    const project = (frame.payload as { project: ProjectInfo }).project;
    useProjectsStore.getState().upsert(project);
  });

  hub.connect();
}

async function loadAndAutoSelect(): Promise<void> {
  const store = useProjectsStore.getState();
  const { projects } = await hub.rpc("projects.list", {});
  store.setProjects(projects);
  if (store.activeId) return; // already on a project (reconnect)

  // `atelier run` opens the UI with ?open=<abs path> for the launching dir.
  const openPath = new URLSearchParams(window.location.search).get("open");
  if (openPath) {
    try {
      const project = await addProject(openPath);
      await switchProject(project.id);
      return;
    } catch {
      // fall through to the normal auto-select below
    }
  }

  const target = pickInitial(projects);
  if (target) await switchProject(target.id);
}

/** Most-recently opened, else the first running, else the first known. */
function pickInitial(projects: ProjectInfo[]): ProjectInfo | undefined {
  const byRecent = [...projects].sort(
    (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)
  );
  return (
    byRecent.find((p) => (p.lastOpenedAt ?? 0) > 0) ??
    projects.find((p) => p.status === "running") ??
    projects[0]
  );
}

/**
 * Point the bridge at a project's agent, resetting all workspace-scoped
 * state so nothing from the previous project leaks in. Starts the agent
 * first (idempotent) to obtain its port + token.
 */
export async function switchProject(id: string): Promise<void> {
  const store = useProjectsStore.getState();
  if (store.switching) return;
  store.setSwitching(true);
  try {
    const { endpoint } = await hub.rpc("projects.start", { id });
    bridge.disconnect();
    resetWorkspaceStores();
    terminalRegistry.disposeAll();
    bridge.setEndpoint({ port: endpoint.port, token: endpoint.token });
    store.setActive(id);
    bridge.connect();
  } finally {
    useProjectsStore.getState().setSwitching(false);
  }
}

export async function addProject(path: string): Promise<ProjectInfo> {
  const { project } = await hub.rpc("projects.add", { path });
  useProjectsStore.getState().upsert(project);
  return project;
}

export async function stopProject(id: string): Promise<void> {
  await hub.rpc("projects.stop", { id });
}

export async function removeProject(id: string): Promise<void> {
  await hub.rpc("projects.remove", { id });
  useProjectsStore.setState((s) => ({
    projects: s.projects.filter((p) => p.id !== id),
  }));
}
