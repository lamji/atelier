import type { EventFrame, ProjectInfo } from "@atelier/protocol";
import { bridge } from "./bridge-client.js";
import { hub } from "./hub-client.js";
import { terminalRegistry } from "./terminal-registry.js";
import { workspaceActivity } from "./workspace-activity.js";
import { useProjectsStore } from "@/state/projects.store";
import { usePreferencesStore } from "@/state/preferences.store";
import { resetWorkspaceStores } from "@/state/reset";
import { isDesktop } from "@/lib/desktop";

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
    store.setHubState(state);
    if (state !== "connected") return;
    try {
      await loadAndAutoSelect();
    } catch {
      // A failed bootstrap leaves no active project; the connection gate
      // tells the user to run `atelier run` and offers a retry.
    }
  });

  hub.subscribe("project.status", (frame: EventFrame) => {
    const project = (frame.payload as { project: ProjectInfo }).project;
    useProjectsStore.getState().upsert(project);
  });

  hub.connect();
  // Follows every warm background agent so the switcher can say which
  // workspaces are actually working, not merely loaded.
  workspaceActivity.start();
}

async function loadAndAutoSelect(): Promise<void> {
  const store = useProjectsStore.getState();
  // Held until a project is selected so the gate shows "connecting", not
  // "no project open", during the list → start → handshake round trip.
  store.setBootstrapping(true);
  try {
    const { projects, initialId } = await hub.rpc("projects.list", {});
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

    // Desktop: never auto-open a workspace. The welcome screen appears
    // immediately and the user opens or imports a project themselves —
    // no spinner, no "connecting" limbo on boot.
    if (isDesktop()) return;

    const target = pickInitial(projects, initialId);
    if (target) await switchProject(target.id);
  } finally {
    useProjectsStore.getState().setBootstrapping(false);
  }
}

/**
 * The project this supervisor was launched for (`atelier debug` / `run` in
 * that folder), else most-recently opened, else the first running, else the
 * first known. Launch intent has to win: the initial project's agent is
 * still starting at this point, so its lastOpenedAt is not stamped yet and
 * a purely recency-based pick would open — and start — last session's
 * project instead.
 */
function pickInitial(
  projects: ProjectInfo[],
  initialId?: string
): ProjectInfo | undefined {
  const launched = projects.find((p) => p.id === initialId);
  if (launched) return launched;

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
    // Each workspace keeps its own composer picks (model, effort, knowledge,
    // vibe); load this project's before anything can read them.
    usePreferencesStore.getState().setProjectScope(id);
    bridge.setEndpoint({ port: endpoint.port, token: endpoint.token });
    store.setActive(id);
    bridge.connect();
  } finally {
    useProjectsStore.getState().setSwitching(false);
  }
}

/**
 * Re-establish whichever link is missing, outermost first: the supervisor,
 * then the project list, then the active project's agent. Drives the
 * connection gate's Retry button, so it never throws.
 */
export async function retryConnection(): Promise<void> {
  const store = useProjectsStore.getState();
  if (store.hubState !== "connected") {
    hub.disconnect();
    hub.connect();
    return;
  }
  try {
    // projects.start is idempotent: it revives a stopped agent and returns
    // the live endpoint for one that is already running.
    if (store.activeId) await switchProject(store.activeId);
    else await loadAndAutoSelect();
  } catch {
    // The gate keeps showing the failure; the user can retry again.
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
